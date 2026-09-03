/**
 * Step 07 — 可持续对话的注册表（封装 ContinuationManager）
 *
 * 渐进叙事：step-01 的注册表只管"一次性委托"。本步的注册表管的是"可持续 child"——
 * 派出去之后还能追加消息、跨进程重启不丢。内部封装了 Session/Activation/inbox 的
 * 所有细节，对外只暴露三个操作：delegate（派 child）、followup（追加）、restart（重启）。
 *
 * 对应源码：packages/subagent/subagent/src/continuation.ts
 *   startContinuable L403 / followup L476 / coldResume L883
 */

import { ContinuationManager, type ParentAgent, SubagentError } from './manager'

export class SubagentRuntime {
  private manager = new ContinuationManager()

  /** 注册一个父 agent（返回凭据，后续操作需要它） */
  registerParent(id: string): ParentAgent {
    return { id }
  }

  /** 派一个 durable child，返回 { childId, messageId }（不等 turn 开始） */
  delegate(parent: ParentAgent, prompt: string): { childId: string; messageId: string } {
    return this.manager.startContinuable(parent, prompt)
  }

  /** 追加一轮消息（live 入 inbox / 不在 cold resume） */
  followup(parent: ParentAgent, childId: string, content: string): string {
    return this.manager.followup(parent, childId, content)
  }

  /** 等 child 的某条消息对应 turn 完成并取回回答 */
  async replyOf(childId: string, messageId: string): Promise<string> {
    return this.manager.replyOf(childId, messageId)
  }

  /** 模拟进程重启：清空 Activation 表（内存），保留 Session 存储（磁盘） */
  simulateRestart(): void {
    this.manager.simulateRestart()
  }
}

export { SubagentError }
export {}
