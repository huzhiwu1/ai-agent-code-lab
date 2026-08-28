/**
 * Step 04 – 适配器注册表 + llm/stream waterfall：调用方怎么做到"不知道供应商是谁"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「注册表」= provider 名 → adapter 实例的路由表。调用方只写
 *   `{ provider: 'deepseek' }`，注册表负责找到"会讲 DeepSeek 协议"的 adapter。
 * 「waterfall」= 一条可拦截的中间件链：每次流式调用都要从链上过一遍，
 *   每个中间件能读请求、改写请求，甚至短路（自己 yield 结果，根本不调 adapter）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：业务代码直接 `new OpenAiAdapter().chat(...)`，供应商名写死在
 * 调用点。换供应商 / 加 mock / 加日志全要改业务代码。正解：业务代码只说
 * "我要调 provider A"，路由、日志、mock 都是横切关注点。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 1. registerAdapter(providers, adapter) 是 all-or-nothing：候选集先全量
 *    校验（空名 / 重复 / 元数据坏），一个冲突整个注册拒绝（DUPLICATE_ADAPTER），
 *    绝不"注册一半"。
 * 2. replace 是原子切换：先验后换、同步段内完成，观察者看不到"旧路由已删、
 *    新路由还没上"的中间态。
 * 3. llm/stream waterfall 挂在每个流式调用上：请求日志、重放、mock 全部
 *    以中间件形式接入，与 adapter 本体解耦。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 供应商对调用方完全透明；日志/重放/mock 不碰业务代码，按需挂链。
 *
 * 对应源码：packages/llm/llm/src/index.ts:338-413（registerAdapter/prepareRoutes/
 *   commitRoutes）+ index.ts:917-927（streamWithRegistration 的 ctx.waterfall，
 *   本步用函数数组简化，不引入 Cordis）
 * 跑法：pnpm run llm:step:04（或 articles/dsh-llm 内 pnpm run step:04）
 */

/** 统一流式 chunk（沿用 step-01/02 的词汇表，本步只取演示需要的几种） */
type StreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'finish'; reason: { kind: 'stop' } }

/** 一次模型请求的最小形态（对应源码 types.ts:320-356 GenerateOptions 的演示子集） */
interface GenerateOptions {
  provider: string
  model: string
}

/** harness 错误：带稳定机器码（对应源码 error.ts:13-22 HarnessError） */
class LlmError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
    this.name = 'LlmError'
  }
}

/** provider 展示元数据（对应源码 types.ts:144-149 LlmProviderInfo） */
interface LlmProviderInfo {
  id: string
  name: string
}

/**
 * adapter 接口（对应源码 index.ts:180-233 LlmAdapter 的演示子集）。
 * 真实实现只要求 stream 一个方法，其余都有默认实现。
 */
interface LlmAdapter {
  /** 描述一个 provider 路由的展示元数据（对应源码 index.ts:186-188） */
  providerInfo(provider: string): LlmProviderInfo
  /** 流式发起一次模型调用（对应源码 index.ts:232） */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** 注册表内的一条路由（对应源码 index.ts:941-945 AdapterRegistration 的演示子集） */
interface AdapterRegistration {
  readonly adapter: LlmAdapter
  readonly provider: LlmProviderInfo
}

/**
 * 中间件签名：waterfall 链上的一环。能读请求、改写请求（返回新 options），
 * 或短路（自己 yield chunk 并返回 true，不再调 adapter，也不走后续中间件）。
 */
type StreamMiddleware = (
  options: GenerateOptions,
  invoke: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
) => AsyncIterable<StreamChunk>

/** 注册句柄：disposer + 原子替换路由（对应源码 index.ts:239-257 AdapterRegistrationHandle） */
interface AdapterRegistrationHandle {
  (): void
  replace(providers: string[]): void
}

/**
 * LLM 运行时：适配器注册表 + 带 waterfall 的 stream 入口
 * （对应源码 index.ts:284-928 LlmRuntime 的演示子集）。
 */
class LlmRuntime {
  private adapters = new Map<string, AdapterRegistration>()
  /** llm/stream 中间件链（简化：函数数组，真实是 Cordis 事件瀑布） */
  private middleware: StreamMiddleware[] = []

