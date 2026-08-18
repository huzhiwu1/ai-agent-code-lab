/**
 * Step 06 – preStep 决策点：每步开始前先决策
 *
 * 学习目标：理解 preStep() 为什么是"当前步的决策入口"而非"注入"。
 *
 * 前置依赖：Step 05 的 Phase 状态机 + 外部驱动。
 * 本步在 Phase 基础上，为每个 step 插入决策点——插件可以改写或拒绝这一步的输入。
 *
 * 对应源码 agent.ts:225-243 的 preStep()：
 *   1. inbox.claim() → 原子取走消息批次
 *   2. assembleContextFor() → 组装 system prompt
 *   3. dispatch.waterfall('agent/pre-step', ...) → 插件可改写或拒绝
 *
 * 关键机制：
 *   - claim 后消息不可逆——即使 reject 也不退回 inbox
 *   - preStep 和 inject 的分界：inject 影响"后续 step"，preStep 影响"当前 step"
 *   - 完整消息批次只经过一次 preStep 决策
 *
 * 跑法：pnpm run step:06
 */

import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'

// ─── 类型定义 ────────────────────────────────────────────────────────

/**
 * Turn 结束原因。
 * 真实定义在 packages/core/session/src/types.ts（agent.ts 是使用方）；
 * 本步新增 blocked（preStep 拒绝）；interrupted 仅崩溃恢复层使用，教学版省略。
 */
type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted' }
  | { kind: 'blocked' } // preStep 拒绝 → blocked
  | { kind: 'error'; error: Error }

/** preStep 决策结果，对应 agent.ts 的 PreStepDecision */
type PreStepDecision =
  | { kind: 'reject' } // 拒绝这一步，turn 结束为 blocked
  | { kind: 'enter'; messages: BaseMessage[] } // 进入这一步，携带（可能被改写的）消息

interface ToolEntry {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

/**
 * 单 turn 最大 step 数（安全阀）。
 * 注意：真实 harness 没有硬编码 step 上限——turn 终止靠数据（工具结果 concludesTurn）、
 * 策略（agent/pre-step 拦截器 reject → blocked）、取消（abort）三类机制。
 * 教学版因真实 LLM 行为不可控，加显式上限防演示死循环；
 * 若想更贴近真实模式，可把它改为注册在 onPreStep() 的拦截器（超限 reject）。
 */
const MAX_STEPS_PER_TURN = 8

// ─── PreStepAgent ────────────────────────────────────────────────────

/**
 * PreStepAgent – 带 preStep 决策点的 Agent 循环
 *
 * 对应 agent.ts 中 preStep() 的完整流程：
 *   - claim inbox 消息批次
 *   - 组装 context
 *   - waterfall 决策（插件可改写或拒绝）
 *
 * 这个类在 Step 04 的工具闭环基础上，插入了 preStep 决策点。
 * 演示：插件通过 preStep 可以"拒绝"或"改写"每一步的输入。
 */
class PreStepAgent {
  private messages: BaseMessage[] = []
  private inbox: BaseMessage[] = []
  private tools: Map<string, ToolEntry> = new Map()
  private llm: ChatOpenAI
  private aborted = false

  /** 插件注册的 preStep 拦截器 */
  private preStepInterceptors: Array<
    (decision: PreStepDecision) => PreStepDecision | Promise<PreStepDecision>
  > = []

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
  }

  registerTool(entry: ToolEntry): void {
    this.tools.set(entry.name, entry)
  }

  /** 注册 preStep 拦截器（模拟 agent/pre-step waterfall） */
  onPreStep(
    interceptor: (decision: PreStepDecision) => PreStepDecision | Promise<PreStepDecision>,
  ): void {
    this.preStepInterceptors.push(interceptor)
  }

  send(message: string): void {
    this.inbox.push(new HumanMessage(message))
  }

  cancel(): void {
    this.aborted = true
  }

  // ── preStep 决策点 ────────────────────────────────────────────────
  //
  // 对应 agent.ts:225-243 的 preStep()：
  //   1. inbox.claim(target, turn) → 原子取走消息批次
  //   2. assembleContextFor() → 组装 system prompt
  //   3. dispatch.waterfall('agent/pre-step', ...) → 插件可改写或拒绝
  //
  // 关键设计：
  //   - claim 后消息不可逆——即使 reject 也不退回 inbox
  //   - 这是 preStep 和 inject 的本质区别：
  //     inject → 影响"后续 step"的消息
  //     preStep → 影响"当前 step 正在结算的请求"

  private async preStep(
    _target: 'next-turn' | 'next-step',
    _turn: number,
    _step: number,
  ): Promise<PreStepDecision> {
    // 1. claim：原子取走消息批次
    // 对应 agent.ts: inbox.claim(target, turn)
    const claimed: BaseMessage[] = []
    while (this.inbox.length > 0) {
      claimed.push(this.inbox.shift()!)
    }

    console.log(`  🔍 preStep: claim 了 ${claimed.length} 条消息`)

    // 2. 组装 system prompt（简化版）
    // 对应 agent.ts: assembleContextFor(this, signal) + renderContextSections()

    // 3. waterfall：插件可改写或拒绝
    // 对应 agent.ts: dispatch.waterfall('agent/pre-step', ...)
    let decision: PreStepDecision = { kind: 'enter', messages: claimed }

    for (const interceptor of this.preStepInterceptors) {
      decision = await interceptor(decision)
      if (decision.kind === 'reject') {
        console.log('  🚫 preStep: 插件拒绝了这一步')
        return decision
      }
    }

    console.log(
      `  ✅ preStep: 进入 step，${decision.messages.length} 条消息`,
      decision.messages.length !== claimed.length ? '(消息被改写!)' : '',
    )
    return decision
  }

