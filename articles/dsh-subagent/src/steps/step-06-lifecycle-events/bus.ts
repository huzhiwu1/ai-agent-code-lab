/**
 * Step 06 — 极简事件总线：on/emit + listener 隔离
 *
 * 对应源码：packages/subagent/subagent/src/lifecycle.ts
 *   createLifecycleEmitter L100-123
 */

type Listener = (payload: unknown) => void

export type EventName =
  'subagent/start' | 'subagent/end' | 'subagent/provider-added' | 'subagent/provider-removed'

export class EventBus {
  private listeners = new Map<EventName, Listener[]>()

  /** 注册一个监听器（对应源码 Cordis events 的 on/dispatch 注册语义） */
  on(name: EventName, listener: Listener): void {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
  }

  /**
   * 广播一个事件。每个 listener 独立 try/catch（对应源码 createLifecycleEmitter
   * 的 per-listener containment）：一个 observer throw 不影响其他 observer
   * 收到事件，也不影响事件源继续工作。
   */
  emit(name: EventName, payload: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      try {
        listener(payload)
      } catch (error) {
        console.warn(
          `   ⚠️ listener 隔离：${name} 的一个 listener 抛了 ${(error as Error).message}，其他 listener 不受影响`,
        )
      }
    }
  }
}

export {}
