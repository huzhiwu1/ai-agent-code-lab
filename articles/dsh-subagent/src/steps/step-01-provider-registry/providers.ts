/**
 * Step 01 — 两个 provider 实现：spawn（同进程）+ acp（外部进程桩）
 *
 * 注意：本步的 provider 还没有 capabilities / inheritsParentContext 字段——
 * 那两个概念分别到 step-03（能力声明）和 step-02（上下文哲学）才长出来。
 * 本步两个 provider 只演示一件事：同一份委托协议，不同的运输方式。
 *
 * 对应源码：packages/subagent/subagent-spawn-in-process/src/index.ts
 *   packages/subagent/subagent-acp/src/index.ts
 */

import { randomUUID } from 'node:crypto'
import { llmTask } from '../../shared/llm'
import {
  SubagentError,
  type SubagentProvider,
  type SubagentRun,
  type SubagentResult,
  type SubagentStartRequest,
} from './types'

const CHILD_SYSTEM = '你是一个被父 agent 派来干独立小任务的子代理。直接给出结论，用中文简洁回答。'

/**
 * spawn provider：同进程 fresh child（学习源码 subagent-spawn-in-process）。
 * 完整演示「发布边界」的两个方向：
 *   发布前取消 → start() reject；
 *   发布后取消 → run.result 结算 stopReason='aborted'。
 */
export class SpawnProvider implements SubagentProvider {
  constructor(readonly name: string) {}

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const controller = new AbortController()
    // 把调用方的取消信号接到 run 自己的控制器上（对应源码 drivePublishedRun 的 onAbort）
    const relay = (): void => controller.abort()
    request.signal?.addEventListener('abort', relay, { once: true })
    // ── 发布边界之前 ──：取消信号已亮 → 拒绝，且"没有发布任何东西"
    // （对应源码 in-process-driver L107：prePublicationAbort）
    if (request.signal?.aborted) {
      controller.abort()
      throw new SubagentError(
        'subagent request was aborted before child publication',
        'START_ABORTED',
      )
    }

    // ── 发布边界：run 对象诞生 = 子代理已发布，所有权交给调用方 ──
    const id = randomUUID()
    const result = (async (): Promise<SubagentResult> => {
      try {
        const output = await llmTask(CHILD_SYSTEM, request.prompt, controller.signal)
        return { output, stopReason: 'completed' }
      } catch {
        // 发布后的失败不 reject，而是结算成 stopReason（对应源码 readResult）：
        // 取消 → aborted；模型/传输故障 → error。调用方总能 await 到一个结果。
        return controller.signal.aborted
          ? { output: '', stopReason: 'aborted' }
          : { output: '', stopReason: 'error' }
      }
    })()
    return {
      id,
      result,
      async dispose(): Promise<void> {
        request.signal?.removeEventListener('abort', relay)
        controller.abort() // 取消剩余工作，让 result 尽快结算
        await result.catch(() => undefined)
      },
    }
  }
}

/**
 * acp provider：外部进程子代理的简化桩（学习源码 subagent-acp：真实 acp 通过 ACP
 * 协议把任务交给另一个进程）。这里"外部进程" = 一个与主进程状态完全隔离的执行
 * 上下文（独立 LLM 会话），并用一段握手延迟模拟外部进程启动。
 * 进程边界不是本步重点，child 干活仍是真实 LLM。
 */
export class AcpProvider implements SubagentProvider {
  constructor(readonly name: string) {}

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const controller = new AbortController()
    // 把调用方的取消信号接到 run 自己的控制器上（对应源码 drivePublishedRun 的 onAbort）
    const relay = (): void => controller.abort()
    request.signal?.addEventListener('abort', relay, { once: true })
    // ── 发布边界之前 ──：取消信号已亮 → 拒绝（对应源码 in-process-driver 的 prePublicationAbort）
    if (request.signal?.aborted) {
      controller.abort()
      throw new SubagentError(
        'subagent request was aborted before child publication',
        'START_ABORTED',
      )
    }

    const id = randomUUID()
    const result = (async (): Promise<SubagentResult> => {
      try {
        // 模拟外部进程启动握手（对应源码 acp 的进程启动阶段）：这段时间里父 agent
        // 取消，子代理还没开始干活 → 发布后取消结算成 aborted
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250)
          controller.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted during process handshake'))
          })
        })
        const output = await llmTask(CHILD_SYSTEM, request.prompt, controller.signal)
        return { output, stopReason: 'completed' }
      } catch {
        return controller.signal.aborted
          ? { output: '', stopReason: 'aborted' }
          : { output: '', stopReason: 'error' }
      }
    })()
    return {
      id,
      result,
      async dispose(): Promise<void> {
        request.signal?.removeEventListener('abort', relay)
        controller.abort()
        await result.catch(() => undefined)
      },
    }
  }
}

export {}
