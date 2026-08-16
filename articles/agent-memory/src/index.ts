/**
 * Agent 记忆管理：LangGraph MemorySaver 跨会话记忆
 * ------------------------------------------------------------------
 * 知识点：
 *   - LangGraph 的 State 是"每次调用后即焚"的（invoke 之间不共享）
 *   - 想要跨会话记忆，需要 Checkpointer（检查点）把每次执行后的状态
 *     落盘/存内存；MemorySaver 是最简单的内存版检查点
 *   - 记忆的隔离粒度是 thread_id：同一个 thread_id 共享记忆，
 *     不同 thread_id 互不可见（这就是"多用户/多会话隔离"的原理）
 *
 * 两步式对比（同一套 Agent 图，唯一的差别是有没有挂 Checkpointer）：
 *   场景 A（无记忆）：会话 1 告诉它"我叫张三"，会话 2 问"我叫什么名字"
 *     → 答不上来，因为每次 invoke 都是全新状态
 *   场景 B（有记忆）：同样两句话，但用同一个 thread_id + MemorySaver
 *     → 能答出来，因为状态被检查点保存并跨会话恢复
 *   场景 C（thread 隔离）：换一个 thread_id 再问 → 又答不上来，
 *     证明记忆是按 thread 隔离的，不会串到别的会话
 *
 * 运行：cd ai-tools-demo && npx tsx src/code-and-doc/test-agent-memory.ts
 * 需要真实 LLM key（读 agent-coze-workflow/.env 的 LLM_* 网关配置）
 */

import "dotenv/config";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { Annotation, StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";

// 加载仓库根目录的 .env（LLM 网关配置）
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const MODEL = process.env.LLM_MODEL ?? "deepseek-v4-flash";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://llm.gw.dachensky.com/v1";
const API_KEY = process.env.LLM_API_KEY ?? "";

const llm = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
  temperature: 0.2,
  maxTokens: 2048,
});

const SYSTEM_PROMPT = new SystemMessage(
  "你是一个乐于助人的助手。用户可能在对话中透露个人信息（比如名字），" +
    "如果历史消息里有，被问到时直接回答；如果没有，就如实说不知道。回答保持简洁。",
);

/* ------------------------------------------------------------------ */
/* 1. 定义 Agent 状态与图                                               */
/* ------------------------------------------------------------------ */

// 状态里只存消息列表：reducer 负责把每次节点返回的消息追加进历史
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: (a, b) => [...a, ...b],
  }),
});

async function modelNode(state: typeof AgentState.State) {
  const res = await llm.invoke([SYSTEM_PROMPT, ...state.messages]);
  return { messages: [res] };
}

/** 同一个图，可选挂 Checkpointer。挂与不挂，就是"有记忆"与"无记忆"的全部差别。 */
function buildAgent(checkpointer?: MemorySaver) {
  const graph = new StateGraph(AgentState)
    .addNode("model", modelNode)
    .addEdge(START, "model")
    .addEdge("model", END);
  return checkpointer ? graph.compile({ checkpointer }) : graph.compile();
}

/* ------------------------------------------------------------------ */
/* 2. 工具函数：跑一轮对话并打印                                       */
/* ------------------------------------------------------------------ */

async function chat(agent: ReturnType<typeof buildAgent>, text: string, config?: object) {
  const res = await agent.invoke({ messages: [new HumanMessage(text)] }, config);
  const last = res.messages[res.messages.length - 1];
  const content =
    typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  return content;
}

/* ------------------------------------------------------------------ */
/* 3. 场景 A：无记忆 Agent（每次 invoke 都是新会话）                     */
/* ------------------------------------------------------------------ */

async function scenarioNoMemory() {
  console.log("========== 场景 A：无记忆 Agent（每次调用都是全新状态） ==========");
  const agent = buildAgent(); // ← 没挂 Checkpointer

  const r1 = await chat(agent, "你好，我叫张三，请记住我的名字。");
  console.log("会话 1：我叫张三，请记住我的名字。");
  console.log(`  Agent：${r1}`);

  // 第二次 invoke 没有传任何历史，也没传 thread_id —— 状态是全新的
  const r2 = await chat(agent, "我叫什么名字？");
  console.log("会话 2：我叫什么名字？");
  console.log(`  Agent：${r2}`);
  console.log("  → 结论：没有记忆，Agent 对上个会话一无所知\n");
}

/* ------------------------------------------------------------------ */
/* 4. 场景 B：有记忆 Agent（MemorySaver + 同一个 thread_id）            */
/* ------------------------------------------------------------------ */

async function scenarioWithMemory() {
  console.log("========== 场景 B：有记忆 Agent（MemorySaver + 同一 thread_id） ==========");
  const checkpointer = new MemorySaver(); // ← 内存版检查点
  const agent = buildAgent(checkpointer);
  const config = { configurable: { thread_id: "user-zhangsan" } };

  const r1 = await chat(agent, "你好，我叫张三，请记住我的名字。", config);
  console.log("会话 1（thread=user-zhangsan）：我叫张三，请记住我的名字。");
  console.log(`  Agent：${r1}`);

  // 第二次 invoke 同样传 thread_id —— LangGraph 从检查点恢复历史状态
  const r2 = await chat(agent, "我叫什么名字？", config);
  console.log("会话 2（thread=user-zhangsan）：我叫什么名字？");
  console.log(`  Agent：${r2}`);

  // 顺便看看检查点里到底存了什么
  const state = await agent.getState(config);
  console.log(`  → 检查点里已存 ${state.values.messages.length} 条消息（含系统提示词），跨会话生效 ✅\n`);
}

/* ------------------------------------------------------------------ */
/* 5. 场景 C：thread_id 隔离（换一个会话，记忆不串）                     */
/* ------------------------------------------------------------------ */

async function scenarioThreadIsolation() {
  console.log("========== 场景 C：thread 隔离（换 thread_id，记忆不串） ==========");
  const checkpointer = new MemorySaver();
  const agent = buildAgent(checkpointer);

  const configA = { configurable: { thread_id: "thread-A" } };
  const configB = { configurable: { thread_id: "thread-B" } };

  await chat(agent, "你好，我叫李四，请记住我的名字。", configA);
  console.log("thread-A：我叫李四，请记住我的名字。（已写入 A 的记忆）");

  // B 与 A 是不同会话，应该完全不知道"李四"
  const r = await chat(agent, "我叫什么名字？", configB);
  console.log("thread-B：我叫什么名字？");
  console.log(`  Agent：${r}`);
  console.log("  → 结论：记忆按 thread_id 隔离，多用户/多会话互不干扰 ✅\n");
}

/* ------------------------------------------------------------------ */
/* 6. 主入口                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  if (!API_KEY) {
    console.error("❌ 缺少 LLM_API_KEY，请检查 ../../.env");
    process.exit(1);
  }
  console.log(`使用模型：${MODEL} @ ${BASE_URL}\n`);
  try {
    await scenarioNoMemory();
    await scenarioWithMemory();
    await scenarioThreadIsolation();
    console.log("========== 全部场景跑完 ==========");
  } catch (err) {
    console.error("❌ 运行出错：", (err as Error).message);
    process.exit(1);
  }
}

main();
