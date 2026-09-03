/**
 * Step 02 – spawn vs fork：都是"派子代理"，差在哪？——委托的两种上下文哲学
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「spawn」= 派一个 fresh child：自己的 Session、零父上下文，看不到父对话
 *   （类比：外包一个全新供应商，把需求完整写在合同里，对方对你公司的历史一无所知）。
 * 「fork」= 派一个 seed child：把父 Session 的"已完成 turn 前缀"复制给 child
 *   当起点，child 继承父对话上下文（类比：把新人拉进群聊，让他先看完聊天记录
 *   再接手你聊到一半的话题）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：所有子代理一视同仁"给它一段话就能干活"。但"基于已有对话的追问"
 * 和"独立调研"是两种任务：前者没有父上下文就是答非所问，后者带着父上下文
 * 反而是污染。一种上下文哲学塞不下两类任务。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * fork 的 seed 不是"把整个父日志复制过去"，而是 completedTurnPrefix：
 * 截到**最后一个 turn/end**。in-flight turn（正在进行、还没收尾的那轮）被
 * 排除——它里面的 subagent 调用还没结果，事件是不平衡的，不能作为合法的
 * 回放历史（copy 一半的账本会让 child 读到"调用已发出但结果不存在"的鬼状态）。
 * 另外父日志只记录 tool/call + tool/result（子代理的最终输出），child 内部
 * 的 step 不进父日志——父只要结论，不关心过程。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 追问型任务 fork（省 token、答得上上下文），独立任务 spawn（隔离、防污染）；
 * in-flight turn 永远不会被误继承。
 *
 * 对应源码：packages/subagent/subagent-fork-in-process/src/index.ts
 *   （completedTurnPrefix L48-54、inheritsParentContext L64）
 *   packages/subagent/subagent-spawn-in-process/src/index.ts（inheritsParentContext L44）
 * 跑法：pnpm run subagent:step:02（或 articles/dsh-subagent 内 pnpm run step:02）
 */

import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// 加载仓库根 .env（LLM_* 权威配置）。两个理由不用 `import 'dotenv/config'`：
// 1. 它只找 cwd 下的 .env——从 articles/dsh-subagent 内跑（铁律跑法）会找不到根 .env；
// 2. dotenv 默认不覆盖 shell 里已存在的同名变量，会顶掉根 .env 的正确 key（override 保证 .env 权威）。
const ENV_CANDIDATES = ['../../.env', '.env'] // 包内跑 → 根 .env；仓库根跑 → ./.env
for (const candidate of ENV_CANDIDATES) {
  if (existsSync(candidate)) {
    config({ path: candidate, override: true })
    break
  }
}

// ── 1. 简化的会话事件（本步用日志数组模拟 Session，真实事件系统 Step 06 讲）──

type SessionEvent =
  | { type: 'turn/start' }
  | { type: 'turn/end' }
  | { type: 'user/message'; content: string }
  | { type: 'assistant/message'; content: string }
  | { type: 'tool/call'; name: string; arguments: string }
  | { type: 'tool/result'; content: string }

/** append-only 日志（沿用 dsh-memory step-01 的 Session 简化版） */
class Session {
  private log: SessionEvent[] = []

  append(event: SessionEvent): void {
    this.log.push(event)
  }

  get events(): readonly SessionEvent[] {
    return this.log
  }
}

/**
 * fork 的 seed 计算：已完成 turn 前缀（对应源码 completedTurnPrefix L48-54）。
 * 截到**最后一个** turn/end（含它本身）：它之后如果有事件，必然是 in-flight
 * turn 的开头——turn 没收尾，事件不平衡，不能作为合法回放历史。
 * 没有任何已完成 turn → 返回空数组（child 从零开始，等价 fresh）。
 */
