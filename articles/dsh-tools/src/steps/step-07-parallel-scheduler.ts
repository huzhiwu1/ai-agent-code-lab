/**
 * Step 07 – 并行/独占调度：厨房可以并行炒菜，上菜必须按点单顺序
 *
 * 学习目标：模型一次返回 N 个工具调用时，调度器（真实源码
 * packages/core/agent-loop/src/tool-calls.ts，289 行）怎么编排？
 *   - 分类（fail-closed）：isConcurrencySafe 精确返回 true 才进并行滚动池，
 *     抛异常/返回非 true 一律按独占处理——猜错方向永远偏向"保守"。
 *   - 滚动池：并行调用最多 maxParallelToolCalls（真实默认 10，本步演示设 2）
 *     个同时在飞，空出一个槽位就补位下一个。
 *   - 独占屏障：exclusive 调用要等池子排空才启动，单独跑完才释放——
 *     屏障持续到它的 post-execute 完成。
 *   - 提交保序（head-of-line cursor）：结果按模型顺序提交，前面的没结算完，
 *     后面的先完成也得等——模型看到的工具结果顺序 = 它请求的顺序。
 *   - 取消：已启动的 drain 完（协作式），未启动的合成
 *     ABORTED_BEFORE_DISPATCH 结果写进日志——不然回放会看到
 *     "调用了却没结果"的洞。
 *
 * 本步骤在 Step 06 完整管线外面加调度器：
 *   调度器：executionMode 分类 + 滚动池 + 独占屏障 + head-of-line 提交
 *
 * 对应源码：packages/core/agent-loop/src/tool-calls.ts
 *   executeToolCalls() → runGroup() / commitReady() / startCall() / fillPool()
 *   设计契约：.agents/notes/implemented/architecture/2026-07-10-parallel-tool-call-execution.md
 *
 * 跑法：pnpm run step:07
 */

/** 工具执行结果：失败时携带结构化错误码 */
type ToolResult = {
  isError: boolean
  content: string
  value?: unknown
  error?: { code: string }
}

/** 不透明执行 token：brand 类型让它与普通 symbol 不互通，只能由物化函数创建 */
const toolExecutionTokenBrand = Symbol('dsh.tool.execution')
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }

/** 一次工具调用的执行上下文 */
interface ToolExec {
  readonly callId: string
  readonly token: ToolExecutionToken
  readonly name: string
  /** 物化后的参数：快照 + 递归冻结 */
  readonly args: unknown
  /** 发起调用的 agent（agent-less 调用 = undefined） */
  readonly agent?: { id: string }
  /** 取消信号：dispatch 阶段是唯一允许替换它的窗口（超时插件换信号用） */
  signal: AbortSignal
}

/** 取消检查函数：用函数读取，避免 TS 控制流收窄误判 aborted 恒真 */
function isAborted(exec: ToolExec): boolean {
  return exec.signal.aborted
}

/** 取消结果工厂：body 是否已启动决定用哪个错误码 */
function cancellationResult(bodyInvoked: boolean): ToolResult {
  return bodyInvoked
    ? { isError: true, content: 'Error: tool call aborted', error: { code: 'ABORTED' } }
    : {
        isError: true,
        content: 'Error: tool call aborted before dispatch',
        error: { code: 'ABORTED_BEFORE_DISPATCH' },
      }
}

/** 插件私有的超时错误：用它精确判定"是不是我的计时器触发了" */
class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`tool timed out after ${ms}ms`)
    this.name = 'ToolTimeoutError'
  }
}

/** 工具定义：timeoutMs 预算 + 并发分类器 + 执行 + 输出契约 */
interface ToolDef {
  timeoutMs?: number
  /** 纯函数分类器：精确 true 才可并行（抛异常/非 true = 独占，fail-closed） */
  isConcurrencySafe?: (args: unknown) => boolean
  execute: (args: unknown, exec: ToolExec) => Promise<unknown>
  output: { render: (args: unknown, value: unknown) => string }
}

