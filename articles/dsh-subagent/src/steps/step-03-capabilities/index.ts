/**
 * Step 03 – 能力声明 + fail loud：为什么不支持的请求要提前拒绝，而不是"接受后忽略"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「capabilities」= provider 在 start 时刻支持什么特性的一组静态声明（类比：
 *   酒店房间页面上的设施清单——"有泳池/无健身房"，你订房前就能知道）。
 * 「fail loud」= 不支持就大声报错，绝不默默吞掉（类比：餐厅没有儿童座椅，
 *   你订座时服务员当场告诉你，而不是你抱着孩子到了才发现没椅子坐）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：provider 收到带 persona 的请求，发现"我不支持 persona"，就
 * 悄悄忽略这个字段继续跑。结果：父 agent 以为"我已经给子代理设了人设"，
 * 子代理实际没有任何人设——**模型以为限制生效了，实际上没有**。这种"接受
 * 后忽略"的错位极难排查，因为一切都"正常跑完了"。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 给 provider 长出 capabilities 静态声明（五个 flag），runtime.start() 委托前
 * **逐一校验**请求字段 vs 声明，缺哪个抛 UNSUPPORTED_CAPABILITY——在委托还没
 * 发生时就拒绝。本步聚焦 persona 一个能力做完整闭环（声明 → 校验 → 实现 →
 * 生效），其余四个 flag 只声明不展开（实现方式见 types.ts 注释）。
 * 另一个对比设计：「方法存在即能力」——continuable 能力不设独立 flag，而是
 * 用可选方法 prepareContinuable 表示，防止 flag 和实现漂移。
 *
 * ── 本步在 8 步渐进里的位置 ─────────────────────────────────
 * step-01 的委托请求只有 prompt + 取消信号，所以不需要任何校验。本步长出第一
 * 批"可选能力"：请求字段一旦变多，provider 能不能接住就成了问题——于是
 * SubagentProvider 长出 capabilities 字段，SubagentStartRequest 长出对应的
 * 可选字段。step-04 会展开讲 depthLimit 背后的深度预算机制。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 限制的"可见性"和"生效性"永远一致：要么被明确拒绝，要么真的生效。
 *
 * 对应源码：packages/subagent/subagent/src/types.ts（SubagentCapabilities L86-91）
 *   packages/subagent/subagent/src/index.ts（assertCapabilities L481-496）
 * 跑法：pnpm run subagent:step:03（或 articles/dsh-subagent 内 pnpm run step:03）
 */

import { SubagentRuntime } from './runtime'
import { MinimalProvider, FullProvider, BrokenProvider } from './providers'
import { type SubagentError, type SubagentProvider, type SubagentStartRequest } from './types'
import { clip } from '../../shared/clip'
import { naiveDemo } from './naive'

