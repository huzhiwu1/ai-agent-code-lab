/**
 * Step 09 — 总装 runtime：注册表 + 深度 + 权限 + 事件 + AgentHandle(07) + report(08)
 * 冷恢复 + 授权 + prepareContinuable + monotone floor + child log 持久事件
 */

import { randomUUID } from 'node:crypto'
import { llmTask } from '../../shared/llm'
import { EventBus } from './event-bus'

export interface SubagentCapabilities {
  readonly persona: boolean
  /** 可选方法 = continuable 能力（step-03）：方法存在即能力，不设 flag */
  readonly prepareContinuable?: boolean
}

// ── 深度（step-04）+ monotone floor ──

function resolveChildDepth(parentDepth: number, headerDepth: number, maxDepth: number): number {
  // monotone floor：header 是下限，运行时只能加深不能减轻（step-04）
  const effective = Math.max(headerDepth, parentDepth)
  const childDepth = effective + 1
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
  /** 持久转录（step-07：Session 的 transcript，跨重启不丢） */
  transcript: string[] = []
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
        this.transcript.push(`Q: ${next.content.slice(0, 60)}…`, `A: ${this.output.slice(0, 60)}…`)
      } finally {
        this.waiters.get(next.id)?.()
        this.waiters.delete(next.id)
      }
    }
  }
}

// ── 持久存储（step-07：cold resume 的基座）──

interface DurableSession {
  readonly parentId: string
  readonly transcript: string[]
}

// ── 注册表 ──

export class SubagentRuntime {
  private caps = new Map<string, SubagentCapabilities>()
  readonly events = new EventBus()
  private handles = new Map<string, AgentHandle>()
  private reportBox = new Map<string, string[]>()
  /** 持久 Session 存储（step-07：模拟"磁盘"，重启不丢） */
  private store = new Map<string, DurableSession>()
  /** child log 持久事件（step-05：source='delegation'） */
  private childLogs = new Map<string, { type: string; payload: unknown }[]>()

  registerCapability(name: string, depth: number, caps: SubagentCapabilities): string {
    this.caps.set(name, caps)
    this.events.emit('subagent/provider-added', name)
    return name
  }

  async start(
    name: string,
    prompt: string,
    parentDepth: number,
    parentId: string,
    headerDepth = 0,
    persona?: string,
    maxDepth = 2,
  ): Promise<string> {
    const cap = this.caps.get(name)
    if (cap === undefined) throw new Error(`no provider "${name}"`)
    if (persona !== undefined && !cap.persona)
      throw new Error(`provider "${name}" does not support persona`)

    // monotone floor（step-04）：header 是下限，重启不能降低
    const childDepth = resolveChildDepth(parentDepth, headerDepth, maxDepth)
    const runId = randomUUID()
    this.events.emit('subagent/start', { runId, provider: name, depth: childDepth })

    // child log 持久事件（step-05）：委托边界写入，source='delegation'
    const log: { type: string; payload: unknown }[] = []
    log.push({ type: 'sandbox/mode', payload: { source: 'delegation' } })
    log.push({ type: 'approval/policy', payload: { policy: 'never', source: 'delegation' } })
    this.childLogs.set(runId, log)

    const handle = new AgentHandle()
    void handle.run()
    this.handles.set(runId, handle)

    // 持久化 Session（step-07：cold resume 从它恢复）
    this.store.set(runId, { parentId, transcript: handle.transcript })

    const system =
      persona !== undefined ? `${DELEGATION_CTX} 你的专属人设：${persona}` : DELEGATION_CTX
    const msgId = randomUUID()
    handle.enqueue(msgId, `【delegation 声明】${system}\n【任务】${prompt}`)

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

  /** 获取 child 的持久事件日志（step-05） */
  getChildLog(runId: string): { type: string; payload: unknown }[] {
    return this.childLogs.get(runId) ?? []
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

  /** 模拟进程重启：清空 Activation 表（内存），Session 保留（磁盘）（step-07） */
  simulateRestart(_parentId: string): void {
    for (const [runId, handle] of this.handles) {
      // 持久化最新转录到 store
      const session = this.store.get(runId)
      if (session) this.store.set(runId, { ...session, transcript: handle.transcript })
    }
    this.handles.clear()
  }

  /**
   * coldResume（step-07）：从持久 Session 重建 child，并校验授权
   * 只有 exact live direct parent 能继续它（authorizeLineage）
   */
  async coldResume(runId: string, parentId: string, prompt: string): Promise<string> {
    const session = this.store.get(runId)
    if (session === undefined) throw new Error(`child "${runId}" is unavailable (NOT_RESUMABLE)`)

    // authorizeLineage（step-07）：只有持久记录的 direct parent 能继续
    if (session.parentId !== parentId)
      throw new Error(`agent "${parentId}" is not the direct parent of "${runId}" (UNAUTHORIZED)`)

    // 重建 Activation（step-07：materialize）
    const handle = new AgentHandle()
    handle.transcript = session.transcript
    void handle.run()
    this.handles.set(runId, handle)

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
