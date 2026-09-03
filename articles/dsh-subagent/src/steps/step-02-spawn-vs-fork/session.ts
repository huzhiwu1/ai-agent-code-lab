/**
 * Step 02 — append-only 会话日志（简化版 Session）
 *
 * 对应源码：packages/subagent/subagent-fork-in-process/src/index.ts（completedTurnPrefix L48-54）
 *   packages/session（Session：append-only 日志，seq === 数组下标是 slice 的前提）
 */

export type SessionEvent =
  | { type: 'turn/start' }
  | { type: 'turn/end' }
  | { type: 'user/message'; content: string }
  | { type: 'assistant/message'; content: string }
  | { type: 'tool/call'; name: string; arguments: string }
  | { type: 'tool/result'; content: string }

/**
 * append-only 日志（沿用 dsh-memory step-01 的 Session 简化版）。
 * append 契约：只追加不修改，数组下标 = 事件 seq（对应源码 Session 的 append 契约，
 * completedTurnPrefix 的 slice 依赖这个不变式）。
 */
export class Session {
  private log: SessionEvent[] = []

  append(event: SessionEvent): void {
    this.log.push(event)
  }

  get events(): readonly SessionEvent[] {
    return this.log
  }
}

export {}
