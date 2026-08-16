/**
 * Step 02 – 加工具：模型开始"想要调工具"
 *
 * 学习目标：理解工具是怎么让模型知道的。
 *   - 工具注册表（Map<name, entry>）：保存每个工具的名字/描述/参数 Schema/执行函数
 *   - bindTools()：把工具声明塞进请求，模型就能在回答里返回 tool_calls
 *
 * 这一步：模型会返回 tool_calls，但我们还不执行工具——
 * 只是打印出来，让你看到"模型确实学会了声明工具调用"。
 *
 * 对应源码：
 *   - 工具注册表 → dsh-tools 的 ctx.tools.register()
 *   - bindTools → agent.ts buildRequest() 里把 assembly.tools 绑定进请求
 *
 * 跑法：pnpm run step:02
 */

import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'

/** 工具条目：描述 + 参数 JSON Schema + 执行函数 */
interface ToolEntry {
  name: string
  description: string
  /** 参数 JSON Schema，bindTools 时告知模型参数格式 */
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

class ToolAwareLoop {
  private messages: BaseMessage[] = []

  /** 工具注册表：对应 dsh-tools 的 tool registry */
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

  /** 注册工具，对应 dsh-tools 的 ctx.tools.register() */
  registerTool(entry: ToolEntry): void {
    this.tools.set(entry.name, entry)
  }

  /** 构建工具绑定列表：把注册的工具转成模型认识的 function 声明 */
  private buildToolBindings(): Record<string, unknown>[] {
    const bindings: Record<string, unknown>[] = []
    for (const [name, entry] of this.tools) {
      bindings.push({
        type: 'function',
        function: {
          name,
          description: entry.description,
          parameters: entry.parameters,
        },
      })
    }
    return bindings
  }

  async turn(userInput: string): Promise<void> {
    this.messages.push(new HumanMessage(userInput))
    console.log('\n🔄 === Turn 开始 ===\n')

    // 只跑一步：看模型返回什么
    await this.step()

    console.log('\n🔄 === Turn 结束 ===\n')
  }

  private async step(): Promise<void> {
    const systemPrompt = new SystemMessage(
      '你是一个 AI Agent，可以调用工具完成任务。当用户需要查询天气或计算时，调用对应工具。',
    )
    const llmMessages: BaseMessage[] = [systemPrompt, ...this.messages]

    // 关键：bindTools() 把工具声明塞进请求
    // 对应源码：agent.ts buildRequest() 的 prepareCall 绑定 tools
    const toolBindings = this.buildToolBindings()
    const llmWithTools = toolBindings.length > 0 ? this.llm.bindTools(toolBindings) : this.llm

    console.log(`  ⚡ 调 LLM（已声明 ${toolBindings.length} 个工具）...`)
    const result = await llmWithTools.invoke(llmMessages)

    const toolCalls = result.tool_calls || []
    console.log(`  📨 模型返回 tool_calls=${toolCalls.length}`)

    if (toolCalls.length === 0) {
      console.log(
        '  💬 模型直接回答:',
        typeof result.content === 'string' ? result.content : '(非文本)',
      )
      return
    }

    // 这一步先不执行工具，只展示模型"声明了"什么
    for (const tc of toolCalls) {
      console.log(`  🛠️  模型声明要调: ${tc.name}(${JSON.stringify(tc.args)})`)
      console.log('  ⏭️  Step 03 会真正执行它（这里是演示：不执行）')
    }
  }
}

async function main() {
  const loop = new ToolAwareLoop()
  loop.registerTool({
    name: 'get_weather',
    description: '查询指定城市的天气情况',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名称，例如北京' } },
      required: ['city'],
    },
    execute: async () => '（未执行）',
  })
  loop.registerTool({
    name: 'calculator',
    description: '执行数学计算，支持加减乘除',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '数学表达式，例如 1+1' } },
      required: ['expression'],
    },
    execute: async () => '（未执行）',
  })

  await loop.turn('帮我查一下北京的天气，并计算 1+1 等于多少？')
}

main().catch(e => {
  console.error('❌', e)
  process.exit(1)
})