function completedTurnPrefix(session: Session): SessionEvent[] {
  const events = session.events
  // 等价于源码的 events.findLast(e => e.type === 'turn/end')（lib 仅 ES2022，手写回扫）
  let lastEnd = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') {
      lastEnd = i
      break
    }
  }
  if (lastEnd === -1) return []
  // seq === 数组下标（append 契约），所以直接 slice 到最后一个 turn/end（含）
  return events.slice(0, lastEnd + 1)
}

/** 只把"模型可见"的事件渲染成文本（user/assistant/tool result 才有对话意义） */
function visibleText(events: readonly SessionEvent[]): string[] {
  const lines: string[] = []
  for (const e of events) {
    if (e.type === 'user/message') lines.push(`👤 父：${e.content}`)
    else if (e.type === 'assistant/message') lines.push(`🤖 父 agent：${e.content}`)
    else if (e.type === 'tool/result') lines.push(`🔧 工具结果：${e.content}`)
  }
  return lines
}

/** 把 seed 历史拼成一段给模型的"回放文字"（简化版 deriveMessages 的用途） */
function seedAsText(seed: readonly SessionEvent[]): string {
  return visibleText(seed).join('\n')
}

// ── 2. child 执行器：真实 LLM，带/不带父上下文 ──

/** 真实 LLM 调用：child 的"一次回答" */
async function childAnswer(system: string, history: string, question: string): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  const reply = await llm.invoke([new SystemMessage(system), new HumanMessage(history + question)])
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

/** spawn：fresh child，零父上下文（对应源码 subagent-spawn-in-process） */
async function spawnChild(task: string): Promise<string> {
  const system =
    '你是一个被派来干独立任务的子代理。你**看不到**父 agent 的任何对话历史，只能根据任务描述回答。'
  return childAnswer(system, '', task)
}

/** fork：seed child，先"回放"父的已完成 turn 前缀再回答（对应源码 fork 的 seed） */
async function forkChild(seed: readonly SessionEvent[], task: string): Promise<string> {
  const system =
    '你是一个继承了父对话上下文的子代理。下面给你父 agent 已完成的历史（回放），请基于它回答问题。'
  const history =
    seedAsText(seed).length > 0
      ? `【父对话历史（已完成 turn 的回放）】\n${seedAsText(seed)}\n\n`
      : ''
  return childAnswer(system, history, task)
}

function clip(text: string, max = 70): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

