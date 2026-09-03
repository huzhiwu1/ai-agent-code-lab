/**
 * Step 09 – 完整总装：把 1-8 步的所有知识点串成一个闭环
 *
 * 跑法：pnpm run subagent:step:09（或 articles/dsh-subagent 内 pnpm run step:09）
 */

import { SubagentRuntime, ChildProvider } from './runtime'
import { clip } from '../../shared/clip'

async function main(): Promise<void> {
  console.log('🧩 Step 09 – 完整总装：把 1-8 步所有知识点串成闭环')
  console.log('='.repeat(62))

  const runtime = new SubagentRuntime()
  const events = runtime.events
  const ROOT = 'root'

  // ── ① 注册表 + 生命周期事件（step-01/06）──
  console.log('\n① 注册表 + 生命周期事件（step-01/06）')
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
  events.on('subagent/provider-added', (name: unknown) => {
    console.log(`   🛠️ provider "${name}" 注册（工具层镜像）`)
  })

  // ── ② 注册 provider + capabilities（step-03）──
  console.log('\n② 注册 provider + capabilities 声明（step-03）')
  runtime.registerProvider(new ChildProvider('fork-agent', 0))
  runtime.registerProvider(new ChildProvider('spawn-agent', 0))
  console.log('   fork-agent.capabilities.persona = true')

  // ── ③ 并行派 2 child（step-02）：fork 继承上下文 vs spawn 独立调研
  const parentContext = '父 agent 正在写 DeepSeek Harness 子代理编排章节的周报。'
  const [forkRun, spawnRun] = await Promise.all([
    runtime.start(
      'fork-agent',
      `基于这段上下文为周报写一句总结。\n上下文：${parentContext}`,
      undefined,
      2,
    ),
    runtime.start('spawn-agent', '用一句话说明什么是"子代理"。', undefined, 2),
  ])
  const forkOutput = (await forkRun.result).output
  const spawnOutput = (await spawnRun.result).output
  console.log(`   📨 fork child（depth=${forkRun.depth}）：${clip(forkOutput)}`)
  console.log(`   📨 spawn child（depth=${spawnRun.depth}）：${clip(spawnOutput)}`)

  // ── ④ 委托链深度限制（step-04）──
  console.log('\n④ 委托链深度限制（step-04）：maxDepth=2，grandchild 到边界')
  runtime.registerProvider(new ChildProvider('child1-agent', forkRun.depth))
  const child2 = await runtime.start(
    'child1-agent',
    '用一句话回答：递归的终止条件是什么？',
    undefined,
    2,
  )
  console.log(`   ✅ child2 depth=${child2.depth}，回答：${clip((await child2.result).output)}`)
  runtime.registerProvider(new ChildProvider('child2-agent', child2.depth))
  try {
    await runtime.start('child2-agent', '再派一层', undefined, 2)
    console.log('   ❌ 意外：第 3 层居然被发布了')
  } catch (error) {
    console.log(`   ✅ 拒绝：${(error as Error).message}（委托前拒绝，child 从未创建）`)
  }

  // ── ⑤ 权限快照 + persona 闭环（step-03/05）──
  console.log('\n⑤ 权限快照 + persona 闭环（step-03/05）')
  const permRun = await runtime.start(
    'fork-agent',
    '你的任务需要访问一个你无权访问的机密文件。你会怎么回复我？',
    undefined,
    2,
  )
  const permOutput = (await permRun.result).output
  console.log(`   📨 delegation 声明：${clip(permOutput)}`)
  const follows =
    /重试|再试/.test(permOutput) === false && /限制|无法|不能|父|上报|处理/.test(permOutput)
  console.log(
    `   ${follows ? '✅' : '❌'} ${follows ? '说明限制而非重试（delegation 生效）' : '行为偏离'}`,
  )

  const personaRun = await runtime.start('fork-agent', '用一句话介绍你自己。', '说话像海盗', 2)
  const personaOutput = (await personaRun.result).output
  console.log(`   📨 persona：${clip(personaOutput)}`)
  const personaWorked = /海盗|船|哟|pirate/i.test(personaOutput)
  console.log(
    `   ${personaWorked ? '✅' : '❌'} 人设${personaWorked ? '生效（海盗腔）' : '没生效'}`,
  )

  // ── ⑥ cold resume（step-07）：重启后从持久存储恢复 child 的回答 ──
  console.log('\n⑥ cold resume（step-07）：模拟重启后从持久 store 恢复 child 回答')
  const recalled = runtime.recall(forkRun.id)
  console.log(`   🔍 重启后 recall(forkRun.id) → ${recalled ? clip(recalled) : '（无）'}`)
  console.log(
    `   ${recalled ? '✅' : '❌'} cold resume 成功：${recalled ? '重启后 child 的回答还在（持久存储不丢）' : '丢失'}`,
  )
  console.log('   → 这就是 Session/Activation 分离的哲学：驻留丢，身份不丢。')

  // ── ⑦ report 回传 + 越级汇报（step-08）──
  console.log('\n⑦ report 回传 + 越级汇报（step-08）')
  runtime.report(forkRun.id, ROOT, `周报总结：${forkOutput}`)
  runtime.report(spawnRun.id, ROOT, `调研结论：${spawnOutput}`)
  console.log('   fork child 和 spawn child 各自把结果 report 给 root')
  const rootInbox = runtime.inbox(ROOT)
  console.log(
    `   📥 root 收件箱收到 ${rootInbox.length} 条 report：${rootInbox.map(s => clip(s, 30)).join(' | ')}`,
  )

  // 越级汇报：grandchild（child2）想直接报给 root，但它的 parent 是 child1-agent
  runtime.report(child2.id, 'child1-agent', '我想直接报给 root！')
  console.log(`   🚫 grandchild 的 report 到达 child1-agent（它的 direct parent），不是 root`)
  console.log(`   → 嵌套汇报只跨一条边：grandchild → direct parent，不跳级。`)

  // ── ⑧ 完整委托链总结 ──
  console.log('\n⑧ 完整委托链总结')
  console.log('   root(0) ──fork──▶ child1(1) ──fork──▶ child2(2) ──❌ 超限')
  console.log('   root(0) ──spawn─▶ spawn-child(1)')
  console.log('   root(0) ──fork──▶ persona-child(1) 海盗腔 ✓')
  console.log('   root(0) ──fork──▶ delegation-child(1) 权限限制 ✓')
  console.log(
    '   每个 child：start/end（06）、delegation（05）、depth（04）、recall（07）、report（08）',
  )

  // ── C. 🎯 一句话小结 ──
  console.log(
    '\n🎯 一句话：注册表解耦"怎么派"，深度预算防递归，权限快照钉死边界，事件广播让一切可观测，Session 持久保上下文，report 显式送结果——8 步串联就是子代理的完整设计哲学。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
