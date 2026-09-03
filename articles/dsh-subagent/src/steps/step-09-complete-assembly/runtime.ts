/**
 * Step 09 — 总装 runtime：注册表 + 深度 + 权限 + 事件 + AgentHandle(07) + report(08)
 */

import { randomUUID } from 'node:crypto'
import { llmTask } from '../../shared/llm'
import { EventBus } from './event-bus'

export interface SubagentCapabilities {
  readonly persona: boolean
}

function resolveChildDepth(parentDepth: number, maxDepth: number): number {
  const childDepth = parentDepth + 1
  if (childDepth > maxDepth) throw new Error(`depth ${childDepth} exceeds maxDepth ${maxDepth}`)
  return childDepth
}

const DELEGATION_CTX =
  '你是一个被委托的子代理：权限在启动时已固定，无法从会话内部扩大。' +
  '需要审批的操作自动拒绝；超出范围的访问在回复中说明限制，让父 agent 处理。'

// ── AgentHandle：inbox FIFO + turn 循环（step-07 核心）──

class AgentHandle {
  private inbox: { id: string; content: string }[] = []
  private wake: (() => void) | null = null
  private waiters = new Map<string, () => void>()
  private output: string = ''
  status: 'running' | 'waiting' = 'waiting'

  enqueue(id: string, content: string): void {
    this.inbox.push({ id, content })
    if (this.status === 'waiting' && this.wake) this.wake()
  }

  waitTurn(id: string): Promise<void> {
    return new Promise(resolve => {
      this.waiters.set(id, resolve)
    })
  }

  get lastOutput(): string {
    return this.output
  }

  /** 驻留循环：排队 → 执行 → 再排队（学习源码 Agent 的 turn 循环） */
  async run(): Promise<void> {
    for (;;) {
      const next = this.inbox.shift()
      if (!next) {
        this.status = 'waiting'
        await new Promise<void>(r => {
          this.wake = r
        })
        this.wake = null
        this.status = 'running'
        continue
      }
      this.status = 'running'
      try {
        this.output = await llmTask('你是子代理，简短回答，中文。', next.content)
      } finally {
        this.waiters.get(next.id)?.()
        this.waiters.delete(next.id)
      }
    }
  }
}

// ── 注册表 ──

export class SubagentRuntime {
  private caps = new Map<string, SubagentCapabilities>()
  readonly events = new EventBus()
  private handles = new Map<string, AgentHandle>()
  private reportBox = new Map<string, string[]>()

  registerCapability(name: string, depth: number, caps: SubagentCapabilities): string {
    this.caps.set(name, caps)
    this.events.emit('subagent/provider-added', name)
    return name
  }

  async start(
    name: string,
    prompt: string,
    parentDepth: number,
    persona?: string,
    maxDepth = 2,
  ): Promise<string> {
    const cap = this.caps.get(name)
    if (cap === undefined) throw new Error(`no provider "${name}"`)
    if (persona !== undefined && !cap.persona)
      throw new Error(`provider "${name}" does not support persona`)

    const childDepth = resolveChildDepth(parentDepth, maxDepth)
    const runId = randomUUID()
    this.events.emit('subagent/start', { runId, provider: name, depth: childDepth })

    const handle = new AgentHandle()
    void handle.run()
    this.handles.set(runId, handle)

    const system =
      persona !== undefined ? `${DELEGATION_CTX} 你的专属人设：${persona}` : DELEGATION_CTX
    const msgId = randomUUID()
    handle.enqueue(msgId, `【delegation 声明】${system}\n【任务】${prompt}`)

    // 挂 end 钩子（await 在 followup 或 caller 里做）
    void handle.waitTurn(msgId).then(() => {
      this.events.emit('subagent/end', {
        runId,
        provider: name,
        depth: childDepth,
        stopReason: 'completed',
        output: handle.lastOutput,
      })
    })

    return runId
  }

  /** followup（step-07）：给已存在的 child 追加一轮消息 */
  async followup(runId: string, prompt: string): Promise<string> {
    const handle = this.handles.get(runId)
    if (handle === undefined) throw new Error(`child "${runId}" is not live`)
    const msgId = randomUUID()
    handle.enqueue(msgId, prompt)
    await handle.waitTurn(msgId)
    return handle.lastOutput
  }

  /** report（step-08） */
  report(childId: string, parentId: string, content: string): void {
    const box = this.reportBox.get(parentId) ?? []
    box.push(content)
    this.reportBox.set(parentId, box)
  }

  inbox(parentId: string): readonly string[] {
    return this.reportBox.get(parentId) ?? []
  }
}

export {}
