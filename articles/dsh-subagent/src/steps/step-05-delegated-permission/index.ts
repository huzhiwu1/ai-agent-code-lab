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
 * 人类用户在睡觉），这个审批就永远挂起：任务卡死 + 无人认领的待审批记录。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * captureDelegatedPolicyOverrides 在委托边界同步捕获，approvalPolicy**钉死'never'**
 * 快照写成 child log 持久事件（source:'delegation'），child 的 system prompt 带
 * delegation 声明（SUBAGENT_DELEGATION_CONTEXT）：权限已固定、要审批的操作自动拒绝。
 *
 * ── 本步在 8 步渐进里的位置 ─────────────────────────────────
 * step-04 讲的是"派多深"（递归预算），本步转向另一个维度：派出去时 child
 * 能干什么（权限）。demo 接回注册表体系：注册 provider → runtime.start 内部
 * 捕获快照 → child 干活 → 越权被确定性拒绝。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 越权请求被**确定性拒绝**而不是挂起；child 知道边界并会主动上报，而不是原地打转。
 *
 * 对应源码：packages/subagent/subagent/src/child-agent.ts
 * 跑法：pnpm run subagent:step:05（或 articles/dsh-subagent 内 pnpm run step:05）
 */

import { SubagentRuntime, SandboxedProvider } from './runtime'
import type { ParentAgent } from './policy'
import { decide } from './approval'
import { clip } from '../../shared/clip'
import { naiveDemo } from './naive'

async function main(): Promise<void> {
  console.log('🔒 Step 05 – 委托即权限快照：后台 child 的审批钉死 never')
  console.log('='.repeat(62))

  // ── A. 对照组：继承 ask → 死锁现场 ──
  naiveDemo()

  // ── B. Harness 方案：注册表 + 权限快照 ──
  console.log('\n── B. Harness 方案：注册表接入权限快照 ──')

  const runtime = new SubagentRuntime()
  runtime.registerProvider(new SandboxedProvider('sandboxed'))
  const parent: ParentAgent = { id: 'root', explicitSandboxOverride: 'workspace-write' }

  // ── ① 注册表派 child：runtime.start() 内部做三件事 ──
  console.log('\n① 注册 provider 后派 child（runtime.start 内部三步）')
  console.log('   父 agent：sandbox=workspace-write')
  console.log('   runtime.start() 内部：')
  console.log('     a. captureDelegatedPolicyOverrides → sandbox 继承 + approval 钉死 never')
  console.log('     b. appendDelegatedPolicyOverrides → 写进 child log（source=delegation）')
  console.log('     c. provider.start() → child 真实 LLM 干活')
  const run = await runtime.start('sandboxed', parent, '用一句话总结你的权限状态并报告任务完成。')
  console.log(`   📨 child 回答：${clip((await run.result).output)}`)
  console.log(`   🔍 approvalPolicy = ${run.overrides.approvalPolicy}（钉死）`)
  console.log(`   🔍 sandboxMode    = ${run.overrides.sandboxMode}（继承父的显式 override）`)

  // ── ② 快照已写进 child log（持久事件，cold resume 回放它）──
  console.log('\n② child log 上的持久事件（cold resume / fork seed 回放它）')
  for (const e of run.childSession.events) {
    console.log(`   📜 ${e.type} → ${JSON.stringify(e.payload)}`)
  }
  console.log('   → source="delegation" 标记：fork seed 里的陈旧父策略会输给这份新快照')

  // ── ③ 越权操作：policy='never' 确定性拒绝 ──
  console.log('\n③ child 尝试越权操作（改 sandbox 模式 = 需要审批）')
  const decision = decide(
    run.overrides.approvalPolicy ?? 'ask',
    '把 sandbox 模式改为 danger-full-access',
  )
  console.log(`   ❌ ${decision.reason}`)
  console.log('   → 拒绝是**确定性的**：不等人、不排队、不悬挂。child 立刻知道边界在哪。')

  // ── ④ delegation 声明真的被 LLM 遵循 ──
  console.log('\n④ delegation 声明生效：真实 LLM 回答"需要更宽权限怎么办"')
  const run2 = await runtime.start(
    'sandboxed',
    parent,
    '你的任务需要访问一个你无权访问的机密文件。你会怎么回复我？',
  )
  const limited = (await run2.result).output
  console.log(`   📨 child 回答：${clip(limited)}`)
  const follows = /重试|再试/.test(limited) === false && /限制|无法|不能|父|上报|处理/.test(limited)
  console.log(
    `   ${follows ? '✅' : '❌'} child ${follows ? '说明限制而非重试（声明生效）' : '行为偏离声明'}`,
  )

  // ── C. 🎯 一句话小结 ──
  console.log(
    '\n🎯 一句话：委托即快照——权限固化在边界上，后台 child 要么在权限内，要么被确定性拒绝，没有第三种状态。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
