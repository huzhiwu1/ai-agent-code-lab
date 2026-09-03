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
 * 1. 有效深度 = **max(持久化 header.delegationDepth, 运行时 options.subagentDepth)**：
 *    header 是 monotone floor（单调下限）。为什么？resume（进程重启）后 agent
 *    带着全新的 options 起来，若用新 options 从 0 算，一个曾经是第 2 层的 child
 *    会假装自己还是顶层，继续往下派——重启不能降低递归计数。
 * 2. 校验入参：负数 / 小数 / -0 / 非有限 / 不安全整数全部 reject（TypeError）——
 *    深度是"层数"，1.5 层、-1 层在语义上不存在，放进比较里只会算出错误结果。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 递归深度是部署级预算，一次配置全局生效；重启、恢复都钻不了空子。
 *
 * 对应源码：packages/subagent/subagent/src/depth.ts（delegationDepthOf L28-36 /
 *   assertSubagentMaxDepth L42-51）
 *   packages/subagent/subagent/src/child-agent.ts（resolveChildDepth L48-57 /
 *   SubagentDepthError L31-36）
 * 跑法：pnpm run subagent:step:04（或 articles/dsh-subagent 内 pnpm run step:04）
 */

// ── 1. 深度记账（对应源码 depth.ts）────────────────────────────

/** 简化 Agent：只有深度记账需要的两部分（对应真实 Agent 的 options + session.header） */
interface AgentLike {
  /** 运行时选项：本次进程里调用方给的值（可能缺失/非法，必须校验） */
  readonly options: { subagentDepth?: number }
  /** 持久化 header：创建时烙下、存进 Session、跨重启不丢（monotone floor） */
  readonly header: { delegationDepth?: number }
}

/**
 * 读一个 agent 的委托深度（对应源码 delegationDepthOf L28-36）。
 * 缺省视为顶层 0；持久化 header 是权威且单调的：运行时 options 可以加深
 * （比如一个普通 agent 临时当子代理用），但永远不能降低已烙下的深度。
 */
function delegationDepthOf(agent: AgentLike): number {
  const runtime = agent.options.subagentDepth
  // 运行时值必须是非负安全整数：负数/小数/-0/Infinity/NaN 都是"层数"里不存在的东西
  if (
    runtime !== undefined &&
    (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))
  ) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer')
  }
  // 取 max：header 是下限（monotone floor），运行时只能加深不能减轻
  return Math.max(agent.header.delegationDepth ?? 0, runtime ?? 0)
}

/**
 * 校验 maxDepth 入参（对应源码 assertSubagentMaxDepth L42-51）。
 * maxDepth 也必须是非负安全整数：一个无法精确表示层数的上限会静默算错。
 */
function assertSubagentMaxDepth(maxDepth: unknown): void {
  if (
    maxDepth !== undefined &&
    (typeof maxDepth !== 'number' ||
      !Number.isSafeInteger(maxDepth) ||
      maxDepth < 0 ||
      Object.is(maxDepth, -0))
  ) {
    throw new TypeError('subagent maxDepth must be a non-negative safe integer')
  }
}

/** 拒绝"再派一层会超上限"的委托（对应源码 SubagentDepthError L31-36） */
class SubagentDepthError extends Error {
  constructor(
    readonly attemptedDepth: number,
    readonly maxDepth: number,
  ) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

/**
 * 从父推导 child 深度并执行上限（对应源码 resolveChildDepth L48-57）。
 * 超过 maxDepth → 抛 SubagentDepthError（child 根本不发布，不是"发布了再叫停"）。
 */
function resolveChildDepth(parent: AgentLike, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)
  }
  return childDepth
}

// ── 2. 简化委托服务：在"发布 child 之前"检查深度 ──────────────────

/** 顶层 agent：depth 0，无持久化烙印 */
const ROOT: AgentLike = { options: {}, header: {} }

