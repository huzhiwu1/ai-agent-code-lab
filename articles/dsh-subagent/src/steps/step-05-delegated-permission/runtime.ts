/**
 * Step 05 — 带权限快照的注册表（长在 step-01 的注册表骨架上）
 *
 * 渐进叙事：step-04 在 start() 里加了深度校验。本步在 start() 里加另一道关卡——
 * 委托边界同步捕获权限快照：captureDelegatedPolicyOverrides 钉死 approval 'never'，
 * 然后把快照写成 child log 上的持久事件。
 *
 * 对应源码：packages/subagent/subagent/src/child-agent.ts
 *   captureDelegatedPolicyOverrides L199-204 / appendDelegatedPolicyOverrides L215-225
 */

import { llmTask } from '../../shared/llm'
import {
  captureDelegatedPolicyOverrides,
  type ParentAgent,
  SUBAGENT_DELEGATION_CONTEXT,
} from './policy'
import { ChildSession, appendDelegatedPolicyOverrides } from './session'
import type { DelegatedPolicyOverrides } from './policy'

export interface SubagentRun {
  readonly id: string
  readonly overrides: DelegatedPolicyOverrides
  readonly childSession: ChildSession
  readonly result: Promise<{ output: string }>
}

export interface SubagentProvider {
  readonly name: string
  start(
    prompt: string,
    overrides: DelegatedPolicyOverrides,
    childSession: ChildSession,
  ): Promise<SubagentRun>
}

/** 带权限快照的注册表 */
export class SubagentRuntime {
  private providers = new Map<string, SubagentProvider>()

  registerProvider(provider: SubagentProvider): void {
    this.providers.set(provider.name, provider)
  }

  /**
   * 派一次委托，委托边界做三件事：
   * 1. 同步捕获权限快照（captureDelegatedPolicyOverrides）——钉死 approval 'never'
   * 2. 快照写进 child 自己的 log（appendDelegatedPolicyOverrides）——source='delegation'
   * 3. 派 child 干活（真实 LLM，system 带 delegation 声明）
   */
  async start(name: string, parent: ParentAgent, prompt: string): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`no subagent provider registered for "${name}"`)
    const overrides = captureDelegatedPolicyOverrides(parent)
    const childSession = new ChildSession()
    appendDelegatedPolicyOverrides(childSession, overrides)
    return provider.start(prompt, overrides, childSession)
  }
}

/** 沙箱化 child 执行器（真实 LLM 干活，system 带 delegation 声明） */
export class SandboxedProvider implements SubagentProvider {
  constructor(readonly name: string) {}

  async start(
    prompt: string,
    overrides: DelegatedPolicyOverrides,
    childSession: ChildSession,
  ): Promise<SubagentRun> {
    const output = await llmTask(SUBAGENT_DELEGATION_CONTEXT, prompt)
    return { id: 'sandboxed-run-1', overrides, childSession, result: Promise.resolve({ output }) }
  }
}

export {}
