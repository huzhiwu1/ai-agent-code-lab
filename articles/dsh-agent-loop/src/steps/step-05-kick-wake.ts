/**
 * Step 05 – 外部驱动 + Phase 状态机：谁启动 Agent？什么时候能跑？
 *
 * 学习目标：理解 Agent 不是无状态死循环——它有完整的生命周期管理。
 * Step 04 告诉我们 turn 怎么结束（TurnEndReason），
 * Step 05 告诉我们 Agent 什么时候能跑、什么时候不能跑（Phase 状态机）。
 *
 * 前置依赖：Step 04 的 TurnEndReason + 工具闭环。
 * 本步在 Step 04 的基础上，把整个 turn 循环包进 Phase 生命周期中。
 *
 * 对应源码 agent.ts：
 *   - Phase 状态机 → agent.ts:37-53（idle / running / maintenance）
 *   - wakeDriver() → agent.ts:163-183（latch + 收敛重放）
 *   - kick() → agent.ts:197-210（外部驱动 while 循环）
 *   - cancel() → agent.ts:148-155（清 inbox + abort signal）
 *
 * 关键机制：
 *   - Phase 状态机：idle（空闲）↔ running（工作）↔ idle
 *   - 每次 turn 结束换新 AbortController，旧信号上的 latch 失效
 *   - 取消收敛窗口：abort() 返回后驱动还在收敛，此时到达的唤醒
 *     会被 latch，等驱动收敛到 idle 后自动重放
 *   - kick() 的 finally 块：收敛到 idle 后检查 latch 并重放
 *   - kick() 失败不崩——错误在驱动边界内收敛
 *
 * 对应设计笔记：
 *   - 2026-08-07 cancel-convergence-wake-latch（取消收敛窗口唤醒锁存）
 *   - 2026-07-16 explicit-turn-cancellation（显式 turn 取消）
 *
 * 跑法：pnpm run step:05
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
 * maintenance：后台任务（如持久化），此时新唤醒被 latch（简化版不实现）
 */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/**
 * Turn 结束原因。
 * 真实定义在 packages/core/session/src/types.ts（agent.ts 是使用方）；
 * 本步含 4 个成员：blocked 在 Step 06 随 preStep 引入，
 * interrupted 仅崩溃恢复层使用、主循环从不发出，教学版省略。
 */
type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'max-tokens' } // 输出触顶（粘性：一旦触顶，后续 step 不能降级）
  | { kind: 'aborted' } // 被取消
  | { kind: 'error'; error: Error }

interface ToolEntry {
  name: string
  description: string
  /** 参数 JSON Schema，bindTools 时告知模型参数格式 */
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

/**
 * max-tokens 粘性合并：
 *   - turnEnds 已触顶（max-tokens）→ 保持触顶，不被后续正常 step 降级
 *   - 否则用当前 step 的结果
 *
 * 为什么需要粘性？聚合指标要保留最坏情况——
 * 如果 Step 1 触顶（输出被截断），Step 2 正常完成就把原因改成 completed，
 * UI/恢复逻辑看到的终止原因就是失真的。
 */
function mergeTurnEnds(
  current: TurnEndReason | null,
  next: TurnEndReason | null,
): TurnEndReason | null {
  if (current !== null && current.kind === 'max-tokens') return current
  return next
}

// ─── PhaseAwareAgent ─────────────────────────────────────────────────

/**
 * PhaseAwareAgent – 带 Phase 状态机的 Agent 循环
 *
 * 在 Step 04 的 TurnEndReason + 工具闭环基础上，新增：
 *   - Phase 状态机（idle/running）
 *   - 外部驱动 kick() + wakeDriver()
 *   - 取消收敛窗口 latch
 *   - 每 turn 换新 AbortController
 *
 * 对应 agent.ts 中 ReactLoopAgent 的外部驱动层：
 *   - kick()：while (await this.turn()) {}
 *   - wakeDriver()：Phase 状态机 + latch 机制
 */
class PhaseAwareAgent {
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

  // ── 消息注入 ──────────────────────────────────────────────────────

  /** 发送消息并唤醒驱动。简化版：不分 followup/steer/inject，统一 send + wake */
  send(message: string): void {
    this.inbox.push(new HumanMessage(message))
    this.wakeDriver()
  }

  /** 取消当前 turn，对应 agent.ts cancel() */
  cancel(): void {
    this.inbox = []
    if (this.phase.kind === 'running') {
      this.phase.wakeRequested = false
      this.phase.abort.abort(new Error('user cancelled'))
    }
  }

  // ── Phase 状态机 + 外部驱动 ───────────────────────────────────────
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

  /**
   * 唤醒驱动：idle → running，或 latch 唤醒信号
   * 对应 agent.ts:163-183 的 wakeDriver()
   */
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
    // 异步启动 kick，不阻塞调用方
    this.kick()
  }

