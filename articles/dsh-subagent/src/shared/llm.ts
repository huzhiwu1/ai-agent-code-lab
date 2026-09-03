/**
 * 跨步共享 LLM 客户端：ChatOpenAI 初始化 + 封装好的 invoke。
 *
 * 封装理由：8 个 step 里重复出现了 ChatOpenAI 构造 + SystemMessage/HumanMessage
 * invoke 模式，抽到这里统一维护。每步通过相对路径 `../../shared/llm.ts` 引用。
 */

import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// 加载仓库根 .env（LLM_* 权威配置）。两个理由不用 `import 'dotenv/config'`：
// 1. 它只找 cwd 下的 .env——从 articles/dsh-subagent 内跑（铁律跑法）会找不到根 .env；
// 2. dotenv 默认不覆盖 shell 里已存在的同名变量，会顶掉根 .env 的正确 key（override 保证 .env 权威）。
const ENV_CANDIDATES = ['../../.env', '.env'] // 包内跑 → 根 .env；仓库根跑 → ./.env
for (const candidate of ENV_CANDIDATES) {
  if (existsSync(candidate)) {
    config({ path: candidate, override: true })
    break
  }
}

/** 一次真实 LLM 调用：子代理"干活"（用法对齐 articles/dsh-agent-loop） */
export async function llmTask(system: string, task: string, signal?: AbortSignal): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  const reply = await llm.invoke([new SystemMessage(system), new HumanMessage(task)], { signal })
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

export {}
