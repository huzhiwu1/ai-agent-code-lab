/**
 * Step 03 – 能力声明 + fail loud：为什么不支持的请求要提前拒绝，而不是"接受后忽略"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「capabilities」= provider 在 start 时刻支持什么特性的一组静态声明（类比：
 *   酒店房间页面上的设施清单——"有泳池/无健身房"，你订房前就能知道）。
 * 「fail loud」= 不支持就大声报错，绝不默默吞掉（类比：餐厅没有儿童座椅，
 *   你订座时服务员当场告诉你，而不是你抱着孩子到了才发现没椅子坐）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：provider 收到带 persona 的请求，发现"我不支持 persona"，就
 * 悄悄忽略这个字段继续跑。结果：父 agent 以为"我已经给子代理设了人设"，
 * 子代理实际没有任何人设——**模型以为限制生效了，实际上没有**。这种"接受
 * 后忽略"的错位极难排查，因为一切都"正常跑完了"。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * SubagentCapabilities 四个静态 flag（outputSchema / depthLimit / toolFilter
 * / persona），runtime.start() 委托前**逐一校验**请求字段 vs 声明，缺哪个
 * 抛 UNSUPPORTED_CAPABILITY——在委托还没发生时就拒绝，父 agent 立刻知道
 * "这个 provider 干不了这活"，可以换 provider 或调整请求。
 * 另一个对比设计：「方法存在即能力」——continuable 能力不设独立 flag，而是
 * 用可选方法 prepareContinuable 表示（TS narrowing 直接发现方法在不在），
 * 防止 flag 和实现漂移（flag 说 true、方法却被删了）。本步只演示 flag 校验。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 限制的"可见性"和"生效性"永远一致：要么被明确拒绝，要么真的生效。
 *
 * 对应源码：packages/subagent/subagent/src/types.ts（SubagentCapabilities L86-91）
 *   packages/subagent/subagent/src/index.ts（assertCapabilities L481-496）
 *   packages/subagent/subagent/src/types.ts（prepareContinuable L323，方法存在即能力）
 * 跑法：pnpm run subagent:step:03（或 articles/dsh-subagent 内 pnpm run step:03）
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

// ── 1. 能力声明与校验（对应源码 types.ts + index.ts）──────────────────

/** start 时刻的四个能力 flag（对应源码 SubagentCapabilities） */
interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

/** 一次性委托请求：每个可选字段都对应一个能力（对应源码 SubagentStartRequest） */
interface SubagentStartRequest {
  readonly prompt: string
  /** 要求结构化输出（对应 outputSchema 能力） */
  readonly outputSchema?: object
  /** 深度上限（对应 depthLimit 能力，Step 04 讲） */
  readonly maxDepth?: number
  /** 子代理工具过滤（对应 toolFilter 能力） */
  readonly toolFilter?: string[]
  /** 子代理专属人设（对应 persona 能力） */
  readonly persona?: string
}

interface SubagentRun {
  readonly id: string
  readonly result: Promise<{ output: string }>
}

interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  /** 可选方法 = continuable 能力（对应源码 prepareContinuable）：方法存在即能力，不设 flag */
  readonly prepareContinuable?: unknown
  start(request: SubagentStartRequest): Promise<SubagentRun>
}

/** 带错误码的领域错误（同 Step 01，对应源码 error.ts） */
class SubagentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SubagentError'
  }
}

/** 注册表（本步只保留 start + 校验，其余见 Step 01） */
class SubagentRuntime {
  private providers = new Map<string, SubagentProvider>()

  registerProvider(provider: SubagentProvider): void {
    this.providers.set(provider.name, provider)
  }

  /**
   * 委托前逐一校验：请求用到的每个字段，provider 都必须声明支持（对应源码 assertCapabilities L481-496）。
   * 拒绝发生在"委托之前"——不是接受后忽略，父 agent 的意图永远不会静默丢失。
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined)
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    this.assertCapabilities(provider, request)
    return provider.start(request)
  }

  /** 拒绝第一个"请求需要但 provider 没声明"的能力（对应源码 L482-495 的 needs 循环） */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
      { when: request.toolFilter !== undefined, cap: 'toolFilter' },
      { when: request.persona !== undefined, cap: 'persona' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new SubagentError(
          `subagent provider "${provider.name}" does not support the "${cap}" capability`,
          'UNSUPPORTED_CAPABILITY',
        )
      }
    }
  }
}

// ── 2. 两个 provider：精简（全 false）vs 全功能（全 true）──────────────

async function llmTask(system: string, task: string): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  const reply = await llm.invoke([new SystemMessage(system), new HumanMessage(task)])
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

class MinimalProvider implements SubagentProvider {
  // 精简 provider：四个能力全 false——只能跑"裸"委托
  readonly capabilities: SubagentCapabilities = {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  }
  readonly prepareContinuable = undefined

  constructor(readonly name: string) {}

