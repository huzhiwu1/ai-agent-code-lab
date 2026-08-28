/**
 * Step 07 – 重试策略与执行器：怎么重试才不浪费、不雪崩？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「策略」= provider 注册时捕获的声明：哪些失败码值得重试、最多几次、
 *   退避参数（normal 限次重试 / always 无限重试）。
 * 「执行器」= 挂在 agent/request-error 扩展点上的插件：真失败时按策略
 *   算延迟、睡一觉、记日志、发出 retry 决策。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：catch 到错误直接 for 循环重试 3 次，每次固定 sleep 1 秒。
 * AUTH 错误（改 key 才有救）也重试 → 白等；几十个并发请求同时失败同时
 * 重试 → 打爆供应商。正解：策略声明"什么值得重试"，执行器负责"怎么退避"，
 * 两者分离。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 1. 策略与执行分离：provider 注册时捕获 ResolvedRetryPolicy——normal 模式
 *    限次重试指定错误码（默认 RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE）、
 *    always 模式无限重试；执行器挂在 agent/request-error 扩展点。
 * 2. 指数退避 + 对称 jitter：initialDelayMs 500 起、2 倍指数、maxDelayMs
 *    上限、jitterRatio 0.1 抖动——防所有请求同时重试形成雪崩。
 * 3. 尊重 providerRetryAfterMs：供应商说"等多久"就等多久；超过 maxDelayMs
 *    时 normal 放弃（走 next()）、always 用本地退避。
 * 4. 重试计数从会话事件日志 derive：找 llm/retry 事件里同 turn/step/provider/
 *    policyKey 的上次重试——durable、重启不丢、防重复计数。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 可恢复错误自动恢复且不雪崩；不可恢复错误立刻失败；重试决策有据可查。
 *
 * 对应源码：packages/llm/llm/src/retry-policy.ts:145-191（resolveRetryPolicy）
 *   + packages/llm/llm-retry/src/index.ts:58-63（localDelay）、111-208
 *   （backoff/recover；事件日志本步用内存数组模拟，真实是 SessionEvent）
 * 跑法：pnpm run llm:step:07（或 articles/dsh-llm 内 pnpm run step:07）
 */

/** 序列化失败事实（沿用 step-06 的归一化结果） */
interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly providerRetryAfterMs?: number
}

/** 默认重试的错误码（对应源码 retry-policy.ts:18-24 DEFAULT_RETRYABLE_CODES） */
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1
const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/** 重试策略配置（对应源码 retry-policy.ts:37-57 RetryPolicyConfig） */
type RetryPolicyConfig =
  | { mode: 'normal'; maxRetries?: number; retryableCodes?: string[]; backoff?: BackoffConfig }
  | { mode: 'always'; backoff?: BackoffConfig }

/** 退避参数（对应源码 retry-policy.ts:27-34 BackoffConfig） */
interface BackoffConfig {
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
}

/** 解析后的退避（对应源码 retry-policy.ts:60-64 ResolvedRetryBackoff） */
interface ResolvedRetryBackoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** 解析后的策略（对应源码 retry-policy.ts:67-79 ResolvedRetryPolicy） */
type ResolvedRetryPolicy =
  | (ResolvedRetryBackoff & {
      readonly mode: 'normal'
      readonly maxRetries: number
      readonly retryableCodes: readonly string[]
    })
  | (ResolvedRetryBackoff & { readonly mode: 'always' })

/**
 * 校验、补默认值、并 detach 一个策略（对应源码 retry-policy.ts:145-191
 * resolveRetryPolicy；schemastery 校验简化为手写检查）。
 */
function resolveRetryPolicy(
  config: RetryPolicyConfig | undefined,
  path: string,
): ResolvedRetryPolicy {
  if (config === undefined) {
    return Object.freeze({
      mode: 'normal',
      maxRetries: DEFAULT_MAX_RETRIES,
      retryableCodes: DEFAULT_RETRYABLE_CODES,
      ...resolveBackoff(undefined, path),
    })
  }
  switch (config.mode) {
    case 'normal': {
      const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
      const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES]
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
        throw new Error(`${path}.maxRetries must be a non-negative safe integer`)
      }
      if (retryableCodes.length === 0 || new Set(retryableCodes).size !== retryableCodes.length) {
        throw new Error(`${path}.retryableCodes must be non-empty and duplicate-free`)
      }
      return Object.freeze({
        mode: 'normal',
        maxRetries,
        retryableCodes: Object.freeze([...retryableCodes]),
        ...resolveBackoff(config.backoff, path),
      })
    }
    case 'always':
      return Object.freeze({ mode: 'always', ...resolveBackoff(config.backoff, path) })
    default:
      throw new Error(`${path}.mode must be "normal" or "always"`)
  }
}

