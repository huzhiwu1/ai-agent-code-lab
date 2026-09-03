/**
 * Step 06 – 生命周期可观测：start/end 事件对怎么让子代理"看得见"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「生命周期事件」= 子代理从诞生到终结向外广播的通知（类比：仓库门口的
 *   出入登记——卡车"进仓"记一笔，"出仓"记一笔，看登记簿就知道现在有几辆车
 *   在仓里、哪辆是哪批货）。
 * 「事件配对」= start 和 end 用**同一个 runId** 关联成一对（类比：快递单号——
 *   揽收和签收是两次记录，但同一个单号把"这趟运输"的两端钉在一起）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：子代理跑起来没有任何通知。观察者（日志系统、监控面板、消费
 * 工具）想知道"现在有几个子代理在跑、哪个完了、结果如何"，只能轮询内部
 * 状态——看不到边界，也没有统一词汇。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 三个设计：
 * 1. observeRun：run 发布时发 `subagent/start`（runId + provider + child id），
 *    result 结算时发配对的 `subagent/end`（**同一 runId** + stopReason +
 *    lastAssistantMessage）。观察者拿到统一词汇：一个 run 的一生 = 一对事件。
 * 2. provider 注册表广播 `provider-added` / `provider-removed`：消费方（工具层）
 *    **镜像 provider 生命周期**而不是赌加载顺序——provider 在就注册工具、走
 *    就注销。异步状态不是同步状态：跨 fiber 的依赖用事件传递，消除
 *    load-order 需求（"你先注册我才注册"的排序要求直接不存在了）。
 * 3. listener 隔离：一个 listener throw 不能饿死其他 listener（try/catch
 *    包裹每个回调）——观察者是旁观者，旁观者不能改比赛结果。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 子代理的运行全程可观测、工具注册永远与 provider 存在性同步、坏观察者不传染。
 *
 * 对应源码：packages/subagent/subagent/src/lifecycle.ts
 *   （observeRun L133-162 / createLifecycleEmitter L100-123）
 *   packages/subagent/subagent/src/index.ts（registerProvider L369-385 的
 *   provider-added 广播 + effect 清理时的 provider-removed）
 * 跑法：pnpm run subagent:step:06（或 articles/dsh-subagent 内 pnpm run step:06）
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

// ── 1. 事件类型：观察者看到的统一词汇（对应源码 types.ts 的事件 payload）──

type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** subagent/start 的 payload（对应源码 SubagentRunInfo） */
interface SubagentRunInfo {
  readonly runId: string
  readonly provider: string
  readonly id: string
}

/** subagent/end 的 payload：与 start 同 runId 配对（对应源码 SubagentRunEndInfo） */
interface SubagentRunEndInfo extends SubagentRunInfo {
  readonly stopReason: SubagentStopReason
  readonly lastAssistantMessage?: string
}

type EventName =
  'subagent/start' | 'subagent/end' | 'subagent/provider-added' | 'subagent/provider-removed'

// ── 2. 极简事件总线：on/emit + listener 隔离（对应源码 createLifecycleEmitter）──

type Listener = (payload: unknown) => void

class EventBus {
  private listeners = new Map<EventName, Listener[]>()

  on(name: EventName, listener: Listener): void {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
  }

  /**
   * 广播一个事件。每个 listener 独立 try/catch（对应源码 createLifecycleEmitter
   * 的 per-listener containment）：一个 observer throw 不影响其他 observer
   * 收到事件，也不影响事件源继续工作。
   */
  emit(name: EventName, payload: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      try {
        listener(payload)
      } catch (error) {
        console.warn(
          `   ⚠️ listener 隔离：${name} 的一个 listener 抛了 ${(error as Error).message}，其他 listener 不受影响`,
        )
      }
    }
  }
}

// ── 3. 子代理服务：注册表广播 + 事件对（对应源码 index.ts + lifecycle.ts）──

interface SubagentRun {
  readonly id: string
  readonly result: Promise<{ output: string; stopReason: SubagentStopReason }>
  dispose(): Promise<void>
}

interface SubagentProvider {
  readonly name: string
  start(prompt: string): Promise<SubagentRun>
}

/** 带事件广播的注册表（注册表机制见 Step 01，本步聚焦事件） */
class SubagentRuntime {
  private providers = new Map<string, SubagentProvider>()
  readonly events = new EventBus()

  registerProvider(provider: SubagentProvider): void {
    this.providers.set(provider.name, provider)
    // 广播 provider-added（对应源码 registerProvider 里的 ctx.emit）：
    // 消费方（工具层）听到它才注册工具——不需要"先有 provider 再加载工具"的加载顺序
    this.events.emit('subagent/provider-added', provider.name)
  }

  /** 移除 provider：广播 provider-removed，消费方同步注销工具（镜像生命周期） */
  removeProvider(name: string): void {
    this.providers.delete(name)
    this.events.emit('subagent/provider-removed', name)
  }

