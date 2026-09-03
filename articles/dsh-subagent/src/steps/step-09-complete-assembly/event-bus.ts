/**
 * Step 09 — 极简 EventBus（on/emit + listener 隔离）
 *
 * 学习源码 createLifecycleEmitter 的 per-listener containment：
 * 一个 observer throw 不影响其他 observer，也不影响事件源继续工作。
 */

type Listener = (payload: unknown) => void

export type EventName =
  'subagent/start' | 'subagent/end' | 'subagent/provider-added' | 'subagent/provider-removed'

export class EventBus {
  private listeners = new Map<EventName, Listener[]>()

  on(name: EventName, listener: Listener): void {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
  }

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
