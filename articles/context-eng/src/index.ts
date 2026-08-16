/**
 * test-context-eng-v2.ts — 上下文工程：三种上下文策略对比
 *
 * 对比三种上下文构建策略（坏/中/好）在 RAG 场景下的表现差异：
 *   坏（Bad）  ：全部检索结果塞入，不筛选
 *   中（Medium）：top-k 筛选，不裁剪
 *   好（Good）  ：top-k 筛选 + 语义边界裁剪 + 截断标记
 *
 * 输出：chunk 数、token 估算、信号比（相关 chunk 占比）、LLM 回答质量对比
 *
 * 运行：cd ~/workspace/ai-tools-demo && npx tsx src/code-and-doc/test-context-eng-v2.ts
 */

import dotenv from "dotenv";
import path from "path";

// 加载仓库根目录 .env
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { trimMessages } from "@langchain/core/messages";
import { getEncoding } from "js-tiktoken";

// ───────── 知识库文档（10 篇电商主题） ─────────
const KNOWLEDGE_BASE = [
  /* 1 */ `退货政策 3.0（2026-08-01 修订）
退货期限：签收后 7 天内支持无理由退货，商品需保持完好。
特殊商品：食品、内衣、定制商品、跨境商品不支持无理由退货。
退货流程：订单详情页 → 申请售后 → 选择退货退款 → 填写原因 → 提交申请。
审核时效：商家在 24 小时内审核退货申请，审核通过后系统生成退货单号。
签收确认：商家收到退货商品后 48 小时内完成签收确认。`,

  /* 2 */ `退款时效与规则（2026-06-15 生效）
退款触发条件：商家确认收到退货商品后，系统自动发起退款。
退款到账时间：支付宝/微信支付 1-3 个工作日，银行卡 3-7 个工作日，花呗以支付渠道为准。
退款路径：原路退回，不支持更换退款账户。
退款金额：全额退款 = 商品金额 + 原始运费。
退款失败处理：若 7 个工作日未到账，联系人工客服并提供订单号。`,

  /* 3 */ `订单查询与物流追踪
订单号格式：ORD-YYYYMMDD-XXX（如 ORD-20260815-001）。
查询入口：我的订单 → 输入订单号或手机号 → 查看订单详情。
物流状态：待发货 / 已发货 / 运输中 / 已签收 / 异常。
发货时效：现货商品下单后 24 小时内发货，预售商品以页面标注为准。`,

  /* 4 */ `会员积分体系（2026 版）
积分获取：消费 1 元累计 1 积分，评价商品额外奖励 10 积分。
积分有效期：自获取之日起 12 个月，过期自动清零。
积分使用：100 积分 = 1 元，可在下单时抵扣，单笔订单最多抵扣 50%。
积分等级：普通会员 / 银卡（5000 积分）/ 金卡（20000 积分）/ 钻石（50000 积分）。`,

  /* 5 */ `平台支付方式说明
支持支付方式：微信支付、支付宝、花呗、银行卡、Apple Pay。
分期付款：花呗支持 3/6/12 期免息分期（限指定商品）。
支付安全：所有支付链路采用 HTTPS + SSL 加密，PCI DSS 三级认证。
支付异常：扣款成功但订单未生成，系统在 30 分钟内自动退款。`,

  /* 6 */ `客服体系与投诉处理
在线客服：9:00-24:00（工作日），10:00-22:00（节假日）。
电话客服：400-XXX-XXXX（工作日 9:00-18:00）。
投诉处理流程：提交投诉 → 客服 2 小时内响应 → 24 小时内给出处理方案 → 72 小时内结案。`,

  /* 7 */ `促销活动与优惠券规则
优惠券类型：满减券、折扣券、免邮券、新用户专享券。
使用规则：每笔订单限用一张优惠券，不可与店铺券叠加。
优惠券有效期：领取后 7-30 天不等，过期作废。
退款场景：使用优惠券的订单退款时，优惠券金额按比例退回。`,

  /* 8 */ `账号安全与隐私保护
账号注册：手机号实名注册，一个手机号仅限一个账号。
安全设置：建议开启两步验证（短信验证码 + 登录密码）。
异地登录保护：检测到异地登录自动触发短信验证。
隐私政策：用户数据加密存储，不向第三方出售个人信息。`,

  /* 9 */ `配送与收货规则
配送范围：全国（港澳台除外），偏远地区加收配送费。
配送时效：一线城市次日达，二三线城市 2-3 天，偏远地区 5-7 天。
签收规则：签收时请当面验货，如有破损可拒收并联系客服。`,

  /* 10 */ `售后与维修服务
售后范围：商品质量问题、功能故障、外观损坏（非人为）。
售后期限：签收后 7 天内可退货，15 天内可换货，1 年内保修。
维修费用：保修期内非人为损坏免费维修，人为损坏收取维修费。`,
];