async function main(): Promise<void> {
  console.log('🚦 Step 03 – 能力声明 + fail loud：不支持的请求在委托前就被拒绝')
  console.log('='.repeat(62))

  // ── A. 对照组：接受后忽略翻车现场 ──
  await naiveDemo()

  // ── B. Harness 方案 ──
  console.log('\n── B. Harness 方案：assertCapabilities 委托前逐一校验 ──')

  const runtime = new SubagentRuntime()
  runtime.registerProvider(new MinimalProvider('minimal'))
  runtime.registerProvider(new FullProvider('full'))
  runtime.registerProvider(new BrokenProvider('broken'))
  console.log('\n① 注册三个 provider：minimal（全 false）/ full（全 true）/ broken（声明≠实现）')

  // ── ② 向精简 provider 请求 persona → 提前抛 UNSUPPORTED_CAPABILITY ──
  console.log('\n② 向 minimal 请求 persona（它没声明这个能力）')
  try {
    await runtime.start('minimal', { prompt: '你好', persona: '说话像海盗' })
    console.log('   ❌ 意外：请求居然通过了')
  } catch (error) {
    console.log(`   ✅ 委托前拒绝：${(error as SubagentError).message}`)
    console.log(`     code = ${(error as SubagentError).code}`)
  }
  console.log('   → 关键：拒绝发生在 provider.start() **之前**，子代理从未被创建。')

  // ── ③ 同一个请求给全功能 provider → 正常通过，persona 真实生效 ──
  console.log('\n③ 同一个请求给 full（声明了 persona 能力）→ 通过且真实生效')
  const fullRun = await runtime.start('full', {
    prompt: '用一句话介绍你自己。',
    persona: '说话像海盗',
  })
  const fullResult = await fullRun.result
  console.log(`   📨 child 回答：${clip(fullResult.output)}`)
  const personaWorked = /海盗|船|哟|yarr|pirate/i.test(fullResult.output)
  console.log(
    `   ${personaWorked ? '✅' : '❌'} 人设真的装进了 child 的 system prompt（限制可见 = 限制生效）`,
  )

  // ── ④ 逐项校验演示：五个字段各自对应一个能力 ──
  console.log('\n④ 逐项校验：每个请求字段 → 一个能力 flag')
  const probes: { label: string; request: Partial<SubagentStartRequest> }[] = [
    { label: 'agentOptions', request: { agentOptions: {} } },
    { label: 'maxDepth', request: { maxDepth: 2 } },
    { label: 'toolFilter', request: { toolFilter: ['read'] } },
    { label: 'outputSchema', request: { outputSchema: { type: 'object' } } },
  ]
  for (const { label, request } of probes) {
    try {
      await runtime.start('minimal', { prompt: 'hi', ...request })
      console.log(`   ❌ ${label}：意外通过`)
    } catch (error) {
      console.log(`   ✅ ${label} 请求 → minimal 抛 ${(error as SubagentError).code}`)
    }
  }

  // ── ⑤ 方法存在即能力：continuable 不设 flag ──
  console.log('\n⑤ 对比设计：continuable 能力 = 可选方法 prepareContinuable 是否存在')
  const hasContinuable = (p: SubagentProvider): boolean => p.prepareContinuable !== undefined
  console.log(
    `   full=${hasContinuable(new FullProvider('x'))}（方法在）minimal=${hasContinuable(new MinimalProvider('x'))}（方法不在）`,
  )
  console.log('   → 为什么不设 flag：flag 说 true、方法却被删了 → 声明与实现漂移；')
  console.log('     方法在不在由 TS narrowing 直接发现，两者不可能不一致。')

  // ── ⑥ persona 完整闭环放大镜：声明 → 校验 → 实现 → 生效 ──
  console.log('\n⑥ persona 完整闭环：请求 → 校验 → 实现 → 生效')
  console.log('   ① 父的请求：{ prompt, persona: "说话像海盗" }')
  console.log('   ② needs 映射：persona !== undefined → 查 capabilities.persona')
  console.log('   ③ full.capabilities.persona = true → 放行，进入 provider.start()')
  console.log('   ④ FullProvider 实现：PERSONA_SYSTEM(persona) 拼进 system prompt')
  console.log('   ⑤ 真实 LLM 开口海盗腔（见 ③ 的回答）→ 人设生效')
  console.log('   → 闭环成立：声明 flag 在实现里有对应代码，声明才算数。')

  // ── ⑦ fail loud 的边界：声明 ≠ 实现（BrokenProvider）──
  console.log('\n⑦ fail loud 的边界：BrokenProvider 声明 persona=true 却忽略它')
  const brokenRun = await runtime.start('broken', {
    prompt: '用一句话介绍你自己。',
    persona: '说话像海盗',
  })
  const brokenResult = await brokenRun.result
  console.log(`   📨 child 回答：${clip(brokenResult.output)}`)
  const brokenWorked = /海盗|船|哟|pirate/i.test(brokenResult.output)
  console.log(
    `   💥 校验放行了（它声明了 persona=true），人设却${brokenWorked ? '意外生效' : '静默失效'}——`,
  )
  console.log(
    '     声明与实现漂移：assertCapabilities 只对照"请求 vs 声明"，验证不了"声明 vs 实现"。',
  )
  console.log('   → 这是 fail loud 的边界：契约靠 trusted provider 约定（源码注释 Providers')
  console.log('     are trusted same-process implementations），运行时替 provider 保证不了这个。')

  // ── C. 🎯 一句话小结 ──
  console.log('\n🎯 一句话：能力要么被明确拒绝，要么真实生效——"接受后忽略"是最贵的沉默。')
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
