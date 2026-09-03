/**
 * Step 07 — AgentHandle / Activation / inbox
 *
 * 对应源码：packages/subagent/subagent/src/continuation.ts
 *   Activation L188-237 / inbox 单一队列语义
 *   packages/agent（AgentHandle：执行句柄 + Agent 的 turn 循环）
 */

import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { type DurableSession } from './store'

/** 待处理消息（inbox 里的单元，对应源码 inbox 里的 Message） */
export interface InboxMessage {
  readonly messageId: string
  readonly content: string
}

/**
 * 执行句柄：一个 live Activation 持有的"活体子代理"。
 * inbox 是**唯一** turn FIFO（单一排序权威）：running 时新消息排队、waiting 时唤醒。
 */
export class AgentHandle {
  private inbox: InboxMessage[] = []
  private wake: (() => void) | null = null
  private turnWaiters = new Map<string, () => void>()
  status: 'running' | 'waiting' = 'waiting'

  constructor(readonly session: DurableSession) {}

  /** 投递进唯一 FIFO；waiting 状态立即唤醒（对应源码 inbox 单一队列语义） */
  enqueue(messageId: string, content: string): void {
    this.inbox.push({ messageId, content })
    if (this.status === 'waiting' && this.wake !== null) this.wake()
  }

  /** 等某条消息对应的 turn 完成（教学辅助：messageId → 完成信号） */
  waitTurn(messageId: string): Promise<void> {
    return new Promise(resolve => {
      this.turnWaiters.set(messageId, resolve)
    })
  }

  /** 驻留循环：排队 → 执行 → 再排队（对应源码 Agent 的 turn 循环 + inbox 单一队列） */
  async run(): Promise<void> {
    for (;;) {
      const next = this.inbox.shift()
      if (next === undefined) {
        this.status = 'waiting'
        await new Promise<void>(resolve => {
          this.wake = resolve
        })
        this.wake = null
        this.status = 'running'
        continue
      }
      this.status = 'running'
      await this.turn(next)
    }
  }

  /**
   * 一轮 turn = 一次真实 LLM 往返（对应源码 Agent 的 turn 执行）：
   * 转录全量发给模型，回答追加进持久转录；finally 里无论成败都通知本轮完成。
   */
  private async turn(message: InboxMessage): Promise<void> {
    try {
      const llm = new ChatOpenAI({
        model: process.env.LLM_MODEL || 'deepseek-v4-flash',
        configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
        apiKey: process.env.LLM_API_KEY || '',
        maxTokens: 256,
      })
      this.session.transcript.push(new HumanMessage(message.content))
      const reply = await llm.invoke([
        new SystemMessage('你是一个被持续对话的子代理。请记住对话历史并基于它回答，中文简洁作答。'),
        ...this.session.transcript,
      ])
      this.session.transcript.push(reply)
    } finally {
      this.turnWaiters.get(message.messageId)?.()
      this.turnWaiters.delete(message.messageId)
    }
  }

  /** 教学辅助：取最后一条 assistant 消息内容（演示脚本观察每轮输出用） */
  lastAssistantContent(): string {
    const transcript = this.session.transcript
    const last = transcript[transcript.length - 1]
    return last !== undefined && 'content' in last ? String(last.content) : ''
  }
}

/** live Activation：驻留期对象（进程重启即消失） */
export interface Activation {
  readonly childId: string
  readonly handle: AgentHandle
}

export {}
