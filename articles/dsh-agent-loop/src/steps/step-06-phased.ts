/**
 * Step 06 – 完整状态机：Phase 生命周期 + TurnEndReason
 *
 * 学习目标：理解 Agent 不是无状态死循环，它有完整的生命周期管理。
 * Step 04 只讲了 TurnEndReason（这一步怎么结束），
 * Step 06 补上 Phase 状态机（Agent 什么时候能跑、什么时候不能跑）。
 *
 * 对应源码 agent.ts：
 *   - Phase 状态机 → agent.ts:37-53（idle / running / maintenance）
 *   - wakeDriver() → agent.ts:163-183（latch + 收敛重放）
 *   - kick() → agent.ts:197-210（外部驱动 while 循环）
 *   - cancel() → agent.ts:148-155（清 inbox + abort signal）
 *   - TurnEndReason → agent.ts:245-329（turn 结束状态）
 *   - max-tokens 粘性 → agent.ts:285-290
 *
 * 关键机制（在 Step 04 基础上新增）：
 *   - Phase 状态机：idle（空闲）↔ running（工作）↔ idle
 *   - 每次 turn 结束换新 AbortController，旧信号上的 latch 失效
 *   - 取消收敛窗口：abort() 后驱动还在收敛，此时到的唤醒被 latch
 *   - kick() 的 finally 块：收敛到 idle 后重放 latch 的唤醒
 *
 * 对应设计笔记：
 *   - 2026-08-07 cancel-convergence-wake-latch（取消收敛窗口唤醒锁存）
 *   - 2026-07-16 explicit-turn-cancellation（显式 turn 取消）
 *   - 2026-07-31 claimed-pre-step-inbox-lifecycle（claim + preStep 决策）
 *
 * 跑法：pnpm run step:06
 */

import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'

// ─── 类型定义 ────────────────────────────────────────────────────────

/**
 * Phase 状态机，对应 agent.ts:37-53
 *
 * idle：空闲，可接收新 turn
 * running：正在跑一个 driver（含 turn/step 计数 + AbortController）
 * maintenance：后台任务（如持久化），此时新唤醒被 latch
 */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** Turn 结束原因，对应 agent.ts 的 TurnEndReason 联合类型 */
type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'max-tokens' } // 输出触顶（粘性）
  | { kind: 'aborted' } // 被取消
  | { kind: 'blocked' } // preStep 拒绝
  | { kind: 'error'; error: Error }

interface ToolEntry {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

/**
 * max-tokens 粘性合并：
 *   - turnEnds 已触顶（max-tokens）→ 保持触顶，不被后续正常 step 降级
 *   - 否则用当前 step 的结果
 */
function mergeTurnEnds(
  current: TurnEndReason | null,
  next: TurnEndReason | null,
): TurnEndReason | null {
  if (current !== null && current.kind === 'max-tokens') return current
  return next
}

// ─── StatefulAgent ───────────────────────────────────────────────────

/**
 * StatefulAgent – 带完整状态机的 Agent 循环
 *
 * 在 Step 04 的 TurnEndReason 基础上，新增：
 *   - Phase 状态机（idle/running）
 *   - 外部驱动 kick() + wakeDriver()
 *   - 取消收敛窗口 latch
 *   - 每 turn 换新 AbortController
 */
class StatefulAgent {
  private messages: BaseMessage[] = []
  private inbox: BaseMessage[] = []
  private tools: Map<string, ToolEntry> = new Map()
  private llm: ChatOpenAI
  private phase: Phase

  constructor(
    modelName = process.env.LLM_MODEL || 'deepseek-v4-flash',
    baseUrl = process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    apiKey = process.env.LLM_API_KEY || '',
  ) {
    this.llm = new ChatOpenAI({
      model: modelName,
      configuration: { baseURL: baseUrl },
      apiKey,
      maxTokens: 1024,
    })
    this.phase = { kind: 'idle', lastTurn: 0 }
  }

  registerTool(entry: ToolEntry): void {
    this.tools.set(entry.name, entry)
  }

  /** 发送消息并唤醒，对应 agent.ts followup() */
  send(message: string): void {
    this.inbox.push(new HumanMessage(message))
    this.wakeDriver()
  }

