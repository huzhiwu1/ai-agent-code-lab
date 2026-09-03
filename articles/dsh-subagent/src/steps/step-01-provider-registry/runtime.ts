/**
 * Step 01 — 注册表：SubagentRuntime（学习源码 index.ts）
 *
 * 渐进叙事：这是 8 步的起点——只有"按名字注册、按名字派单"的最小闭环。
 * 后续步骤会在这个骨架上逐步长出新能力：step-03 在 start() 里长出能力校验，
 * step-06 长出事件广播。本步只解决一个问题：怎么派、怎么拒绝不存在的名字。
 *
 * 对应源码：packages/subagent/subagent/src/index.ts
 *   registerProvider L369 / list L400 / start L414 / expectProvider L449
 */

import {
  SubagentError,
  type SubagentProvider,
  type SubagentRun,
  type SubagentStartRequest,
} from './types'

/** 按名字注册 provider 的子代理服务 */
export class SubagentRuntime {
  private providers = new Map<string, SubagentProvider>()

  /** 注册一个 provider；同名重复注册 → 报错（对应源码 registerProvider L369） */
  registerProvider(provider: SubagentProvider): void {
    if (this.providers.has(provider.name)) {
      throw new SubagentError(
        `a subagent provider named "${provider.name}" is already registered`,
        'DUPLICATE_PROVIDER',
      )
    }
    this.providers.set(provider.name, provider)
  }

  /** 按名字查 provider（对应源码 getProvider L533）；不存在返回 undefined，由调用方决定报错 */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /** 按插入顺序列出已注册的名字（对应源码 list L400） */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * 按名字派一次委托（对应源码 start L414）。
   * 注意发布边界：provider.start() reject = 这次委托从未发布，调用方拿不到 run、
   * 也无需清理；一旦兑现，所有权转移，之后的一切结局都通过 run.result 结算。
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      // 对应源码 expectProvider L449：不存在的名字 → fail loud
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    return provider.start(request)
  }
}

/** 全局单例：各演示场景共享同一个注册表 */
export const runtime = new SubagentRuntime()

export {}