  /**
   * 注册一个 adapter 服务给定 provider 路由。all-or-nothing：
   * 候选集全量校验通过才一次性提交，一个冲突全拒（对应源码 index.ts:338-367）。
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle {
    const owned = new Set<string>()
    let released = false
    this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned))
    const handle = ((): void => {
      released = true
      for (const provider of owned) this.adapters.delete(provider)
      owned.clear()
    }) as AdapterRegistrationHandle
    handle.replace = (next: string[]): void => {
      if (released) {
        throw new LlmError(
          'a disposed adapter registration cannot replace its routes',
          'REGISTRATION_DISPOSED',
        )
      }
      this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned))
    }
    return handle
  }

  /**
   * 校验一个候选路由集，不写任何状态（对应源码 index.ts:374-396 prepareRoutes）：
   * - 空名 / 集合内重复 → INVALID_ADAPTER；
   * - 与别家注册冲突（自己已持有的不算）→ DUPLICATE_ADAPTER；
   * - providerInfo 返回的 id 必须等于 provider 且 name 非空 → INVALID_ADAPTER。
   */
  private prepareRoutes(
    providers: string[],
    adapter: LlmAdapter,
    owned: ReadonlySet<string>,
  ): AdapterRegistration[] {
    const unique = new Set<string>()
    const registrations: AdapterRegistration[] = []
    for (const provider of providers) {
      if (provider.length === 0) {
        throw new LlmError('adapter provider names must be non-empty', 'INVALID_ADAPTER')
      }
      if (unique.has(provider) || (this.adapters.has(provider) && !owned.has(provider))) {
        throw new LlmError(
          `an adapter for provider "${provider}" is already registered`,
          'DUPLICATE_ADAPTER',
        )
      }
      const info = adapter.providerInfo(provider)
      if (info.id !== provider || info.name.length === 0) {
        throw new LlmError(
          `adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`,
          'INVALID_ADAPTER',
        )
      }
      unique.add(provider)
      registrations.push({ adapter, provider: { id: info.id, name: info.name } })
    }
    return registrations
  }

  /**
   * 在一个同步段内完成路由替换（对应源码 index.ts:405-413 commitRoutes）：
   * 先释放旧路由再写入新路由，中间不 await、不抛错，观察者看不到中间态。
   */
  private commitRoutes(owned: Set<string>, registrations: readonly AdapterRegistration[]): void {
    for (const provider of owned) this.adapters.delete(provider)
    owned.clear()
    for (const registration of registrations) {
      this.adapters.set(registration.provider.id, registration)
      owned.add(registration.provider.id)
    }
  }

  /** 列出当前注册的 provider 路由（对应源码 index.ts:419-421 listProviders） */
  listProviders(): LlmProviderInfo[] {
    return [...this.adapters.values()].map(({ provider }) => ({ ...provider }))
  }

  /** 挂一个 llm/stream 中间件（对应源码 ctx.on('llm/stream')） */
  use(middleware: StreamMiddleware): void {
    this.middleware.push(middleware)
  }

  /** 找到 provider 对应的注册路由；没有 → NO_ADAPTER（对应源码 index.ts:816-820） */
  private registration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (!registration)
      throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER')
    return registration
  }

  /**
   * 流式调用入口：请求穿过 middleware 链，最后落到 adapter.stream。
   * 链尾的"真身"就是路由到注册表里 adapter 的那一步。
   * （对应源码 index.ts:913-927 stream + streamWithRegistration）
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const terminal: StreamMiddleware = (finalOptions, _invoke) => {
      return this.registration(finalOptions.provider).adapter.stream(finalOptions)
    }
    const chain = [...this.middleware, terminal]
    // waterfall 语义：每个中间件拿到"剩下链的入口" invoke，可以决定是否调用它
    const invokeAt =
      (index: number) =>
      (current: GenerateOptions): AsyncIterable<StreamChunk> => {
        const middleware = chain[index]
        if (!middleware) throw new Error('waterfall chain exhausted')
        return middleware(current, invokeAt(index + 1))
      }
    return invokeAt(0)(options)
  }
}

/** 模拟 adapter：DeepSeek 风格（对应源码 llm-deepseek 的演示替身） */
class MockDeepSeekAdapter implements LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek Mock' }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: `[DeepSeek ${options.model}] 你好` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 模拟 adapter：OpenAI 风格 */
class MockOpenAiAdapter implements LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenAI Mock' }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: `[OpenAI ${options.model}] Hello` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 消费统一 chunk 流（和 step-01 的循环一样，不关心供应商） */
async function drain(label: string, chunks: AsyncIterable<StreamChunk>): Promise<void> {
  const parts: string[] = []
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') parts.push(chunk.text)
  }
  console.log(`   ✅ ${label}: ${parts.join('')}`)
}

