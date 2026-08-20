/**
 * Step 06 – 超时策略：一个插件怎么"挂"到 execute 环绕上？
 *
 * 学习目标：理解六段管线第 ④ 段的插件挂载方式。超时不是写死在核心调度器
 * 里的——它是 tools/execute 瀑布上的一个标准插件（真实源码
 * packages/guard/timeout-policy/src/index.ts，81 行）。要点：
 *   - timeoutMs 声明在工具定义上，而不是配置映射表里："这个工具有没有
 *     超时预算"是工具自己的能力声明。
 *   - 插件替换 exec.signal（dispatch 阶段是唯一允许替换信号的窗口）：
 *     派生一个"融合信号" = 上游取消 + 本插件超时计时器。上游取消必须
 *     继续传播——包装器不能把调用者的取消"摘掉"。
 *   - 超时是协作式的：插件 await next() 等工具体自然结束（不竞速、不放弃
 *     Promise），工具尊重信号才能提前停；不尊重就等它跑完再标记超时。
 *   - 归因精确：只有"自己的计时器"触发才算 TOOL_TIMEOUT；上游取消导致的
 *     中止归因给 ABORTED——错误码是插件私有的，嵌套超时/上游取消不会被误读。
 *   - finally 恢复上游信号：post-execute 阶段看不到插件的信号。
 *
 * 本步骤把 Step 05 的 ④ 段填实：
 *   ④ execute 环绕：timeout-policy 插件（换信号 → next() → 归因 → 恢复）
 *
 * 对应源码：packages/core/tools/src/index.ts dispatchScheduledExecution()
 *   + packages/guard/timeout-policy/src/index.ts（81 行）
 *
 * 跑法：pnpm run step:06
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
  /**
   * 取消信号。注意：**不是 readonly**——dispatch 阶段是唯一允许替换它的窗口
   * （对应源码的 ToolDispatchExecution 可变视图），超时插件就靠这个换信号。
   */
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

