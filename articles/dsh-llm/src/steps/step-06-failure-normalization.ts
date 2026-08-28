/**
 * Step 06 – 错误归一化：adapter 边界为什么是"最后的故障翻译点"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「归一化」= 把千奇百怪的 throw 统一成一个结构化对象（message/code/status/
 *   providerRetryAfterMs/requestId 五字段序列化事实）。
 * 「终态 chunk」= 流协议的最后一条：`finish {kind:'error'|'aborted'}`。
 *   错误不是向上 throw，而是作为流的合法结尾发给消费者。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：adapter 抛什么，消费者就 catch 什么——SDK Error、字符串、带
 * getter 的宿主对象……每个消费者都得写自己的 try/catch 判类型，稍漏一种
 * 就崩。正解：错误在 adapter 边界统一翻译成终态 finish chunk，消费者只
 * switch finish.kind，流协议永远完整。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 1. normalizeLlmFailure 只信任 Harness 自己的 code taxonomy：第三方 SDK
 *    的 code（"rate_limit_error" 之类）不是我们的分类，一律归 UNKNOWN，
 *    防 SDK 错误码混入错误路由/重试判定。
 * 2. 用 getOwnPropertyDescriptor 读字段、不触发 getter——SDK 对象上的恶意
 *    accessor 不能劫持归一化本身。
 * 3. 归一化后变成终态 finish chunk：消费者只 switch finish.kind，永远不用
 *    try/catch 供应商错误。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 供应商错误、传输错误、取消，全部收敛成流协议里的两种终态；
 * 错误路由（如 step-07 的重试）只依赖稳定 code。
 *
 * 对应源码：packages/llm/llm/src/adapter-failure.ts 全文（normalizeLlmFailure，
 *   ownFailureSnapshot 的 getter 防御细节本步简化）+ index.ts:843-900
 *   （adapterStream：选择/派发/迭代失败全部变终态 chunk）
 * 跑法：pnpm run llm:step:06（或 articles/dsh-llm 内 pnpm run step:06）
 */

/** harness 错误基类（对应源码 error.ts:13-22 HarnessError，带稳定机器码 + cause 链） */
class HarnessError extends Error {
  readonly code: string
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** LLM 领域错误：额外携带可序列化的 failure 事实（对应源码 index.ts:83-117 LlmError） */
class LlmError extends HarnessError {
  readonly failure: LlmFailure
  constructor(
    message: string,
    code: string,
    options?: { status?: number; providerRetryAfterMs?: number; requestId?: string },
  ) {
    super(message, code)
    this.failure = Object.freeze({
      message,
      code,
      ...(options?.status === undefined ? {} : { status: options.status }),
      ...(options?.providerRetryAfterMs === undefined
        ? {}
        : { providerRetryAfterMs: options.providerRetryAfterMs }),
      ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
    })
  }
}

/** 序列化失败事实（对应源码 types.ts:40-51 LlmFailure 五字段） */
interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}

/** 终态结束原因（对应源码 types.ts:116-125 FinishReasonMap 的 error/aborted） */
type TerminalFinish =
  { kind: 'error'; failure: LlmFailure } | { kind: 'aborted'; failure: LlmFailure }

/** 统一流式 chunk（本步只关心终态 finish 与普通 delta） */
type StreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'finish'; reason: { kind: 'stop' } | TerminalFinish }

/** 渲染非 Error 的 throw 值，防敌对 coercion 逃出归一化（对应源码 adapter-failure.ts:31-38） */
function thrownMessage(value: unknown): string {
  try {
    const message = String(value)
    return message.length > 0 ? message : 'LLM adapter failed'
  } catch {
    return 'LLM adapter failed'
  }
}