  // ── Phase 状态机 ──────────────────────────────────────────────────
  //
  // 对应 agent.ts:163-183 的 wakeDriver()：
  //   - idle → 直接启动驱动
  //   - running/aborted → latch 唤醒信号，收敛后重放
  //   - maintenance → latch 唤醒信号，任务结束后重放
  //
  // 关键设计（来自 cancel-convergence-wake-latch 笔记）：
  //   cancel() 返回后 abort 信号已触发，但 LLM stream teardown、
  //   工具取消、turn/end 写入都还在异步进行中。
  //   此时到达的唤醒信号如果直接丢弃，消息就永远停在队列里。
  //   latch 机制：把唤醒信号暂存，等驱动收敛到 idle 后自动重放。

  private wakeDriver(): void {
    if (this.phase.kind !== 'idle') {
      // 驱动还在跑或正在收敛 → latch 唤醒信号
      if (this.phase.kind === 'running') {
        this.phase.wakeRequested = true
      }
      return
    }
    // idle → running：启动新驱动
    this.phase = {
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    }
    this.kick()
  }

  /** 取消当前 turn，对应 agent.ts cancel() */
  cancel(): void {
    this.inbox = []
    if (this.phase.kind === 'running') {
      this.phase.wakeRequested = false
      this.phase.abort.abort(new Error('user cancelled'))
    }
  }

  /**
   * 外部驱动入口，对应 agent.ts:197-210 的 kick()：
   *   while (await this.turn()) {}
   *
   * 关键设计：kick() 的 finally 块在收敛到 idle 后
   * 检查 latch 并重放——这是取消收敛窗口唤醒的核心机制。
   */
  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {
        /* 消费 inbox 直到队列为空 */
      }
    } catch {
      console.log('  ⚠️  驱动层捕获错误，不影响后续 turn')
    } finally {
      // 对应 agent.ts kick() 的 finally：收敛到 idle 后重放 latch
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.phase = { kind: 'idle', lastTurn: turn }
        if (wakeRequested && this.inbox.length > 0) this.wakeDriver()
      }
    }
  }

  // ── 主循环 ────────────────────────────────────────────────────────

  /**
   * 一次 turn，对应 agent.ts:245-329 的 turn()
   *
   * 在 Step 04 基础上新增：
   *   - Phase 检查（只在 running 时执行）
   *   - 每 turn 结束换新 AbortController
   *   - blocked 结束原因（preStep 拒绝）
   *   - turn/start 和 turn/end 的 Phase 生命周期管理
   */
  private async turn(): Promise<boolean> {
    if (this.inbox.length === 0) return false
    if (this.phase.kind !== 'running') return false

    const phase = this.phase
    const { signal } = phase.abort

    // 对应 agent.ts: 递增 turn 号
    phase.turn = phase.turn + 1
    phase.step = 0
    console.log(`\n🔄 === Turn ${phase.turn} 开始 ===\n`)

    // 消费 inbox
    while (this.inbox.length > 0) {
      this.messages.push(this.inbox.shift()!)
    }

    let turnEnds: TurnEndReason | null = null
    let needAnotherStep = false

    try {
      while (true) {
        if (signal.aborted) {
          turnEnds = { kind: 'aborted' }
          break
        }

        phase.step++
        const stepEnd = await this.step()

        // step() 返回 null = 工具结果已回填，需要继续循环
        if (stepEnd === null) {
          needAnotherStep = true
          continue
        }

        // max-tokens 粘性
        turnEnds = mergeTurnEnds(turnEnds, stepEnd)

        if (needAnotherStep && turnEnds?.kind === 'completed') {
          needAnotherStep = false
          continue
        }

        break
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted' }
      } else {
        turnEnds = {
          kind: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    }

    console.log(`\n🔄 === Turn ${phase.turn} 结束 (${turnEnds?.kind ?? 'unknown'}) ===\n`)

    // 对应 agent.ts: 换新 AbortController，旧 latch 失效
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0

    return this.inbox.length > 0
  }

  /** 一次 step：调模型 → 工具回路 → 返回结束原因 */
  private async step(): Promise<TurnEndReason> {
    try {
      const systemPrompt = new SystemMessage(
        '你是一个 AI Agent，可以调用工具完成任务。当用户需要查询天气或计算时，调用对应工具。',
      )
      const llmMessages: BaseMessage[] = [systemPrompt, ...this.messages]

      const toolBindings = this.buildToolBindings()
      const llmWithTools = toolBindings.length > 0 ? this.llm.bindTools(toolBindings) : this.llm

      console.log(`  ⚡ 调 LLM ...`)
      const result = await llmWithTools.invoke(llmMessages)

      const finishReason: string =
        ((result.response_metadata as Record<string, unknown> | undefined)
          ?.finish_reason as string) ?? 'stop'

      const toolCalls = result.tool_calls || []
      this.messages.push(result)

      if (finishReason === 'length' || finishReason === 'max_tokens') {
        console.log(`  ⚠️  输出触顶（finish_reason=${finishReason}）→ max-tokens`)
        return { kind: 'max-tokens' }
      }

      if (toolCalls.length === 0) {
        const content =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        console.log(`  💬 回答: ${content.substring(0, 80)}`)
        return { kind: 'completed' }
      }

      console.log(`  📨 ${toolCalls.length} 个工具调用`)
      for (const tc of toolCalls) {
        console.log(`  🛠️  执行: ${tc.name}(${JSON.stringify(tc.args)})`)
        const entry = this.tools.get(tc.name)
        let resultContent: string
        if (entry) {
          try {
            resultContent = await entry.execute(tc.args as Record<string, unknown>)
          } catch (e: unknown) {
            resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
          }
        } else {
          resultContent = `Error: 未知工具 "${tc.name}"`
        }
        console.log(`  ✅ 结果: ${resultContent.substring(0, 60)}`)
        this.messages.push(new ToolMessage({ content: resultContent, tool_call_id: tc.id ?? '' }))
      }

      return null as unknown as TurnEndReason
    } catch (e: unknown) {
      if (this.phase.kind === 'running' && this.phase.abort.signal.aborted) {
        return { kind: 'aborted' }
      }
      return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) }
    }
  }

  private buildToolBindings(): Record<string, unknown>[] {
    const bindings: Record<string, unknown>[] = []
    for (const [name, entry] of this.tools) {
      bindings.push({
        type: 'function',
        function: { name, description: entry.description, parameters: entry.parameters },
      })
    }
    return bindings
  }
}