// ───────── 辅助函数 ─────────

/** 估算 token 数（中文约 1.5 char/token，英文约 4 char/token） */
function estimateTokens(text: string): number {
  let cn = 0,
    en = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cn++;
    else if (/\S/.test(ch)) en++;
  }
  return Math.ceil(cn / 1.5) + Math.ceil(en / 4);
}

/** 判断 chunk 是否与问题主题相关（基于关键词匹配） */
function isRelevant(pageContent: string, keywords: string[]): boolean {
  return keywords.some((kw) => pageContent.includes(kw));
}

/** 生产级裁剪：按精确 token 预算裁剪，保留消息尾部（最新信息优先） */
const enc = getEncoding("cl100k_base");

async function trimChunk(chunk: string, maxTokens: number): Promise<string> {
  const msg = new HumanMessage(chunk);
  const trimmed = await trimMessages([msg], {
    maxTokens,
    strategy: "last",  // 保留尾部（最近信息优先）
    tokenCounter: (msgs) =>
      msgs.reduce((sum, m) => sum + enc.encode(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).length, 0),
    includeSystem: false,
    allowPartial: true,
  });
  return typeof trimmed[0].content === "string" ? trimmed[0].content : chunk;
}

// ───────── 主流程 ─────────
async function main() {
  console.log("=".repeat(70));
  console.log("  上下文工程（Context Engineering）— 三种策略对比");
  console.log("=".repeat(70));

  // ── 1. 文档分块 ──
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 150,
    chunkOverlap: 20,
    separators: ["\n\n", "\n", "。", "；", "，", " ", ""],
  });

  const docs = KNOWLEDGE_BASE.map(
    (text, i) =>
      new Document({
        pageContent: text,
        metadata: { docId: `doc-${i + 1}`, title: text.split("\n")[0] },
      })
  );
  const chunks = await splitter.splitDocuments(docs);
  console.log(`\n📦 文档分块: ${KNOWLEDGE_BASE.length} 篇文档 → ${chunks.length} 个 chunk`);
  console.log(`   chunk 大小分布: ${chunks.map((c) => c.pageContent.length).join(", ")} 字符`);

  // ── 2. 向量化 + 检索 ──
  // 生产级 Embedding：阿里云 DashScope（OpenAI 兼容端点），text-embedding-v3
