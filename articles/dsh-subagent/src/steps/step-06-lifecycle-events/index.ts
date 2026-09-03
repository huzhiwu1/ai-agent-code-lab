/**
 * Step 06 – 生命周期可观测：start/end 事件对怎么让子代理"看得见"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「生命周期事件」= 子代理从诞生到终结向外广播的通知（类比：仓库门口的
 *   出入登记——卡车"进仓"记一笔，"出仓"记一笔，看登记簿就知道现在有几辆车
 *   在仓里、哪辆是哪批货）。
 * 「事件配对」= start 和 end 用**同一个 runId** 关联成一对（类比：快递单号——
 *   揽收和签收是两次记录，但同一个单号把"这趟运输"的两端钉在一起）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：子代理跑起来没有任何通知。观察者想知道"现在有几个子代理在跑、
 * 哪个完了、结果如何"，只能轮询内部状态——看不到边界，也没有统一词汇。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 三个设计：
 * 1. observeRun：run 发布时发 subagent/start，result 结算时发配对的
 *    subagent/end（**同一 runId** + stopReason + lastAssistantMessage）。
 * 2. provider 注册表广播 provider-added / provider-removed：工具层**镜像
 *    provider 生命周期**而不是赌加载顺序——在就注册、走就注销。
 * 3. listener 隔离：一个 listener throw 不能饿死其他 listener——
 *    观察者是旁观者，旁观者不能改比赛结果。
 *
 * ── 本步在 8 步渐进里的位置 ─────────────────────────────────
 * 回到 step-01 的注册表：它现在只有 Map + start，外面的人看不到里面在发生什么。
 * 本步给注册表和 run 各长出一对"向外广播的窗口"——provider-added/removed（注册表）
 * + start/end（run 的一生），机制都长在 step-01 的骨架上，不是另起炉灶。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 子代理的运行全程可观测、工具注册永远与 provider 存在性同步、坏观察者不传染。
 *
 * 对应源码：packages/subagent/subagent/src/lifecycle.ts
 *   （observeRun L133-162 / createLifecycleEmitter L100-123）
 *   packages/subagent/subagent/src/index.ts（registerProvider 广播 + effect 清理）
 * 跑法：pnpm run subagent:step:06（或 articles/dsh-subagent 内 pnpm run step:06）
 */

import { SubagentRuntime } from './runtime'
import { type SubagentRunInfo, type SubagentRunEndInfo } from './observe'
import { ToolMirror } from './tool'
import { clip } from '../../shared/clip'
import { naiveDemo } from './naive'

async function main(): Promise<void> {
  console.log('📡 Step 06 – 生命周期可观测：一对事件讲清一个 run 的一生')
  console.log('='.repeat(62))

  // ── A. 对照组：两个事故 ──
  naiveDemo()

  // ── B. Harness 方案 ──
  console.log('\n── B. Harness 方案：事件驱动 + 镜像生命周期 ──')

  const runtime = new SubagentRuntime()
  const toolMirror = new ToolMirror(runtime.events)

  // ── ① 注册/移除 provider：added/removed 广播 ──
  console.log('\n① 注册 provider（观察工具层如何镜像生命周期）')
  runtime.registerProvider('spawn')
  console.log(`   → 当前挂载的工具：${toolMirror.tools.join('、') || '（无）'}`)
  console.log('\n② 移除 provider')
  runtime.removeProvider('spawn')
  console.log(`   → 当前挂载的工具：${toolMirror.tools.join('、') || '（无）'}`)
  console.log('   → 工具不赌"加载顺序"，provider 在就注册、走就注销。')
  runtime.registerProvider('spawn') // 重新注册，供下面 start 用

  // ── ③ 订阅 start/end，看一对事件的完整配对 ──
  console.log('\n③ 订阅 subagent/start + subagent/end，跑一次真实委托')
  const seen: { start?: SubagentRunInfo; end?: SubagentRunEndInfo } = {}
  runtime.events.on('subagent/start', payload => {
    const info = payload as SubagentRunInfo
    seen.start = info
    console.log(
      `   🟢 start：runId=${info.runId.slice(0, 8)}… provider=${info.provider} childId=${info.id.slice(0, 8)}…`,
    )
  })
  runtime.events.on('subagent/end', payload => {
    const info = payload as SubagentRunEndInfo
    seen.end = info
    console.log(`   🔴 end：  runId=${info.runId.slice(0, 8)}… stopReason=${info.stopReason}`)
    if (info.lastAssistantMessage)
      console.log(`       lastAssistantMessage=${clip(info.lastAssistantMessage)}`)
  })

  const run = await runtime.start('spawn', '用一句话回答：什么是事件驱动？')
  const result = await run.result
  console.log(`   📨 最终输出：${clip(result.output)}`)
  const paired =
    seen.start !== undefined && seen.end !== undefined && seen.start.runId === seen.end.runId
  console.log(`   ${paired ? '✅' : '❌'} start/end 同 runId 配对成功`)

  // ── ④ listener 隔离：一个坏 observer 不饿死其他人 ──
  console.log('\n④ listener 隔离：故意 throw 的 observer 不影响其他 listener')
  let goodListenerGotIt = false
  runtime.events.on('subagent/start', () => {
    throw new Error('我是坏 observer，我炸了')
  })
  runtime.events.on('subagent/start', () => {
    goodListenerGotIt = true
    console.log('   ✅ 好 observer 仍然收到事件')
  })
  await runtime.start('spawn', '用一句话回答：什么是闭包？').then(r => r.result)
  console.log(
    `   ${goodListenerGotIt ? '✅' : '❌'} 隔离生效：坏 observer 的异常被吞掉并警告，不影响其他人`,
  )
  console.log('   → 观察者是旁观者：旁观者摔一跤，比赛照常进行。')

  // ── C. 🎯 一句话小结 ──
  console.log(
    '\n🎯 一句话：run 的一生 = 一对同 runId 的 start/end 事件；工具随 provider 进退；坏观察者不传染。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
