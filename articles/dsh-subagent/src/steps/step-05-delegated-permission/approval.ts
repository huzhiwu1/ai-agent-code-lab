/**
 * Step 05 — 极简审批裁决（真实 ApprovalService 的简化替身）
 *
 * 对应源码：packages/subagent/subagent/src/child-agent.ts
 *   captureDelegatedPolicyOverrides L199-204（approvalPolicy 钉死 'never'，
 *   只读父 ctx 的 approval 服务是否存在，不读父的策略）
 */

export type ApprovalPolicy = 'never' | 'ask'

export type ApprovalDecision =
  | { kind: 'denied'; reason: string } // never：确定性拒绝
  | { kind: 'pending'; reason: string } // ask：挂起等人看（后台没人看！）

/**
 * 极简审批裁决：decide 只认 policy。
 * 'never' → 确定性拒绝（对应源码 delegation 语义：要审批的操作自动拒绝，不等人）；
 * 'ask' → 挂起等待（父 agent 在 UI 前才有意义，后台 child 没有）。
 */
export function decide(policy: ApprovalPolicy, operation: string): ApprovalDecision {
  if (policy === 'never') {
    return {
      kind: 'denied',
      reason: `审批策略='never'：操作「${operation}」被自动拒绝（要审批的操作在此会话不可用）`,
    }
  }
  return {
    kind: 'pending',
    reason: `审批策略='ask'：操作「${operation}」已提交，等待人类批准……`,
  }
}

export {}
