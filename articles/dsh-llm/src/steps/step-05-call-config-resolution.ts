/**
 * Step 05 – 调用配置解析：为什么发请求前要先"对一下模型能力"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「能力元数据」= adapter 对某个精确模型的能力声明：支持哪些 reasoning
 *   effort、默认 effort、defaultMaxTokens（对应源码 LlmResolvedModelInfo）。
 * 「物化（materialize）」= 把"调用方没填、但模型侧有默认值"的字段补进去，
 *   落定成最终值。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：调用方随手传 config，不支持的参数直接发给供应商，等供应商
 * 报错才回来改（浪费一次请求、浪费 token）。正解：发请求前用模型能力
 * 元数据预检，不支持就提前拒绝；同时物化默认值并深冻结，防止请求发出后
 * 配置被悄悄改动。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 1. resolveCallFor 按精确模型能力解析：请求的 reasoningEffort 模型不支持
 *    → 提前抛 UNSUPPORTED_REASONING_EFFORT（不发浪费的请求）；maxTokens
 *    没填但模型有 defaultMaxTokens → 物化；模型有默认 effort 且调用方没
 *    指定 → 落定。
 * 2. 解析后的配置 deepFreeze：请求发出后不可变——缓存复用键稳定，防止
 *    静默漂移。
 * 3. prepared call 单次派发：prepareCall 绑定注册快照 + 冻结配置，stream()
 *    只能调一次、config 必须与解析结果一致，否则 INVALID_PREPARED_CALL。
 *    保证 HMR 场景下能力解析和派发不会跨 adapter 混搭。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 请求要么符合能力、要么根本发不出去；发出去的请求配置被冻结，谁也改不动。
 *
 * 对应源码：packages/llm/llm/src/index.ts:734-814（resolveCallFor /
 *   prepareCall）+ call-config.ts:49-59（callConfigEquals）、88-117（deepFreeze）
 * 跑法：pnpm run llm:step:05（或 articles/dsh-llm 内 pnpm run step:05）
 */

/** harness 错误：带稳定机器码（对应源码 error.ts:13-22 HarnessError） */
class LlmError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
    this.name = 'LlmError'
  }
}

/** 调用配置（对应源码 call-config.ts:23-30 LlmCallConfig） */
interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/** 字段级配置相等（对应源码 call-config.ts:49-59 callConfigEquals） */
function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider ||
    a.model !== b.model ||
    a.reasoningEffort !== b.reasoningEffort ||
    a.temperature !== b.temperature ||
    a.maxTokens !== b.maxTokens
  )
    return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

/** 深冻结（对应源码 call-config.ts:88-117 deepFreeze，本步简化递归版） */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/** 精确模型的推理能力元数据（对应源码 types.ts:262-281 LlmModelReasoningInfo / LlmResolvedModelInfo） */
interface ModelCapabilities {
  provider: string
  id: string
  /** 支持的 effort 列表（适配器偏好序） */
  reasoningEfforts?: readonly { id: string; name: string }[]
  /** 调用方省略 effort 时物化的默认值 */
  defaultEffort?: string
  /** 调用方省略 maxTokens 时物化的默认值 */
  defaultMaxTokens?: number
}

/** prepared call（对应源码 index.ts:155-172 PreparedLlmCall 的演示子集） */
interface PreparedLlmCall {
  /** 已解析、已深冻结的最终配置 */
  readonly config: LlmCallConfig
  /** 哪几个字段是 adapter 物化的默认值（对应源码 LlmCallConfigAdapterDefaults） */
  readonly adapterDefaults: { reasoningEffort?: true; maxTokens?: true }
  /** 单次派发入口：config 不一致或二次调用 → INVALID_PREPARED_CALL */
  stream(options: LlmCallConfig): string
}

/** 简化运行时：能力目录 + resolveCallFor + prepareCall（对应源码 index.ts LlmRuntime 子集） */
class LlmRuntime {
  private capabilities = new Map<string, ModelCapabilities>()

  constructor(capabilities: ModelCapabilities[]) {
    for (const capability of capabilities) {
      this.capabilities.set(`${capability.provider}/${capability.id}`, capability)
    }
  }

  private capabilitiesFor(config: LlmCallConfig): ModelCapabilities {
    const capability = this.capabilities.get(`${config.provider}/${config.model}`)
    if (!capability) {
      throw new LlmError(`no adapter registered for provider "${config.provider}"`, 'NO_ADAPTER')
    }
    return capability
  }

