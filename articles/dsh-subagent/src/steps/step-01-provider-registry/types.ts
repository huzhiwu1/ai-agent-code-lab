/**
 * Step 01 — 对外契约类型（学习源码 subagent/src/types.ts 的设计）
 *
 * 本步只定义"派一个子代理"最小闭环需要的四个类型：run 的结局、run 的句柄、
 * 委托请求、transport 接口。**刻意不引入 capabilities**——那是 step-03 才长出来的
 * 概念（本步的委托只有 prompt + 取消信号，没有需要声明的能力）。
 *
 * 对应源码：packages/subagent/subagent/src/types.ts
 *   SubagentStopReasonMap L200 / SubagentResult L219 / SubagentRun L249 /
 *   SubagentProvider L285
 */

/** 子代理 run 的终结原因词汇表（学习源码 SubagentStopReasonMap，merge-extensible） */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** run 的终端结果：非 completed 的 stopReason 意味着 output 可能不完整（学习源码 SubagentResult） */
export interface SubagentResult {
  readonly output: string
  readonly stopReason: SubagentStopReason
}

/**
 * 一个已发布子代理的句柄（学习源码 SubagentRun）。
 * 发布之后：提交任务、干活、基础故障全部归 result 结算；dispose 取消剩余工作。
 */
export interface SubagentRun {
  readonly id: string
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

/** 一次性委托请求（本步只有 prompt 和取消信号；step-03 才会长出 persona 等可选能力） */
export interface SubagentStartRequest {
  readonly prompt: string
  readonly signal?: AbortSignal
}

/**
 * 一种"子代理怎么跑"的运输方式（学习源码 SubagentProvider）。
 * 本步的 provider 极简：只有 name + start。后续步骤会逐步给它长出新字段——
 * step-02 加 inheritsParentContext（上下文哲学）、step-03 加 capabilities（能力声明）。
 */
export interface SubagentProvider {
  /** 注册表里的唯一名字（如 spawn / acp） */
  readonly name: string
  /** 建立一次性子代理并在"发布"后返回 run；发布前失败 → reject 并自行清理 */
  start(request: SubagentStartRequest): Promise<SubagentRun>
}

/** 带错误码的领域错误（学习源码 error.ts 的 SubagentError） */
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
