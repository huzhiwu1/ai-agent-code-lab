/**
 * Step 03 — 能力声明与校验类型（学习源码 types.ts）
 *
 * 渐进叙事：step-01 的 SubagentStartRequest 只有 prompt + 取消信号、
 * SubagentProvider 只有 name + start。本步给两者**各自长出新字段**：
 * 请求长出可选能力字段（persona / maxDepth / …），provider 长出 capabilities
 * 声明——请求字段和声明 flag 一一对应，校验才有依据。
 *
 * 对应源码：packages/subagent/subagent/src/types.ts
 *   SubagentCapabilities L86-91 / SubagentStartRequest L101-157
 */

/**
 * start 时刻的五个能力 flag（学习源码 SubagentCapabilities，含 agentOptions）。
 *
 * 两个关键点：
 * 1. 一一对应：每个 flag 与 SubagentStartRequest 里的一个可选字段对应——
 *    depthLimit → maxDepth，其余同名。请求没带的字段，对应 flag 不会被查。
 * 2. 只管 one-shot 路径：这些 flag 描述的是 provider.start()（一次性委托）的
 *    能力面；continuable child 的创建不查这些 flag（见下方 prepareContinuable）。
 *
 * 五个 flag 各自在真实源码里的实现方式（教学版只展开 persona，其余仅声明）：
 *   agentOptions  → 子代理的 provider/model 路由覆盖（源码 merge over parent options）
 *   outputSchema  → 结构化输出捕获（源码 assertObjectJsonSchema + 结果校验）
 *   depthLimit    → 委托深度上限（源码 resolveChildDepth，step-04 展开）
 *   toolFilter    → 子代理工具可见性裁剪（源码 scoped tools.restrict()）
 *   persona       → 子代理专属人设（源码 scoped deployment:persona section，本步演示）
 */
export interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

/** 一次性委托请求：每个可选字段都对应一个能力（学习源码 SubagentStartRequest） */
export interface SubagentStartRequest {
  readonly prompt: string
  /** 要求的 Agent 选项覆盖（对应 agentOptions 能力） */
  readonly agentOptions?: object
  /** 要求结构化输出（对应 outputSchema 能力） */
  readonly outputSchema?: object
  /** 深度上限（对应 depthLimit 能力，step-04 展开讲） */
  readonly maxDepth?: number
  /** 子代理工具过滤（对应 toolFilter 能力） */
  readonly toolFilter?: string[]
  /** 子代理专属人设（对应 persona 能力，本步完整闭环演示） */
  readonly persona?: string
}

export interface SubagentRun {
  readonly id: string
  readonly result: Promise<{ output: string }>
}

export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  /**
   * 可选方法 = continuable 能力（学习源码 prepareContinuable L323）：方法存在
   * 即能力，不设 flag。为什么：flag 说 true、方法却被删了 → 声明与实现漂移；
   * 方法在不在由 TS narrowing 直接发现，两者不可能不一致。
   */
  readonly prepareContinuable?: unknown
  start(request: SubagentStartRequest): Promise<SubagentRun>
}

/** 带错误码的领域错误（学习源码 error.ts SubagentError） */
export class SubagentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SubagentError'
  }
}

export {}
