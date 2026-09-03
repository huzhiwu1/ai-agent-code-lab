/**
 * Step 08 — ContinuationManager 简化（child 表 + inbox + 越级拒绝）
 *
 * 对应源码：packages/subagent/subagent/src/continuation.ts
 *   sendToParent / sendMessage（report 的单边投递实现）
 *   packages/subagent/subagent/src/index.ts startContinuable L403（建立 durable child）
 */

import { randomUUID } from 'node:crypto'
import { runChildTask, type ChildHandle, type DurableSession, type ReportRecord } from './report'

/** 带错误码的领域错误（对应源码 error.ts SubagentError） */
export class SubagentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SubagentError'
  }
}

/**
 * 续对话管理器（简化版，聚焦 report）。
 * activations 表 = live child 注册处，reportBoxes = 各父 agent 的收件箱。
 */
export class ContinuationManager {
  private activations = new Map<string, ChildHandle>()
  private reportBoxes = new Map<string, ReportRecord[]>()

  /** 建立 durable continuable child（对应源码 startContinuable L403：保留 childId + 建立 Session） */
  startContinuable(parentId: string): string {
    const childId = randomUUID()
    const session: DurableSession = { id: childId, parentSession: parentId, transcript: [] }
    this.activations.set(childId, { session, runTask: runChildTask })
    return childId
  }

  /** 建立一次性 child（对应源码 runtime.start L414 的 one-shot 路径：没有 report 工具） */
  startOneShot(parentId: string): string {
    const childId = randomUUID()
    const session: DurableSession = { id: childId, parentSession: parentId, transcript: [] }
    this.activations.set(childId, { session, runTask: runChildTask })
    return childId
  }

  /** 取 child 句柄；不存在 → fail loud（对应源码 expectProvider 式的显式拒绝） */
  getHandle(childId: string): ChildHandle {
    const handle = this.activations.get(childId)
    if (handle === undefined)
      throw new SubagentError(`subagent "${childId}" is not live`, 'NOT_RESUMABLE')
    return handle
  }

  /**
   * report 的唯一入口（对应源码 sendToParent）：
   * 1. exact live child 是发送凭证——不是某个 live Activation 本人的 Agent 不能以它的名义发
   * 2. 从持久 parentSession 推导**唯一**接收者——API 形状上没有"发给谁"的参数，
   *    嵌套汇报只能跨一条边：grandchild → direct parent，不跳级
   */
  reportFrom(childId: string, content: string): { parentId: string; delivered: boolean } {
    const handle = this.activations.get(childId)
    if (handle === undefined) {
      throw new SubagentError(
        `agent "${childId}" is not a live continuable subagent and cannot report`,
        'UNAUTHORIZED',
      )
    }
    const parentId = handle.session.parentSession
    const inbox = this.reportBoxes.get(parentId) ?? []
    inbox.push({ senderId: childId, content })
    this.reportBoxes.set(parentId, inbox)
    return { parentId, delivered: true }
  }

  /** 父读自己的 report 收件箱 */
  reportsOf(parentId: string): readonly ReportRecord[] {
    return this.reportBoxes.get(parentId) ?? []
  }
}

export {}
