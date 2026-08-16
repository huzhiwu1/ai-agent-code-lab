/**
 * Step 04 – 加结束状态机：max-tokens 粘性、错误处理、取消
 *
 * 学习目标：理解生产级 turn 结束原因为什么重要。
 *
 * 对应源码 agent.ts：
 *   - TurnEndReason 联合类型：completed / max-tokens / aborted / error / blocked
 *   - max-tokens 粘性：一旦某 step 触顶，后续正常 step 不能把 turn 结果降级回 completed
 *   - AbortController：取消信号贯穿 turn/step/工具执行
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

/** Turn 结束原因，对应 agent.ts 的 TurnEndReason */
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
   */
  async turn(userInput: string): Promise<TurnEndReason> {
    this.messages.push(new HumanMessage(userInput))
    console.log('\n🔄 === Turn 开始 ===\n')

    let turnEnds: TurnEndReason | null = null

    // 工具回填后需要再跑一步的标记
    let needAnotherStep = false

    while (true) {
      if (this.aborted) {
        turnEnds = { kind: 'aborted' }
        break
      }

      const stepEnd = await this.step()

      // step() 返回 null 表示“工具结果已回填，需要再调一次模型”
      if (stepEnd === null) {
        needAnotherStep = true
        continue
      }

      // max-tokens 粘性：触顶过就不能被降级
      // 对应源码: if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
      // 用辅助函数避免 TS 控制流收窄问题（stepEnd 可能是 null=待继续）
      const merged = mergeTurnEnds(turnEnds, stepEnd)
      turnEnds = merged

      // completed 且有工具回填待消化 → 继续循环
      if (needAnotherStep && turnEnds?.kind === 'completed') {
        needAnotherStep = false
        continue
      }

      // 其他情况（completed 无待处理 / max-tokens / aborted / error）→ 结束 turn
      break
    }

    console.log(`\n🔄 === Turn 结束 (${turnEnds?.kind ?? 'unknown'}) ===\n`)
    return turnEnds ?? { kind: 'completed' }
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

      // 工具结果已回填 → 返回 null 语义：继续循环。
      // 但我们的状态机里用一个哨兵值表示"继续"——用 error 里的特殊标志不可取，
      // 所以这里直接返回 completed 会让 turn 提前结束？不对——
      // 真实源码 step() 返回 null 表示继续。
      // 处理：返回一个"中间态"——用 max-tokens 之外的方式。
      // 简化：这里返回 null，由 turn() 判断 null = 继续循环。
      return null as unknown as TurnEndReason
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
