/**
 * Step 01 — 子代理注册表：为什么"派子代理"要做成"注册表 + 可插拔 provider"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「子代理（subagent）」= 父 agent 派生出来干一件独立任务的小 agent。它有自己的
 *   上下文、自己的模型调用，干完把结果交回父（类比：老板把一份调研派给实习生，
 *   实习生自己去查资料，老板只要结论）。
 * 「provider」= 一种"子代理怎么跑起来"的运输方式实现（类比：实习生可以坐班
 *   （同进程 spawn）、也可以远程办公（外部进程 acp）——老板只按"运输方式的名字"
 *   点单，不关心具体怎么把人叫醒）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：想派子代理，就在主循环里直接 new 一个子 Agent 类写死。等想换一种
 * 子代理跑法（换成本地进程 → 远程沙箱），主循环里到处是 if/else；加一个第三方
 * 子代理实现，还得改核心代码。派生的"动作"和派生的"方式"焊死在一起了。
 * 另一个坑：朴素版把"没派出去"和"干坏了"混成一个 try/catch 吞掉——调用方
 * 分不清"委托不存在"和"委托失败"。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 注册表 + 可插拔 provider（学习源码 SubagentRuntime）：provider 按名字注册进
 * Map，父 agent 按名字 start。多个 provider 并存（不像 bash 那样只能有一个执行器），
 * 加运输方式 = 注册新 provider，不改核心。另一个关键设计是「发布边界」：
 * provider.start() 的 promise 兑现（fulfill）那一刻 = 子代理正式"发布"，所有权
 * 转移给调用方；发布前失败 → start() reject（调用方拿不到 run，无需清理）；
 * 发布后失败 → 通过 run.result 结算成 stopReason（completed/aborted/error/
 * max-tokens/refusal），result 本身不 reject。
 *
 * ── 本步在 8 步渐进里的位置 ─────────────────────────────────
 * 这是最原始的一层：委托请求只有 prompt + 取消信号，provider 只有 name + start。
 * 后续每一步都在这个骨架上**长出一个新概念**：step-02 长出上下文哲学（spawn/fork），
 * step-03 长出能力声明（capabilities），step-04 长出深度预算……本步刻意不提前引入
 * 任何后面才讲的概念。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 运输方式可插拔、子代理实现可扩展；调用方对"派出去没"和"结局是什么"有确定答案。
 *
 * 对应源码：packages/subagent/subagent/src/types.ts（SubagentProvider L285 /
 *   SubagentRun L249 / SubagentResult L219 / SubagentStopReasonMap L200）
 *   packages/subagent/subagent/src/index.ts（registerProvider L369 /
 *   expectProvider L449 / start L414）
 * 跑法：pnpm run subagent:step:01（或 articles/dsh-subagent 内 pnpm run step:01）
 */

import { runtime } from './runtime'
import { SpawnProvider, AcpProvider } from './providers'
import { type SubagentError } from './types'
import { clip } from '../../shared/clip'
import { naiveDemo } from './naive'

