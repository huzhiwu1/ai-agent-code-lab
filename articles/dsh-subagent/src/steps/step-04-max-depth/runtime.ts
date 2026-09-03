/**
 * Step 04 — 带深度校验的注册表（长在 step-01 的注册表骨架上）
 *
 * 渐进叙事：step-03 的 assertCapabilities 在校验"provider 是否声明了 depthLimit"。
 * 本步把声明背后的完整机制接进来：start() 里不光查 flag，还真正执行深度校验——
 * 算 childDepth、超限拒绝、发布前抛 SubagentDepthError。
 *
 * 对应源码：packages/subagent/subagent/src/index.ts
 *   start L414（校验前置：assertCapabilities → assertSubagentMaxDepth → provider.start）
 *   packages/subagent/subagent/src/child-agent.ts resolveChildDepth L48-57
 */

import { randomUUID } from 'node:crypto'
import { llmTask } from '../../shared/llm'
import { resolveChildDepth } from './depth'

export interface SubagentRun {
  readonly id: string
  readonly depth: number
  readonly result: Promise<{ output: string }>
}

export interface SubagentProvider {
  readonly name: string
  /** 本 provider 代表的 agent 的当前深度（顶层=0，child=父+1） */
  readonly parentDepth: number
  start(prompt: string, maxDepth?: number): Promise<SubagentRun>
}

/** 带深度校验的注册表 */
export class SubagentRuntime {
  private providers = new Map<string, SubagentProvider>()

  registerProvider(provider: SubagentProvider): void {
    this.providers.set(provider.name, provider)
  }

  /**
   * 派一次委托，两步校验：
   * 1. 深度校验（resolveChildDepth）：超限 → SubagentDepthError（拒绝在发布前）
   * 2. 通过 → 发布 child，child 烙下 depth=childDepth 的 header
   */
  async start(name: string, prompt: string, maxDepth?: number): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`no subagent provider registered for "${name}"`)
    // 深度校验：超限直接抛，child 从未创建
    const childDepth = resolveChildDepth(
      { options: { subagentDepth: provider.parentDepth }, header: {} },
      maxDepth,
    )
    return provider.start(prompt, childDepth)
  }
}

/** 简单 child 执行器（真实 LLM 干活，焦点在深度校验而非回答内容） */
export class SpawnProvider implements SubagentProvider {
  constructor(
    readonly name: string,
    readonly parentDepth: number,
  ) {}

  async start(prompt: string, childDepth: number): Promise<SubagentRun> {
    const id = randomUUID()
    const result = (async () => {
      const output = await llmTask(`你是第 ${childDepth} 层子代理，简短回答，中文。`, prompt)
      return { output }
    })()
    return { id, depth: childDepth, result }
  }
}

export {}
