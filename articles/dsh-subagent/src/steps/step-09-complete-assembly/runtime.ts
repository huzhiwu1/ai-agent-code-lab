/**
 * Step 09 — 总装注册表：注册表 + 深度 + 权限 + 事件 + 持久 + report
 *
 * 把 1-7 步的机制全部串接：start() 内做四件事，此外还有 store（持久存储）
 * 和 report（回传）——分别对应 step-07 的 cold resume 和 step-08 的显式回传。
 */

import { randomUUID } from 'node:crypto'
import { llmTask } from '../../shared/llm'
import { EventBus } from './event-bus'

// ── 类型 ──

export interface SubagentCapabilities {
  readonly persona: boolean
}

export interface SubagentRun {
  readonly id: string
  readonly depth: number
  readonly result: Promise<{ output: string }>
}

export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly parentDepth: number
  start(prompt: string, childDepth: number): Promise<SubagentRun>
}

// ── 深度记账（简化版，学习源码 depth.ts）──

function resolveChildDepth(parentDepth: number, maxDepth: number): number {
  const childDepth = parentDepth + 1
  if (childDepth > maxDepth) throw new Error(`depth ${childDepth} exceeds maxDepth ${maxDepth}`)
  return childDepth
}

// ── 权限快照（简化版，学习源码 child-agent.ts）──

const SUBAGENT_DELEGATION_CONTEXT =
  '你是一个被委托的子代理：你的权限范围在启动时已固定，无法从会话内部自行扩大——' +
  '需要审批的操作会被自动拒绝。当任务需要超出此范围的访问时，不要重试被拒操作；' +
  '在回复中说明限制，让委托你的父 agent 来处理。'

// ── 注册表 ──

export class SubagentRuntime {
  private providers = new Map<string, SubagentProvider>()
  readonly events = new EventBus()

  // ── 持久存储（step-07：cold resume 的基座，重启不丢）──
  private store = new Map<string, string>()
  // ── report 收件箱（step-08：child → parent 显式回传）──
  private reportBox = new Map<string, string[]>()

  registerProvider(provider: SubagentProvider): void {
    this.providers.set(provider.name, provider)
    this.events.emit('subagent/provider-added', provider.name)
  }

  /**
   * 总装 start：深度校验 → 权限快照 → 事件广播 → 派 child
   */
  async start(name: string, prompt: string, persona?: string, maxDepth = 2): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`no subagent provider registered for "${name}"`)

    // ① 能力声明校验（step-03：persona 需要 provider 声明）
    if (persona !== undefined && !provider.capabilities.persona) {
      throw new Error(`provider "${name}" does not support persona capability`)
    }

    // ② 深度校验（step-04：超限拒绝）
    const childDepth = resolveChildDepth(provider.parentDepth, maxDepth)

    const runId = randomUUID()
    // ③ 事件广播（step-06：start/end 配对）
    this.events.emit('subagent/start', { runId, provider: name, depth: childDepth })

    // ④ 权限快照（step-05：delegation 声明 + system prompt）
    const system =
      persona !== undefined
        ? `${SUBAGENT_DELEGATION_CONTEXT} 你的专属人设：${persona}`
        : SUBAGENT_DELEGATION_CONTEXT

    const run = await provider.start(`【delegation 声明】${system}\n【任务】${prompt}`, childDepth)

    // 挂 end 钩子
    void run.result.then(result => {
      // 持久化 child 的回答（step-07：cold resume 从它恢复）
      this.store.set(runId, result.output)
      this.events.emit('subagent/end', {
        runId,
        provider: name,
        depth: childDepth,
        stopReason: 'completed',
        output: result.output,
      })
    })

    return run
  }

  /** 模拟 cold resume（step-07）：从持久存储恢复 child 的回答 */
  recall(runId: string): string | undefined {
    return this.store.get(runId)
  }

  /** report 回传（step-08）：child 把结果送回 direct parent */
  report(childId: string, parentId: string, content: string): void {
    const inbox = this.reportBox.get(parentId) ?? []
    inbox.push(content)
    this.reportBox.set(parentId, inbox)
  }

  /** 父读自己的 report 收件箱（step-08） */
  inbox(parentId: string): readonly string[] {
    return this.reportBox.get(parentId) ?? []
  }
}

// ── Provider ──

export class ChildProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { persona: true }

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