/** 读外部错误对象自身的 code 数据属性，不触发 accessor（对应源码 adapter-failure.ts:41-48） */
function ownErrorCode(error: Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

/** 安全读 error.message，防 getter 劫持（对应源码 adapter-failure.ts:91-99） */
function errorMessage(error: Error): string {
  try {
    const message: unknown = error.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch {
    // 落回兜底，保留可序列化失败事实
  }
  return 'LLM adapter failed'
}

/** 只信任 Harness 自己的 code；第三方 SDK 的 code 不是我们的分类（对应源码 adapter-failure.ts:102-104） */
function harnessErrorCode(error: Error): string {
  return error instanceof HarnessError ? error.code : 'UNKNOWN'
}

/**
 * 把任意 throw 值归一化成结构化 LlmFailure（对应源码 adapter-failure.ts:16-28
 * normalizeLlmFailure；跨包 failure 快照的 ownFailureSnapshot 细节本步简化）。
 */
function normalizeLlmFailure(value: unknown): LlmFailure {
  const error =
    value instanceof Error
      ? value
      : new HarnessError(thrownMessage(value), 'UNKNOWN', { cause: value })
  return Object.freeze({
    message: errorMessage(error),
    code: harnessErrorCode(error),
  })
}

/**
 * 把一个 adapter throw 转成流协议的终态 chunk（对应源码 index.ts:931-939
 * adapterFailureChunk）：signal 已中止 → aborted，否则 → error。
 */
function adapterFailureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeLlmFailure(error)
  return {
    type: 'finish',
    reason:
      signal?.aborted || failure.code === 'ABORTED'
        ? { kind: 'aborted', failure }
        : { kind: 'error', failure },
  }
}

/**
 * 最终 adapter 边界：选择、派发、迭代中的任何 throw 都变成终态 chunk，
 * 不向上抛（对应源码 index.ts:843-900 adapterStream 的演示简化）。
 */
async function* adapterStream(
  stream: () => AsyncIterable<StreamChunk>,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  let iterator: AsyncIterator<StreamChunk>
  try {
    iterator = stream()[Symbol.asyncIterator]()
  } catch (error: unknown) {
    yield adapterFailureChunk(error, signal)
    return
  }
  while (true) {
    let next: IteratorResult<StreamChunk>
    try {
      next = await iterator.next()
    } catch (error: unknown) {
      yield adapterFailureChunk(error, signal)
      return
    }
    if (next.done) return
    yield next.value
  }
}

/** 核心循环侧的消费者：只 switch finish.kind，永远不用 try/catch（对应源码消费方契约） */
function consume(chunks: AsyncIterable<StreamChunk>): Promise<void> {
  return (async () => {
    let text = ''
    for await (const chunk of chunks) {
      switch (chunk.type) {
        case 'text-delta':
          text += chunk.text
          break
        case 'finish':
          switch (chunk.reason.kind) {
            case 'stop':
              console.log(`   ✅ 正常结束：${text}`)
              break
            case 'error':
              console.log(
                `   🚫 错误终态：code=${chunk.reason.failure.code} message="${chunk.reason.failure.message}"`,
              )
              break
            case 'aborted':
              console.log(
                `   ⏹️  中止终态：code=${chunk.reason.failure.code} message="${chunk.reason.failure.message}"`,
              )
              break
          }
          break
      }
    }
  })()
}

async function main(): Promise<void> {
  console.log('🛡️  Step 06 – 错误归一化：adapter 抛什么，出来都是终态 chunk')
  console.log('='.repeat(64))

  // ========== ① 各种 throw 值归一化成标准 failure ==========
  console.log('\n① 各种 throw 值 → normalizeLlmFailure 结构化事实')
  const sdkError = Object.assign(new Error('api rate limit'), { code: 'rate_limit_error' })
  // 恶意 Error：把 message 换成一读就抛的 getter，模拟 SDK 对象上的 accessor 陷阱
  const hostileError = new Error('原始消息')
  Object.defineProperty(hostileError, 'message', {
    get(): string {
      throw new Error('别想读我')
    },
  })
  const cases: Array<{ label: string; thrown: unknown }> = [
    {
      label: 'LlmError(code=RATE_LIMIT)',
      thrown: new LlmError('provider rate limit hit', 'RATE_LIMIT', {
        status: 429,
        providerRetryAfterMs: 2000,
        requestId: 'req-1',
      }),
    },
    { label: '普通 Error', thrown: new Error('socket hang up') },
    { label: 'SDK Error(code=rate_limit_error)', thrown: sdkError },
    { label: 'throw 字符串', thrown: 'timeout' },
    { label: '带恶意 getter 的 Error', thrown: hostileError },
  ]
  for (const { label, thrown } of cases) {
    const failure = normalizeLlmFailure(thrown)
    console.log(
      `   • ${label.padEnd(28)} → code=${failure.code.padEnd(9)} message="${failure.message}"`,
    )
  }
  // ownErrorCode 不触发 accessor 读到 SDK 的 code 数据属性——但读得到也不代表被信任
  console.log(
    `   💡 检测：SDK 错误的 code 数据属性="${String(ownErrorCode(sdkError))}"，harness 不信任 → 归 UNKNOWN`,
  )
  console.log('     防止第三方错误码混入错误路由/重试判定（只有 HarnessError 子类的 code 被信任）')
  console.log(
    '   💡 恶意 getter 无法劫持归一化：message 一读就抛 → 归一化捕获，落回兜底"LLM adapter failed"',
  )

  // ========== ② 流中途抛错 → 终端 error chunk，不向上 throw ==========
  console.log('\n② 流中途抛错 → 终端 error chunk（消费者不用 try/catch）')
  await consume(
    adapterStream(async function* () {
      yield { type: 'text-delta', index: 0, text: '说了一半' }
      throw new LlmError('stream aborted mid-flight', 'TRANSPORT')
    }),
  )

  // ========== ③ 派发前就抛错 → 同样终态 ==========
  console.log('\n③ 派发（构造流）就抛错 → 同样终态 error chunk')
  await consume(
    adapterStream(() => {
      throw new LlmError('no adapter registered for provider "unknown"', 'NO_ADAPTER')
    }),
  )

  // ========== ④ signal.aborted → aborted chunk ==========
  console.log('\n④ 请求被取消（signal.aborted）→ 终态 aborted chunk')
  const controller = new AbortController()
  await consume(
    adapterStream(async function* () {
      yield { type: 'text-delta', index: 0, text: '部分输出' }
      controller.abort() // 用户点取消
      throw new HarnessError('aborted by caller', 'ABORTED')
    }, controller.signal),
  )

  // ========== ⑤ 消费者统一 switch finish.kind ==========
  console.log('\n⑤ 消费者视角：只 switch finish.kind，协议永远完整')
  console.log('   ✅ error / aborted / stop 三种结尾全走同一份消费代码（上面 ②③④ 就是证据）')

  console.log('\n🎯 一句话：adapter 边界把错误翻译成终态 chunk——流永不"半路抛出"。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