/** 造一个被派出来的 child：烙下 delegationDepth = childDepth 的持久化 header */
function makeChild(parent: AgentLike, maxDepth: number | undefined): AgentLike {
  const childDepth = resolveChildDepth(parent, maxDepth)
  console.log(`   ✅ 发布 child（delegationDepth 烙进 header = ${childDepth}）`)
  // 关键：深度写进持久化 header（模拟落库），而不是只在内存 options 里
  return { options: {}, header: { delegationDepth: childDepth } }
}

async function main(): Promise<void> {
  console.log('🧮 Step 04 – 委托深度预算：递归是配置出来的，不是运气防住的')
  console.log('='.repeat(62))

  const MAX_DEPTH = 2

  // ── ① 合法委托链：root(0) → child1(1) → child2(2) ──
  console.log(`\n① 合法委托链（maxDepth=${MAX_DEPTH}）`)
  console.log('   root 深度 = 0（顶层 agent 缺省）')
  const child1 = makeChild(ROOT, MAX_DEPTH)
  const child2 = makeChild(child1, MAX_DEPTH)

  // ── ② 超限拒绝：child2 想派 child3 → attemptedDepth=3 > 2 ──
  console.log('\n② child2 想再派一层（递归失控的瞬间）')
  try {
    makeChild(child2, MAX_DEPTH)
    console.log('   ❌ 意外：第 3 层居然被发布了')
  } catch (error) {
    const depthError = error as SubagentDepthError
    console.log(`   ✅ 拒绝：${depthError.message}`)
    console.log(
      `     attemptedDepth=${depthError.attemptedDepth} > maxDepth=${depthError.maxDepth}`,
    )
  }
  console.log('   → 拒绝发生在发布之前：第 3 层 child 根本不存在，没有需要清理的东西。')

  // ── ③ 持久化 header 防作弊：重启不能降低递归计数 ──
  console.log('\n③ 持久化 header 防作弊（monotone floor）')
  const resumedChild2: AgentLike = {
    // 模拟进程重启：内存 options 清零，新进程里调用方给的 options.subagentDepth = 0
    options: { subagentDepth: 0 },
    // 但持久化 header 还在：它曾经是第 2 层
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
      `   ✅ 它想再派一层 → 实际 attemptedDepth=3，被拒：${(error as SubagentDepthError).message}`,
    )
  }
  console.log('   → 如果有效深度用新 options 从 0 算，这个"第 2 层"重启后会假装顶层，')
  console.log('     递归预算就失效了——所以 header 是单调下限，只能加深不能减轻。')

  // ── ④ 非法参数校验：这些"层数"在语义上不存在 ──
  console.log('\n④ 非法参数全部 reject（TypeError）')
  const badDepths: { label: string; value: unknown }[] = [
    { label: '负数 -1', value: -1 },
    { label: '小数 1.5', value: 1.5 },
    { label: '负零 -0', value: -0 },
    { label: 'Infinity', value: Infinity },
    { label: 'NaN', value: NaN },
  ]
  for (const { label, value } of badDepths) {
    try {
      assertSubagentMaxDepth(value)
      console.log(`   ❌ maxDepth=${label}：意外通过`)
    } catch (error) {
      console.log(`   ✅ maxDepth=${label} → ${(error as TypeError).name}`)
    }
  }
  try {
    delegationDepthOf({ options: { subagentDepth: 2.5 }, header: {} })
    console.log('   ❌ options.subagentDepth=2.5：意外通过')
  } catch (error) {
    console.log(`   ✅ options.subagentDepth=2.5 → ${(error as TypeError).name}`)
  }
  console.log('   → 为什么连 -0 也拒：-0 与 0 在 === 下相等却在 Object.is 下不等，')
  console.log('     混进深度比较会制造"看起来合法、实际不可信"的值。')

  console.log('\n🎯 一句话：深度是"派一层烙一层"的持久烙印，重启改不了，超限就拒绝。')
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