  async start(name: string, prompt: string): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`no subagent provider registered for "${name}"`)
    const run = await provider.start(prompt)
    // observeRun（对应源码 observeRun L133）：发布 start 事件 + 挂上 end 事件的结算钩子
    return this.observeRun(provider.name, run)
  }

  /**
   * 把 run 的一生包成一对事件（对应源码 observeRun L133-162）：
   * start 事件先同步发出；result 结算时（无论成功失败）发出配对的 end 事件。
   */
  private observeRun(provider: string, run: SubagentRun): SubagentRun {
    const identity: SubagentRunInfo = { runId: randomUUID(), provider, id: run.id }
    // 先挂 end 钩子再发 start：保证任何结算都发生在 start 之后（start → end 顺序不破）
    void run.result.then(
      result => {
        this.events.emit('subagent/end', {
          ...identity,
          stopReason: result.stopReason,
          ...(result.output.length > 0 ? { lastAssistantMessage: result.output } : {}),
        })
      },
      () => {
        this.events.emit('subagent/end', { ...identity, stopReason: 'error' })
      },
    )
    this.events.emit('subagent/start', identity)
    return run
  }
}

// ── 4. 真实 LLM 的 spawn provider ──────────────────────────────

async function llmTask(task: string): Promise<string> {
  const llm = new ChatOpenAI({
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    configuration: { baseURL: process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1' },
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: 256,
  })
  const reply = await llm.invoke([
    new SystemMessage('你是一个被父 agent 派来干活的子代理，直接给出结论，中文回答。'),
    new HumanMessage(task),
  ])
  return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
}

class SpawnProvider implements SubagentProvider {
  readonly name = 'spawn'

  async start(prompt: string): Promise<SubagentRun> {
    const id = randomUUID()
    const result = (async () => {
      try {
        const output = await llmTask(prompt)
        return { output, stopReason: 'completed' as SubagentStopReason }
      } catch {
        return { output: '', stopReason: 'error' as SubagentStopReason }
      }
    })()
    return { id, result, async dispose() {} }
  }
}

function clip(text: string, max = 60): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

async function main(): Promise<void> {
  console.log('📡 Step 06 – 生命周期可观测：一对事件讲清一个 run 的一生')
  console.log('='.repeat(62))

  const runtime = new SubagentRuntime()
  // 工具层：镜像 provider 生命周期（对应源码 tool-subagent 的 provider-added/removed 监听）
  let mountedTools: string[] = []
  runtime.events.on('subagent/provider-added', name => {
    mountedTools.push(`subagent-${name}`)
    console.log(`   🛠️ 工具层镜像：provider "${name}" 出现 → 注册工具 subagent-${name}`)
  })
  runtime.events.on('subagent/provider-removed', name => {
    mountedTools = mountedTools.filter(tool => tool !== `subagent-${name}`)
    console.log(`   🧹 工具层镜像：provider "${name}" 离开 → 注销工具 subagent-${name}`)
  })

  // ── ① 注册/移除 provider：added/removed 广播 ──
  console.log('\n① 注册 provider（观察工具层如何镜像生命周期）')
  runtime.registerProvider(new SpawnProvider())
  console.log(`   → 当前挂载的工具：${mountedTools.join('、') || '（无）'}`)
  console.log('\n② 移除 provider')
  runtime.removeProvider('spawn')
  console.log(`   → 当前挂载的工具：${mountedTools.join('、') || '（无）'}`)
  console.log('   → 异步状态不是同步状态：工具不赌"加载顺序"，provider 在就注册、走就注销。')
  runtime.registerProvider(new SpawnProvider()) // 重新注册，供下面 start 用

  // ── ③ 订阅 start/end，看一对事件的完整配对 ──
  console.log('\n③ 订阅 subagent/start + subagent/end，跑一次真实委托')
  const seen: { start?: SubagentRunInfo; end?: SubagentRunEndInfo } = {}
  runtime.events.on('subagent/start', payload => {
    const info = payload as SubagentRunInfo
    seen.start = info
    console.log(
      `   🟢 start：runId=${info.runId.slice(0, 8)}… provider=${info.provider} childId=${info.id.slice(0, 8)}…`,
    )
  })
  runtime.events.on('subagent/end', payload => {
    const info = payload as SubagentRunEndInfo
    seen.end = info
    console.log(`   🔴 end：  runId=${info.runId.slice(0, 8)}… stopReason=${info.stopReason}`)
    if (info.lastAssistantMessage)
      console.log(`       lastAssistantMessage=${clip(info.lastAssistantMessage)}`)
  })

  const run = await runtime.start('spawn', '用一句话回答：什么是事件驱动？')
  const result = await run.result
  console.log(`   📨 最终输出：${clip(result.output)}`)
  console.log(
    `   ${seen.start !== undefined && seen.end !== undefined && seen.start.runId === seen.end.runId ? '✅' : '❌'} start/end 同 runId 配对成功（${seen.start?.runId.slice(0, 8)}…）`,
  )

  // ── ④ listener 隔离：一个坏 observer 不饿死其他人 ──
  console.log('\n④ listener 隔离：故意 throw 的 observer 不影响其他 listener')
  let goodListenerGotIt = false
  runtime.events.on('subagent/start', () => {
    throw new Error('我是坏 observer，我炸了')
  })
  runtime.events.on('subagent/start', () => {
    goodListenerGotIt = true
    console.log('   ✅ 好 observer 仍然收到事件')
  })
  await runtime.start('spawn', '用一句话回答：什么是闭包？').then(r => r.result)
  console.log(
    `   ${goodListenerGotIt ? '✅' : '❌'} 隔离生效：坏 observer 的异常被吞掉并警告，不影响其他人`,
  )
  console.log('   → 观察者是旁观者：旁观者摔一跤，比赛照常进行。')

  console.log(
    '\n🎯 一句话：run 的一生 = 一对同 runId 的 start/end 事件；工具随 provider 进退；坏观察者不传染。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
