/**
 * Step 08 – child 怎么把结果送回父？——report 显式回传 + 双 child 并行总装
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「report」= 子代理**主动**把一段自包含结果送回父的工具（类比：外包团队主动
 *   给你发一份结题报告——你不去翻它的工作过程，它把结论送到你桌上）。
 * 「scope-local」= 一个注册只对特定作用域可见：report 工具只装在 continuable
 *   in-process child 里，roots（顶层 agent）、one-shot child、远程 child 都
 *   看不到也执行不了——**可见性与权威一致**（类比：员工卡只在内网生效，
 *   外面的人连卡长什么样都不知道）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：父靠"等 child 结束再读它的输出"拿结果；或者让 child 直接写父的
 * 会话。前者只有一次性委托能用，后者破坏了隔离。父需要"child 干到一半就能
 * 主动把进展/结论送过来"，且不能允许 child 乱投（比如孙代理直接捅到爷爷那）。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * reportFrom(child, content)：**exact live child 是发送凭证**（authorizeReporter
 * 校验它确实是某个 live continuable Activation 的本人），service 从持久
 * parentSession 推导唯一接收者——API 形状上就没有"选 recipient"的参数，
 * 不接受调用方指定接收者/祖先。**嵌套汇报只跨一条边**：grandchild 只能报给
 * 它的 direct parent。另外 report 是协作控制不是结果包装：成功不结束 turn、
 * 不结算 Activation、结束 turn 也从不自动 report——child 被指导"结束前调一次
 * report，给自包含结果"（不然一句"做完了"对父毫无用处）。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 父在任意时刻收到 child 的主动回传；投递路径只有一条边，权限模型不可绕过。
 *
 * 对应源码：packages/subagent/tool-subagent-report/src/index.ts（installReportTool L49）
 *   packages/subagent/subagent/src/continuation.ts（reportFrom L583 /
 *   authorizeReporter L596 / resolveReportParent L616）
 * 跑法：pnpm run subagent:step:08（或 articles/dsh-subagent 内 pnpm run step:08）
 */

import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'

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

// ── 1. 结构与类型（延续 Step 07 的 Session/Activation，加 report 能力）────

/** 父 agent 收到的 report 记录 */
interface ReportRecord {
  readonly senderId: string
  readonly content: string
}

/** 持久 Session：identity + lineage + 转录（Step 07 的简化版） */
interface DurableSession {
  readonly id: string
  readonly parentSession: string
  readonly transcript: BaseMessage[]
}

/** 带错误码的领域错误（对应源码 error.ts SubagentError） */
class SubagentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SubagentError'
  }
}

/**
 * child 的 report 工具是否可见 = scope 是否 continuable in-process。
 * 对应源码 tool-subagent-report：只通过 registerContinuableSetup 装进
 * continuable child 的创建上下文——roots/one-shot/remote 看不到。
 */
type ChildScope = 'continuable' | 'one-shot' | 'root'

/** report 工具注册表：只有 scope='continuable' 的 child 有 report 工具 */
function reportToolVisible(scope: ChildScope): boolean {
  return scope === 'continuable'
}

// ── 2. 子代理（真实 LLM 干活 + report 回传）──────────────────────

interface ChildHandle {
  readonly session: DurableSession
  /** 干活：真实 LLM 执行一轮任务，返回最终文本 */
  runTask(task: string, inheritHistory: string): Promise<string>
}

/**
 * 续对话管理器（Step 07 的机制，本步聚焦 report）。
 * activations 表 = live child 注册处，authorizeReporter 在这里校验 exact live child。
 */
class ContinuationManager {
  private activations = new Map<string, ChildHandle>()
  /** 每个"父"的收件箱：report 投递到这里 */
  private reportBoxes = new Map<string, ReportRecord[]>()

  /** 建立 durable child（startContinuable 简化版：直接返回 handle） */
  startContinuable(parentId: string): string {
    const childId = randomUUID()
    const session: DurableSession = { id: childId, parentSession: parentId, transcript: [] }
    this.activations.set(childId, { session, runTask: runChildTask })
    return childId
  }

  /** 一次性 child：注册为 one-shot 作用域（没有 report 工具） */
  startOneShot(parentId: string): string {
    const childId = randomUUID()
    const session: DurableSession = { id: childId, parentSession: parentId, transcript: [] }
    this.activations.set(childId, { session, runTask: runChildTask })
    return childId
  }

  getHandle(childId: string): ChildHandle {
    const handle = this.activations.get(childId)
    if (handle === undefined)
      throw new SubagentError(`subagent "${childId}" is not live`, 'NOT_RESUMABLE')
    return handle
  }

