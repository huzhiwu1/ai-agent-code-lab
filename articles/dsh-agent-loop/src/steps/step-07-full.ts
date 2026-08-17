/**
 * Step 07 – 完整版：整合所有机制
 *
 * 这是《从 0 实现一遍 Agent 主循环》渐进教程的最终版：
 *   step-01 最小骨架：turn/step 双层循环（无工具）
 *   step-02 外部驱动：kick/wake + Phase 状态机（谁启动 Agent？）
 *   step-03 加工具：模型开始声明 tool_calls（不执行）
 *   step-04 工具闭环：执行工具 + 结果回填 + 多 step 往返
 *   step-05 preStep 决策点：claim + waterfall + reject
 *   step-06 完整状态机：Phase 生命周期 + TurnEndReason
 *   step-07 完整版：整合以上所有机制 + Inbox 队列 + 诊断（本文件）
 *
 * 建议按顺序跑：pnpm run step:01 → step:02 → ... → step:07
 *
 * 跑法：pnpm run run:dsh-loop（或 pnpm run step:07）
 */

import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'

// ─── 类型定义 ────────────────────────────────────────────────────────

/** Phase 状态机，对应 agent.ts:37-53 */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** Turn 结束原因，对应 agent.ts 的 TurnEndReason */
type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted' }
  | { kind: 'blocked' }
  | { kind: 'error'; error: Error }

/** preStep 决策结果，对应 agent.ts 的 PreStepDecision */
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: BaseMessage[] }

interface ToolEntry {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

interface StepDiagnostic {
  turn: number
  step: number
  toolCalls: number
  finishReason: string
  tokensUsed?: number
}

// ─── SimplifiedReactLoop ─────────────────────────────────────────────

/**
 * SimplifiedReactLoop – 完整版 Agent 主循环
 *
 * 对应 agent.ts 中 ReactLoopAgent 类的全部核心机制：
 *   - kick() 外部驱动 → agent.ts:197-210
 *   - wakeDriver() + Phase 状态机 → agent.ts:37-53, 163-183
 *   - preStep() 决策点 → agent.ts:225-243
 *   - turn() 回合循环 → agent.ts:245-329
 *   - step() 模型往返 → agent.ts:330-354
 *   - Inbox 消息队列 → agent.ts Inbox 类
 *   - 工具注册表 → dsh-tools 的 tool registry
 *   - 工具结果回填 → executeToolCalls() 的 acceptContext 回调
 *   - max-tokens 粘性 → agent.ts:285-290
 *   - 取消收敛窗口 latch → 2026-08-07 cancel-convergence-wake-latch
 */
class SimplifiedReactLoop {
  private inbox: BaseMessage[] = []
  private tools: Map<string, ToolEntry> = new Map()
  private messages: BaseMessage[] = []
  private phase: Phase
  private llm: ChatOpenAI
  diagnostics: StepDiagnostic[] = []

  constructor(
    private modelName: string = process.env.LLM_MODEL || 'deepseek-v4-flash',
    private baseUrl: string = process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1',
    private apiKey: string = process.env.LLM_API_KEY || '',
  ) {
    this.llm = new ChatOpenAI({
      model: this.modelName,
      configuration: { baseURL: this.baseUrl },
      apiKey: this.apiKey,
      maxTokens: 4096,
    })
    this.phase = { kind: 'idle', lastTurn: 0 }
  }

  registerTool(toolEntry: ToolEntry): void {
    this.tools.set(toolEntry.name, toolEntry)
  }

  // ── 消息注入 ──────────────────────────────────────────────────────

  /** 发送消息并唤醒驱动，对应 agent.ts followup() */
  send(message: string): void {
    this.inbox.push(new HumanMessage(message))
    this.wakeDriver()
  }

  cancel(): void {
    this.inbox = []
    if (this.phase.kind === 'running') {
      this.phase.wakeRequested = false
      this.phase.abort.abort(new Error('user cancelled'))
    }
  }

  // ── Phase 状态机 + 外部驱动 ───────────────────────────────────────

  /**
   * 唤醒驱动：idle → running，或 latch 唤醒信号
   * 对应 agent.ts:163-183 的 wakeDriver()
   */
  private wakeDriver(): void {
    if (this.phase.kind !== 'idle') {
      if (this.phase.kind === 'running') this.phase.wakeRequested = true
      return
    }
    this.phase = {
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    }
    this.kick()
  }

