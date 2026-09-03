/**
 * Step 05 — 权限快照：委托边界捕获 + child log 持久 + delegation 声明
 *
 * 对应源码：packages/subagent/subagent/src/child-agent.ts
 *   captureDelegatedPolicyOverrides L199-204 / appendDelegatedPolicyOverrides L215-225
 *   SUBAGENT_DELEGATION_CONTEXT L135-139
 */

/** sandbox 三档模式（对应源码 dsh-sandbox 的 SandboxMode） */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 委托边界捕获的权限快照（对应源码 DelegatedPolicyOverrides L178-187） */
export interface DelegatedPolicyOverrides {
  readonly sandboxMode: SandboxMode | undefined
  /** 只要审批服务存在就钉死 'never'——后台 child 的审批升级是"没人看的阻塞" */
  readonly approvalPolicy: 'never' | undefined
}

/**
 * 简化父 agent：session 上带一个"显式 sandbox override"。
 * 对应源码 Agent（真实实现读 parent.ctx 的 sandboxPolicy 服务）。
 */
export interface ParentAgent {
  readonly id: string
  /** 显式 override：只有父自己主动设置过才有值（对应源码 overrideOf） */
  readonly explicitSandboxOverride: SandboxMode | undefined
}

/**
 * 委托边界同步捕获权限快照（对应源码 captureDelegatedPolicyOverrides L199-204）。
 * 只捕获父的**显式** sandbox override（不捕获部署默认值/一次性授权）；
 * approval 不管父是什么策略，一律钉死 'never'。
 */
export function captureDelegatedPolicyOverrides(parent: ParentAgent): DelegatedPolicyOverrides {
  return {
    sandboxMode: parent.explicitSandboxOverride,
    approvalPolicy: 'never',
  }
}

/**
 * child system prompt 里的 delegation 声明（对应源码 SUBAGENT_DELEGATION_CONTEXT L135-139）。
 * 逐句对应源码：
 *   - 权限范围在启动时就固定，会话内无法自行扩大
 *   - 需要审批的操作会被自动拒绝
 *   - 任务需要超出范围的访问时，不要重试被拒操作，在回复里说明限制，让父 agent 处理
 */
export const SUBAGENT_DELEGATION_CONTEXT =
  '你是一个被委托的子代理：你的权限范围在启动时已固定，无法从会话内部自行扩大——' +
  '需要审批的操作会被自动拒绝。当任务需要超出此范围的访问时，不要重试被拒操作；' +
  '在回复中说明限制，让委托你的父 agent 来处理。'

export {}