  start(request: SubagentStartRequest): Promise<SubagentRun> {
    // 若运行时校验漏了，这里还有最后一道防线：声明与实现一致
    return Promise.resolve({
      id: 'minimal-run-1',
      result: (async () => ({
        output: await llmTask('你是普通子代理，简短回答。', request.prompt),
      }))(),
    })
  }
}

class FullProvider implements SubagentProvider {
  // 全功能 provider：四个能力全 true（对应源码 spawn/fork 的 capabilities L42/L62）
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }

  constructor(readonly name: string) {}

  // 方法存在即能力（对应源码 prepareContinuable L323）：continuable 由方法在不在决定
  prepareContinuable: unknown = {}

  start(request: SubagentStartRequest): Promise<SubagentRun> {
    // persona 生效的演示：把请求的人设真的装进 system prompt（限制可见 = 限制生效）
    const system =
      request.persona !== undefined
        ? `你是一个被派来干活的子代理。你的专属人设：${request.persona}`
        : '你是一个被派来干活的普通子代理。'
    return Promise.resolve({
      id: 'full-run-1',
      result: (async () => ({ output: await llmTask(system, request.prompt) }))(),
    })
  }
}

function clip(text: string, max = 70): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

async function main(): Promise<void> {
  console.log('🚦 Step 03 – 能力声明 + fail loud：不支持的请求在委托前就被拒绝')
  console.log('='.repeat(62))

  const runtime = new SubagentRuntime()
  runtime.registerProvider(new MinimalProvider('minimal'))
  runtime.registerProvider(new FullProvider('full'))
  console.log('\n① 注册两个 provider：minimal（4 个能力全 false）+ full（全 true）')

  // ── ② 向精简 provider 请求 persona → 提前抛 UNSUPPORTED_CAPABILITY ──
  console.log('\n② 向 minimal 请求 persona（它没声明这个能力）')
  try {
    await runtime.start('minimal', { prompt: '你好', persona: '说话像海盗' })
    console.log('   ❌ 意外：请求居然通过了')
  } catch (error) {
    console.log(`   ✅ 委托前拒绝：${(error as SubagentError).message}`)
    console.log(`     code = ${(error as SubagentError).code}`)
  }
  console.log('   → 关键：拒绝发生在 provider.start() **之前**，子代理从未被创建。')
  console.log('     如果"接受后忽略"，父 agent 会以为海盗人设已生效——模型以为限制在，其实不在。')

  // ── ③ 同一个请求给全功能 provider → 正常通过，persona 真实生效 ──
  console.log('\n③ 同一个请求给 full（声明了 persona 能力）→ 通过且真实生效')
  const fullRun = await runtime.start('full', {
    prompt: '用一句话介绍你自己。',
    persona: '说话像海盗',
  })
  const fullResult = await fullRun.result
  console.log(`   📨 child 回答：${clip(fullResult.output)}`)
  const personaWorked = /海盗|船|哟|yarr|pirate/i.test(fullResult.output)
  console.log(
    `   ${personaWorked ? '✅' : '❌'} 人设真的装进了 child 的 system prompt（限制可见 = 限制生效）`,
  )

  // ── ④ 逐项校验演示：四个字段各自对应一个能力 ──
  console.log('\n④ 逐项校验：每个请求字段 → 一个能力 flag')
  const probes: { label: string; request: Partial<SubagentStartRequest> }[] = [
    { label: 'maxDepth', request: { maxDepth: 2 } },
    { label: 'toolFilter', request: { toolFilter: ['read'] } },
    { label: 'outputSchema', request: { outputSchema: { type: 'object' } } },
  ]
  for (const { label, request } of probes) {
    try {
      await runtime.start('minimal', { prompt: 'hi', ...request })
      console.log(`   ❌ ${label}：意外通过`)
    } catch (error) {
      console.log(`   ✅ ${label} 请求 → minimal 抛 ${(error as SubagentError).code}`)
    }
  }

  // ── ⑤ 方法存在即能力：continuable 不设 flag ──
  console.log('\n⑤ 对比设计：continuable 能力 = 可选方法 prepareContinuable 是否存在（注释演示）')
  const hasContinuable = (p: SubagentProvider): boolean => p.prepareContinuable !== undefined
  console.log(
    `   full.prepareContinuable 存在 → continuable 能力 = ${hasContinuable(new FullProvider('x'))}`,
  )
  console.log(
    `   minimal.prepareContinuable 不存在 → continuable 能力 = ${hasContinuable(new MinimalProvider('x'))}`,
  )
  console.log('   → 为什么不设 flag：flag 说 true、方法却被删了 → 声明与实现漂移。')
  console.log('     方法在不在由 TS narrowing 直接发现，两者不可能不一致。')

  console.log('\n🎯 一句话：能力要么被明确拒绝，要么真实生效——"接受后忽略"是最贵的沉默。')
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
