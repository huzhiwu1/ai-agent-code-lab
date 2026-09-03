/**
 * Step 06 — observeRun：run 的一生 = 一对同 runId 的 start/end 事件
 *
 * 对应源码：packages/subagent/subagent/src/lifecycle.ts
 *   observeRun L133-162
 *   packages/subagent/subagent/src/types.ts
 *   SubagentRunInfo L36-50 / SubagentRunEndInfo L56-73
 */

import { randomUUID } from 'node:crypto'
import { type EventBus } from './bus'

export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** subagent/start 的 payload（对应源码 types.ts SubagentRunInfo L36-50） */
export interface SubagentRunInfo {
  readonly runId: string
  readonly provider: string
  readonly id: string
}

/** subagent/end 的 payload：与 start 同 runId 配对（对应源码 SubagentRunEndInfo L56-73） */
export interface SubagentRunEndInfo extends SubagentRunInfo {
  readonly stopReason: SubagentStopReason
  readonly lastAssistantMessage?: string
}

/** 简化 run：与 Step 01 的 SubagentRun 同构（对应源码 types.ts SubagentRun L249） */
export interface SubagentRun {
  readonly id: string
  readonly result: Promise<{ output: string; stopReason: SubagentStopReason }>
  dispose(): Promise<void>
}

/**
 * 把 run 的一生包成一对事件（对应源码 observeRun L133-162）：
 * start 事件先同步发出；result 结算时（无论成功失败）发出配对的 end 事件。
 */
export function observeRun(events: EventBus, provider: string, run: SubagentRun): SubagentRun {
  const identity: SubagentRunInfo = { runId: randomUUID(), provider, id: run.id }
  // 先挂 end 钩子再发 start：保证任何结算都发生在 start 之后（start → end 顺序不破）
  void run.result.then(
    result => {
      events.emit('subagent/end', {
        ...identity,
        stopReason: result.stopReason,
        ...(result.output.length > 0 ? { lastAssistantMessage: result.output } : {}),
      })
    },
    () => {
      events.emit('subagent/end', { ...identity, stopReason: 'error' })
    },
  )
  events.emit('subagent/start', identity)
  return run
}

export {}