async function main(): Promise<void> {
  console.log('🗺️  Step 04 – 适配器注册表 + waterfall：调用方不认识供应商')
  console.log('='.repeat(64))

  // ========== ① 注册两个 adapter ==========
  console.log('\n① 注册 mock-deepseek / mock-openai 两个 adapter')
  const runtime = new LlmRuntime()
  const deepSeekHandle = runtime.registerAdapter(
    ['deepseek', 'deepseek-reasoner'],
    new MockDeepSeekAdapter(),
  )
  runtime.registerAdapter(['openai'], new MockOpenAiAdapter())
  console.log(
    '   ✅ 当前路由：',
    runtime
      .listProviders()
      .map(p => p.id)
      .join(', '),
  )
  await drain('deepseek →', runtime.stream({ provider: 'deepseek', model: 'deepseek-chat' }))
  await drain('openai →', runtime.stream({ provider: 'openai', model: 'gpt-4o' }))

  // ========== ② 重复注册 → all-or-nothing ==========
  console.log('\n② 重复注册：一个冲突，整个候选集全拒，原注册不受影响')
  try {
    // 候选集里 'openai' 已被占用：'claude' 虽然空闲，也必须一起被拒
    runtime.registerAdapter(['claude', 'openai'], new MockOpenAiAdapter())
    console.log('   ❌ 意外：冲突注册成功了')
  } catch (error) {
    console.log(`   ✅ 全拒：${(error as LlmError).message}（code=${(error as LlmError).code}）`)
  }
  console.log(
    '   ✅ 原注册不受影响：',
    runtime
      .listProviders()
      .map(p => p.id)
      .join(', '),
  )

  // ========== ③ replace 原子切换路由 ==========
  console.log('\n③ replace 原子切换：deepseek-reasoner → claude，一个同步段内完成')
  console.log(
    '   切换前：',
    runtime
      .listProviders()
      .map(p => p.id)
      .join(', '),
  )
  deepSeekHandle.replace(['deepseek', 'claude']) // 丢弃 deepseek-reasoner，新增 claude
  console.log(
    '   切换后：',
    runtime
      .listProviders()
      .map(p => p.id)
      .join(', '),
  )
  console.log('   ✅ 没有中间态：任何时刻读 listProviders 都只有"旧全集"或"新全集"')

  // ========== ④ waterfall 链：日志中间件 + mock 短路中间件 ==========
  console.log('\n④ llm/stream waterfall：日志中间件 + mock 短路中间件')
  const runtime2 = new LlmRuntime()
  runtime2.registerAdapter(['deepseek'], new MockDeepSeekAdapter())

  // 中间件 1：请求日志——读请求、原样放行
  runtime2.use((options, invoke) => {
    console.log(`   📝 [请求日志] provider=${options.provider} model=${options.model}`)
    return invoke(options)
  })
  // 中间件 2：mock 短路——只对 provider='fake' 生效，yield 自己的 chunk，不再调 adapter
  runtime2.use((options, invoke) => {
    if (options.provider !== 'fake') return invoke(options)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: '[mock 短路] 不调任何 adapter，直接回话' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })

  await drain('正常调用 →', runtime2.stream({ provider: 'deepseek', model: 'deepseek-chat' }))
  // provider='fake' 根本没有注册 adapter，靠短路中间件拦下来也能"调通"
  await drain('短路调用 →', runtime2.stream({ provider: 'fake', model: 'no-such-model' }))
  console.log('   💡 日志/重放/mock 都是中间件：挂在链上即可，adapter 本体与业务代码零改动')

  console.log('\n🎯 一句话：注册表管路由，waterfall 管拦截——供应商从此对调用方隐身。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
