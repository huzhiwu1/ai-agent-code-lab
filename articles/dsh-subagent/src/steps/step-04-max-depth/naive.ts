/**
 * Step 04 对照组：两个事故——无深度限制 + 重启后从 0 算
 *
 * 事故①：无深度限制 → 无限递归
 * 事故②：重启后 options.subagentDepth=0 → 假装顶层继续派
 */

import { type AgentLike, delegationDepthOf } from './depth'

export function naiveDemo(): void {
  console.log('── A. 对照组：朴素做法翻车现场 ──')

  // ── 事故①：无深度限制 → 无限递归 ──
  console.log('\n🚫 事故①：无深度限制——子代理可以无限派子代理')
  console.log('   朴素实现：没有 maxDepth 参数，child 可以继续派，再派……')
  console.log(
    '   委托链膨胀：root(0) → child1(1) → child2(2) → child3(3) → child4(4) → child5(5) → child6(6)',
  )
  console.log('   💥 到第 6 层还没停——没有预算 = 靠运气防递归。算力和钱都在烧。')
  console.log('   → harness 的做法：resolveChildDepth 超过 maxDepth 就抛 SubagentDepthError')
  console.log('     child 根本不发布，不是"发布了再叫停"。深度是部署级预算，一次配置全局生效。')

  // ── 事故②：重启后从 0 算 → 假装顶层 ──
  console.log('\n🚫 事故②：重启后从 0 算——一个曾经是第 2 层的 child 假装自己是顶层')
  const naiveRestarted: AgentLike = {
    // 模拟进程重启：内存 options 清零，新进程里调用方给的 options.subagentDepth = 0
    options: { subagentDepth: 0 },
    // 持久化 header 还在：它曾经是第 2 层
    header: { delegationDepth: 2 },
  }
  // ⚠️ 朴素版：直接用新 options 的值（0），忽略 header
  const naiveDepth = naiveRestarted.options.subagentDepth ?? 0
  console.log(`   header.delegationDepth=2，重启后 options.subagentDepth=0`)
  console.log(`   💥 朴素版直接用 options 算：有效深度 = ${naiveDepth}（假装顶层！）`)
  console.log('   → 这意味着一个曾经是第 2 层的 child，重启后可以继续往下派——递归预算失效。')

  // harness 的正确做法：取 max(header, runtime)
  const correctDepth = delegationDepthOf(naiveRestarted)
  console.log(
    `   ✅ harness 的做法：有效深度 = max(2, 0) = ${correctDepth}（header 是 monotone floor）`,
  )
  console.log('   → header 是下限，只能加深不能减轻。重启改不了已烙下的深度。')
}

export {}