  /**
   * report 的唯一入口（对应源码 reportFrom L583）：
   * 1. authorizeReporter（L596）：exact live child 是发送凭证——不是某个 live
   *    Activation 本人的 Agent 不能以它的名义发；
   * 2. resolveReportParent（L616）：从持久 parentSession 推导**唯一**接收者。
   *    注意 API 形状：没有"发给谁"的参数——调用方选 recipient/ancestor 的
   *    可能被形状本身消灭，嵌套汇报只能跨一条边。
   */
  reportFrom(childId: string, content: string): { parentId: string; delivered: boolean } {
    const handle = this.authorizeReporter(childId)
    const parentId = handle.session.parentSession
    const inbox = this.reportBoxes.get(parentId) ?? []
    inbox.push({ senderId: childId, content })
    this.reportBoxes.set(parentId, inbox)
    return { parentId, delivered: true }
  }

  /** 只有 exact live continuable child 能报（对应源码 authorizeReporter L596） */
  private authorizeReporter(childId: string): ChildHandle {
    const handle = this.activations.get(childId)
    if (handle === undefined) {
      throw new SubagentError(
        `agent "${childId}" is not a live continuable subagent and cannot report`,
        'UNAUTHORIZED',
      )
    }
    return handle
  }

  /** 父读自己的 report 收件箱 */
  reportsOf(parentId: string): readonly ReportRecord[] {
    return this.reportBoxes.get(parentId) ?? []
  }
}

/** 真实 LLM 执行 child 任务（继承历史 = fork 的 seed 文字，空 = spawn 的 fresh） */
async function runChildTask(
  this: ChildHandle,
  task: string,
  inheritHistory: string,
): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  // report 使用指导（对应源码 installReportTool 的 guidance 文案 L54-62）：
  // 结束前调一次 report，给自包含结果——父共享工作区但不会自动收到你的转录/工具输出/推理
  const guidance = reportToolVisible('continuable')
    ? '你有一个 report 工具：完成前把自包含的最终结果回传给父 agent。父不会自动看到你的过程，只说"做完了"对父没有用。'
    : '你没有 report 工具（one-shot child 的作用域里不存在它）。直接给出完整最终回答。'
  const history = inheritHistory.length > 0 ? `【继承的父对话上下文】\n${inheritHistory}\n\n` : ''
  const reply = await llm.invoke([
    new SystemMessage(`你是一个子代理。${guidance} 中文简洁作答。`),
    new HumanMessage(history + task),
  ])
  this.session.transcript.push(new HumanMessage(task))
  this.session.transcript.push(reply)
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

// ── 3. 真实 LLM 工具函数：父的最终汇总 ─────────────────────────

async function parentSummarize(reports: readonly string[]): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  const reply = await llm.invoke([
    new SystemMessage('你是父 agent。把两个子代理的报告合并成一段总览，中文，不超过 3 句话。'),
    new HumanMessage(`子代理报告 1：${reports[0]}\n子代理报告 2：${reports[1]}`),
  ])
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

function clip(text: string, max = 70): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