  /**
   * 按精确模型能力解析配置（对应源码 index.ts:734-769 resolveCallFor）：
   * 1. maxTokens 未填且模型有 defaultMaxTokens → 物化；
   * 2. 请求的 effort 模型不支持 → UNSUPPORTED_REASONING_EFFORT（不发请求）；
   * 3. 调用方没指定 effort 而模型有默认 effort → 落定默认值。
   */
  resolveCallFor(config: LlmCallConfig): LlmCallConfig {
    const capability = this.capabilitiesFor(config)
    const defaulted =
      config.maxTokens === undefined && capability.defaultMaxTokens !== undefined
        ? { ...config, maxTokens: capability.defaultMaxTokens }
        : config
    const requested = defaulted.reasoningEffort
    if (capability.reasoningEfforts === undefined) {
      // 模型根本没有推理能力元数据
      if (requested !== undefined) {
        throw new LlmError(
          `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
      return defaulted
    }
    const effective = requested ?? capability.defaultEffort
    if (effective !== undefined) {
      if (!capability.reasoningEfforts.some(effort => effort.id === effective)) {
        throw new LlmError(
          `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
      // 调用方没指定、默认值落定时才改写 config
      if (requested !== effective) return { ...defaulted, reasoningEffort: effective }
    }
    return defaulted
  }

  /**
   * 绑定一次解析结果：冻结配置 + 单次派发（对应源码 index.ts:779-814 prepareCall）。
   * stream() 只允许调一次；传入 config 必须与解析结果一致。
   */
  prepareCall(config: LlmCallConfig): PreparedLlmCall {
    const resolvedConfig = deepFreeze(structuredClone(this.resolveCallFor(config)))
    const adapterDefaults = deepFreeze<{ reasoningEffort?: true; maxTokens?: true }>({
      ...(config.reasoningEffort === undefined && resolvedConfig.reasoningEffort !== undefined
        ? { reasoningEffort: true }
        : {}),
      ...(config.maxTokens === undefined && resolvedConfig.maxTokens !== undefined
        ? { maxTokens: true }
        : {}),
    })
    let dispatched = false
    return Object.freeze({
      config: resolvedConfig,
      adapterDefaults,
      stream: (options: LlmCallConfig): string => {
        if (dispatched) {
          throw new LlmError(
            'a prepared LLM call can only be dispatched once',
            'INVALID_PREPARED_CALL',
          )
        }
        if (!callConfigEquals(options, resolvedConfig)) {
          throw new LlmError(
            'prepared LLM call config changed before adapter dispatch',
            'INVALID_PREPARED_CALL',
          )
        }
        dispatched = true
        return `dispatch ${options.provider}/${options.model} maxTokens=${options.maxTokens ?? '-'} effort=${options.reasoningEffort ?? '-'}`
      },
    })
  }
}

async function main(): Promise<void> {
  console.log('⚙️  Step 05 – 调用配置解析：请求先过能力预检，配置冻结不可变')
  console.log('='.repeat(64))

  // deepseek-reasoner：声明支持 low/high 两个 effort，默认 high，defaultMaxTokens 8192
  const runtime = new LlmRuntime([
    {
      provider: 'deepseek',
      id: 'deepseek-reasoner',
      reasoningEfforts: [
        { id: 'low', name: '低思考' },
        { id: 'high', name: '高思考' },
      ],
      defaultEffort: 'high',
      defaultMaxTokens: 8192,
    },
    { provider: 'deepseek', id: 'deepseek-chat' }, // 无推理元数据、无默认 maxTokens
  ])

  // ========== ① 不带 effort → 自动落定默认 ==========
  console.log('\n① 请求不带 effort → 物化模型默认 effort + defaultMaxTokens')
  const resolved = runtime.resolveCallFor({ provider: 'deepseek', model: 'deepseek-reasoner' })
  console.log(`   ✅ 解析结果：${JSON.stringify(resolved)}`)

  // ========== ② 请求支持的 effort → 通过 ==========
  console.log('\n② 请求模型支持的 effort → 原样通过')
  const explicit = runtime.resolveCallFor({
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'low',
    maxTokens: 2048,
  })
  console.log(`   ✅ 解析结果：${JSON.stringify(explicit)}`)

  // ========== ③ 请求不支持的 effort → 提前拒绝 ==========
  console.log('\n③ 请求不支持的 effort → UNSUPPORTED_REASONING_EFFORT，请求根本不发')
  try {
    runtime.resolveCallFor({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
    console.log('   ❌ 意外：不支持的 effort 通过了')
  } catch (error) {
    console.log(
      `   ✅ 提前拒绝：${(error as LlmError).message}（code=${(error as LlmError).code}）`,
    )
    console.log('   💡 没有推理元数据（deepseek-chat）时，任何 effort 都是不支持的——不发浪费的请求')
  }

  // ========== ④ maxTokens 物化 ==========
  console.log('\n④ maxTokens 未填但模型有 defaultMaxTokens → 物化')
  console.log(`   ✅ 物化结果：maxTokens=${resolved.maxTokens}`)

  // ========== ⑤ deepFreeze 后修改 → 抛错 ==========
  console.log('\n⑤ 解析后配置深冻结：修改直接抛错')
  try {
    const frozen = runtime.resolveCallFor({ provider: 'deepseek', model: 'deepseek-reasoner' })
    deepFreeze(frozen) // prepareCall 里真正执行；这里演示冻结语义
    frozen.maxTokens = 1
    console.log('   ❌ 意外：冻结后修改没报错')
  } catch {
    console.log('   ✅ 冻结生效：请求发出后不可变（缓存复用键稳定，防止静默漂移）')
  }

  // ========== ⑥ prepared call 单次派发 ==========
  console.log('\n⑥ prepared call：绑定解析结果，只能派发一次')
  const prepared = runtime.prepareCall({ provider: 'deepseek', model: 'deepseek-reasoner' })
  console.log(
    `   ✅ 冻结配置：${JSON.stringify(prepared.config)}  物化标记：${JSON.stringify(prepared.adapterDefaults)}`,
  )
  console.log(`   ✅ 首次派发：${prepared.stream(prepared.config)}`)
  try {
    prepared.stream(prepared.config)
    console.log('   ❌ 意外：二次派发成功了')
  } catch (error) {
    console.log(`   ✅ 二次派发拒绝：${(error as LlmError).code}（一次准备一次用，防止 HMR 混搭）`)
  }
  try {
    prepared.stream({ ...prepared.config, model: 'deepseek-chat' })
    console.log('   ❌ 意外：换 config 派发成功了')
  } catch (error) {
    console.log(`   ✅ 换 config 拒绝：${(error as LlmError).code}（派发配置必须与解析结果一致）`)
  }

  console.log('\n🎯 一句话：先对能力再发请求——不支持就拒，支持就物化并冻结。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
