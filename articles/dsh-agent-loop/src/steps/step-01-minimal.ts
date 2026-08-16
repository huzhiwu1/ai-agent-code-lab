/**
 * Step 01 – 最小骨架：只有 turn/step 双层循环，没有工具
 *
 * 学习目标：先建立"turn 管回合、step 管模型往返"的双层结构直觉。
 * 这一步不做任何工具，模型回答完就直接结束 turn。
 *
 * 对应源码：agent.ts 中 ReactLoopAgent 最核心的 while 循环结构
 *   turn() {                    // 一次对话回合
 *     while (true) {            // 回合内可以跑多个 step
 *       step()                  // 一次模型往返
 *       if (无更多输入) break
 *     }
 *   }
 *
 * 跑法：pnpm run step:01
 */

import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'

/**
 * 最简 Agent 主循环
 *
 * 只有两个方法：
 *   - turn()：一次对话回合的边界
 *   - step()：一次模型调用
 *
 * 注意：这里还没有工具注册表、没有 inbox 消息队列、没有结束状态机——
 * 全部留到后面的步骤逐步加。现在只看骨架。
 */
class MinimalLoop {
  /** 会话消息历史（所有 turn/step 共用的上下文） */
  private messages: BaseMessage[] = []

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

  /**
   * 打开一个 turn：把用户消息加入历史，然后反复调 step
   * 直到模型回答完毕（没有更多要处理的）
   */
  async turn(userInput: string): Promise<string> {
    this.messages.push(new HumanMessage(userInput))
    console.log('\n🔄 === Turn 开始 ===\n')

    // 对应源码：turn() 内部的 while(true) 循环
    // 这里的"还有没有下一步"由 step 内部决定：
    // 如果 step 返回 null（模型已答完）就结束，否则继续
    let result: string | null = null
    while (result === null) {
      result = await this.step()
    }

    console.log('\n🔄 === Turn 结束 ===\n')
    return result
  }

  /**
   * 一次模型往返：把当前所有历史发给模型，拿回答
   *
   * 对应源码：step() 方法——真正的"模型调用边界"
   * 生产环境这一步会经历：buildRequest → 流式生成 → 解析 tool-calls
   * 但现在只有：组 prompt → 调模型 → 拿文本
   */
  private async step(): Promise<string | null> {
    const systemPrompt = new SystemMessage('你是一个简洁的 AI 助手，用一两句话回答问题。')
    const llmMessages: BaseMessage[] = [systemPrompt, ...this.messages]

    console.log(`  ⚡ 调 LLM ...`)
    const result = await this.llm.invoke(llmMessages)

    // 把模型回答加入历史，这样多轮对话能记住上下文
    this.messages.push(result)

    const content =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
    console.log(`  📨 回答: ${content.substring(0, 80)}...`)
    return content
  }
}

async function main() {
  const loop = new MinimalLoop()
  const answer = await loop.turn('你好，请用一句话介绍你自己。')
  console.log('\n最终回答:', answer)
}

main().catch(e => {
  console.error('❌', e)
  process.exit(1)
})
