/**
 * Step 08 — report 注册表（封装 ContinuationManager）
 *
 * 渐进叙事：step-07 的 runtime 管"可持续对话"。本步的 runtime 在此基础上长出
 * report 能力——child 干完活后主动把结果送回父。内部封装了 activations 表和
 * reportBoxes 收件箱，对外暴露：registerParent（注册父）、delegate（派 child）、
 * report（child 回传）、inbox（父读收件箱）。
 *
 * 对应源码：packages/subagent/subagent/src/continuation.ts
 *   sendToParent / sendMessage（report 的单边投递实现）
 */

import { ContinuationManager } from './manager'

export class SubagentRuntime {
  private manager = new ContinuationManager()

  /** 注册一个父 agent（返回凭据，后续操作需要它） */
  registerParent(id: string): string {
    return id
  }

  /** 派一个 continuable child（带 report 能力） */
  delegateContinuable(parentId: string): string {
    return this.manager.startContinuable(parentId)
  }

  /** 派一个一次性 child（无 report 工具） */
  delegateOneShot(parentId: string): string {
    return this.manager.startOneShot(parentId)
  }

  /** 取 child 句柄（用于干活） */
  getHandle(childId: string) {
    return this.manager.getHandle(childId)
  }

  /** child 主动回传结果给 direct parent */
  report(childId: string, content: string): { parentId: string; delivered: boolean } {
    return this.manager.reportFrom(childId, content)
  }

  /** 父读自己的 report 收件箱 */
  inbox(parentId: string) {
    return this.manager.reportsOf(parentId)
  }
}

export {}