async function main(): Promise<void> {
  console.log('🍴 Step 02 – spawn vs fork：独立调研派 spawn，追问派 fork')
  console.log('='.repeat(62))

  // ── ① 造一个父会话日志：1 个已完成 turn + 1 个 in-flight turn ──
  console.log('\n① 父会话日志（1 个已完成 turn + 1 个正在进行的 turn）')
  const parent = new Session()
  // turn 1（已完成）：用户问技术栈，assistant 回答后收尾
  parent.append({ type: 'turn/start' })
  parent.append({ type: 'user/message', content: '我们这个 AI 课程项目用什么技术栈？' })
  parent.append({
    type: 'assistant/message',
    content: '前端用 React + Vite，后端用 NestJS，AI 部分用 LangChain。',
  })
  parent.append({ type: 'turn/end' })
  // turn 2（in-flight）：assistant 刚发起一次子代理调用，还没等到结果
  parent.append({ type: 'turn/start' })
  parent.append({ type: 'user/message', content: '帮我把登录接口的安全性检查一遍。' })
  parent.append({ type: 'assistant/message', content: '好的，我派一个子代理去审计登录接口。' })
  parent.append({
    type: 'tool/call',
    name: 'subagent',
    arguments: '{"description":"审计登录接口","prompt":"检查 /api/login ..."}',
  })
  // ← 注意：turn 2 没有 turn/end，子代理的 tool/result 也还没回来

  console.log('   完整父日志：')
  for (const e of parent.events) {
    const detail =
      'content' in e ? e.content : 'arguments' in e ? `${e.name}(${e.arguments.slice(0, 30)}…)` : ''
    console.log(`     ${e.type.padEnd(20)} ${clip(detail, 44)}`)
  }

  // ── ② completedTurnPrefix：seed 截到最后一个 turn/end ──
  console.log('\n② fork 的 seed = completedTurnPrefix（截到最后一个 turn/end）')
  const seed = completedTurnPrefix(parent)
  console.log(`   🔍 seed 含 ${seed.length} 条事件（父日志共 ${parent.events.length} 条）`)
  for (const line of seedAsText(seed)) console.log(`     ${clip(line, 60)}`)
  const inFlight = parent.events.slice(seed.length)
  console.log(
    `   🚫 被排除的 in-flight turn：${inFlight
      .filter(e => e.type === 'tool/call')
      .map(e => (e as Extract<SessionEvent, { type: 'tool/call' }>).name)
      .join('、')}（调用已发出但结果没回来）`,
  )
  console.log('   → 为什么排除：turn 没收尾 = 事件不平衡。把"调用已发出、结果不存在"的')
  console.log('     半本账复制给 child，child 会读到一个它无法解释的鬼状态。')

  // ── ③ fork child：继承上下文，能答出父对话内容 ──
  console.log('\n③ fork 一个 child，追问父对话内容（真实 LLM 回答）')
  const forkAnswer = await forkChild(seed, '父 agent 刚才说的 AI 部分用的是什么技术？请直接回答。')
  console.log(`   📨 fork child 回答：${clip(forkAnswer)}`)
  const forkKnows = /langchain|LangChain|langChain/i.test(forkAnswer)
  console.log(
    `   ${forkKnows ? '✅' : '❌'} fork child ${forkKnows ? '答出了继承的上下文' : '没能答出上下文'}（它有 seed，看得见父历史）`,
  )

  // ── ④ spawn child：同一追问，答不出继承内容 ──
  console.log('\n④ spawn 一个 child，问同一个追问（真实 LLM 回答）')
  const spawnAnswer = await spawnChild('父 agent 刚才说的 AI 部分用的是什么技术？请直接回答。')
  console.log(`   📨 spawn child 回答：${clip(spawnAnswer)}`)
  const spawnKnows = /langchain|LangChain|langChain/i.test(spawnAnswer)
  console.log(
    `   ${spawnKnows ? '❌ 意外：spawn 居然看见了父上下文' : '✅'} spawn child 答不出（它上下文是空的，只会照实说不知道）`,
  )
  console.log(
    '   → 同一个追问，两种哲学两种结果：追问必须 fork，独立任务必须 spawn（带上父上下文反而是污染）。',
  )

  // ── ⑤ 父日志的可见范围：只有 tool/call + tool/result ──
  console.log('\n⑤ 父日志只记录子代理的"调用 + 最终输出"，child 内部过程不进父日志')
  const childInternal = new Session()
  childInternal.append({ type: 'turn/start' })
  childInternal.append({ type: 'user/message', content: '审计登录接口' })
  childInternal.append({ type: 'tool/call', name: 'read_file', arguments: '{"path":"auth.ts"}' })
  childInternal.append({ type: 'tool/result', content: '找到 3 处问题' })
  childInternal.append({ type: 'assistant/message', content: '审计完成，3 处中危漏洞。' })
  childInternal.append({ type: 'turn/end' })
  // 父日志只追加两行：调用标记 + 最终输出
  parent.append({ type: 'tool/result', content: '审计完成，3 处中危漏洞。' })
  parent.append({ type: 'turn/end' })
  console.log('   child 内部 6 条事件（read_file 调用等）→ 父日志只追加 2 条：')
  console.log('     └─ tool/result（子代理最终输出）')
  console.log('     └─ turn/end（收尾）')
  console.log(`   父日志现在 ${parent.events.length} 条；child 内部 step 永远不会出现在父日志里`)

  console.log(
    '\n🎯 一句话：spawn 给独立任务一个干净的脑子，fork 给追问任务一本抄好的笔记——边界是最后一个 turn/end。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