  /**
   * 外部驱动入口：循环消费 inbox 直到队列为空
   *
   * 对应 agent.ts:197-210 的 kick()：
   *   while (await this.turn()) {}
   *
   * 关键设计：kick() 的 finally 块在收敛到 idle 后
   * 检查 latch 并重放——这是取消收敛窗口唤醒的核心机制。
   */
  private async kick(): Promise<void> {
    try {
      // 对应 agent.ts: while (await this.turn()) {}
      while (await this.turn()) {
        /* 持续消费 inbox 直到队列为空 */
      }
    } catch {
      // 对应 agent.ts: catch block — 错误在驱动边界内收敛
      console.log('  ⚠️  驱动层捕获错误，不影响后续 turn')
    } finally {
      // 对应 agent.ts kick() 的 finally：收敛到 idle 后重放 latch
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.phase = { kind: 'idle', lastTurn: turn }
        // 如果收敛期间有 latch 的唤醒 → 重放
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
   *   - turn 内的异常捕获（区分 abort 和真实 error）
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

    // 消费 inbox 中的消息，加入会话历史
    // 对应 agent.ts preStep() 的 inbox.claim()
    while (this.inbox.length > 0) {
      this.messages.push(this.inbox.shift()!)
    }

    let turnEnds: TurnEndReason | null = null

    try {
      // 对应 agent.ts: while(true) { step → check break }
      while (true) {
        // 检查取消信号
        if (signal.aborted) {
          turnEnds = { kind: 'aborted' }
          break
        }

        phase.step++

        // 执行一个 step
        const stepEnd = await this.executeStep()

        // stepEnd === null 表示"工具结果已回填，需要继续循环"
        // 对应源码：step() 返回 null 表示继续
        if (stepEnd === null) continue

        // max-tokens 粘性：触顶过就不能被降级
        turnEnds = mergeTurnEnds(turnEnds, stepEnd)

        // 如果 step 结束且没有更多 inbox 消息 → 结束当前 turn
        if (turnEnds && this.inbox.length === 0) break
      }
    } catch (error: unknown) {
      // 区分 abort 和真实异常
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

    // 如果还有更多 inbox 消息 → 继续下一个 turn
    return this.inbox.length > 0
  }

  /**
   * 一次 step：调模型 → 工具回路 → 返回结束原因。
   *
   * 返回 null 表示"工具结果已回填，需要继续循环再调模型"，
   * 由 turn() 的 while 循环处理。
   *
   * 对应 agent.ts:330-354 的 step()
   */
  private async executeStep(): Promise<TurnEndReason | null> {
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

      // 输出触顶 → max-tokens（粘性）
      if (finishReason === 'length' || finishReason === 'max_tokens') {
        console.log(`  ⚠️  输出触顶（finish_reason=${finishReason}）→ max-tokens`)
        return { kind: 'max-tokens' }
      }

      // 没有工具调用 → completed
      if (toolCalls.length === 0) {
        const content =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        console.log(`  💬 回答: ${content.substring(0, 80)}`)
        return { kind: 'completed' }
      }

      // 有工具调用 → 执行回填
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

      // 工具结果已回填 → 返回 null，由 turn() 继续循环
      return null
    } catch (e: unknown) {
      // 区分 abort 和真实异常
      if (this.phase.kind === 'running' && this.phase.abort.signal.aborted) {
        return { kind: 'aborted' }
      }
      return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) }
    }
  }

  /**
   * 构建工具绑定列表，用于 ChatOpenAI.bindTools()
   * 对应 agent.ts: assembly.tools 中的工具声明
   */
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
  console.log('║  Step 05 – Phase 状态机：kick / wake / idle ↔ running      ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()

  // ── 场景 1：正常流程（idle → running → idle） ──
  console.log('--- 场景 1：正常流程（工具闭环 + Phase 状态机） ---\n')
  const agent = new PhaseAwareAgent()
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
      // biome-ignore lint/security/noGlobalEval: 消毒过的数学表达式，仅教学用途
      return `计算结果: ${expr} = ${Function(`"use strict"; return (${expr})`)()}`
    },
  })

  // 发送消息 → wakeDriver() 从 idle 切换到 running → kick() 启动
  console.log('👤 用户: 帮我查一下北京的天气，并计算 1+1 等于多少？')
  agent.send('帮我查一下北京的天气，并计算 1+1 等于多少？')

  // 等待异步 kick 完成
  await new Promise(resolve => setTimeout(resolve, 12000))

  // ── 场景 2：取消演示 ──
  console.log('\n--- 场景 2：取消演示 ---\n')
  const agent2 = new PhaseAwareAgent()
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

  console.log('👤 用户: 查北京天气')
  agent2.send('查北京天气')

  // 立即取消——演示 cancel() 会清空 inbox 并 abort
  setTimeout(() => {
    console.log('  🛑 取消！cancel() 清空 inbox + abort signal')
    agent2.cancel()
  }, 2000)

  await new Promise(resolve => setTimeout(resolve, 8000))

  // ── 场景 3：latch 演示（发送消息时驱动还在跑） ──
  console.log('\n--- 场景 3：latch 演示 ---\n')
  const agent3 = new PhaseAwareAgent()
  agent3.registerTool({
    name: 'get_weather',
    description: '查询天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市' } },
      required: ['city'],
    },
    execute: async args => `📍 ${(args.city as string) || '未知'} 天气：晴天`,
  })

  console.log('👤 用户: 查北京天气')
  agent3.send('查北京天气')

  // 在第一个 turn 还没跑完时再发一条消息
  // 此时 phase 为 running，wakeDriver() 会 latch 唤醒信号
  // 等第一个 turn 跑完后 kick() 的 finally 块会重放 latch
  await new Promise(resolve => setTimeout(resolve, 2000))
  console.log('👤 用户（latch）: 再查一下上海天气')
  agent3.send('再查一下上海天气')

  await new Promise(resolve => setTimeout(resolve, 15000))

  console.log('\n✅ 演示完成')
}

main().catch(e => {
  console.error('❌', e)
  process.exit(1)
})
