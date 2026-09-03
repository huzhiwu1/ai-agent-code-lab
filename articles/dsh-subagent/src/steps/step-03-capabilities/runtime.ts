/**
 * Step 03 — 注册表 + 能力校验（长在 step-01 的注册表骨架上）
 *
 * 渐进叙事：step-01 的 start() 是"找到 provider 就派"。本步在"派"之前插入了
 * 一段新关卡：assertCapabilities——请求用到的每个字段，provider 必须声明支持。
 * 这就是渐进式生长：不是重写注册表，而是给 start() 加一道门。
 *
 * 对应源码：packages/subagent/subagent/src/index.ts
 *   assertCapabilities L481-496
 */

import {
  SubagentError,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentRun,
  type SubagentStartRequest,
} from './types'

/** 注册表（本步只保留 start + 校验，其余见 Step 01） */
export class SubagentRuntime {
  private providers = new Map<string, SubagentProvider>()

  /** 注册 provider（对应源码 registerProvider L369；本步省略重名/广播，聚焦校验） */
  registerProvider(provider: SubagentProvider): void {
    this.providers.set(provider.name, provider)
  }

  /**
   * 委托前逐一校验（学习源码 start L414 的校验前置）：
   * 1. 先找到 provider（不存在 → NO_PROVIDER）；
   * 2. assertCapabilities 检查"请求用到的字段 vs provider 声明的 flag"；
   * 3. 全部通过才把请求交给 provider.start()——拒绝发生在委托之前，child 从未创建。
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined)
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    this.assertCapabilities(provider, request)
    return provider.start(request)
  }

  /**
   * 拒绝第一个"请求需要但 provider 没声明"的能力（学习源码 L482-495 的 needs 循环）。
   * 机制拆解：
   * - needs 表把"请求字段 → 能力名"的映射写显式：字段存在（when）就查对应 flag；
   * - 请求没带的字段**不会被查**（provider 多声明的能力不碍事）；
   * - 发现第一个缺口立刻 throw，不做聚合报告——fail loud 只要"最早的一声响"；
   * - 注意边界：这里只对照"请求 vs 声明"，验证不了"声明 vs 实现"（见 BrokenProvider）。
   */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.agentOptions !== undefined, cap: 'agentOptions' },
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
      { when: request.toolFilter !== undefined, cap: 'toolFilter' },
      { when: request.persona !== undefined, cap: 'persona' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new SubagentError(
          `subagent provider "${provider.name}" does not support the "${cap}" capability`,
          'UNSUPPORTED_CAPABILITY',
        )
      }
    }
  }
}

export {}
