/**
 * Step 01 – 子代理注册表：为什么"派子代理"要做成"注册表 + 可插拔 provider"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「子代理（subagent）」= 父 agent 派生出来干一件独立任务的小 agent。它有自己的
 *   上下文、自己的模型调用，干完把结果交回父（类比：老板把一份调研派给实习生，
 *   实习生自己去查资料，老板只要结论）。
 * 「provider」= 一种"子代理怎么跑起来"的运输方式实现（类比：实习生可以坐班
 *   （同进程 spawn）、也可以远程办公（外部进程 acp）——老板只按"运输方式的名字"
 *   点单，不关心具体怎么把人叫醒）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：想派子代理，就在主循环里直接 new 一个子 Agent 类写死。等想换一种
 * 子代理跑法（换成本地进程 → 远程沙箱），主循环里到处是 if/else；加一个第三方
 * 子代理实现，还得改核心代码。派生的"动作"和派生的"方式"焊死在一起了。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 注册表 + 可插拔 provider（对应源码 SubagentRuntime）：provider 按名字注册进
 * Map，父 agent 按名字 start。多个 provider 并存（不像 bash 那样只能有一个执行器），
 * 加运输方式 = 注册新 provider，不改核心。另一个关键设计是「发布边界」：
 * provider.start() 的 promise 兑现（fulfill）那一刻 = 子代理正式"发布"，所有权
 * 转移给调用方；发布前失败 → start() reject（调用方拿不到 run，无需清理）；
 * 发布后失败 → 通过 run.result 结算成 stopReason（completed/aborted/error/
 * max-tokens/refusal），result 本身不 reject。分开是因为：发布前还没有"可观察
 * 的东西"，reject 让调用方知道"压根没派出去"；发布后 run 已经存在，子代理的
 * 结局是一个"结果"而不是一个"异常"——调用方必须始终能拿到并 settle 这个 run。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 运输方式可插拔、子代理实现可扩展；调用方对"派出去没"和"结局是什么"有确定答案。
 *
 * 对应源码：packages/subagent/subagent/src/types.ts（SubagentProvider L285 /
 *   SubagentRun L249 / SubagentResult L219 / SubagentStopReasonMap L200）
 *   packages/subagent/subagent/src/index.ts（registerProvider L369 /
 *   expectProvider L449 / start L414）
 * 跑法：pnpm run subagent:step:01（或 articles/dsh-subagent 内 pnpm run step:01）
 */

import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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

// ── 1. 对外契约类型（对应源码 subagent/src/types.ts）──────────────────

/** 子代理 run 的终结原因词汇表（对应源码 SubagentStopReasonMap，merge-extensible） */
type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** run 的终端结果：非 completed 的 stopReason 意味着 output 可能不完整（对应源码 SubagentResult） */
interface SubagentResult {
  readonly output: string
  readonly stopReason: SubagentStopReason
}

/**
 * 一个已发布子代理的句柄（对应源码 SubagentRun）。
 * 发布之后：提交任务、干活、基础故障全部归 result 结算；dispose 取消剩余工作。
 */
interface SubagentRun {
  readonly id: string
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

/** 一次性委托请求（简化版：本步只保留 prompt 和取消信号） */
interface SubagentStartRequest {
  readonly prompt: string
  readonly signal?: AbortSignal
}

/** start 时刻的能力声明（Step 03 才逐项讲，这里先占位） */
interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

/** 一种"子代理怎么跑"的运输方式（对应源码 SubagentProvider） */
interface SubagentProvider {
  /** 注册表里的唯一名字（如 spawn / acp） */
  readonly name: string
  readonly capabilities: SubagentCapabilities
  /** 子代理是否继承父的已完成对话（spawn=false / fork=true，Step 02 讲） */
  readonly inheritsParentContext: boolean
  /** 建立一次性子代理并在"发布"后返回 run；发布前失败 → reject 并自行清理 */
  start(request: SubagentStartRequest): Promise<SubagentRun>
}

/** 带错误码的领域错误（对应源码 error.ts 的 SubagentError） */
class SubagentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SubagentError'
  }
}

// ── 2. 注册表：SubagentRuntime（对应源码 index.ts）──────────────────

/** 按名字注册 provider 的子代理服务 */
class SubagentRuntime {
  private providers = new Map<string, SubagentProvider>()

  /** 注册一个 provider；同名重复注册 → 报错（对应源码 registerProvider L369） */
  registerProvider(provider: SubagentProvider): void {
    if (this.providers.has(provider.name)) {
      throw new SubagentError(
        `a subagent provider named "${provider.name}" is already registered`,
        'DUPLICATE_PROVIDER',
      )
    }
    this.providers.set(provider.name, provider)
  }

  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /** 按插入顺序列出已注册的名字（对应源码 list L400） */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * 按名字派一次委托（对应源码 start L414）。
   * 注意发布边界：provider.start() reject = 这次委托从未发布，调用方拿不到 run、
   * 也无需清理；一旦兑现，所有权转移，之后的一切结局都通过 run.result 结算。
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      // 对应源码 expectProvider L449：不存在的名字 → fail loud
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    return provider.start(request)
  }
}

// ── 3. 真实 child 执行：用仓库根 .env 的 LLM 配置完成子代理任务 ─────────

const CHILD_SYSTEM = '你是一个被父 agent 派来干独立小任务的子代理。直接给出结论，用中文简洁回答。'

/** 一次真实 LLM 调用 = 子代理"干活"（用法对齐 articles/dsh-agent-loop） */
async function llmTask(task: string, signal?: AbortSignal): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  const reply = await llm.invoke([new SystemMessage(CHILD_SYSTEM), new HumanMessage(task)], {
    signal,
  })
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

