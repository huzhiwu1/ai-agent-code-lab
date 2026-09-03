/**
 * Step 08 — report 工具：scope-local 安装 + 真实 LLM 工具函数
 *
 * 对应源码：packages/subagent/tool-subagent-report/src/index.ts
 *   installReportTool L49（只通过 registerContinuableSetup 装进 continuable child，
 *   roots/one-shot/remote 都看不到——可见性与权威一致）
 */

import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'

/** child 的 report 工具是否可见 = scope 是否 continuable in-process */
export type ChildScope = 'continuable' | 'one-shot' | 'root'

/**
 * report 工具注册表：只有 scope='continuable' 的 child 有 report 工具
 * （对应源码 installReportTool L49：scope-local 安装，其他作用域连入口都不存在）。
 */
export function reportToolVisible(scope: ChildScope): boolean {
  return scope === 'continuable'
}

/** 父 agent 收到的 report 记录 */
export interface ReportRecord {
  readonly senderId: string
  readonly content: string
}

/** 持久 Session：identity + lineage + 转录 */
export interface DurableSession {
  readonly id: string
  readonly parentSession: string
  readonly transcript: BaseMessage[]
}

export interface ChildHandle {
  readonly session: DurableSession
  runTask(task: string, inheritHistory: string): Promise<string>
}

/** 真实 LLM 执行 child 任务（report 使用指导对应源码 installReportTool 的 guidance 文案） */
export async function runChildTask(
  this: ChildHandle,
  task: string,
  inheritHistory: string,
): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  // 对应源码 installReportTool 的 guidance 文案：结束前调一次 report，给自包含结果——
  // 父共享工作区但不会自动收到你的转录/工具输出/推理，只说"做完了"对父没有用
  const guidance = reportToolVisible('continuable')
    ? '你有一个 report 工具：完成前把自包含的最终结果回传给父 agent。父不会自动看到你的过程，只说"做完了"对父没有用。'
    : '你没有 report 工具（one-shot child 的作用域里不存在它）。直接给出完整最终回答。'
  const history = inheritHistory.length > 0 ? `【继承的父对话上下文】\n${inheritHistory}\n\n` : ''
  const reply = await llm.invoke([
    new SystemMessage(`你是一个子代理。${guidance} 中文简洁作答。`),
    new HumanMessage(history + task),
  ])
  this.session.transcript.push(new HumanMessage(task))
  this.session.transcript.push(reply)
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

/** 真实 LLM 工具函数：父的最终汇总 */
export async function parentSummarize(reports: readonly string[]): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  const reply = await llm.invoke([
    new SystemMessage('你是父 agent。把两个子代理的报告合并成一段总览，中文，不超过 3 句话。'),
    new HumanMessage(`子代理报告 1：${reports[0]}\n子代理报告 2：${reports[1]}`),
  ])
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

export {}