/** 工具定义：比 Step 05 多了 timeoutMs 预算声明 */
interface ToolDef {
  /** 超时预算（毫秒）：声明了才有超时保护，由 timeout-policy 插件强制执行 */
  timeoutMs?: number
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
// ① 参数物化（继承 Step 02-05）
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
// ② pre-execute 瀑布 + ③ 单调守卫（继承 Step 03-05）
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

// ---------------------------------------------------------------------------
// ④ tools/execute 环绕（本步骤的新内容）：timeout-policy 插件
// ---------------------------------------------------------------------------

/** 可插拔环绕包装：timeout-policy 就挂在这里（数组模拟 Cordis 瀑布） */
const wrappers: ((exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>)[] = []

/**
 * 安装超时策略插件（对应 packages/guard/timeout-policy/src/index.ts）
 *
 * 作为 tools/execute 瀑布上的一个监听者：
 *   1. 工具没声明 timeoutMs → 直接 next() 放行，什么都不管
 *   2. 派生 deadline 信号：超时计时器 + 上游取消两个来源融合——
 *      上游取消必须继续传播，包装器不能把调用者的取消"摘掉"
 *   3. 替换 exec.signal（dispatch 阶段是唯一允许替换的窗口）
 *   4. await next() 协作式等待工具体自然结束
 *   5. 归因：只有自己的计时器触发（reason 是 ToolTimeoutError）才算 TOOL_TIMEOUT；
 *      上游取消导致的中止归因给 ABORTED，绝不误读
 *   6. finally 恢复上游信号：post-execute 看不到插件的信号
 */
function installTimeoutPolicy(): void {
  wrappers.push(async (exec, next) => {
    const timeoutMs = registry.get(exec.name)?.timeoutMs
    if (timeoutMs === undefined) return next() // 没声明预算就不管

    // 派生信号：融合"上游取消"（必须保留）与"本插件超时"（新增）
    const derived = new AbortController()
    const upstream = exec.signal
    const onUpstreamAbort = (): void => derived.abort(upstream.reason)
    upstream.addEventListener('abort', onUpstreamAbort, { once: true })
    const timer = setTimeout(() => derived.abort(new ToolTimeoutError(timeoutMs)), timeoutMs)

    const previous = exec.signal
    exec.signal = derived.signal // 替换信号：工具体看到的是"带截止"的信号
    try {
      const result = await next() // 协作式：等工具体自然结束，不竞速
      // 归因：只有"我的计时器"触发才算超时；上游取消 → 归因 ABORTED
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
      exec.signal = previous // 恢复：post-execute 看不到我们的信号
    }
  })
}

/** post-execute 后处理（本步用来验证"信号已恢复"） */
const postHooks: ((exec: ToolExec, result: ToolResult) => ToolResult)[] = []

/**
 * 六段管线主入口
 *
 * ① 物化 → 检查点 A → ② pre-execute → 检查点 B → ③ guards → 检查点 C
 * → 检查点 D → ④ timeout-policy 环绕 + body → ⑤ post-execute → ⑥ 返回
 */
async function execute(exec: ToolExec): Promise<ToolResult> {
  // 检查点 A：prepare 入口
  if (isAborted(exec)) return cancellationResult(false)

  // ② pre-execute 瀑布
  for (const hook of preHooks) {
    const decision = await hook(exec)
    if (decision.kind === 'allow') continue
    if (decision.kind === 'deny') {
      return { isError: true, content: `Error: ${decision.reason}` }
    }
    return { isError: true, content: `Error: tool "${exec.name}" requires approval (no channel)` }
  }
  // 检查点 B：pre-execute 之后
  if (isAborted(exec)) return cancellationResult(false)

  // ③ 单调守卫
  const reason = guardReason(exec)
  if (reason !== undefined) {
    return { isError: true, content: `Error: guarded: ${reason}` }
  }
  // 检查点 C：guards 之后
  if (isAborted(exec)) return cancellationResult(false)

  // 检查点 D：dispatch 之前
  if (isAborted(exec)) return cancellationResult(false)

  // ④ 环绕包装（timeout-policy 在这里换信号）+ 工具体
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
  // 显式标注 next 类型，帮 TS 选中带 initialValue 的 reduceRight 重载
  let result = await wrappers.reduceRight(
    (next: () => Promise<ToolResult>, wrap) => () => wrap(exec, next),
    body,
  )()

  // ⑤ post-execute：统一后处理（替换内容 / 阻止）
  result = postHooks.reduce((r, hook) => hook(exec, r), result)

  // ⑥ 返回（简化版省略 tools/result 事件通知）
  return result
}

/** 协作式工具：分片工作，每片后检查 signal，尊重"带截止"的信号及时收尾 */
function makeCooperativeTool(label: string, totalMs: number) {
  return async (_args: unknown, exec: ToolExec): Promise<unknown> => {
    const start = Date.now()
    while (Date.now() - start < totalMs) {
      if (exec.signal.aborted) return `${label} stopped (signal)`
      await new Promise(r => setTimeout(r, 20))
    }
    return `${label} finished`
  }
}

/** 顽固工具：无视 signal 硬跑到底（糟糕实现，真实世界存在） */
function makeStubbornTool(label: string, totalMs: number) {
  return async (): Promise<unknown> => {
    await new Promise(r => setTimeout(r, totalMs))
    return `${label} finished anyway`
  }
}

/** 让 main 可读的等待辅助 */
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function main(): Promise<void> {
  console.log('⏱️  Step 06 – 超时策略：tools/execute 环绕上挂插件')
  console.log('---------------------------------------------------')

  register('search', {
    timeoutMs: 300,
    execute: makeCooperativeTool('search', 2000), // 协作：本要 2s，尊重信号提前停
    output: { render: (_args, value) => String(value) },
  })
  register('index', {
    timeoutMs: 300,
    execute: makeStubbornTool('index', 800), // 顽固：硬跑 800ms，无视信号
    output: { render: (_args, value) => String(value) },
  })
  register('fast', {
    timeoutMs: 100,
    execute: makeCooperativeTool('fast', 30), // 30ms 就完成，远低于预算
    output: { render: (_args, value) => String(value) },
  })
  register('no-budget', {
    // 不声明 timeoutMs → 超时插件完全不管它
    execute: makeStubbornTool('no-budget', 150),
    output: { render: (_args, value) => String(value) },
  })

  installTimeoutPolicy() // 装上超时插件（真实源码里这是独立的 guard 包）

  /** 演示辅助：物化一个调用（正常参数一定 ready），并断言物化成功 */
  const execOf = (name: string, signal: AbortSignal): ToolExec => {
    const mat = createExecution({ callId: `call-${name}`, name, args: {}, signal })
    if (mat.kind !== 'ready') throw new Error(mat.reason)
    return mat.exec
  }

  // 场景 1：协作工具 + 300ms 预算 → 工具尊重信号提前停，归因 TOOL_TIMEOUT
  const started1 = Date.now()
  const r1 = await execute(execOf('search', new AbortController().signal))
  console.log(
    `① 协作工具(预算300ms)  → code=${r1.error?.code}  耗时 ${Date.now() - started1}ms（工具及时停了）`,
  )
  console.log()

  // 场景 2：顽固工具 + 300ms 预算 → 等它跑完 800ms 才归因 TOOL_TIMEOUT（协作式）
  const started2 = Date.now()
  const r2 = await execute(execOf('index', new AbortController().signal))
  console.log(
    `② 顽固工具(预算300ms)  → code=${r2.error?.code}  耗时 ${Date.now() - started2}ms（不竞速，等它跑完）`,
  )
  console.log()

  // 场景 3：快工具 30ms < 预算 100ms → 正常成功；post-execute 里验证信号已恢复
  postHooks.push((exec, result) => {
    const recovered = !exec.signal.aborted && !(exec.signal.reason instanceof ToolTimeoutError)
    console.log(`   post-execute 检查：exec.signal 已恢复为上游信号 → ${recovered ? '✅' : '❌'}`)
    return result
  })
  const r3 = await execute(execOf('fast', new AbortController().signal))
  console.log(`③ 快工具(30ms<100ms)   → isError=${r3.isError}  "${r3.content}"`)
  postHooks.length = 0 // 卸掉验证钩子
  console.log()

  // 场景 4：无预算声明的工具 → 超时插件直接放行，跑满 150ms 正常完成
  const started4 = Date.now()
  const r4 = await execute(execOf('no-budget', new AbortController().signal))
  console.log(
    `④ 无预算工具           → isError=${r4.isError}  耗时 ${Date.now() - started4}ms（插件完全不管）`,
  )
  console.log()

  // 场景 5：上游取消 vs 超时归因——上游 100ms 时取消，工具 300ms 预算
  // 派生信号把上游取消传播进来：结果是 ABORTED，绝不会被误报成 TOOL_TIMEOUT
  const upstream = new AbortController()
  const running5 = execute(execOf('search', upstream.signal))
  await sleep(100)
  upstream.abort()
  const r5 = await running5
  console.log(
    `⑤ 上游取消(早于超时)   → code=${r5.error?.code}（归因 ABORTED，不误报 TOOL_TIMEOUT）`,
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：每个 step 自包含，避免与其它 step 共享 TS 全局作用域
export {}
