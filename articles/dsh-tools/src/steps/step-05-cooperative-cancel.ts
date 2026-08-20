/**
 * Step 05 – 协作式取消：ABORTED vs ABORTED_BEFORE_DISPATCH
 *
 * 学习目标：理解贯穿整个管线的取消体系。用户点取消后，AbortSignal 从
 * agent loop 一路传进每个工具调用（必填字段）。源码的取消是"协作式"的：
 *   - 不竞速、不放弃 Promise：body 一旦开始，注册表就等它自然结束
 *     （quiescence），只是把最终结果替换成取消错误。竞速（Promise.race
 *     赢者通吃）的代价是被放弃的 Promise 里的工作还在跑，可能产生你
 *     不知道的副作用。
 *   - 两个错误码区分"停在哪了"：
 *       ABORTED_BEFORE_DISPATCH：body 还没启动就取消了
 *       ABORTED：body 已启动，成功结果被取消覆盖
 *     为什么区分？回放（replay）需要知道真相——"这个调用到底跑没跑"。
 *   - 取消检查点遍布全程：prepare 入口、pre-execute 之后、guards 之后、
 *     dispatch 之前，每次 await 回来都重查。
 *
 * 本步骤把 AbortSignal 引入六段管线，并在每个阶段之间加检查点：
 *   输入新增 signal（必填）+ 检查点 + cancellationResult 双错误码
 *
 * 对应源码：packages/core/tools/src/index.ts
 *   cancellationResult() / toolAbortedResult() / toolAbortedBeforeDispatchResult()
 *   .agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.md
 *
 * 跑法：pnpm run step:05
 */

/** 工具执行结果：失败时携带结构化错误码（模型可据此自我纠正） */
type ToolResult = {
  isError: boolean
  content: string
  value?: unknown
  /** 结构化错误码：ABORTED / ABORTED_BEFORE_DISPATCH / UNKNOWN_TOOL / ... */
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
  /** 必填：调用者拥有的取消信号（源码里 ToolExecutionInput.signal 是必填 readonly） */
  readonly signal: AbortSignal
}

/**
 * 取消检查函数：为什么用函数而不是直接读 exec.signal.aborted？
 * 因为 TS 的控制流收窄——`if (signal.aborted)` 之后 TS 会认为 aborted 恒真，
 * 后续代码里 signal.aborted 的读取语义被破坏。用函数读取避免误判。
 */
function isAborted(exec: ToolExec): boolean {
  return exec.signal.aborted
}

/** 取消结果工厂：body 是否已启动决定用哪个错误码 */
function cancellationResult(bodyInvoked: boolean): ToolResult {
  return bodyInvoked
    ? {
        isError: true,
        content: 'Error: tool call aborted',
        error: { code: 'ABORTED' },
      }
    : {
        isError: true,
        content: 'Error: tool call aborted before dispatch',
        error: { code: 'ABORTED_BEFORE_DISPATCH' },
      }
}

/** 注册表：强制每个工具声明 output（schema + render），否则注册直接报错 */
const registry = new Map<
  string,
  {
    execute: (args: unknown, exec: ToolExec) => Promise<unknown>
    output: { render: (args: unknown, value: unknown) => string }
  }
>()

function register(
  name: string,
  def: {
    execute: (args: unknown, exec: ToolExec) => Promise<unknown>
    output: { render: (args: unknown, value: unknown) => string }
  },
): void {
  if (typeof def.output?.render !== 'function' || typeof def.execute !== 'function') {
    throw new TypeError(`tool "${name}" must declare output { schema, render } + execute`)
  }
  registry.set(name, def)
}

// ---------------------------------------------------------------------------
// ① 参数物化（继承 Step 02-04）：lossless 验证 → 快照 → 冻结 → 身份
// ---------------------------------------------------------------------------

/** 递归检查值是否可无损 JSON 化（拒绝 undefined/函数/symbol/bigint/循环引用） */
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

/** 无损快照：先验证、再克隆 */
function snapshotJsonValue<T>(value: T): T | undefined {
  if (!isLosslessJson(value)) return undefined
  return structuredClone(value) as T
}

/** 递归冻结：任何路径上的写入在严格模式下都会抛 TypeError */
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

/** 参数物化：创建一次工具调用的"执行身份 + 只读参数" */
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
// ② pre-execute 瀑布 + ③ 单调守卫（继承 Step 03/04）
// ---------------------------------------------------------------------------