/**
 * spawn provider：同进程 fresh child（对应源码 subagent-spawn-in-process）。
 * 完整演示「发布边界」的两个方向：
 *   发布前取消 → start() reject；
 *   发布后取消 → run.result 结算 stopReason='aborted'。
 */
class SpawnProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = false

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
        const output = await llmTask(request.prompt, controller.signal)
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
 * acp provider：外部进程子代理的简化桩。真实 acp 通过 ACP 协议把任务交给另一个
 * 进程；这里"外部进程" = 一个与主进程状态完全隔离的执行上下文（独立 LLM 会话），
 * 并用一段握手延迟模拟外部进程启动。进程边界不是本步重点，child 干活仍是真实 LLM。
 */
class AcpProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  }
  readonly inheritsParentContext = false

  constructor(readonly name: string) {}

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const controller = new AbortController()
    const relay = (): void => controller.abort()
    request.signal?.addEventListener('abort', relay, { once: true })
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
        // 模拟外部进程启动握手：这段时间里父 agent 取消，子代理还没开始干活
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250)
          controller.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted during process handshake'))
          })
        })
        const output = await llmTask(request.prompt, controller.signal)
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

function clip(text: string, max = 60): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

async function main(): Promise<void> {
  console.log('🧭 Step 01 – 子代理注册表：派子代理 = 按名字点单，不关心运输方式')
  console.log('='.repeat(62))

  const runtime = new SubagentRuntime()

  // ── ① 注册两个 provider：spawn（同进程）+ acp（外部进程桩）──
  console.log('\n① 注册 provider（多种运输方式并存）')
  runtime.registerProvider(new SpawnProvider('spawn'))
  runtime.registerProvider(new AcpProvider('acp'))
  console.log(`   ✅ 已注册：${runtime.list().join('、')}`)

  // ── ② 重复注册同名 → DUPLICATE_PROVIDER ──
  console.log('\n② 重复注册同名 provider')
  try {
    runtime.registerProvider(new SpawnProvider('spawn'))
    console.log('   ❌ 意外：重名注册没报错')
  } catch (error) {
    console.log(
      `   ✅ 拒绝：${(error as SubagentError).message}（code=${(error as SubagentError).code}）`,
    )
  }

  // ── ③ start 不存在的名字 → NO_PROVIDER ──
  console.log('\n③ start 一个不存在的 provider')
  try {
    await runtime.start('ghost', { prompt: '你好' })
    console.log('   ❌ 意外：幽灵 provider 居然跑起来了')
  } catch (error) {
    console.log(
      `   ✅ 拒绝：${(error as SubagentError).message}（code=${(error as SubagentError).code}）`,
    )
  }

  // ── ④ spawn 一次真实委托：child 用真实 LLM 完成任务 ──
  console.log('\n④ spawn 派一个 child（真实 LLM 干活）')
  const spawnRun = await runtime.start('spawn', { prompt: '用一句话解释什么是"闭包"。' })
  console.log(`   🔍 run.id = ${spawnRun.id}`)
  const spawnResult = await spawnRun.result
  console.log(`   📨 child 真实回答：${clip(spawnResult.output)}`)
  console.log(`   🏁 stopReason = ${spawnResult.stopReason}（发布后正常完成 → 通过 result 结算）`)

  // ── ⑤ acp 一次真实委托：外部进程桩里的 child 同样是真实 LLM ──
  console.log('\n⑤ acp 派一个 child（进程边界之外，干活仍是真实 LLM）')
  const acpRun = await runtime.start('acp', { prompt: '用一句话解释什么是"事件循环"。' })
  console.log(`   🔍 run.id = ${acpRun.id}`)
  const acpResult = await acpRun.result
  console.log(`   📨 child 真实回答：${clip(acpResult.output)}`)
  console.log(`   🏁 stopReason = ${acpResult.stopReason}`)

  // ── ⑥ 发布边界（方向一）：发布前取消 → start() reject，没有 run ──
  console.log('\n⑥ 发布边界 · 发布前失败：start() reject，调用方拿不到 run、无需清理')
  const preAborted = new AbortController()
  preAborted.abort() // 还没开始委托，取消信号已经亮了
  try {
    await runtime.start('spawn', { prompt: '永远到不了的任务', signal: preAborted.signal })
    console.log('   ❌ 意外：发布前取消居然返回了 run')
  } catch (error) {
    console.log(`   ✅ start() reject：${(error as SubagentError).message}`)
    console.log('   → 没有任何 run 诞生，调用方没有需要 dispose 的对象（未发布 = 不存在）')
  }

  // ── ⑦ 发布边界（方向二）：发布后取消 → result 结算 aborted，不 reject ──
  console.log('\n⑦ 发布边界 · 发布后失败：run.result 结算 stopReason，不 reject')
  const cancelRun = await runtime.start('acp', { prompt: '帮我写一份 200 字的项目周报。' })
  console.log(`   🔍 run.id = ${cancelRun.id}（已发布）`)
  console.log('   ⚡ 父 agent 立刻 dispose（模拟"不需要结果了"）')
  await cancelRun.dispose()
  const cancelled = await cancelRun.result // 注意：await 一个被取消的 run 不抛异常
  console.log(`   ✅ result 结算：stopReason = ${cancelled.stopReason}`)
  console.log('   → 发布前是"异常"（reject），发布后是"结局"（stopReason）——调用方永远有确定答案')

  console.log('\n🎯 一句话：注册表解耦"派什么活"和"怎么派"，发布边界解耦"没派出去"和"结局如何"。')
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
