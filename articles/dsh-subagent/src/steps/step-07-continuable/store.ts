/**
 * Step 07 — 持久 Session 存储（模拟"磁盘"）
 *
 * 对应源码：packages/subagent/subagent/src/continuation.ts
 *   startContinuable L403（先落持久 Session）/ coldResume L883（从持久层加载重建）
 *   packages/session-persistence（SessionPersistence：真实的持久化接口）
 */

import type { BaseMessage } from '@langchain/core/messages'

/** 持久 Session：身份 + 转录 + lineage（对应源码 DurableSession：进程重启不丢的东西都在这） */
export interface DurableSession {
  readonly id: string
  /** 直接父的 id（对应源码 header.parentSession）：冷恢复授权的依据 */
  readonly parentSession: string
  /** 对话转录：模型的全部上下文 */
  readonly transcript: BaseMessage[]
}

/**
 * 持久存储：教学简化用内存 Map 模拟"落库"——"重启"只清 Activation 表，不清它。
 * 对应源码 SessionPersistence 的角色（save/load 语义一致，实现是内存版）。
 */
export class SessionStore {
  private sessions = new Map<string, DurableSession>()

  /** 落库（对应源码 SessionPersistence 的保存语义） */
  save(session: DurableSession): void {
    this.sessions.set(session.id, session)
  }

  /** 读盘（对应源码 SessionPersistence 的加载语义） */
  load(id: string): DurableSession | undefined {
    return this.sessions.get(id)
  }
}

export {}
