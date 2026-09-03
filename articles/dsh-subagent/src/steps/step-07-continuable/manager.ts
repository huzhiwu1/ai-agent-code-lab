/**
 * Step 07 — 续对话管理器（学习源码 SubagentContinuationManager）
 *
 * 渐进叙事：step-01 的 run 是"一次委托一个结果"。本步长出"可持续 child"的
 * 管理骨架：startContinuable（建 Session + Activation）→ followup（live 入
 * inbox / 不在 cold resume）→ 授权（exact live direct parent）。
 *
 * 对应源码：packages/subagent/subagent/src/continuation.ts
 *   startContinuable L403 / followup L476 / coldResume L883 / authorizeLineage L1434
 */

import { randomUUID } from 'node:crypto'
import { SessionStore, type DurableSession } from './store'
import { AgentHandle, type Activation } from './activation'

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

export interface ParentAgent {
  readonly id: string
}

export class ContinuationManager {
  /** live Activation 表：模拟"进程内存"——重启时清空它 */
  private activations = new Map<string, Activation>()
  /** 持久 Session 存储：模拟"磁盘"——重启不清空 */
  private readonly store = new SessionStore()

  /**
   * 建立 durable child 并把初始 prompt 投进 inbox（对应源码 startContinuable L403）。
   * 返回 { childId, messageId } 时只代表"inbox 接受了"，不等 turn 开始。
   */
  startContinuable(
    parent: ParentAgent,
    initialPrompt: string,
  ): { childId: string; messageId: string } {
    const childId = randomUUID()
    const session: DurableSession = { id: childId, parentSession: parent.id, transcript: [] }
    this.store.save(session)
    this.materialize(session)
    const messageId = this.submitMaterialized(childId, initialPrompt)
    return { childId, messageId }
  }

  /**
   * 追加一轮消息（对应源码 followup L476）。三分支：
   * live Activation 在 → 授权后直接入 inbox（running 排队 / waiting 唤醒）；
   * 不在 → cold resume（从持久 Session 重建 Activation）。
   * 两条路径都先过授权（对应源码 submitAdmitted L1198 的 authorizeLineage）。
   */
  followup(parent: ParentAgent, childId: string, content: string): string {
    const live = this.activations.get(childId)
    if (live !== undefined) {
      this.authorizeLineage(parent, live.handle.session)
      const state = live.handle.status
      const messageId = this.submitMaterialized(childId, content)
      console.log(
        `   → live Activation 在（状态=${state}）：消息直接入唯一 inbox ${state === 'waiting' ? '并唤醒' : '排队'}`,
      )
      return messageId
    }
    console.log('   → live Activation 不在：cold resume（从持久 Session 重建 Activation）')
    return this.coldResume(parent, childId, content)
  }

  /** 模拟进程重启：清空 Activation 表（内存没了），Session 存储保留（磁盘还在） */
  simulateRestart(): void {
    this.activations.clear()
  }

  /** 从持久 Session 重建 live Activation（对应源码 coldResume L883） */
  private coldResume(parent: ParentAgent, childId: string, content: string): string {
    const session = this.store.load(childId)
    if (session === undefined) {
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE')
    }
    this.authorizeLineage(parent, session)
    this.materialize(session)
    return this.submitMaterialized(childId, content)
  }

  /** 授权：调用者必须是 durable child 记录里的 exact live direct parent */
  private authorizeLineage(parent: ParentAgent, session: DurableSession): void {
    if (session.parentSession !== parent.id) {
      throw new SubagentError(
        `agent "${parent.id}" is not the direct parent of subagent "${session.id}"; followup denied`,
        'UNAUTHORIZED',
      )
    }
  }

  /** 创建 handle 并启动驻留循环（对应源码 materialize L966） */
  private materialize(session: DurableSession): void {
    const handle = new AgentHandle(session)
    void handle.run()
    this.activations.set(session.id, { childId: session.id, handle })
  }

  /** 投递进 inbox 并返回 messageId（对应源码 submitMaterialized） */
  private submitMaterialized(childId: string, content: string): string {
    const activation = this.activations.get(childId)
    if (activation === undefined)
      throw new SubagentError(`subagent "${childId}" is not live`, 'NOT_RESUMABLE')
    const messageId = randomUUID()
    activation.handle.enqueue(messageId, content)
    return messageId
  }

  /** 教学辅助：等指定 child 的某条消息对应 turn 完成并取回最终回答 */
  async replyOf(childId: string, messageId: string): Promise<string> {
    const activation = this.activations.get(childId)
    if (activation === undefined) return ''
    await activation.handle.waitTurn(messageId)
    return activation.handle.lastAssistantContent()
  }
}

export {}