async function main(): Promise<void> {
  console.log('🧭 Step 01 – 子代理注册表：派子代理 = 按名字点单，不关心运输方式')
  console.log('='.repeat(62))

  // ── A. 对照组：朴素做法翻车现场 ──
  naiveDemo()

  // ── B. Harness 方案：注册表 + 可插拔 provider ──
  console.log('\n── B. Harness 方案：注册表 + 可插拔 provider ──')

  // ── ① 注册两个 provider：spawn（同进程）+ acp（外部进程桩）──
  console.log('\n① 注册 provider（多种运输方式并存）')
  runtime.registerProvider(new SpawnProvider('spawn'))
  runtime.registerProvider(new AcpProvider('acp'))
  console.log(`   ✅ 已注册：${runtime.list().join('、')}`)

  // ── ② 重复注册同名 → DUPLICATE_PROVIDER ──
  console.log('\n② 重复注册同名 provider')
  // 对应源码 index.ts registerProvider L369：同名重复注册 → 报错
  try {
    runtime.registerProvider(new SpawnProvider('spawn'))
    console.log('   ❌ 意外：重名注册没报错')
  } catch (error) {
    console.log(
      `   ✅ 拒绝：${(error as SubagentError).message}（code=${(error as SubagentError).code}）`,
    )
  }

  // ── ③ start 不存在的名字 → NO_PROVIDER ──
  console.log('\n③ start 一个不存在的 provider')
  // 对应源码 index.ts expectProvider L449：不存在的名字 → fail loud
  try {
    await runtime.start('ghost', { prompt: '你好' })
    console.log('   ❌ 意外：幽灵 provider 居然跑起来了')
  } catch (error) {
    console.log(
      `   ✅ 拒绝：${(error as SubagentError).message}（code=${(error as SubagentError).code}）`,
    )
  }

  // ── ④ spawn 一次真实委托：child 用真实 LLM 完成任务 ──
  console.log('\n④ spawn 派一个 child（真实 LLM 干活）')
  const spawnRun = await runtime.start('spawn', { prompt: '用一句话解释什么是"闭包"。' })
  console.log(`   🔍 run.id = ${spawnRun.id}`)
  const spawnResult = await spawnRun.result
  console.log(`   📨 child 真实回答：${clip(spawnResult.output)}`)
  console.log(`   🏁 stopReason = ${spawnResult.stopReason}（发布后正常完成 → 通过 result 结算）`)

  // ── ⑤ acp 一次真实委托：外部进程桩里的 child 同样是真实 LLM ──
  console.log('\n⑤ acp 派一个 child（进程边界之外，干活仍是真实 LLM）')
  const acpRun = await runtime.start('acp', { prompt: '用一句话解释什么是"事件循环"。' })
  console.log(`   🔍 run.id = ${acpRun.id}`)
  const acpResult = await acpRun.result
  console.log(`   📨 child 真实回答：${clip(acpResult.output)}`)
  console.log(`   🏁 stopReason = ${acpResult.stopReason}`)

  // ── ⑥ 发布边界（方向一）：发布前取消 → start() reject，没有 run ──
  console.log('\n⑥ 发布边界 · 发布前失败：start() reject，调用方拿不到 run、无需清理')
  const preAborted = new AbortController()
  preAborted.abort() // 还没开始委托，取消信号已经亮了
  try {
    await runtime.start('spawn', { prompt: '永远到不了的任务', signal: preAborted.signal })
    console.log('   ❌ 意外：发布前取消居然返回了 run')
  } catch (error) {
    console.log(`   ✅ start() reject：${(error as SubagentError).message}`)
    console.log('   → 没有任何 run 诞生，调用方没有需要 dispose 的对象（未发布 = 不存在）')
  }

  // ── ⑦ 发布边界（方向二）：发布后取消 → result 结算 aborted，不 reject ──
  console.log('\n⑦ 发布边界 · 发布后失败：run.result 结算 stopReason，不 reject')
  const cancelRun = await runtime.start('acp', { prompt: '帮我写一份 200 字的项目周报。' })
  console.log(`   🔍 run.id = ${cancelRun.id}（已发布）`)
  console.log('   ⚡ 父 agent 立刻 dispose（模拟"不需要结果了"）')
  await cancelRun.dispose()
  const cancelled = await cancelRun.result // 注意：await 一个被取消的 run 不抛异常
  console.log(`   ✅ result 结算：stopReason = ${cancelled.stopReason}`)
  console.log('   → 发布前是"异常"（reject），发布后是"结局"（stopReason）——调用方永远有确定答案')

  // ── C. 🎯 一句话小结 ──
  console.log('\n🎯 一句话：注册表解耦"派什么活"和"怎么派"，发布边界解耦"没派出去"和"结局如何"。')
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
