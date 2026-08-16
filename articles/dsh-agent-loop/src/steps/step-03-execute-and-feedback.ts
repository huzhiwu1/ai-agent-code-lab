/**
 * Step 03 – 执行工具 + 结果回填 + 多 step 循环
 *
 * 学习目标：理解 Agent 闭环的完整一圈：
 *   step 1：模型声明要调工具（tool_calls）
 *   step 2：执行工具，把结果作为 ToolMessage 回填
 *   step 3：再调模型，模型看到工具结果后给出最终回答
 *
 * 对应源码 agent.ts step() 内部的核心 while 循环：
 *   while (true) {
 *     buildRequest → stream
 *     if (无 tool-calls) return { kind: 'completed' }
 *     executeToolCalls → 结果 splice 回 next-step inbox → 继续循环
 *   }
 *
 * 关键机制：
 *   - ToolMessage.tool_call_id 必须对上模型返回的 tc.id，模型才能把结果对应上
 *   - 工具结果回填后循环继续 → 这就是"多 step 往返"
 *
 * 跑法：pnpm run step:03
 */

import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'

interface ToolEntry {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

class ClosedLoop {
  private messages: BaseMessage[] = []
  private tools: Map<string, ToolEntry> = new Map()
  private llm: ChatOpenAI

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

  async turn(userInput: string): Promise<string> {
    this.messages.push(new HumanMessage(userInput))
    console.log('\n🔄 === Turn 开始 ===\n')

    // 对应源码 turn() 的 while(true)：step 循环直到 completed
    let finalAnswer: string | null = null
    while (finalAnswer === null) {
      finalAnswer = await this.step()
    }

    console.log('\n🔄 === Turn 结束 ===\n')
    return finalAnswer
  }

  /**
   * 一次 step：调模型 → 有工具就执行回填 → 返回 null 表示继续循环
   *                      → 没工具就返回最终回答
   *
   * 对应源码 step() 核心 while 循环的单次迭代
   */
  private async step(): Promise<string | null> {
    const systemPrompt = new SystemMessage(
      '你是一个 AI Agent，可以调用工具完成任务。当用户需要查询天气或计算时，调用对应工具。',
    )
    const llmMessages: BaseMessage[] = [systemPrompt, ...this.messages]

    const toolBindings = this.buildToolBindings()
    const llmWithTools = toolBindings.length > 0 ? this.llm.bindTools(toolBindings) : this.llm

    console.log(`  ⚡ 调 LLM ...`)
    const result = await llmWithTools.invoke(llmMessages)

    const toolCalls = result.tool_calls || []

    // 模型回答加入历史（工具调用声明也要保留，模型需要看到自己说过什么）
    this.messages.push(result)

    // 没有工具调用 → 这是最终回答
    if (toolCalls.length === 0) {
      const content =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      console.log(`  💬 最终回答: ${content.substring(0, 80)}`)
      return content
    }

    // 有工具调用 → 逐个执行
    console.log(`  📨 模型声明 ${toolCalls.length} 个工具调用`)
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

      console.log(`  ✅ 结果: ${resultContent.substring(0, 80)}`)

      // 关键：ToolMessage 回填，tool_call_id 必须对上 tc.id
      // 对应源码：executeToolCalls 的 acceptContext 回调 → splice 回 next-step inbox
      this.messages.push(
        new ToolMessage({
          content: resultContent,
          tool_call_id: tc.id ?? '',
        }),
      )
    }

    // 返回 null → turn() 里的 while 继续 → 再调模型（下一轮 step）
    return null
  }
}

async function main() {
  const loop = new ClosedLoop()

  loop.registerTool({
    name: 'get_weather',
    description: '查询指定城市的天气情况',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名称，例如北京' } },
      required: ['city'],
    },
    execute: async args => {
      const city = (args.city as string) || '未知城市'
      return `📍 ${city} 天气：晴天，25°C，湿度 40%，微风`
    },
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
      const result = Function(`"use strict"; return (${expression})`)()
      return `计算结果: ${expression} = ${result}`
    },
  })

  const answer = await loop.turn('帮我查一下北京的天气，并计算 1+1 等于多少？')
  console.log('\n最终回答:', answer)
}

main().catch(e => {
  console.error('❌', e)
  process.exit(1)
})
