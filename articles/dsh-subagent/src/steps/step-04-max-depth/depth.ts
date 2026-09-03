/**
 * Step 04 — 深度记账（对应源码 depth.ts + child-agent.ts）
 *
 * 对应源码：packages/subagent/subagent/src/depth.ts
 *   delegationDepthOf L28-36 / assertSubagentMaxDepth L42-51
 *   packages/subagent/subagent/src/child-agent.ts
 *   resolveChildDepth L48-57 / SubagentDepthError L31-36
 */

/** 简化 Agent：只有深度记账需要的两部分（对应真实 Agent 的 options + session.header） */
export interface AgentLike {
  readonly options: { subagentDepth?: number }
  readonly header: { delegationDepth?: number }
}

/**
 * 读一个 agent 的委托深度（对应源码 delegationDepthOf L28-36）。
 * 缺省视为顶层 0；持久化 header 是权威且单调的：运行时 options 可以加深
 * （比如一个普通 agent 临时当子代理用），但永远不能降低已烙下的深度。
 */
export function delegationDepthOf(agent: AgentLike): number {
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
export function assertSubagentMaxDepth(maxDepth: unknown): void {
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
export class SubagentDepthError extends Error {
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
export function resolveChildDepth(parent: AgentLike, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)
  }
  return childDepth
}

export {}