  /**
   * 外部驱动入口：while (await this.turn()) {}
   * 对应 agent.ts:197-210 的 kick()
   */
  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {
        /* 消费 inbox */
      }
    } catch {
      console.log('  ⚠️  驱动层捕获错误')
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.phase = { kind: 'idle', lastTurn: turn }
        if (wakeRequested && this.inbox.length > 0) this.wakeDriver()
      }
    }
  }

  // ── preStep 决策点 ────────────────────────────────────────────────

  /**
   * 每步开始前的决策点：claim + 组装 + waterfall
   * 对应 agent.ts:225-243 的 preStep()
   */
  private async preStep(
    _target: 'next-turn' | 'next-step',
    _turn: number,
    _step: number,
  ): Promise<PreStepDecision> {
    const claimed: BaseMessage[] = []
    while (this.inbox.length > 0) claimed.push(this.inbox.shift()!)
    // 简化版：不做 waterfall，默认 enter
    return { kind: 'enter', messages: claimed }
  }

  // ── 主循环 ────────────────────────────────────────────────────────

  /**
   * 一次 turn，对应 agent.ts:245-329 的 turn()
   */
  private async turn(): Promise<boolean> {
    if (this.inbox.length === 0) return false
    if (this.phase.kind !== 'running') return false

    const phase = this.phase
    const { signal } = phase.abort

    phase.turn = phase.turn + 1
    phase.step = 0
    console.log(`\n🔄 === Turn ${phase.turn} 开始 ===\n`)

    let target: 'next-turn' | 'next-step' = 'next-turn'
    let turnEnds: TurnEndReason | null = null

    try {
      while (true) {
        signal.throwIfAborted()
        phase.step++

        // ═══ preStep 决策点 ═══
        const decision = await this.preStep(target, phase.turn, phase.step)
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break

        for (const msg of decision.messages) this.messages.push(msg)

        // 执行 step
        const stepEnd = await this.executeStep(phase.turn, phase.step)

        // max-tokens 粘性
        if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd

        if (turnEnds && this.inbox.length === 0) break
        target = 'next-step'
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

    // 换新 AbortController
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0

    return this.inbox.length > 0
  }

  /**
   * 一次 step：调 LLM → 解析 tool-calls → 执行 → 回填
   * 对应 agent.ts:330-354 的 step()
   */
  private async executeStep(turn: number, step: number): Promise<TurnEndReason> {
    try {
      const systemPrompt = new SystemMessage(
        '你是一个 AI Agent，可以调用工具来完成任务。' +
          '当用户需要查询天气或进行计算时，请使用对应的工具。',
      )
      const llmMessages: BaseMessage[] = [systemPrompt, ...this.messages]

      const toolBindings = this.buildToolBindings()
      const llmWithTools = toolBindings.length > 0 ? this.llm.bindTools(toolBindings) : this.llm

      console.log(`  ⚡ Step ${turn}.${step}: 调 LLM (${this.modelName})`)
      const result = await llmWithTools.invoke(llmMessages)

      const finishReason: string =
        ((result.response_metadata as Record<string, unknown> | undefined)
          ?.finish_reason as string) ?? 'stop'

      const toolCalls = result.tool_calls || []

      console.log(
        `  📨 Step ${turn}.${step}: finish_reason=${finishReason}, tool_calls=${toolCalls.length}`,
      )

      this.diagnostics.push({
        turn,
        step,
        toolCalls: toolCalls.length,
        finishReason,
        tokensUsed: (
          (result.response_metadata as Record<string, unknown> | undefined)?.usage as
            Record<string, unknown> | undefined
        )?.total_tokens as number | undefined,
      })

      if (finishReason === 'length' || finishReason === 'max_tokens') {
        this.messages.push(result)
        return { kind: 'max-tokens' }
      }

      this.messages.push(result)

      if (toolCalls.length === 0) return { kind: 'completed' }

      for (const tc of toolCalls) {
        console.log(`  🛠️  执行工具: ${tc.name}(${JSON.stringify(tc.args)})`)
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
        this.messages.push(new ToolMessage({ content: resultContent, tool_call_id: tc.id ?? '' }))
        console.log(`  ✅ 工具结果: ${resultContent.substring(0, 80)}`)
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

// ─── 工具定义 ────────────────────────────────────────────────────────

const weatherTool: ToolEntry = {
  name: 'get_weather',
  description: '查询指定城市的天气情况（演示工具，返回固定值）',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名称，例如"北京"、"上海"、"广州"' } },
    required: ['city'],
  },
  execute: async (args: Record<string, unknown>) => {
    const city = (args.city as string) || '未知城市'
    const weathers: Record<string, string> = {
      北京: '晴天，25°C，湿度 40%，微风',
      上海: '多云，28°C，湿度 65%，东南风 3级',
      广州: '阵雨，32°C，湿度 80%，南风 2级',
    }
    return `📍 ${city} 天气：${weathers[city] || '晴天，22°C，湿度 50%'}`
  },
}

const calculatorTool: ToolEntry = {
  name: 'calculator',
  description: '执行数学计算，支持加减乘除运算',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: '数学表达式，例如"1+1"、"2*3+4"' } },
    required: ['expression'],
  },
  execute: async (args: Record<string, unknown>) => {
    const expression = (args.expression as string) || ''
    if (!expression) return 'Error: 未提供表达式'
    try {
      const sanitized = expression.replace(/\s+/g, '')
      if (!/^[\d+\-*/().%]+$/.test(sanitized)) return 'Error: 表达式包含非法字符'
      // biome-ignore lint/security/noGlobalEval: 消毒过的数学表达式，仅教学用途
      const result = Function(`"use strict"; return (${sanitized})`)()
      return `计算结果: ${expression} = ${result}`
    } catch (e: unknown) {
      return `Error: 计算失败 - ${e instanceof Error ? e.message : String(e)}`
    }
  },
}

// ─── 场景演示 ────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  SimplifiedReactLoop v2 — 完整版 Agent 主循环               ║')
  console.log('║  kick/wake + Phase + preStep + turn/step + tools + inbox    ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`模型: ${process.env.LLM_MODEL || 'deepseek-v4-flash'}`)
  console.log(`API Base: ${process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1'}`)
  console.log()

  const loop = new SimplifiedReactLoop()
  loop.registerTool(weatherTool)
  loop.registerTool(calculatorTool)

  const userMessage = '帮我查一下北京的天气，并计算 1+1 等于多少？'
  console.log(`👤 用户: ${userMessage}`)
  loop.send(userMessage)

  // 等待异步 kick 完成
  await new Promise(resolve => setTimeout(resolve, 15000))

  console.log()
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║                    诊断信息                                 ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()
  for (const d of loop.diagnostics) {
    console.log(
      `  Turn ${d.turn} Step ${d.step}: ${d.toolCalls} 工具, ` +
        `finish=${d.finishReason}, tokens=${d.tokensUsed ?? 'N/A'}`,
    )
  }
}

main().catch(e => {
  console.error('❌', e)
  process.exit(1)
})
