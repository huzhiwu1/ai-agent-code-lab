/**
 * Step 04 – 结束状态机：max-tokens 粘性、错误处理、取消
 *
 * 学习目标：理解生产级 turn 结束原因为什么重要。
 *
 * 前置依赖：Step 03 的工具闭环（工具声明 + 执行 + 回填 + 多 step 往返）。
 * 本步在闭环基础上，为 turn 加明确的结束状态——不再只是"答完就结束"。
 *
 * 对应源码：
 *   - TurnEndReason 联合类型 → packages/core/session/src/types.ts
 *     （真实枚举含 6 个成员；本步先实现 4 个：blocked 在 Step 06 随 preStep 引入，
 *     interrupted 是崩溃恢复层专用、主循环从不发出，教学版省略）
 *   - max-tokens 粘性 → agent.ts:285-290
 *     （一旦某 step 触顶，后续正常 step 不能把 turn 结果降级回 completed）
 *   - AbortController：取消信号贯穿 turn/step/工具执行
 *     （本步简化为 boolean 标志位，真正的 AbortController 在 Step 05 引入）
 *
 * 关键机制：
 *   - finish_reason === 'length' 表示输出触顶（截断）
 *   - sticky：turnEnds 一旦是 max-tokens，就再也不会被覆盖成 completed
 *   - abort：cancel() 后当前 step 结束，turn 返回 aborted
 *
 * 跑法：pnpm run step:04
 */

import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'

/**
 * Turn 结束原因。
 * 真实定义在 packages/core/session/src/types.ts（agent.ts 是使用方）；
 * 真实枚举含 6 个成员，教学版简化如下：
 *   - blocked 在 Step 06 随 preStep 引入
 *   - interrupted 仅崩溃恢复层使用，主循环从不发出，教学版省略
 */
type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'max-tokens' } // 输出触顶（粘性）
  | { kind: 'aborted' } // 被取消
  | { kind: 'error'; error: Error } // 异常

interface ToolEntry {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

/**
 * 单 turn 最大 step 数（安全阀）。
 * 注意：真实 harness 没有硬编码 step 上限——turn 终止靠数据（工具结果 concludesTurn）、
 * 策略（agent/pre-step 拦截器 reject）、取消（abort）三类机制。
 * 教学版因真实 LLM 行为不可控，加显式上限防止演示死循环，非真实机制。
 */
const MAX_STEPS_PER_TURN = 8

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

class StatefulLoop {
  private messages: BaseMessage[] = []
  private tools: Map<string, ToolEntry> = new Map()
  private llm: ChatOpenAI
  private aborted = false

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

  /** 取消当前 turn，对应 agent.ts cancel() */
  cancel(): void {
    this.aborted = true
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

  /**
   * 一次 turn，返回结束原因。
   *
   * 对应源码 turn()：
   *   while (true) {
   *     stepEnd = await step()
   *     if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd  ← 粘性
   *     if (turnEnds && inbox.nextStep.length === 0) break
   *   }
   *
   * 注意：step() 返回 null（工具回填）→ continue 再调模型；
   * 返回非 null（completed/max-tokens/aborted/error）→ 直接结束 turn。
   * 没有多余的补跑逻辑——补跑会引入重复回答，甚至死循环。
   */
  async turn(userInput: string): Promise<TurnEndReason> {
    this.messages.push(new HumanMessage(userInput))
    console.log('\n🔄 === Turn 开始 ===\n')

    let turnEnds: TurnEndReason | null = null
    let stepCount = 0

    while (true) {
      // 取消标志位：cancel() 后当前循环检查到就结束 turn
      if (this.aborted) {
        turnEnds = { kind: 'aborted' }
        break
      }

      // 安全阀：step 数超限 → 结束 turn，防止死循环
      // 注意：真实 harness 无此上限，靠工具结果 concludesTurn / pre-step 拒绝 / 取消终止
      stepCount++
      if (stepCount > MAX_STEPS_PER_TURN) {
        turnEnds = {
          kind: 'error',
          error: new Error(`达到单 turn 最大 step 数上限 (${MAX_STEPS_PER_TURN})`),
        }
        break
      }

      const stepEnd = await this.step()

      // step() 返回 null 表示“工具结果已回填，需要再调一次模型”
      if (stepEnd === null) continue

      // max-tokens 粘性：触顶过就不能被降级
      // 对应源码: if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
      // 用辅助函数避免 TS 控制流收窄问题（stepEnd 可能是 null=待继续）
      turnEnds = mergeTurnEnds(turnEnds, stepEnd)

      // 有明确结束原因 → 结束 turn
      break
    }

    console.log(`\n🔄 === Turn 结束 (${turnEnds?.kind ?? 'unknown'}) ===\n`)
    return turnEnds ?? { kind: 'completed' }
  }

  /**
   * 一次 step：调模型 → 工具回路 → 返回结束原因。
   *
   * 返回 null 表示"工具结果已回填，需要继续循环再调模型"，
   * 由 turn() 的 while 循环处理。
   */
  private async step(): Promise<TurnEndReason | null> {
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

      // 输出触顶 → 直接结束，标记 max-tokens（粘性）
      // 对应源码: if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }
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

      // 工具结果已回填 → 返回 null 表示"继续循环"
      // 对应源码：step() 返回 null 表示继续，由 turn() 的 while(true) 处理
      return null
    } catch (e: unknown) {
      if (this.aborted) return { kind: 'aborted' }
      return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) }
    }
  }
}

async function main() {
  const loop = new StatefulLoop()
  loop.registerTool({
    name: 'get_weather',
    description: '查询指定城市的天气情况',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名称，例如北京' } },
      required: ['city'],
    },
    execute: async args => `📍 ${(args.city as string) || '未知'} 天气：晴天，25°C`,
  })
  loop.registerTool({
    name: 'calculator',
    description: '执行数学计算，支持加减乘除',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '数学表达式，例如 1+1' } },
      required: ['expression'],
    },
    execute: async args => {
      const expression = ((args.expression as string) || '').replace(/\s+/g, '')
      if (!/^[\d+\-*/().%]+$/.test(expression)) return 'Error: 非法表达式'
      // biome-ignore lint/security/noGlobalEval: 消毒过的数学表达式，仅教学用途
      return `计算结果: ${expression} = ${Function(`"use strict"; return (${expression})`)()}`
    },
  })

  const reason = await loop.turn('帮我查一下北京的天气，并计算 1+1 等于多少？')
  console.log('Turn 结束原因:', reason.kind)
}

main().catch(e => {
  console.error('❌', e)
  process.exit(1)
})
