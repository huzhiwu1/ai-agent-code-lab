/**
 * Step 08 – child 怎么把结果送回父？——report 显式回传 + 双 child 并行总装
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「report」= 子代理**主动**把一段自包含结果送回父的工具（类比：外包团队主动
 *   给你发一份结题报告，你不去翻它的工作过程，它把结论送到你桌上）。
 * 「scope-local」= 一个注册只对特定作用域可见：report 工具只装在 continuable
 *   in-process child 里，roots/one-shot/远程 child 都看不到——可见性与权威一致。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：父靠"等 child 结束再读它的输出"拿结果。父需要"child 干到一半就能
 * 主动把进展/结论送过来"，且不能允许 child 乱投（孙代理直接捅到爷爷那）。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * reportFrom(child, content)：exact live child 是发送凭证，从持久 parentSession
 * 推导唯一接收者——API 上没有"选 recipient"的参数。嵌套汇报只跨一条边：
 * grandchild 只能报给 direct parent。report 不结束 turn、不结算 Activation。
 *
 * ── 本步在 8 步渐进里的位置 ─────────────────────────────────
 * step-07 长出了能持续存在的 child（Session/Activation）。本步给它长出最后一个
 * 能力——把结果送回去。完整的 8 步总装 demo 见 step-09。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 父在任意时刻收到 child 的主动回传；投递路径只有一条边，权限模型不可绕过。
 *
 * 跑法：pnpm run subagent:step:08（或 articles/dsh-subagent 内 pnpm run step:08）
 */

import { reportToolVisible, parentSummarize, type ChildScope } from './report'
import { SubagentRuntime } from './runtime'
import { clip } from '../../shared/clip'
import { naiveDemo } from './naive'

async function main(): Promise<void> {
  console.log('📮 Step 08 – report 显式回传 + 双 child 并行总装')
  console.log('='.repeat(62))

  // ── A. 对照组：隐式协议翻车现场 ──
  naiveDemo()

  // ── B. Harness 方案 ──
  console.log('\n── B. Harness 方案：注册表 + report 显式回传 ──')

  const runtime = new SubagentRuntime()
  const ROOT_ID = runtime.registerParent('root')

  // ── ① scope-local：report 工具只装在 continuable child ──
  console.log('\n① scope-local 安装：哪些作用域看得到 report 工具？')
  const scopes: { scope: ChildScope; who: string }[] = [
    { scope: 'root', who: '顶层 agent' },
    { scope: 'one-shot', who: '一次性 child' },
    { scope: 'continuable', who: 'continuable child' },
  ]
  for (const { scope, who } of scopes) {
    const visible = reportToolVisible(scope)
    console.log(`   ${visible ? '🟢' : '⛔'} ${who} → report 工具${visible ? '可见' : '不可见'}`)
  }

  // ── ② 并行派 2 child：fork（继承上下文）+ spawn（独立调研）──
  console.log('\n② 并行派 2 child：fork 继承上下文 + spawn 独立调研')
  const parentContext =
    '父 agent 正在写一份 DeepSeek Harness 源码精读系列的周报，本周完成了子代理编排章节。'
  const forkChildId = runtime.delegateContinuable(ROOT_ID)
  const spawnChildId = runtime.delegateOneShot(ROOT_ID)
  const forkHandle = runtime.getHandle(forkChildId)
  const spawnHandle = runtime.getHandle(spawnChildId)
  console.log(`   🍴 fork child ${forkChildId.slice(0, 8)}… 继承父上下文 → 写周报总结`)
  console.log(`   🧪 spawn child ${spawnChildId.slice(0, 8)}… 独立调研 → 解释"子代理"`)
  const [forkOutput, spawnOutput] = await Promise.all([
    forkHandle.runTask('基于这段父对话上下文，为周报写一句总结。', parentContext),
    spawnHandle.runTask('用一句话说明什么是"子代理"（独立调研，无父上下文）。', ''),
  ])
  console.log(`   📨 fork：${clip(forkOutput)}`)
  console.log(`   📨 spawn：${clip(spawnOutput)}`)

  // ── ③ child 各自调 report 回传结果 ──
  console.log('\n③ child 各自调 report 回传结果')
  const forkReport = runtime.report(forkChildId, `周报总结：${forkOutput}`)
  const spawnReport = runtime.report(spawnChildId, `调研结论：${spawnOutput}`)
  console.log(`   🍴 fork → direct parent = ${forkReport.parentId}（唯一接收者）`)
  console.log(`   🧪 spawn → direct parent = ${spawnReport.parentId}（唯一接收者）`)
  console.log('   → 接收者由持久 parentSession 推导，API 上没有"发给谁"的参数。')

  // ── ④ 父收件箱 + 真实 LLM 汇总 ──
  console.log('\n④ 父收件箱 + 真实 LLM 汇总')
  const reports = runtime.inbox(ROOT_ID)
  for (const r of reports) console.log(`   📥 ${r.senderId.slice(0, 8)}…：${clip(r.content)}`)
  const summary = await parentSummarize(reports.map(r => r.content))
  console.log(`   🧑‍💼 父 agent 总装汇总：${clip(summary)}`)

  // ── ⑤ 越级汇报被拒：嵌套汇报只跨一条边 ──
  console.log('\n⑤ 越级汇报被拒：嵌套汇报只跨一条边')
  const childAId = runtime.delegateContinuable(ROOT_ID)
  const grandchildId = runtime.delegateContinuable(childAId)
  console.log(
    `   🔗 root → childA(${childAId.slice(0, 8)}…) → grandchild(${grandchildId.slice(0, 8)}…)`,
  )
  const escalated = runtime.report(grandchildId, '我要直接向 root 汇报！')
  console.log(
    `   🚫 grandchild 的 report 到达：${escalated.parentId.slice(0, 8)}…（direct parent=childA，不是 root）`,
  )
  const rootInbox = runtime.inbox(ROOT_ID)
  const reachedRoot = rootInbox.some(r => r.senderId === grandchildId)
  console.log(
    `   ${reachedRoot ? '❌' : '✅'} root 收件箱里${reachedRoot ? '出现了' : '没有'} grandchild 的直接汇报`,
  )

  // ── ⑥ report 不结束 turn ──
  console.log('\n⑥ report 是协作控制，不结束 turn')
  const stillLive = ((): boolean => {
    try {
      runtime.report(forkChildId, '再报一条进展：总结已补充。')
      return true
    } catch {
      return false
    }
  })()
  console.log(`   ${stillLive ? '✅' : '❌'} report 后 fork child 仍然 live，可以继续报/继续干活`)

  // ── C. 🎯 一句话小结 ──
  console.log(
    '\n🎯 一句话：report 是 child 主动投给 direct parent 的自包含结果——单边、显式、不结束任何东西。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
