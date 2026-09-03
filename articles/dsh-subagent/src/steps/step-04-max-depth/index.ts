/**
 * Step 04 – 委托深度预算：怎么防止"子代理再派子代理"无限递归？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「delegationDepth」= 一个 agent 在委托链上的深度：顶层 agent = 0，child =
 *   父的深度 + 1（类比：公司层级——CEO 是 0 层，他派的活是 1 层，再往下派的
 *   是 2 层……每派一层，记一个"你是第几层"的烙印）。
 * 「maxDepth」= 委托的绝对上限：超过这个深度的新委托一律拒绝（类比：外包
 *   合同里写死"最多转包 2 层"，再转就是违约）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：子代理也能调 subagent 工具 → 子代理再派子代理 → 孙代理再派……
 * 没人管深度，最坏的情况是无限递归：A 派 B、B 派 C、C 派 B…… 算力和钱烧光。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 深度记账放在委托边界：派 child 时算 childDepth = 父深度 + 1，超过 maxDepth
 * 就拒绝（不发布 child）。两个关键细节：
 * 1. 有效深度 = **max(持久化 header, 运行时 options)**：header 是 monotone floor
 *    （单调下限），重启不能降低递归计数。
 * 2. 校验入参：负数 / 小数 / -0 / Infinity / NaN 全部 reject（TypeError）。
 *
 * ── 本步在 8 步渐进里的位置 ─────────────────────────────────
 * step-03 给 provider 长出 capabilities 时，其中一个 flag 是 depthLimit。本步
 * 展开它背后的完整机制：不是只查 flag，而是真正执行深度校验——算 childDepth、
 * 超限拒绝。demo 接回注册表体系：注册 provider → 派委托链 → 深度校验生效。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 递归深度是部署级预算，一次配置全局生效；重启、恢复都钻不了空子。
 *
 * 对应源码：packages/subagent/subagent/src/depth.ts / child-agent.ts
 * 跑法：pnpm run subagent:step:04（或 articles/dsh-subagent 内 pnpm run step:04）
 */

import { SubagentRuntime, SpawnProvider } from './runtime'
import { delegationDepthOf, assertSubagentMaxDepth, SubagentDepthError } from './depth'
import { makeChild } from './chain'
import { clip } from '../../shared/clip'
import { naiveDemo } from './naive'

async function main(): Promise<void> {
  console.log('🧮 Step 04 – 委托深度预算：递归是配置出来的，不是运气防住的')
  console.log('='.repeat(62))

  // ── A. 对照组：两个事故 ──
  naiveDemo()

  // ── B. Harness 方案：注册表 + 深度校验 ──
  console.log('\n── B. Harness 方案：注册表接入深度校验 ──')

  const MAX_DEPTH = 2
  const runtime = new SubagentRuntime()
  // 注册一个顶层 provider（depth=0），负责派 child
  runtime.registerProvider(new SpawnProvider('root-agent', 0))

  // ── ① 合法委托链：root(0) → child1(1) → child2(2)（真实 LLM 干活）──
  console.log(`\n① 合法委托链（maxDepth=${MAX_DEPTH}）`)
  console.log('   root 深度 = 0（顶层 agent）')
  const child1 = await runtime.start('root-agent', '用一句话回答：什么是递归？', MAX_DEPTH)
  console.log(`   ✅ child1 depth=${child1.depth}，回答：${clip((await child1.result).output)}`)

  // 注册 child1 作为"新 agent"继续派：它的 parentDepth=1
  runtime.registerProvider(new SpawnProvider('child1-agent', child1.depth))
  const child2 = await runtime.start(
    'child1-agent',
    '用一句话回答：递归的终止条件是什么？',
    MAX_DEPTH,
  )
  console.log(`   ✅ child2 depth=${child2.depth}，回答：${clip((await child2.result).output)}`)

  // ── ② 超限拒绝：child2 想派 child3 → attemptedDepth=3 > 2 ──
  console.log('\n② child2 想再派一层（递归失控的瞬间）')
  runtime.registerProvider(new SpawnProvider('child2-agent', child2.depth))
  try {
    await runtime.start('child2-agent', '再派一层', MAX_DEPTH)
    console.log('   ❌ 意外：第 3 层居然被发布了')
  } catch (error) {
    const depthError = error as SubagentDepthError
    console.log(`   ✅ 拒绝：${depthError.message}`)
    console.log(
      `     attemptedDepth=${depthError.attemptedDepth} > maxDepth=${depthError.maxDepth}`,
    )
  }
  console.log('   → 拒绝发生在发布之前：第 3 层 child 根本不存在。')

  // ── ③ 持久化 header 防作弊：重启不能降低递归计数 ──
  console.log('\n③ 持久化 header 防作弊（monotone floor）')
  const resumedChild2 = {
    options: { subagentDepth: 0 },
    header: { delegationDepth: 2 },
  }
  const effective = delegationDepthOf(resumedChild2)
  console.log(`   header.delegationDepth=2，重启后 options.subagentDepth=0`)
  console.log(`   → 有效深度 = max(2, 0) = ${effective}（header 说了算，重启不算"回零"）`)
  try {
    makeChild(resumedChild2, MAX_DEPTH)
    console.log('   ❌ 意外：重启后居然能假装顶层继续派')
  } catch (error) {
    console.log(
      `   ✅ 它想再派一层 → attemptedDepth=3，被拒：${(error as SubagentDepthError).message}`,
    )
  }

  // ── ④ 非法参数全部 reject ──
  console.log('\n④ 非法参数全部 reject（TypeError）')
  const badDepths: { label: string; value: unknown }[] = [
    { label: '-1', value: -1 },
    { label: '1.5', value: 1.5 },
    { label: '-0', value: -0 },
    { label: 'Infinity', value: Infinity },
    { label: 'NaN', value: NaN },
  ]
  for (const { label, value } of badDepths) {
    try {
      assertSubagentMaxDepth(value)
      console.log(`   ❌ maxDepth=${label}：意外通过`)
    } catch {
      console.log(`   ✅ maxDepth=${label} → TypeError`)
    }
  }

  // ── C. 🎯 一句话小结 ──
  console.log('\n🎯 一句话：深度是"派一层烙一层"的持久烙印，重启改不了，超限就拒绝。')
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