/** 注册表：强制每个工具声明 output（schema + render），否则注册直接报错 */
const registry = new Map<string, ToolDef>()

function register(name: string, def: ToolDef): void {
  if (typeof def.output?.render !== 'function' || typeof def.execute !== 'function') {
    throw new TypeError(`tool "${name}" must declare output { schema, render } + execute`)
  }
  registry.set(name, def)
}

// ---------------------------------------------------------------------------
// ① 参数物化（继承 Step 02-06）
// ---------------------------------------------------------------------------

function isLosslessJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    return false
  }
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every(item => isLosslessJson(item, seen))
  return Object.values(value).every(item => isLosslessJson(item, seen))
}

function snapshotJsonValue<T>(value: T): T | undefined {
  if (!isLosslessJson(value)) return undefined
  return structuredClone(value) as T
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

type Materialized = { kind: 'ready'; exec: ToolExec } | { kind: 'rejected'; reason: string }

function createExecution(input: {
  callId: string
  name: string
  args: unknown
  agent?: { id: string }
  signal: AbortSignal
}): Materialized {
  const detached = snapshotJsonValue(input.args)
  if (detached === undefined) {
    return {
      kind: 'rejected',
      reason: `tool "${input.name}" arguments must be losslessly JSON-serializable`,
    }
  }
  return {
    kind: 'ready',
    exec: {
      callId: input.callId,
      token: Symbol('dsh.tool.execution') as ToolExecutionToken,
      name: input.name,
      args: deepFreeze(detached),
      agent: input.agent,
      signal: input.signal,
    },
  }
}

// ---------------------------------------------------------------------------
// ② pre-execute 瀑布 + ③ 单调守卫 + ④ 超时环绕（继承 Step 03-06）
// ---------------------------------------------------------------------------

type PreToolDecision =
  { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

const preHooks: ((exec: ToolExec) => Promise<PreToolDecision> | PreToolDecision)[] = []

type ToolGuard = (exec: Readonly<ToolExec>) => string | undefined

const globalGuards: ToolGuard[] = []
const agentGuards = new Map<string, ToolGuard[]>()

function guardReason(exec: ToolExec): string | undefined {
  for (const guard of globalGuards) {
    const reason = guard(exec)
    if (reason !== undefined) return reason
  }
  if (exec.agent) {
    for (const guard of agentGuards.get(exec.agent.id) ?? []) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
  }
  return undefined
}

const wrappers: ((exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>)[] = []

/** 安装超时策略插件（对应 packages/guard/timeout-policy/src/index.ts） */
function installTimeoutPolicy(): void {
  wrappers.push(async (exec, next) => {
    const timeoutMs = registry.get(exec.name)?.timeoutMs
    if (timeoutMs === undefined) return next()
    const derived = new AbortController()
    const upstream = exec.signal
    const onUpstreamAbort = (): void => derived.abort(upstream.reason)
    upstream.addEventListener('abort', onUpstreamAbort, { once: true })
    const timer = setTimeout(() => derived.abort(new ToolTimeoutError(timeoutMs)), timeoutMs)
    const previous = exec.signal
    exec.signal = derived.signal
    try {
      const result = await next()
      if (derived.signal.aborted && derived.signal.reason instanceof ToolTimeoutError) {
        return {
          isError: true,
          content: `Error: tool "${exec.name}" timed out after ${timeoutMs}ms`,
          error: { code: 'TOOL_TIMEOUT' },
        }
      }
      return result
    } finally {
      clearTimeout(timer)
      upstream.removeEventListener('abort', onUpstreamAbort)
      exec.signal = previous
    }
  })
}

const postHooks: ((exec: ToolExec, result: ToolResult) => ToolResult)[] = []

/**
 * 六段管线主入口（与 Step 06 完全一致，调度器是管线的"外部"）
 *
 * ① 物化 → 检查点 A → ② pre-execute → 检查点 B → ③ guards → 检查点 C
 * → 检查点 D → ④ timeout-policy 环绕 + body → ⑤ post-execute → ⑥ 返回
 */
async function execute(exec: ToolExec): Promise<ToolResult> {
  if (isAborted(exec)) return cancellationResult(false)

  for (const hook of preHooks) {
    const decision = await hook(exec)
    if (decision.kind === 'allow') continue
    if (decision.kind === 'deny') {
      return { isError: true, content: `Error: ${decision.reason}` }
    }
    return { isError: true, content: `Error: tool "${exec.name}" requires approval (no channel)` }
  }
  if (isAborted(exec)) return cancellationResult(false)

  const reason = guardReason(exec)
  if (reason !== undefined) {
    return { isError: true, content: `Error: guarded: ${reason}` }
  }
  if (isAborted(exec)) return cancellationResult(false)
  if (isAborted(exec)) return cancellationResult(false)

  const body = async (): Promise<ToolResult> => {
    const tool = registry.get(exec.name)
    if (!tool) {
      return {
        isError: true,
        content: `Error: unknown tool "${exec.name}"`,
        error: { code: 'UNKNOWN_TOOL' },
      }
    }
    const value = await tool.execute(exec.args, exec)
    if (isAborted(exec)) return cancellationResult(true)
    try {
      return { isError: false, content: tool.output.render(exec.args, value), value }
    } catch (error) {
      return { isError: true, content: `Error: render failed: ${String(error)}` }
    }
  }
  let result = await wrappers.reduceRight(
    (next: () => Promise<ToolResult>, wrap) => () => wrap(exec, next),
    body,
  )()

  result = postHooks.reduce((r, hook) => hook(exec, r), result)
  return result
}

// ---------------------------------------------------------------------------
// 调度器（本步骤的新内容）：分类 → 滚动池 + 独占屏障 → head-of-line 提交
// ---------------------------------------------------------------------------

/** 模型一次返回的工具调用（数组顺序 = 模型顺序，提交必须保序） */
interface PlannedCall {
  callId: string
  name: string
  args: unknown
}

/**
 * 并发分类（fail-closed）：
 *   - 工具没声明 isConcurrencySafe → 独占
 *   - 分类器抛异常 → 独占（猜错方向永远偏向保守）
 *   - 只有精确返回 true → 并行
 */
function executionMode(name: string, args: unknown): 'parallel' | 'exclusive' {
  const tool = registry.get(name)
  if (!tool?.isConcurrencySafe) return 'exclusive'
  try {
    return tool.isConcurrencySafe(args) === true ? 'parallel' : 'exclusive'
  } catch {
    return 'exclusive'
  }
}

/** 物化一个调用并跑完整六段管线 */
async function executeCall(call: PlannedCall, signal: AbortSignal): Promise<ToolResult> {
  const mat = createExecution({ callId: call.callId, name: call.name, args: call.args, signal })
  if (mat.kind !== 'ready') {
    return { isError: true, content: `Error: ${mat.reason}` }
  }
  return execute(mat.exec)
}

/**
 * 调度一组调用：滚动池 + 独占屏障 + head-of-line 提交保序
 *
 * @param calls       模型顺序的工具调用列表
 * @param maxParallel 滚动池容量（真实源码 maxParallelToolCalls 默认 10）
 * @param signal      调用者取消信号（贯穿每个调用的管线）
 * @returns 按模型顺序排列的结果数组
 */
async function scheduleCalls(
  calls: PlannedCall[],
  maxParallel: number,
  signal: AbortSignal,
  t0: number,
): Promise<ToolResult[]> {
  const results: (ToolResult | undefined)[] = new Array(calls.length).fill(undefined)
  const settled = new Array(calls.length).fill(false)
  let cursor = 0 // head-of-line：下一个要提交的槽位
  let nextToStart = 0 // 下一个要启动的槽位
  const inflight = new Map<number, Promise<void>>() // 在飞槽位：槽位号 → 完成 Promise

  /** 提交保序：只推进"连续已结算"的槽位——前面的没结算完，后面的先完成也得等 */
  const commitReady = (): void => {
    while (cursor < calls.length && settled[cursor]) {
      const result = results[cursor]!
      console.log(
        `  📦 [${Date.now() - t0}ms] 提交 #${cursor} ${calls[cursor].callId} (${calls[cursor].name}): ${result.content}`,
      )
      cursor++
    }
  }

  /** 结算一个槽位：结果落位，然后尝试推进提交游标 */
  const settle = (index: number, result: ToolResult): void => {
    results[index] = result
    settled[index] = true
    console.log(
      `  ✅ [${Date.now() - t0}ms] 结算 #${index} ${calls[index].callId} (${calls[index].name}): ${result.content}`,
    )
    commitReady()
  }

  while (nextToStart < calls.length) {
    // 取消：未启动的调用合成 ABORTED_BEFORE_DISPATCH 写进日志（回放无洞），
    // 已启动的（inflight）继续 drain 完——协作式，不放弃 Promise
    if (signal.aborted) {
      for (let i = nextToStart; i < calls.length; i++) {
        console.log(
          `  ⏭️  [${Date.now() - t0}ms] #${i} ${calls[i].callId} 未启动 → 合成 ABORTED_BEFORE_DISPATCH`,
        )
        settle(i, cancellationResult(false))
      }
      break
    }

    const next = calls[nextToStart]
    const mode = executionMode(next.name, next.args)

    // 独占：屏障——等池子全部排空，单独跑，跑完才释放
    if (mode === 'exclusive') {
      await Promise.all([...inflight.values()]) // drain：已启动的自然结束
      inflight.clear()
      if (signal.aborted) continue // 屏障期间被取消 → 回到循环顶部合成
      console.log(
        `  🚧 [${Date.now() - t0}ms] 独占 #${nextToStart} ${next.callId} (${next.name}) 开始（池已排空）`,
      )
      settle(nextToStart, await executeCall(next, signal))
      nextToStart++
      continue
    }

    // 并行：滚动池——满了就等任意一个槽位结算后腾位
    if (inflight.size >= maxParallel) {
      await Promise.race([...inflight.values()])
      for (const [index] of [...inflight]) {
        if (settled[index]) inflight.delete(index) // 清掉已结算的槽位
      }
      continue // 重新检查取消 / 独占 / 池容量
    }

    // 启动一个并行调用：只有 body 阶段与兄弟重叠（管线其余阶段已在 execute 内串行）
    const index = nextToStart
    nextToStart++
    console.log(
      `  🏊 [${Date.now() - t0}ms] 并行 #${index} ${next.callId} (${next.name}) 进入滚动池`,
    )
    const promise = executeCall(next, signal).then(result => settle(index, result))
    inflight.set(index, promise)
  }

  // drain：等所有在飞的自然结束（取消时协作式收尾）
  await Promise.all([...inflight.values()])
  commitReady()
  return results as ToolResult[]
}

/** 睡眠辅助 */
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function main(): Promise<void> {
  console.log('🧵 Step 07 – 并行/独占调度：滚动池(max=2) + 独占屏障 + 提交保序')
  console.log('----------------------------------------------------------------')

  register('read', {
    isConcurrencySafe: () => true, // 读操作无副作用：精确 true → 并行
    execute: makeDelayedTool('read', 800),
    output: { render: (_args, value) => String(value) },
  })
  register('read_fast', {
    isConcurrencySafe: () => true,
    execute: makeDelayedTool('read_fast', 300),
    output: { render: (_args, value) => String(value) },
  })
  register('read_fastest', {
    isConcurrencySafe: () => true,
    execute: makeDelayedTool('read_fastest', 200),
    output: { render: (_args, value) => String(value) },
  })
  register('write', {
    // 不声明 isConcurrencySafe → 独占（写操作有副作用，绝不和兄弟重叠）
    execute: makeDelayedTool('write', 500),
    output: { render: (_args, value) => String(value) },
  })
  register('write_short', {
    execute: makeDelayedTool('write_short', 400),
    output: { render: (_args, value) => String(value) },
  })

  installTimeoutPolicy() // 超时插件照常生效（本演示里没有工具声明预算）

  /** 模拟模型一次返回 5 个调用（数组顺序 = 模型顺序，提交必须保序）
   *  顺序设计：三个连续并行 + 两个独占，最大化展示"补位/保序/屏障"三个机制 */
  const calls: PlannedCall[] = [
    { callId: 'c1', name: 'read', args: { path: 'a.ts' } }, // 并行 800ms
    { callId: 'c2', name: 'read_fast', args: { path: 'b.ts' } }, // 并行 300ms
    { callId: 'c3', name: 'read_fastest', args: { path: 'c.ts' } }, // 并行 200ms（补位）
    { callId: 'c4', name: 'write', args: { path: 'd.ts' } }, // 独占 500ms（屏障）
    { callId: 'c5', name: 'write_short', args: { path: 'e.ts' } }, // 独占 400ms
  ]
  console.log(
    '模型顺序: c1(read) → c2(read_fast) → c3(read_fastest) → c4(write=独占) → c5(write_short=独占)',
  )
  console.log()

  const t0 = Date.now()
  await scheduleCalls(calls, 2, new AbortController().signal, t0)
  console.log(`\n⏱️  总耗时 ${Date.now() - t0}ms（若全串行约 2200ms，并行省下约 500ms）`)
  console.log(
    '\n💡 观察要点：\n' +
      '  - c1/c2 并行进池；c2 先结算，c3 补位（滚动池）\n' +
      '  - c2、c3 比 c1 先结算，但提交必须等 c1 先提交（head-of-line 保序）\n' +
      '  - c4 是独占屏障：等池子全部排空才启动，c5 同理\n' +
      '  - 提交顺序永远是 c1 → c2 → c3 → c4 → c5（模型顺序）',
  )
  console.log()

  // ── fail-closed 分类演示：分类器抛异常 → 按独占处理 ──
  register('flaky', {
    isConcurrencySafe: () => {
      throw new Error('classifier bug')
    },
    execute: makeDelayedTool('flaky', 150),
    output: { render: (_args, value) => String(value) },
  })
  console.log('🧪 fail-closed 分类：isConcurrencySafe 抛异常 → 按独占处理（绝不冒险并行）')
  const mode = executionMode('flaky', {})
  console.log(`   flaky 的分类结果: ${mode}${mode === 'exclusive' ? ' ✅' : ' ❌'}`)
  console.log()

  // ── 取消演示：调度中途取消 → 已启动的 drain 完，未启动的合成结果 ──
  console.log('🛑 取消演示：250ms 时取消，池里已有 2 个在飞，第 3 个（独占）未启动')
  const cancelCalls: PlannedCall[] = [
    { callId: 'k1', name: 'read', args: {} }, // 并行 800ms（已启动）
    { callId: 'k2', name: 'read_fast', args: {} }, // 并行 300ms（已启动）
    { callId: 'k3', name: 'write', args: {} }, // 独占 500ms（未启动）
  ]
  const controller = new AbortController()
  const t1 = Date.now()
  const run = scheduleCalls(cancelCalls, 2, controller.signal, t1)
  setTimeout(() => controller.abort(), 250)
  const results = await run
  console.log(
    `   结果: k1=${results[0].error?.code}（已启动→drain 完→ABORTED）  k2=${results[1].error?.code}  k3=${results[2].error?.code}（未启动→合成）`,
  )
}

/** 演示工具工厂：按给定耗时完成工作的无副作用工具 */
function makeDelayedTool(label: string, ms: number) {
  return async (): Promise<unknown> => {
    await sleep(ms)
    return `${label} ok`
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：每个 step 自包含，避免与其它 step 共享 TS 全局作用域
export {}
