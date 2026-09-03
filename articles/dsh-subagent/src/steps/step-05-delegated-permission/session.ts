/**
 * Step 05 — 简化子代理 session：append-only 日志
 *
 * 对应源码：packages/subagent/subagent/src/child-agent.ts
 *   appendDelegatedPolicyOverrides L215-225
 */

import { type DelegatedPolicyOverrides } from './policy'

/** 简化子代理 session：append-only 日志（记录 delegation 事件，供 cold resume 回放） */
export class ChildSession {
  private log: { type: string; payload: unknown }[] = []

  append(type: string, payload: unknown): void {
    this.log.push({ type, payload })
  }

  get events(): readonly { type: string; payload: unknown }[] {
    return this.log
  }
}

/**
 * 把快照写成 child 自己 log 上的持久事件（对应源码 appendDelegatedPolicyOverrides L215-225）。
 * source: 'delegation' 标记"这份策略来自委托快照"，cold resume 回放它、
 * fork seed 里可能携带的陈旧父策略输给它（追加在 seed 之后，新策略赢）。
 */
export function appendDelegatedPolicyOverrides(
  childSession: ChildSession,
  overrides: DelegatedPolicyOverrides,
): void {
  if (overrides.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' })
  }
  if (overrides.approvalPolicy !== undefined) {
    childSession.append('approval/policy', {
      policy: overrides.approvalPolicy,
      source: 'delegation',
    })
  }
}

export {}
