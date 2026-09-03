/**
 * Step 05 – 委托即权限快照：为什么子代理的审批要钉死 'never'？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「权限快照」= 委托发生的那一刻，把父的权限状态"拍一张照"固化给 child；
 *   之后父再改权限，属于父的未来，与这个 child 无关（类比：你给访客办的
 *   门禁卡是**办卡时**的权限，之后你把门禁改了指纹，那张卡还是那张卡）。
 * 「审批升级」= agent 想干一件超出当前权限的事时，请求"升级权限"（类比：
 *   实习生想动生产数据库，系统弹出"请上级批准"）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：子代理继承父的审批策略。父是 'ask'（有事问人），child 也是 'ask'。
 * 但 child 是**后台**跑的——它弹出一个"请批准"却没人看（父 agent 不在 UI 前，
 * 人类用户在睡觉），这个审批就永远挂起：任务卡死，还造出一个"无人认领的
 * 待审批"状态。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 与其给后台 child 造一套"看得见的审批"机制，不如让这个状态**不可能出现**：
 * captureDelegatedPolicyOverrides 在委托边界同步捕获父的显式 sandbox override，
 * 并把 approvalPolicy **钉死 'never'**（不读父的策略）。快照写成 child 自己
 * log 上的持久事件（sandbox/mode + approval/policy，source: 'delegation'），
 * cold resume 回放它、fork seed 的陈旧父策略输给它。同时 child 的 system
 * prompt 里有一条 delegation 声明（SUBAGENT_DELEGATION_CONTEXT）：权限已固定、
 * 要审批的操作自动拒绝、需要更宽权限就报限制给父、别重试。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 越权请求被**确定性拒绝**而不是挂起；child 知道边界并会主动上报，而不是原地打转。
 *
 * 对应源码：packages/subagent/subagent/src/child-agent.ts
 *   （captureDelegatedPolicyOverrides L199-204 / appendDelegatedPolicyOverrides L215-225 /
 *   SUBAGENT_DELEGATION_CONTEXT L135-139）
 * 跑法：pnpm run subagent:step:05（或 articles/dsh-subagent 内 pnpm run step:05）
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

// ── 1. 类型与机制（对应源码 child-agent.ts）─────────────────────

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
type ApprovalPolicy = 'never' | 'ask'

/** 委托边界捕获的权限快照（对应源码 DelegatedPolicyOverrides L178-187） */
interface DelegatedPolicyOverrides {
  /** 父 session 的显式 sandbox override；父没有显式 override 则 undefined */
  readonly sandboxMode: SandboxMode | undefined
  /** 只要审批服务存在就钉死 'never'——后台 child 的审批升级是"没人看的阻塞" */
  readonly approvalPolicy: 'never' | undefined
}

/** 简化父 agent：session 上带一个"显式 sandbox override" */
interface ParentAgent {
  readonly id: string
  /** 显式 override：只有父自己主动设置过才有值（对应源码 overrideOf） */
  readonly explicitSandboxOverride: SandboxMode | undefined
}

/** 简化子代理 session：append-only 日志（记录 delegation 事件，供 cold resume 回放） */
class ChildSession {
  private log: { type: string; payload: unknown }[] = []

  append(type: string, payload: unknown): void {
    this.log.push({ type, payload })
  }

  get events(): readonly { type: string; payload: unknown }[] {
    return this.log
  }
}

/**
 * 委托边界同步捕获权限快照（对应源码 captureDelegatedPolicyOverrides L199-204）。
 * 只捕获父的**显式** sandbox override（不捕获部署默认值/一次性授权）；
 * approval 不管父是什么策略，一律钉死 'never'。
 */
function captureDelegatedPolicyOverrides(parent: ParentAgent): DelegatedPolicyOverrides {
  return {
    sandboxMode: parent.explicitSandboxOverride,
    // 钉死 'never'：不读父的 approval 策略——父在 UI 前有'ask'的意义，后台 child 没有
    approvalPolicy: 'never',
  }
}

/**
 * 把快照写成 child 自己 log 上的持久事件（对应源码 appendDelegatedPolicyOverrides L215-225）。
 * source: 'delegation' 标记"这份策略来自委托快照"，cold resume 回放它、
 * fork seed 里可能携带的陈旧父策略输给它（追加在 seed 之后，新策略赢）。
 */
function appendDelegatedPolicyOverrides(
  childSession: ChildSession,
  overrides: DelegatedPolicyOverrides,
): void {
  if (overrides.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' })
  }
  if (overrides.approvalPolicy !== undefined) {
    childSession.append('approval/policy', {
      policy: overrides.approvalPolicy,
      source: 'delegation',
    })
  }
}

/**
 * child system prompt 里的 delegation 声明（对应源码 SUBAGENT_DELEGATION_CONTEXT L135-139）。
 * 逐句对应源码：
 *   - 权限范围在启动时就固定，会话内无法自行扩大
 *   - 需要审批的操作会被自动拒绝
 *   - 任务需要超出范围的访问时，不要重试被拒操作，在回复里说明限制，让父 agent 处理
 */
const SUBAGENT_DELEGATION_CONTEXT =
  '你是一个被委托的子代理：你的权限范围在启动时已固定，无法从会话内部自行扩大——' +
  '需要审批的操作会被自动拒绝。当任务需要超出此范围的访问时，不要重试被拒操作；' +
  '在回复中说明限制，让委托你的父 agent 来处理。'

