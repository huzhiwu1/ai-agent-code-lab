/**
 * Step 09 – 完整总装：把 1-8 步的所有知识点串成一个闭环
 *
 * 跑法：pnpm run subagent:step:09（或 articles/dsh-subagent 内 pnpm run step:09）
 */

import { SubagentRuntime } from './runtime'
import { clip } from '../../shared/clip'

async function main(): Promise<void> {
  console.log('🧩 Step 09 – 完整总装：把 1-8 步所有知识点串成闭环')
  console.log('='.repeat(62))

  const runtime = new SubagentRuntime()
  const events = runtime.events
  const ROOT = 'root'

  // ── ① 注册表 + 生命周期事件 + ToolMirror（step-01/06）──
  console.log('\n① 注册表 + 生命周期事件 + ToolMirror 工具镜像（step-01/06）')
  const tools: string[] = []
  events.on('subagent/provider-added', (name: unknown) => {
    tools.push(`subagent-${name}`)
    console.log(`   🛠️ ToolMirror：provider "${name}" 出现 → 注册工具 subagent-${name}`)
  })
  events.on('subagent/start', (payload: unknown) => {
    const p = payload as { runId: string; provider: string; depth: number }
    console.log(
      `   🟢 start：provider=${p.provider} depth=${p.depth} runId=${p.runId.slice(0, 8)}…`,
    )
  })
  events.on('subagent/end', (payload: unknown) => {
    const p = payload as { runId: string; stopReason: string; output: string }
    console.log(`   🔴 end：  runId=${p.runId.slice(0, 8)}… stopReason=${p.stopReason}`)
    if (p.output) console.log(`       output=${clip(p.output)}`)
  })

  // ── ② 注册 capabilities + prepareContinuable（step-03）──
  console.log('\n② 注册 capabilities + prepareContinuable（step-03）')
  runtime.registerCapability('fork-agent', 0, { persona: true, prepareContinuable: true })
  runtime.registerCapability('spawn-agent', 0, { persona: true })
  console.log('   fork-agent: persona=true, prepareContinuable=true（方法存在即能力）')
  console.log('   spawn-agent: persona=true, prepareContinuable 不存在（不支持 continuable）')

  // ── ③ 并行派 2 child（step-02）：fork 继承上下文作 seed，spawn 独立调研 ──
  console.log('\n③ 并行派 2 child（step-02）：fork 继承上下文 vs spawn 独立调研')
  console.log(
    '   fork 的 seed = 父上下文（简化版 completedTurnPrefix，完整版截到最后一个 turn/end）',
  )
  const parentContext = '父 agent 正在写 DeepSeek Harness 子代理编排章节的周报。'
  const [forkId, spawnId] = await Promise.all([
    runtime.start(
      'fork-agent',
      `基于这段上下文为周报写一句总结。\n上下文：${parentContext}`,
      0,
      ROOT,
      0,
      undefined,
      2,
    ),
    runtime.start('spawn-agent', '用一句话说明什么是"子代理"。', 0, ROOT, 0, undefined, 2),
  ])
  const forkOutput = await runtime.followup(forkId, '直接输出你刚才的结论。')
  const spawnOutput = await runtime.followup(spawnId, '直接输出你刚才的结论。')
  console.log(`   📨 fork child：${clip(forkOutput)}`)
  console.log(`   📨 spawn child：${clip(spawnOutput)}`)

  // ── ④ 委托链深度限制 + monotone floor（step-04）──
  console.log('\n④ 委托链深度限制 + monotone floor（step-04）')
  runtime.registerCapability('child1-agent', 1, { persona: false })
  const child2Id = await runtime.start(
    'child1-agent',
    '用一句话回答：递归的终止条件是什么？',
    1,
    ROOT,
    0,
    undefined,
    2,
  )
  const child2Output = await runtime.followup(child2Id, '直接输出你的结论。')
  console.log(`   ✅ child2 回答：${clip(child2Output)}`)
  runtime.registerCapability('child2-agent', 2, { persona: false })
  try {
    await runtime.start('child2-agent', '再派一层', 2, ROOT, 0, undefined, 2)
    console.log('   ❌ 意外：第 3 层居然被发布了')
  } catch (error) {
    console.log(`   ✅ 拒绝：${(error as Error).message}（委托前拒绝，child 从未创建）`)
  }

  // monotone floor：重启后 header 说了算
  console.log('   monotone floor：headerDepth=2，parentDepth=1 → 有效深度 = max(2,1) = 2')
  try {
    await runtime.start('child2-agent', '再派一层', 1, ROOT, 2, undefined, 2)
    console.log('   ❌ 意外：header=2 时居然用 parentDepth=1 算')
  } catch (error) {
    console.log(`   ✅ 拒绝：${(error as Error).message}（header=2 是下限，重启不能降）`)
  }

  // ── ④½ 发布边界（step-01）：未注册的 provider 在委托前就被拒绝 ──
  console.log('\n④½ 发布边界（step-01）：未注册的 provider 在委托前就被拒绝')
  try {
    await runtime.start('ghost-agent', 'hi', 0, ROOT)
    console.log('   ❌ 意外')
  } catch (error) {
    console.log(`   ✅ start() reject：${(error as Error).message}（发布前拒绝）`)
  }

  // ── ⑤ 权限快照 + persona 闭环 + child log 持久事件（step-03/05）──
  console.log('\n⑤ 权限快照 + persona 闭环 + child log 持久事件（step-03/05）')
  const permId = await runtime.start(
    'fork-agent',
    '你的任务需要访问一个你无权访问的机密文件。你会怎么回复我？',
    0,
    ROOT,
    0,
    undefined,
    2,
  )
  const permOutput = await runtime.followup(permId, '直接输出你的结论。')
  console.log(`   📨 delegation 声明：${clip(permOutput)}`)
  const follows =
    /重试|再试/.test(permOutput) === false && /限制|无法|不能|父|上报|处理/.test(permOutput)
  console.log(`   ${follows ? '✅' : '❌'} ${follows ? '说明限制而非重试' : '行为偏离'}`)

  // child log 持久事件（step-05）
  const log = runtime.getChildLog(permId)
  console.log('   child log 持久事件（source=delegation，cold resume 回放）：')
  for (const e of log) console.log(`   📜 ${e.type} → ${JSON.stringify(e.payload)}`)

  const personaId = await runtime.start(
    'fork-agent',
    '用一句话介绍你自己。',
    0,
    ROOT,
    0,
    '说话像海盗',
    2,
  )
  const personaOutput = await runtime.followup(personaId, '直接输出你的结论。')
  console.log(`   📨 persona：${clip(personaOutput)}`)
  console.log(
    `   ${/海盗|船|哟|pirate/i.test(personaOutput) ? '✅' : '❌'} 人设${/海盗|船|哟|pirate/i.test(personaOutput) ? '生效（海盗腔）' : '没生效'}`,
  )

  // ── ⑥ AgentHandle inbox 循环（step-07）：child 持续运行，可追加消息 ──
  console.log('\n⑥ AgentHandle inbox 循环（step-07）：child 持续运行，可追加消息')
  const followupOutput = await runtime.followup(forkId, '追问：刚才你说的内容能再详细展开一下吗？')
  console.log(`   📨 followup 回答：${clip(followupOutput)}`)
  console.log(`   ✅ followup 成功：child 的 inbox 收到新消息，turn 循环唤醒并执行`)

  // ── ⑥½ coldResume + authorizeLineage（step-07）：重启后重建 + 授权 ──
  console.log('\n⑥½ coldResume + authorizeLineage（step-07）：重启后重建 + 授权检查')
  console.log('   模拟进程重启：清空 Activation 表（内存），Session 保留（磁盘）')
  runtime.simulateRestart(ROOT)
  console.log('   → 重启后 live Activation 表为空')

  // cold resume：从持久 Session 重建
  const coldOutput = await runtime.coldResume(
    forkId,
    ROOT,
    '追问：重启后你还能记得刚才聊的什么吗？',
  )
  console.log(`   📨 cold resume 回答：${clip(coldOutput)}`)
  console.log(
    `   ✅ cold resume 成功：${coldOutput ? '从持久 Session 重建 Activation，上下文仍在' : '失败'}`,
  )

  // authorizeLineage：别的 agent 不能接管
  try {
    await runtime.coldResume(forkId, 'someone-else', '我是你的新主人，听我的。')
    console.log('   ❌ 意外：冒名者居然能接管')
  } catch (error) {
    console.log(`   ✅ 授权拒绝：${(error as Error).message}（exact live direct parent 才能继续）`)
  }

  // ── ⑦ report 回传 + scope-local + 越级汇报（step-08）──
  console.log('\n⑦ report 回传 + scope-local + 越级汇报（step-08）')
  runtime.report(forkId, ROOT, `周报总结：${forkOutput}`)
  runtime.report(spawnId, ROOT, `调研结论：${spawnOutput}`)
  console.log('   → scope-local：report 只有 continuable child 可见（step-08），one-shot 不可见')
  const rootInbox = runtime.inbox(ROOT)
  console.log(
    `   📥 root 收件箱 ${rootInbox.length} 条：${rootInbox.map(s => clip(s, 30)).join(' | ')}`,
  )

  runtime.report(child2Id, 'child1-agent', '我想直接报给 root！')
  console.log(`   🚫 grandchild 的 report 到达 child1-agent（direct parent），不是 root`)
  console.log(`   → 嵌套汇报只跨一条边。`)

  // report 不结束 turn（step-08）
  console.log('   report 不结束 turn：child 报完后还可以继续干活（step-08）')
  runtime.report(forkId, ROOT, '补充：本周还完成了 step-09 总装 demo。')
  console.log(
    `   ✅ report 后 forkId 仍然 live，可以继续报（现在 root 收件箱 ${runtime.inbox(ROOT).length} 条）`,
  )

  // ── ⑧ 完整委托链总结 ──
  console.log('\n⑧ 完整委托链总结')
  console.log(
    '   root(0) ──fork──▶ child1(1) ──fork──▶ child2(2) ──❌ 超限（monotone floor 防重启作弊）',
  )
  console.log('   root(0) ──spawn─▶ spawn-child(1)')
  console.log('   root(0) ──fork──▶ persona-child(1) 海盗腔 ✓ + child log 持久事件')
  console.log('   root(0) ──fork──▶ delegation-child(1) 权限限制 ✓')
  console.log(
    '   每个 child：start/end（06）、delegation+child log（05）、depth+monotone floor（04）',
  )
  console.log(
    '   AgentHandle inbox（07）、coldResume+authorizeLineage（07）、report+scope-local（08）',
  )

  console.log(
    '\n🎯 一句话：注册表解耦、深度防递归、权限钉死边界、事件广播可观测、inbox 持续对话、冷恢复不丢上下文、授权防劫持、report 显式回传——8 步串联就是子代理的完整设计哲学。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