type PreToolDecision =
  { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

const preHooks: ((exec: ToolExec) => Promise<PreToolDecision> | PreToolDecision)[] = []

type ToolGuard = (exec: Readonly<ToolExec>) => string | undefined

const globalGuards: ToolGuard[] = []
const agentGuards = new Map<string, ToolGuard[]>()

/** 沿 scope 链查询守卫：先全局层，再 agent 层（从远到近），任一 reason 即拒绝 */
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

/** 可插拔瀑布：execute 环绕包装、post-execute 后处理（本步未动） */
const wrappers: ((exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>)[] = []
const postHooks: ((exec: ToolExec, result: ToolResult) => ToolResult)[] = []

/**
 * 六段管线主入口（取消检查点遍布全程）
 *
 * ① 参数物化（在 createExecution 完成）→ 检查点 A
 * ② pre-execute 瀑布 → 检查点 B
 * ③ 单调守卫 → 检查点 C
 * ④ dispatch 前 → 检查点 D，然后 body 启动
 * ⑤ post-execute → ⑥ 最终化
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
  // 检查点 B：pre-execute 之后（hook 可能等审批等了很久，取消可能在这期间发生）
  if (isAborted(exec)) return cancellationResult(false)

  // ③ 单调守卫
  const reason = guardReason(exec)
  if (reason !== undefined) {
    return { isError: true, content: `Error: guarded: ${reason}` }
  }
  // 检查点 C：guards 之后
  if (isAborted(exec)) return cancellationResult(false)

  // 检查点 D：dispatch 之前——到这里 body 还没启动
  if (isAborted(exec)) return cancellationResult(false)

  // ④ body 启动：从这一行起，取消就只能用 ABORTED（body 已启动）
  //    源码用 cancellationStates 的 bodyInvoked 标记同一事实
  const body = async (): Promise<ToolResult> => {
    const tool = registry.get(exec.name)
    if (!tool) {
      return {
        isError: true,
        content: `Error: unknown tool "${exec.name}"`,
        error: { code: 'UNKNOWN_TOOL' },
      }
    }
    // 协作式：不 race、不放弃 Promise，等工具体自然结束
    const value = await tool.execute(exec.args, exec)
    // 成功结果若撞上取消 → 被 ABORTED 覆盖（工具"跑完了"但调用者已经不要了）
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

/** 协作式工具：周期检查 signal，取消后及时收尾 */
function makeCooperativeTool(label: string, stepMs = 20, totalMs = 100) {
  return async (args: unknown, exec: ToolExec): Promise<unknown> => {
    const start = Date.now()
    // 模拟分片工作：每片完成后检查一次取消信号（"告诉它停，它就会停"）
    while (Date.now() - start < totalMs) {
      if (exec.signal.aborted) return `${label} stopped cooperatively`
      await new Promise(r => setTimeout(r, stepMs))
    }
    return `${label} finished: ${String((args as { input?: string })?.input ?? '')}`
  }
}

/** 顽固工具：完全无视 signal（糟糕的实现，但真实世界里存在） */
async function stubbornTool(): Promise<unknown> {
  await new Promise(r => setTimeout(r, 80))
  return 'stubborn finished anyway'
}

async function main(): Promise<void> {
  console.log('🛑 Step 05 – 协作式取消：ABORTED / ABORTED_BEFORE_DISPATCH')
  console.log('----------------------------------------------------------')

  register('slow', {
    execute: makeCooperativeTool('slow'),
    output: { render: (_args, value) => String(value) },
  })
  register('stubborn', {
    execute: stubbornTool,
    output: { render: (_args, value) => String(value) },
  })

  /** 演示辅助：物化一个调用（正常参数一定 ready），并断言物化成功 */
  const execOf = (name: string, signal: AbortSignal): ToolExec => {
    const mat = createExecution({ callId: `call-${name}`, name, args: {}, signal })
    if (mat.kind !== 'ready') throw new Error(mat.reason)
    return mat.exec
  }

  // 场景 1：还没开始就取消 → 检查点 A 命中 → ABORTED_BEFORE_DISPATCH
  const preAborted = new AbortController()
  preAborted.abort()
  const r1 = await execute(execOf('slow', preAborted.signal))
  console.log(`① 入口已取消    → code=${r1.error?.code}  "${r1.content}"`)
  console.log()

  // 场景 2：body 运行中取消，工具协作 → 等它自然收尾，结果被 ABORTED 覆盖
  const midAbort = new AbortController()
  const running2 = execute(execOf('slow', midAbort.signal))
  setTimeout(() => midAbort.abort(), 30) // 30ms 取消；工具分片检查到后收尾
  const r2 = await running2
  console.log(`② 运行中取消(协作) → code=${r2.error?.code}  "${r2.content}"`)
  console.log()

  // 场景 3：body 无视 signal → 照样等它结束（不竞速、不放弃 Promise）
  const stubbornAbort = new AbortController()
  const started3 = Date.now()
  const running3 = execute(execOf('stubborn', stubbornAbort.signal))
  setTimeout(() => stubbornAbort.abort(), 10) // 10ms 取消；工具 80ms 后才 settle
  const r3 = await running3
  const elapsed3 = Date.now() - started3
  console.log(
    `③ 运行中取消(无视) → code=${r3.error?.code}  "${r3.content}"（等了 ${elapsed3}ms 让工具跑完——quiescence）`,
  )
  console.log()

  // 场景 4：pre-execute 期间取消 → 检查点 B 命中 → ABORTED_BEFORE_DISPATCH
  const slowHookAbort = new AbortController()
  preHooks.push(async () => {
    await new Promise(r => setTimeout(r, 50)) // hook 自己很慢（比如等审批）
    return { kind: 'allow' }
  })
  const running4 = execute(execOf('slow', slowHookAbort.signal))
  setTimeout(() => slowHookAbort.abort(), 20) // hook 还没返回就取消
  const r4 = await running4
  console.log(`④ pre-execute 期间取消 → code=${r4.error?.code}  "${r4.content}"`)
  console.log()

  // 场景 5：正常完成
  const ok = await execute(execOf('slow', new AbortController().signal))
  console.log(`⑤ 正常完成      → isError=${ok.isError}  "${ok.content}"`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：每个 step 自包含，避免与其它 step 共享 TS 全局作用域
export {}