// ─── 场景演示 ────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  Step 06 – Phase 状态机 + TurnEndReason                    ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()

  // ── 场景 1：正常流程（idle → running → idle） ──
  console.log('--- 场景 1：正常流程 ---\n')
  const agent = new StatefulAgent()
  agent.registerTool({
    name: 'get_weather',
    description: '查询指定城市的天气情况',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名称' } },
      required: ['city'],
    },
    execute: async args => `📍 ${(args.city as string) || '未知'} 天气：晴天，25°C`,
  })
  agent.registerTool({
    name: 'calculator',
    description: '执行数学计算',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '表达式' } },
      required: ['expression'],
    },
    execute: async args => {
      const expr = ((args.expression as string) || '').replace(/\s+/g, '')
      if (!/^[\d+\-*/().%]+$/.test(expr)) return 'Error: 非法表达式'
      // biome-ignore lint/security/noGlobalEval: 消毒过的数学表达式
      return `计算结果: ${expr} = ${Function(`"use strict"; return (${expr})`)()}`
    },
  })

  // 发送消息 → wakeDriver() 从 idle 切换到 running → kick() 启动
  agent.send('帮我查一下北京的天气，并计算 1+1 等于多少？')

  // 等待异步 kick 完成
  await new Promise(resolve => setTimeout(resolve, 12000))

  // ── 场景 2：取消演示 ──
  console.log('\n--- 场景 2：取消演示 ---\n')
  const agent2 = new StatefulAgent()
  agent2.registerTool({
    name: 'get_weather',
    description: '查询天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市' } },
      required: ['city'],
    },
    execute: async () => '晴天',
  })

  agent2.send('查北京天气')
  // 立即取消
  setTimeout(() => {
    console.log('  🛑 取消！')
    agent2.cancel()
  }, 2000)

  await new Promise(resolve => setTimeout(resolve, 8000))
  console.log('\n✅ 演示完成')
}

main().catch(e => {
  console.error('❌', e)
  process.exit(1)
})
