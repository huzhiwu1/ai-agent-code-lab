/**
 * Step 03 — 三个 provider：精简（全 false）/ 全功能（全 true）/ 说谎（声明≠实现）
 *
 * 渐进叙事：step-01 的两个 provider 没有 capabilities 字段。本步给它们长出
 * 声明——MinimalProvider 声明全 false（只能接裸委托），FullProvider 声明全 true
 * （能接 persona 等可选能力）。第三个 BrokenProvider 演示 fail loud 的边界：
 * 校验只对照"请求 vs 声明"，声明是否属实是 provider 作者的契约责任。
 *
 * 对应源码：packages/subagent/subagent-spawn-in-process/src/index.ts（capabilities L42）
 *   packages/subagent/subagent-fork-in-process/src/index.ts（capabilities L62）
 *   packages/subagent/subagent/src/types.ts（SubagentProvider L300：Providers are
 *   trusted same-process implementations——声明与实现一致是 provider 作者的义务）
 */

import { llmTask } from '../../shared/llm'
import {
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentRun,
  type SubagentStartRequest,
} from './types'

/** 本步唯一展开实现的能力：persona 的完整闭环（声明 → 校验 → 拼 system prompt → 生效） */
const PERSONA_SYSTEM = (persona: string): string =>
  `你是一个被派来干活的子代理。你的专属人设：${persona}`

export class MinimalProvider implements SubagentProvider {
  // 精简 provider：五个能力全 false——只能跑"裸"委托（学习源码 acp 式的窄能力面）。
  // 声明即承诺的左边：右边是 start() 里没有任何对应实现——两边一致，声明属实。
  readonly capabilities: SubagentCapabilities = {
    agentOptions: false,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  }
  readonly prepareContinuable = undefined

  constructor(readonly name: string) {}

  start(request: SubagentStartRequest): Promise<SubagentRun> {
    // 注意：运行时在 start() **之前**已经做了 assertCapabilities 校验——
    // 能走到这里的请求，一定没带它不支持的能力（学习源码 start L414 的校验前置）。
    // 所以这里可以放心只读 request.prompt，不用防御性处理 persona 等字段。
    return Promise.resolve({
      id: 'minimal-run-1',
      result: (async () => ({
        output: await llmTask('你是普通子代理，简短回答。', request.prompt),
      }))(),
    })
  }
}

export class FullProvider implements SubagentProvider {
  // 全功能 provider：五个能力全 true（学习源码 spawn/fork 的 capabilities）。
  // 教学版只实现 persona 一个能力的闭环，其余四个 flag 的实现方式见 types.ts
  // 注释（真实源码：agentOptions=路由覆盖、outputSchema=结构化捕获、
  // depthLimit=resolveChildDepth、toolFilter=tools.restrict()）。
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }

  constructor(readonly name: string) {}

  // 方法存在即能力（学习源码 prepareContinuable L323）：continuable 由方法在不在决定
  prepareContinuable: unknown = {}

  start(request: SubagentStartRequest): Promise<SubagentRun> {
    // persona 生效的实现：声明 persona=true 的右边——请求带了人设，就真的把它
    // 装进 system prompt（限制可见 = 限制生效）。这就是"使用"能力：校验放行后，
    // 能力字段必须在 provider 实现里有对应代码，声明才算数。
    const system =
      request.persona !== undefined
        ? PERSONA_SYSTEM(request.persona)
        : '你是一个被派来干活的普通子代理。'
    return Promise.resolve({
      id: 'full-run-1',
      result: (async () => ({ output: await llmTask(system, request.prompt) }))(),
    })
  }
}

/**
 * 💥 BrokenProvider：声明 persona=true，但 start() 里**故意忽略** request.persona。
 *
 * 演示 fail loud 的边界：assertCapabilities 只对照"请求用到的字段 vs 声明的 flag"，
 * 它验证不了"声明的 flag 是否有对应实现"——那属于 provider 作者的契约责任
 * （源码注释：Providers are trusted same-process implementations）。
 * 所以这个 provider 会**骗过校验**：请求放行，人设却静默失效——和 naive 版的
 * 事故一模一样，只是这次它披着"声明了 persona"的外衣。
 */
export class BrokenProvider implements SubagentProvider {
  // 声明：persona 支持（其余为 false 无关紧要，本演示只用 persona）
  readonly capabilities: SubagentCapabilities = {
    agentOptions: false,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: true, // ⚠️ 声明说支持……
  }

  constructor(readonly name: string) {}

  start(request: SubagentStartRequest): Promise<SubagentRun> {
    // ⚠️ ……但实现里根本没有 request.persona 的代码——字段被静默丢弃。
    // 校验只看声明，放行了；实现没落地，人设失效。声明与实现漂移。
    return Promise.resolve({
      id: 'broken-run-1',
      result: (async () => ({
        output: await llmTask('你是一个被派来干活的普通子代理。', request.prompt),
      }))(),
    })
  }
}

export {}