  // ── 主循环 ────────────────────────────────────────────────────────

  async run(): Promise<string> {
    if (this.inbox.length === 0) return '(无输入)'

    let turnNumber = 0
    let turnEnds: TurnEndReason | null = null

    while (this.inbox.length > 0) {
      turnNumber++
      let stepNumber = 0
      console.log(`\n🔄 === Turn ${turnNumber} 开始 ===\n`)

      // 对应 agent.ts: turn() 内部的 while(true) 循环
      // 每个 step 开始前调用 preStep()
      let target: 'next-turn' | 'next-step' = 'next-turn'

      while (true) {
        if (this.aborted) {
          turnEnds = { kind: 'aborted' }
          break
        }

        // 安全阀：step 数超限 → blocked 结束 turn，防止死循环
        // 注意：真实 harness 无此上限；教学版用显式检查模拟一个 preStep 拦截器超限 reject
        if (stepNumber > MAX_STEPS_PER_TURN) {
          turnEnds = { kind: 'blocked' }
          break
        }

        stepNumber++

        // ═══ preStep 决策点 ═══
        // 对应 agent.ts: const decision = await this.preStep(target, { turn, step })
        const decision = await this.preStep(target, turnNumber, stepNumber)

        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          break
        }

        if (decision.messages.length === 0 && turnEnds) break

        // 把 preStep 批准的消息加入历史
        for (const msg of decision.messages) {
          this.messages.push(msg)
        }

        // 执行 step
        const stepEnd = await this.executeStep()

        // max-tokens 粘性
        if (turnEnds === null || turnEnds.kind !== 'max-tokens') {
          turnEnds = stepEnd
        }

        if (turnEnds && this.inbox.length === 0) break

        target = 'next-step'
      }

      console.log(`\n🔄 === Turn ${turnNumber} 结束 (${turnEnds?.kind ?? 'unknown'}) ===\n`)
    }

    const lastMsg = [...this.messages].reverse().find(m => m._getType() === 'ai')
    return (lastMsg?.content as string) ?? '(无回答)'
  }

  /**
   * 一次 step：调模型 → 工具回路 → 返回结束原因。
   *
   * 返回 null 表示"工具结果已回填，需要继续循环再调模型"，
   * 由 run() 的 while 循环处理。
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

      if (finishReason === 'length' || finishReason === 'max_tokens') {
        console.log(`  ⚠️  输出触顶 → max-tokens`)
        return { kind: 'max-tokens' }
      }

      if (toolCalls.length === 0) {
        const content =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        console.log(`  💬 回答: ${content.substring(0, 80)}`)
        return { kind: 'completed' }
      }

      // 执行工具
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

      // 工具结果已回填 → 返回 null，由 run() 继续循环
      return null
    } catch (e: unknown) {
      if (this.aborted) return { kind: 'aborted' }
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
  console.log('║  Step 06 – preStep 决策点：claim + waterfall + reject       ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()

  // ── 场景 1：正常流程（preStep 不拦截） ──
  console.log('--- 场景 1：正常流程 ---\n')
  const agent1 = new PreStepAgent()
  agent1.registerTool({
    name: 'get_weather',
    description: '查询指定城市的天气情况',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名称' } },
      required: ['city'],
    },
    execute: async args => `📍 ${(args.city as string) || '未知'} 天气：晴天，25°C`,
  })
  agent1.send('查一下北京天气')
  const answer1 = await agent1.run()
  console.log('最终回答:', answer1)

  // ── 场景 2：preStep 拒绝（模拟敏感词过滤） ──
  console.log('\n--- 场景 2：preStep 拒绝 ---\n')
  const agent2 = new PreStepAgent()
  agent2.registerTool({
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

  // 注册 preStep 拦截器：如果消息包含"机密"则拒绝
  agent2.onPreStep(decision => {
    if (decision.kind === 'reject') return decision
    const hasSensitive = decision.messages.some((m: BaseMessage) => {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return text.includes('机密')
    })
    if (hasSensitive) {
      console.log('  🛡️  preStep 拦截器：检测到敏感词，拒绝这一步')
      return { kind: 'reject' }
    }
    return decision
  })

  agent2.send('帮我算一下 1+1')
  const answer2 = await agent2.run()
  console.log('最终回答:', answer2)

  console.log('\n--- 场景 3：preStep 拒绝（turn 结束为 blocked）---\n')
  const agent3 = new PreStepAgent()
  agent3.onPreStep(() => {
    console.log('  🛡️  preStep 拦截器：拒绝这一步')
    return { kind: 'reject' }
  })
  agent3.send('这个请求包含机密信息')
  const answer3 = await agent3.run()
  console.log('最终回答:', answer3, '(应为空——被 preStep 拒绝了)')

  console.log('\n✅ 演示完成')
}

main().catch(e => {
  console.error('❌', e)
  process.exit(1)
})
