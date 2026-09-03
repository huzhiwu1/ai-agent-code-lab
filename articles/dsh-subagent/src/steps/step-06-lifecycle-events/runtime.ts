/**
 * Step 06 — 带事件广播的注册表（长在 step-01 的注册表骨架上）
 *
 * 渐进叙事：step-01 的 SubagentRuntime 只有 Map + start，外面的人看不到里面
 * 在发生什么。本步给它长出两个广播窗口：注册/移除 provider 时广播 added/
 * removed，start 发布后广播 start/end 事件对。
 *
 * 对应源码：packages/subagent/subagent/src/index.ts
 *   registerProvider L369-385 的 provider-added 广播 + effect 清理时的 provider-removed
 *   start L414（发布后接 observeRun，发出配对 start/end 事件）
 */

import { randomUUID } from 'node:crypto'
import { llmTask } from '../../shared/llm'
import { EventBus } from './bus'
import { observeRun, type SubagentRun, type SubagentStopReason } from './observe'

/** 带事件广播的注册表 */
export class SubagentRuntime {
  private providers = new Map<
    string,
    { name: string; start(prompt: string): Promise<SubagentRun> }
  >()
  readonly events = new EventBus()

  /** 注册 provider 并广播 provider-added（对应源码 registerProvider L369-385 的 ctx.emit） */
  registerProvider(name: string): void {
    this.providers.set(name, { name, start: (prompt: string) => this.spawnStart(prompt) })
    this.events.emit('subagent/provider-added', name)
  }

  /** 移除 provider 并广播 provider-removed（对应源码 effect 清理器里的广播） */
  removeProvider(name: string): void {
    this.providers.delete(name)
    this.events.emit('subagent/provider-removed', name)
  }

  /** 按名字派委托，发布后接 observeRun（对应源码 start L414：observeRun 包住返回的 run） */
  async start(name: string, prompt: string): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`no subagent provider registered for "${name}"`)
    const run = await provider.start(prompt)
    return observeRun(this.events, name, run)
  }

  /** spawn provider：真实 LLM 执行（对应源码 subagent-spawn-in-process） */
  private async spawnStart(prompt: string): Promise<SubagentRun> {
    const id = randomUUID()
    const result = (async () => {
      try {
        const output = await llmTask(
          '你是一个被父 agent 派来干活的子代理，直接给出结论，中文回答。',
          prompt,
        )
        return { output, stopReason: 'completed' as SubagentStopReason }
      } catch {
        return { output: '', stopReason: 'error' as SubagentStopReason }
      }
    })()
    return { id, result, async dispose() {} }
  }
}

export {}
