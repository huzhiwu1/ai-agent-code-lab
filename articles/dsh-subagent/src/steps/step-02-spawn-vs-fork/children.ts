/**
 * Step 02 — child 执行器：spawnChild / forkChild（真实 LLM）
 *
 * 对应源码：packages/subagent/subagent-spawn-in-process/src/index.ts
 *   packages/subagent/subagent-fork-in-process/src/index.ts
 */

import { llmTask } from '../../shared/llm'
import { type SessionEvent } from './session'
import { seedAsText } from './prefix'

/**
 * 描述性标志（学习源码 SubagentProvider.inheritsParentContext）：
 * spawn = false（child 看不到父对话），fork = true（child 继承已完成 turn 前缀）。
 * 它只供模型面向的工具文案用，不改变任何服务校验。
 */
export const inheritsParentContext = { spawn: false, fork: true } as const

/** spawn：fresh child，零父上下文（学习源码 subagent-spawn-in-process，标志=false） */
export async function spawnChild(task: string): Promise<string> {
  const system =
    '你是一个被派来干独立任务的子代理。你**看不到**父 agent 的任何对话历史，只能根据任务描述回答。'
  return llmTask(system, task)
}

/** fork：seed child，先"回放"父的已完成 turn 前缀再回答（学习源码 fork 的 seed，标志=true） */
export async function forkChild(seed: readonly SessionEvent[], task: string): Promise<string> {
  const system =
    '你是一个继承了父对话上下文的子代理。下面给你父 agent 已完成的历史（回放），请基于它回答问题。'
  const history =
    seedAsText(seed).length > 0
      ? `【父对话历史（已完成 turn 的回放）】\n${seedAsText(seed)}\n\n`
      : ''
  return llmTask(system, history + task)
}

export {}