/** 解析退避参数并校验（对应源码 retry-policy.ts:117-137 resolveBackoff） */
function resolveBackoff(config: BackoffConfig | undefined, path: string): ResolvedRetryBackoff {
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO
  if (initialDelayMs <= 0 || initialDelayMs > maxDelayMs || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(
      `${path}.backoff values are invalid (0 < initialDelayMs <= maxDelayMs, 0 <= jitterRatio <= 1)`,
    )
  }
  return Object.freeze({ initialDelayMs, maxDelayMs, jitterRatio })
}

/** 策略指纹：事件日志里找"同策略"的重试记录用的 key（对应源码 llm-retry/src/index.ts:65-76） */
function retryPolicyKey(policy: ResolvedRetryPolicy): string {
  return policy.mode === 'always'
    ? JSON.stringify([policy.mode, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
    : JSON.stringify([
        policy.mode,
        policy.maxRetries,
        [...policy.retryableCodes].sort(),
        policy.initialDelayMs,
        policy.maxDelayMs,
        policy.jitterRatio,
      ])
}

/**
 * 本地退避延迟：指数退避 + 对称 jitter（对应源码 llm-retry/src/index.ts:58-63
 * localDelay：initialDelayMs * 2^(retry-1) 封顶 maxDelayMs，再乘
 * [1-jitterRatio, 1+jitterRatio] 的随机系数，最后再封顶）。
 */
function localDelay(policy: ResolvedRetryPolicy, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

/** 会话里的一条 llm/retry 事件（对应源码 SessionEvent<'llm/retry'> 的演示形态） */
interface RetryEvent {
  type: 'llm/retry'
  data: {
    turn: number
    step: number
    provider: string
    policyKey: string
    retry: number
    delayMs: number
  }
}

/** 执行器决策：retry 或放弃（对应源码 RequestErrorAction 的演示形态） */
type RetryDecision = { kind: 'retry'; retry: number; delayMs: number } | { kind: 'give-up' }

/** 模拟会话事件日志：内存数组，真实是 append-only SessionEvent 日志（见 dsh-memory step-01） */
class SessionLog {
  private events: RetryEvent[] = []
  append(event: RetryEvent): void {
    this.events.push(event)
  }
  /** derive：找同 turn/step/provider/policyKey 的上次重试（对应源码 findLast llm/retry） */
  lastRetry(turn: number, step: number, provider: string, policyKey: string): number {
    const prior = [...this.events]
      .reverse()
      .find(
        event =>
          event.data.turn === turn &&
          event.data.step === step &&
          event.data.provider === provider &&
          event.data.policyKey === policyKey,
      )
    return prior?.data.retry ?? 0
  }
}

/**
 * 重试执行器（对应源码 llm-retry/src/index.ts:156-208 recover 的演示简化；
 * 挂 agent/request-error 扩展点、AbortSignal.any 融合等真实机制本步省略）。
 */
function recover(options: {
  turn: number
  step: number
  provider: string
  failure: LlmFailure
  policy: ResolvedRetryPolicy
  log: SessionLog
  random?: () => number
}): RetryDecision {
  const { turn, step, provider, failure, policy, log } = options
  const random = options.random ?? Math.random

  // normal 模式：失败码不在清单里 → 不重试（对应源码 llm-retry/src/index.ts:177-179）
  if (policy.mode === 'normal' && !policy.retryableCodes.includes(failure.code)) {
    return { kind: 'give-up' }
  }

  // 重试计数从会话事件日志 derive（对应源码 llm-retry/src/index.ts:181-191）：
  // 找到同 turn/step/provider/policyKey 的上次重试，加一即本次序号
  const policyKey = retryPolicyKey(policy)
  const previousRetry = log.lastRetry(turn, step, provider, policyKey)
  if (policy.mode === 'normal' && previousRetry >= policy.maxRetries) {
    return { kind: 'give-up' } // 已重试满 maxRetries，走 next() 交给下游
  }
  const retry = previousRetry + 1

  // 供应商明确说"等多久"就等多久（对应源码 llm-retry/src/index.ts:193-205）：
  // 超过 maxDelayMs 时 normal 放弃、always 用本地退避
  let delayMs: number
  if (failure.providerRetryAfterMs !== undefined && failure.providerRetryAfterMs > 0) {
    if (failure.providerRetryAfterMs > policy.maxDelayMs) {
      if (policy.mode === 'normal') return { kind: 'give-up' }
      delayMs = localDelay(policy, retry, random)
    } else {
      delayMs = failure.providerRetryAfterMs
    }
  } else {
    delayMs = localDelay(policy, retry, random)
  }

  log.append({
    type: 'llm/retry',
    data: { turn, step, provider, policyKey, retry, delayMs },
  })
  return { kind: 'retry', retry, delayMs }
}

/** 模拟一次模型请求：前 N 次失败，之后成功（演示用替身） */
function makeAttempt(
  failures: { code: string; providerRetryAfterMs?: number }[],
): () => LlmFailure | undefined {
  const queue = [...failures]
  return (): LlmFailure | undefined => {
    const failure = queue.shift()
    if (failure !== undefined)
      return {
        message: `simulated ${failure.code}`,
        code: failure.code,
        ...(failure.providerRetryAfterMs !== undefined
          ? { providerRetryAfterMs: failure.providerRetryAfterMs }
          : {}),
      }
    return undefined // 成功
  }
}

async function main(): Promise<void> {
  console.log('🔁 Step 07 – 重试策略与执行器：限次重试、指数退避、不雪崩')
  console.log('='.repeat(64))

  // ========== ① normal 策略：RATE_LIMIT 重试 2 次后成功 ==========
  console.log('\n① normal 策略：RATE_LIMIT（retryable）重试 2 次后成功')
  const policyNormal = resolveRetryPolicy(undefined, 'provider deepseek retryPolicy')
  console.log(
    `   策略：mode=${policyNormal.mode} maxRetries=${'maxRetries' in policyNormal ? policyNormal.maxRetries : '∞'} retryable=[${'retryableCodes' in policyNormal ? [...policyNormal.retryableCodes].join(',') : 'all'}]`,
  )
  const log1 = new SessionLog()
  const attempt1 = makeAttempt([{ code: 'RATE_LIMIT' }, { code: 'RATE_LIMIT' }])
  const delaySeed: number[] = []
  for (let call = 1; ; call++) {
    const failure = attempt1()
    if (failure === undefined) {
      console.log(`   ✅ 第 ${call} 次调用成功！`)
      break
    }
    const decision = recover({
      turn: 1,
      step: 1,
      provider: 'deepseek',
      failure,
      policy: policyNormal,
      log: log1,
      // 固定随机源：演示退避序列可读（真实用 Math.random）
      random: () => 0.5,
    })
    if (decision.kind === 'give-up') {
      console.log('   ❌ 意外：应该重试却放弃了')
      break
    }
    delaySeed.push(decision.delayMs)
    console.log(
      `   ⏳ 第 ${call} 次失败(${failure.code}) → retry#${decision.retry} 等 ${decision.delayMs}ms（指数退避+对称jitter）`,
    )
  }
  console.log(
    '   💡 退避序列：500 → 1000 → 2000…封顶 maxDelayMs，jitterRatio 0.1 让所有请求错开重试',
  )
  console.log(`   💡 用固定 random=0.5 展示中位值序列：[${delaySeed.join(', ')}]`)

  // ========== ② AUTH（非 retryable）→ 不重试 ==========
  console.log('\n② AUTH 失败（不在 retryableCodes）→ 不重试直接失败')
  const decisionAuth = recover({
    turn: 2,
    step: 1,
    provider: 'deepseek',
    failure: { message: 'invalid api key', code: 'AUTH' },
    policy: policyNormal,
    log: new SessionLog(),
  })
  console.log(`   ✅ 决策：${decisionAuth.kind}（改 key 才有救，重试纯属浪费）`)

  // ========== ③ always 模式：连续失败一直重试 ==========
  console.log('\n③ always 模式：连续失败一直重试（演示 3 次，真实是无限直到成功/取消）')
  const policyAlways = resolveRetryPolicy({ mode: 'always' }, 'provider gateway retryPolicy')
  const log3 = new SessionLog()
  const attempt3 = makeAttempt([{ code: 'SERVER' }, { code: 'SERVER' }, { code: 'SERVER' }])
  for (let call = 1; call <= 3; call++) {
    const failure = attempt3()
    if (failure === undefined) {
      console.log(`   ✅ 第 ${call} 次调用成功！`)
      break
    }
    const decision = recover({
      turn: 3,
      step: 1,
      provider: 'gateway',
      failure,
      policy: policyAlways,
      log: log3,
      random: () => 0.5,
    })
    console.log(
      `   ⏳ 第 ${call} 次失败(${failure.code}) → ${decision.kind === 'retry' ? `retry#${decision.retry} 等 ${decision.delayMs}ms` : 'give-up'}`,
    )
  }

  // ========== ④ providerRetryAfterMs 覆盖本地延迟 ==========
  console.log('\n④ providerRetryAfterMs：供应商说"等 2000ms"就等 2000ms')
  const decisionRetryAfter = recover({
    turn: 4,
    step: 1,
    provider: 'deepseek',
    failure: { message: 'rate limited', code: 'RATE_LIMIT', providerRetryAfterMs: 2000 },
    policy: policyNormal,
    log: new SessionLog(),
    random: () => 0.5,
  })
  console.log(
    `   ✅ 本地退避会是 500ms，但供应商权威值覆盖：delayMs=${'delayMs' in decisionRetryAfter ? decisionRetryAfter.delayMs : '-'}`,
  )
  const decisionRetryAfterHuge = recover({
    turn: 4,
    step: 2,
    provider: 'deepseek',
    failure: { message: 'rate limited', code: 'RATE_LIMIT', providerRetryAfterMs: 60_000 },
    policy: policyNormal,
    log: new SessionLog(),
    random: () => 0.5,
  })
  console.log(
    `   ✅ providerRetryAfterMs=60000 超 maxDelayMs=10000 → normal 放弃（${decisionRetryAfterHuge.kind}），always 才会改走本地退避`,
  )

  // ========== ⑤ 事件日志 derive：同 step 第二次失败 → retry 超限不再重试 ==========
  console.log('\n⑤ 重试计数从事件日志 derive：同 step 第二次失败，计数不归零')
  const log5 = new SessionLog()
  const shared = {
    turn: 5,
    step: 1,
    provider: 'deepseek',
    policy: policyNormal,
    log: log5,
    random: (): number => 0.5,
  }
  const attempt5 = makeAttempt([
    { code: 'TIMEOUT' },
    { code: 'TIMEOUT' },
    { code: 'TIMEOUT' },
    { code: 'TIMEOUT' },
  ])
  // 第一轮失败链：TIMEOUT ×3 → 重试 2 次后第 3 次失败，正常达限
  for (let call = 1; ; call++) {
    const failure = attempt5()
    if (failure === undefined) break
    const decision = recover({ ...shared, failure })
    if (decision.kind === 'give-up') {
      console.log(
        `   第一轮第 ${call} 次失败：${decision.kind}（retry 已达 maxRetries=2，交给下游）`,
      )
      break
    }
    console.log(`   第一轮第 ${call} 次失败 → retry#${decision.retry} 等 ${decision.delayMs}ms`)
  }
  // 同一 turn/step 的第二个请求又失败：日志 derive 出 previousRetry=2 → 不再重试
  const again = recover({ ...shared, failure: { message: 'timed out', code: 'TIMEOUT' } })
  console.log(
    `   ✅ 同 turn/step 的第二次失败：${again.kind}（derive 出 previousRetry=2 已达限，防重复计数）`,
  )
  console.log('   💡 计数存在事件日志里：durable、重启不丢、换了进程照样接着数')

  console.log('\n🎯 一句话：策略声明"什么值得重试"，执行器负责"怎么退避"——分离才能不浪费、不雪崩。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
