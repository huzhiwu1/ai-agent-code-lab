/**
 * Step 02 — completedTurnPrefix：fork 的 seed 计算（对应源码 L48-54）
 *
 * 对应源码：packages/subagent/subagent-fork-in-process/src/index.ts
 *   completedTurnPrefix L48-54
 */

import { type SessionEvent, type Session } from './session'

/**
 * fork 的 seed 计算：已完成 turn 前缀（对应源码 completedTurnPrefix L48-54）。
 * 截到**最后一个** turn/end（含它本身）：它之后如果有事件，必然是 in-flight
 * turn 的开头——turn 没收尾，事件不平衡，不能作为合法回放历史。
 * 没有任何已完成 turn → 返回空数组（child 从零开始，等价 fresh）。
 */
export function completedTurnPrefix(session: Session): SessionEvent[] {
  const events = session.events
  // 等价于源码的 events.findLast(e => e.type === 'turn/end')（lib 仅 ES2022，手写回扫）
  let lastEnd = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') {
      lastEnd = i
      break
    }
  }
  if (lastEnd === -1) return []
  // seq === 数组下标（append 契约），所以直接 slice 到最后一个 turn/end（含）
  return events.slice(0, lastEnd + 1)
}

/**
 * 只把"模型可见"的事件渲染成文本（user/assistant/tool result 才有对话意义）。
 * 对应源码 fork provider 的 seed 回放（deriveMessages 的简化版：把 seed 事件
 * 变成模型能读的对话文字，tool/call 等内部事件不进回放）。
 */
export function visibleText(events: readonly SessionEvent[]): string[] {
  const lines: string[] = []
  for (const e of events) {
    if (e.type === 'user/message') lines.push(`👤 父：${e.content}`)
    else if (e.type === 'assistant/message') lines.push(`🤖 父 agent：${e.content}`)
    else if (e.type === 'tool/result') lines.push(`🔧 工具结果：${e.content}`)
  }
  return lines
}

/** 把 seed 历史拼成一段给模型的"回放文字"（简化版 deriveMessages 的用途） */
export function seedAsText(seed: readonly SessionEvent[]): string {
  return visibleText(seed).join('\n')
}

export {}