// ── 2. 简化审批服务：decide 只认 policy ─────────────────────────

type ApprovalDecision =
  | { kind: 'denied'; reason: string } // never：确定性拒绝
  | { kind: 'pending'; reason: string } // ask：挂起等人看（后台没人看！）

/** 极简审批裁决（真实 ApprovalService 的简化替身） */
function decide(policy: ApprovalPolicy, operation: string): ApprovalDecision {
  if (policy === 'never') {
    return {
      kind: 'denied',
      reason: `审批策略='never'：操作「${operation}」被自动拒绝（要审批的操作在此会话不可用）`,
    }
  }
  return {
    kind: 'pending',
    reason: `审批策略='ask'：操作「${operation}」已提交，等待人类批准……`,
  }
}

// ── 3. 真实 LLM 执行 child 任务（system 带 delegation 声明）────────

async function childLlm(task: string): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  const reply = await llm.invoke([
    new SystemMessage(SUBAGENT_DELEGATION_CONTEXT),
    new HumanMessage(task),
  ])
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

function clip(text: string, max = 70): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

async function main(): Promise<void> {
  console.log('🔒 Step 05 – 委托即权限快照：后台 child 的审批钉死 never')
  console.log('='.repeat(62))

  // ── ① 父 agent：有显式 sandbox override ──
  const parent: ParentAgent = { id: 'root', explicitSandboxOverride: 'workspace-write' }
  console.log(
    '\n① 父 agent 的状态：显式 sandbox override = workspace-write，审批策略 = ask（人在 UI 前）',
  )

  // ── ② 委托边界：同步捕获快照 ──
  console.log('\n② 委托发生：同步捕获权限快照（captureDelegatedPolicyOverrides）')
  const overrides = captureDelegatedPolicyOverrides(parent)
  console.log(`   🔍 sandboxMode    = ${overrides.sandboxMode}（继承父的显式 override）`)
  console.log(`   🔍 approvalPolicy = ${overrides.approvalPolicy}（不读父的 'ask'，钉死 'never'）`)
  console.log('   → 为什么钉死：child 在后台跑，审批升级 = 没人看的阻塞。')
  console.log('     与其造"后台审批可见性"机制，不如让"挂起"这个状态不可能出现。')

  // ── ③ 快照写进 child log：source='delegation' 的持久事件 ──
  console.log('\n③ 快照写成 child 自己 log 上的持久事件（cold resume 回放它）')
  const childSession = new ChildSession()
  appendDelegatedPolicyOverrides(childSession, overrides)
  for (const e of childSession.events) {
    console.log(`   📜 ${e.type} → ${JSON.stringify(e.payload)}`)
  }
  console.log('   → source="delegation" 标记来源：fork seed 里的陈旧父策略会输给这份新快照')

  // ── ④ 权限内任务：child 真实 LLM 干活，正常完成 ──
  console.log('\n④ child 执行权限内任务（真实 LLM，system 带 delegation 声明）')
  const okAnswer = await childLlm(
    '用一句话总结你的权限状态，然后正常完成任务：把"权限内操作成功"报告给我。',
  )
  console.log(`   📨 child 回答：${clip(okAnswer)}`)
  console.log('   ✅ 权限内操作畅通无阻')

  // ── ⑤ 越权操作：policy='never' 确定性拒绝 ──
  console.log('\n⑤ child 尝试越权操作（改 sandbox 模式 = 需要审批）')
  const decision = decide(
    overrides.approvalPolicy ?? 'ask',
    '把 sandbox 模式改为 danger-full-access',
  )
  console.log(`   ❌ ${decision.reason}`)
  console.log('   → 拒绝是**确定性的**：不等人、不排队、不悬挂。child 立刻知道边界在哪。')

  // ── ⑥ 对比：如果继承父的 'ask' 会发生什么 ──
  console.log('\n⑥ 对比：假设没钉死 never，child 继承了父的 ask')
  const inherited: ApprovalDecision = decide('ask', '把 sandbox 模式改为 danger-full-access')
  console.log(`   ⏳ ${inherited.reason}`)
  console.log(
    '   → 这个 pending 会被谁批准？父 agent 没有审批 UI，人类用户看不到后台 child 的弹窗。',
  )
  console.log('     结果：任务永久卡死 + 一条无人认领的待审批记录——比拒绝糟糕得多。')

  // ── ⑦ delegation 声明真的被 LLM 遵循：真实行为演示 ──
  console.log('\n⑦ delegation 声明生效：让 child 真实 LLM 回答"需要更宽权限怎么办"')
  const limited = await childLlm('你的任务需要访问一个你无权访问的机密文件。你会怎么回复我？')
  console.log(`   📨 child 回答：${clip(limited)}`)
  const follows = /重试|再试/.test(limited) === false && /限制|无法|不能|父|上报|处理/.test(limited)
  console.log(
    `   ${follows ? '✅' : '❌'} child ${follows ? '说明限制而非重试（声明生效）' : '行为偏离声明（检查提示词）'}`,
  )

  console.log(
    '\n🎯 一句话：委托即快照——权限固化在边界上，后台 child 要么在权限内，要么被确定性拒绝，没有第三种状态。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