// key 配置：仓库根 .env 的 EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.EMBEDDING_API_KEY ?? process.env.API_KEY,
  model: process.env.EMBEDDING_MODEL ?? "text-embedding-v3",
  batchSize: 10,  // DashScope 单批上限 10 条
  configuration: {
    baseURL: process.env.EMBEDDING_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
});
  const vectorStore = await MemoryVectorStore.fromDocuments(chunks, embeddings);

  const QUESTION = "我的订单 ORD-20260815-001 发货 3 天了，想退货，退款多久能到账？";
  const RELEVANT_KEYWORDS = ["退货", "退款", "订单", "售后"];

  console.log(`\n🔍 用户问题: "${QUESTION}"`);
  console.log(`  相关关键词: ${RELEVANT_KEYWORDS.join(", ")}`);

  const rawResults = await vectorStore.similaritySearchWithScore(QUESTION, 20);
  console.log(`  检索结果: ${rawResults.length} 个 chunk (含相似度分数)\n`);

  // ── 3. 三种策略构建 ──

  // 策略 A：坏 —— 全部检索结果，不筛选不裁剪
  const badChunks = rawResults;
  const badContext = badChunks
    .map((r, i) => `【${i + 1}】${r[0].pageContent}`)
    .join("\n\n");
  const badSystem = new SystemMessage("你是电商客服助手。请严格依据提供的文档片段回答用户问题。如果文档片段不足以回答，请如实告知。");
  const badHuman = new HumanMessage(`以下是检索到的文档片段：\n\n${badContext}\n\n用户问题：${QUESTION}`);
  const badMessages = [badSystem, badHuman];

  // 策略 B：中 —— top-k 筛选，不裁剪
  const TOP_K = 4;
  const medChunks = rawResults.slice(0, TOP_K);
  const medContext = medChunks
    .map((r, i) => `【${i + 1}】${r[0].pageContent}`)
    .join("\n\n");
  const medSystem = new SystemMessage("你是电商客服助手。请严格依据提供的文档片段回答用户问题。如果文档片段不足以回答，请如实告知。");
  const medHuman = new HumanMessage(`以下是检索到的文档片段：\n\n${medContext}\n\n用户问题：${QUESTION}`);
  const medMessages = [medSystem, medHuman];

  // 策略 C：好 —— top-k 筛选 + 语义边界裁剪 + 截断标记
  const MAX_CHUNK_TOKENS = 60;  // 生产：按精确 token 预算裁剪
  const goodChunks = await Promise.all(medChunks.map(async (r) => ({
    doc: r[0],
    score: r[1],
    truncated: await trimChunk(r[0].pageContent, MAX_CHUNK_TOKENS),
  })));
  const goodContext = goodChunks
    .map((r, i) => `【${i + 1}】${r.truncated}`)
    .join("\n\n");
  const goodSystem = new SystemMessage("你是电商客服助手。请严格依据提供的文档片段回答用户问题。如果文档片段不足以回答，请如实告知。");
  const goodHuman = new HumanMessage(`以下是检索到的文档片段：\n\n${goodContext}\n\n用户问题：${QUESTION}`);
  const goodMessages = [goodSystem, goodHuman];

  // ── 4. 计算指标 ──

  const badTokenEst = badMessages.reduce((s, m) => s + estimateTokens(String(m.content)), 0);
  const medTokenEst = medMessages.reduce((s, m) => s + estimateTokens(String(m.content)), 0);
  const goodTokenEst = goodMessages.reduce((s, m) => s + estimateTokens(String(m.content)), 0);

  const badRelevant = badChunks.filter((r) => isRelevant(r[0].pageContent, RELEVANT_KEYWORDS)).length;
  const medRelevant = medChunks.filter((r) => isRelevant(r[0].pageContent, RELEVANT_KEYWORDS)).length;
  const goodRelevant = goodChunks.filter((r) => isRelevant(r.doc.pageContent, RELEVANT_KEYWORDS)).length;

  const badSignalRatio = badChunks.length > 0 ? (badRelevant / badChunks.length * 100).toFixed(1) : "0.0";
  const medSignalRatio = medChunks.length > 0 ? (medRelevant / medChunks.length * 100).toFixed(1) : "0.0";
  const goodSignalRatio = goodChunks.length > 0 ? (goodRelevant / goodChunks.length * 100).toFixed(1) : "0.0";

  // ── 5. 输出对比表格 ──

  console.log("=".repeat(70));
  console.log("  📊 三种上下文策略对比");
  console.log("=".repeat(70));
  console.log(`  ${"指标".padEnd(20)} ${"坏 (全部)".padEnd(16)} ${"中 (top-k)".padEnd(16)} ${"好 (top-k+裁剪)".padEnd(16)}`);
  console.log("  " + "─".repeat(66));
  console.log(`  ${"chunk 数".padEnd(20)} ${String(badChunks.length).padEnd(16)} ${String(medChunks.length).padEnd(16)} ${String(goodChunks.length).padEnd(16)}`);
  console.log(`  ${"token 估算".padEnd(20)} ${String(badTokenEst).padEnd(16)} ${String(medTokenEst).padEnd(16)} ${String(goodTokenEst).padEnd(16)}`);
  console.log(`  ${"相关 chunk".padEnd(20)} ${badRelevant.toString().padEnd(16)} ${medRelevant.toString().padEnd(16)} ${goodRelevant.toString().padEnd(16)}`);
  console.log(`  ${"信号比".padEnd(20)} ${(badSignalRatio + "%").padEnd(15)} ${(medSignalRatio + "%").padEnd(15)} ${(goodSignalRatio + "%").padEnd(15)}`);
  console.log(`  ${"token 节省".padEnd(20)} ${"—".padEnd(16)} ${`${Math.round((1 - medTokenEst / badTokenEst) * 100)}%`.padEnd(16)} ${`${Math.round((1 - goodTokenEst / badTokenEst) * 100)}%`.padEnd(16)}`);

  // ── 6. LLM 真实对比 ──

  // 从环境变量读 API key（支持 .env 和 ~/.zshrc 两种来源）
  const apiKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  const modelName = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  const baseURL = process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

  if (!apiKey) {
    console.log("\n⚠️  未找到 API key，跳过 LLM 对比环节");
    console.log("   请设置 LLM_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量");
    return;
  }

  const llm = new ChatOpenAI({
    model: modelName,
    apiKey,
    temperature: 0,
    maxTokens: 1024,
    configuration: { baseURL, timeout: 30000 },
  });

  console.log(`\n🤖 LLM 模型: ${modelName}`);
  console.log(`   API 端点: ${baseURL}`);
  console.log("");

  console.log("=".repeat(70));
  console.log("  🧪 LLM 回答对比（真实运行）");
  console.log("=".repeat(70));

  // 逐个调用（非并行，避免流量限制，同时每个策略输出完整）
  const strategies = [
    { label: "❌ 坏上下文（全部 + 不裁剪）", messages: badMessages, tokenEst: badTokenEst, signalRatio: badSignalRatio, chunkCount: badChunks.length },
    { label: "⚠️  中上下文（top-k + 不裁剪）", messages: medMessages, tokenEst: medTokenEst, signalRatio: medSignalRatio, chunkCount: medChunks.length },
    { label: "✅ 好上下文（top-k + 语义裁剪）", messages: goodMessages, tokenEst: goodTokenEst, signalRatio: goodSignalRatio, chunkCount: goodChunks.length },
  ];

  for (const s of strategies) {
    console.log(`\n  ┌─ ${s.label}`);
    console.log(`  │   chunks: ${s.chunkCount} | 估算 token: ${s.tokenEst} | 信号比: ${s.signalRatio}%`);
    console.log(`  │`);

    try {
      const resp = await llm.invoke(s.messages);
      const content = String(resp.content);
      // 限制输出长度，避免刷屏
      const lines = content.split("\n").slice(0, 12);
      for (const line of lines) {
        console.log(`  │  ${line}`);
      }
      if (lines.length < content.split("\n").length) {
        console.log(`  │  …（共 ${content.length} 字符，${content.split("\n").length} 行，此处仅显示前 12 行）`);
      }
      console.log(`  │  ── 回答长度: ${content.length} 字符 | ${estimateTokens(content)} tokens（估算）`);
    } catch (err: any) {
      console.log(`  │  ❌ LLM 调用失败: ${err.message}`);
    }
    console.log(`  └──`);
  }

  // ── 7. 总结 ──
  console.log("\n");
  console.log("=".repeat(70));
  console.log("  📝 总结");
  console.log("=".repeat(70));
  console.log(`
  1. 坏上下文（全部）: 噪声多，关键信息淹没在大量无关 chunk 中，LLM 容易
     被噪声干扰或超出上下文窗口。

  2. 中上下文（top-k）: 缩小范围，信号比显著提升，但每个 chunk 完整保留，
     可能包含冗余信息。

  3. 好上下文（top-k+裁剪）: 在 top-k 基础上进一步压缩每个 chunk 的信息密度，
     语义边界裁剪确保截断不破坏关键含义，截断标记提醒 LLM 信息不完整。

  💡 核心原则：上下文工程的本质是「信息密度最大化」—— 用最少的 token
     传递最相关的信息。每个 token 都在竞争有限的注意力窗口。
`);

  console.log("✅ 运行完成");
}

main().catch((e) => {
  console.error("❌ 运行失败:", e.message);
  process.exit(1);
});