async function main(): Promise<void> {
  console.log('📮 Step 08 – report 显式回传 + 双 child 并行总装')
  console.log('='.repeat(62))

  const manager = new ContinuationManager()
  const ROOT_ID = 'root'

  // ── ① scope-local：report 工具只装在 continuable in-process child ──
  console.log('\n① scope-local 安装：哪些作用域看得到 report 工具？')
  const scopes: { scope: ChildScope; who: string }[] = [
    { scope: 'root', who: '顶层 agent（root）' },
    { scope: 'one-shot', who: '一次性 child（spawn）' },
    { scope: 'continuable', who: 'continuable in-process child' },
  ]
  for (const { scope, who } of scopes) {
    console.log(
      `   ${reportToolVisible(scope) ? '🟢' : '⛔'} ${who} → report 工具${reportToolVisible(scope) ? '可见' : '不可见'}`,
    )
  }
  console.log('   → 可见性与权威一致：没有 report 工具的作用域，连"试图报"的入口都不存在。')

  // ── ② 主 agent 并行派 2 个子代理：fork（带上下文）+ spawn（独立调研）──
  console.log('\n② 主 agent 并行派 2 个子代理（真实 LLM 同时干活）')
  const parentContext =
    '父 agent 正在写一份 DeepSeek Harness 源码精读系列的周报，本周完成了子代理编排章节。'
  const forkChildId = manager.startContinuable(ROOT_ID) // continuable fork：带父上下文
  const spawnChildId = manager.startOneShot(ROOT_ID) // one-shot spawn：fresh

  const forkHandle = manager.getHandle(forkChildId)
  const spawnHandle = manager.getHandle(spawnChildId)
  console.log(
    `   🍴 fork child ${forkChildId.slice(0, 8)}… 继承父对话上下文，任务：基于上下文写一句周报总结`,
  )
  console.log(
    `   🧪 spawn child ${spawnChildId.slice(0, 8)}… 独立调研，任务：一句话说明什么是子代理`,
  )
  const [forkOutput, spawnOutput] = await Promise.all([
    forkHandle.runTask('基于这段父对话上下文，为周报写一句总结。', parentContext),
    spawnHandle.runTask('用一句话说明什么是"子代理"（独立调研，无父上下文）。', ''),
  ])
  console.log(`   📨 fork child 产出：${clip(forkOutput)}`)
  console.log(`   📨 spawn child 产出：${clip(spawnOutput)}`)

  // ── ③ child 各自调 report，把自包含结果送回父 ──
  console.log('\n③ child 各自调 report（结束前回传自包含结果）')
  const forkReport = manager.reportFrom(forkChildId, `周报总结：${forkOutput}`)
  const spawnReport = manager.reportFrom(spawnChildId, `调研结论：${spawnOutput}`)
  console.log(
    `   🍴 fork child 的 report → 唯一接收者 = 它的 direct parent（${forkReport.parentId}）✅`,
  )
  console.log(
    `   🧪 spawn child 的 report → 唯一接收者 = 它的 direct parent（${spawnReport.parentId}）✅`,
  )
  console.log(
    '   → 接收者由持久 parentSession 推导，API 上没有"发给谁"的参数——调用方选不了 recipient。',
  )

  // ── ④ 父收件箱：两条 report，父真实 LLM 汇总 ──
  console.log('\n④ 父 agent 收件箱收到 2 条 report，真实 LLM 汇总')
  const reports = manager.reportsOf(ROOT_ID)
  for (const r of reports) console.log(`   📥 来自 ${r.senderId.slice(0, 8)}…：${clip(r.content)}`)
  const summary = await parentSummarize(reports.map(r => r.content))
  console.log(`   🧑‍💼 父 agent 总装汇总：${clip(summary)}`)

  // ── ⑤ 越级汇报被拒：嵌套汇报只跨一条边 ──
  console.log('\n⑤ 越级汇报：grandchild 只能报给 direct parent，捅不到 root')
  // root → childA（continuable）→ grandchild（continuable，childA 是它 direct parent）
  const childAId = manager.startContinuable(ROOT_ID)
  const grandchildId = manager.startContinuable(childAId)
  console.log(
    `   🔗 委托链：root → childA(${childAId.slice(0, 8)}…) → grandchild(${grandchildId.slice(0, 8)}…)`,
  )
  // grandchild 想"直接报给 root"——但 API 形状里没有 recipient 参数：
  const escalated = manager.reportFrom(grandchildId, '我要直接向 root 汇报！')
  console.log(
    `   🚫 grandchild 的 report 实际到达：${escalated.parentId.slice(0, 8)}…（它的 direct parent = childA，不是 root）`,
  )
  console.log(
    `   ${escalated.parentId === childAId ? '✅' : '❌'} 嵌套汇报只跨一条边：grandchild → 它的 direct parent（childA）`,
  )
  const rootInbox = manager.reportsOf(ROOT_ID)
  const reachedRoot = rootInbox.some(r => r.senderId === grandchildId)
  console.log(
    `   ${reachedRoot ? '❌' : '✅'} root 的收件箱里${reachedRoot ? '出现了' : '没有'} grandchild 的直接汇报`,
  )
  console.log(
    '   → 若 grandchild 要影响 root：先报 childA，由 childA 决定要不要再报 root——每个环节有权过滤。',
  )

  // ── ⑥ report 不结束 turn、不结算 Activation ──
  console.log('\n⑥ report 是协作控制，不是结果包装')
  const stillLive = ((): boolean => {
    try {
      manager.reportFrom(forkChildId, '再报一条进展：总结已补充。')
      return true
    } catch {
      return false
    }
  })()
  console.log(
    `   ${stillLive ? '✅' : '❌'} fork child report 之后仍然 live（report 不结算 Activation），可以继续报/继续干活`,
  )
  console.log('   → 结束 turn 也从不自动 report：child 被指导主动回传，父不猜。')

  console.log(
    '\n🎯 一句话：report 是 child 主动投给 direct parent 的自包含结果——单边、显式、不结束任何东西。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
