/**
 * Step 06 – 超时：tools/execute 环绕包装器（复刻 timeout-policy）
 *
 * 学习目标：源码的超时策略是一个挂在 tools/execute 瀑布上的插件，81 行
 * 就实现了完整语义：读工具声明的 timeoutMs → 派生带截止的信号 → 替换
 * exec.signal（这是唯一允许换信号的阶段）→ 委托执行 → 我们的计时器赢
 * 了就替换成结构化 TOOL_TIMEOUT 错误 → finally 恢复原信号。
 *
 * 对应源码：packages/guard/timeout-policy/src/index.ts（81 行）
 *   apply() → ctx.on('tools/execute') → deadline() / timeoutOf()
 *
 * 跑法：pnpm run step:06
 */

type ToolResult =
  | { isError: false; content: string; value?: unknown }
  | { isError: true; content: string; error: { code: string } }

interface ToolExec {
  readonly name: string
  readonly args: unknown
  /** 环绕包装器唯一能改的字段：signal（ToolDispatchExecution 是唯一可变视图） */
  signal: AbortSignal
}

type Body = (args: unknown, exec: ToolExec) => Promise<unknown>

interface ToolDef {
  execute: Body
  /** 工具声明的超时预算；未声明 = 不受超时约束 */
  timeoutMs?: number
}

const registry = new Map<string, ToolDef>()

/** 环绕包装器表：tools/execute 瀑布的插件（这里只有一个：超时） */
const wrappers: ((exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>)[] = []

/** 派生一个带截止时间的信号：到点自动 abort，code 用于区分"是谁的计时器" */
function deadline(
  signal: AbortSignal,
  timeoutMs: number,
  code: string,
): {
  signal: AbortSignal
  dispose(): void
  timedOut(): boolean
} {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(code), timeoutMs)
  const onCallerAbort = (): void => controller.abort(signal.reason)
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener('abort', onCallerAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.reason === code,
    dispose: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** TOOL_TIMEOUT 结构化结果（模型可据此自纠或重试） */
function toolTimeoutResult(timeoutMs: number): ToolResult {
  return {
    isError: true,
    content: `Error: tool call timed out after ${timeoutMs}ms`,
    error: { code: 'TOOL_TIMEOUT' },
  }
}

async function execute(exec: ToolExec): Promise<ToolResult> {
  const tool = registry.get(exec.name)
  if (!tool)
    return {
      isError: true,
      content: `Error: unknown tool "${exec.name}"`,
      error: { code: 'UNKNOWN_TOOL' },
    }

  const body = async (): Promise<ToolResult> => {
    const value = await tool.execute(exec.args, exec)
    return { isError: false, content: `result = ${String(value)}`, value }
  }
  // 环绕包装：reduceRight 让最外层（超时）最先介入
  const result = await wrappers.reduceRight((next, wrap) => () => wrap(exec, next), body)()
  return result
}

/** 复刻 timeout-policy：读 timeoutMs → 换信号 → 委托 → 赢了就替换结果 */
wrappers.push(async (exec, next) => {
  const timeoutMs = registry.get(exec.name)?.timeoutMs
  if (timeoutMs === undefined) return next() // 没声明预算就不管

  const d = deadline(exec.signal, timeoutMs, 'TOOL_TIMEOUT')
  const upstream = exec.signal
  exec.signal = d.signal // 换信号（仅此阶段允许）
  try {
    const result = await next() // 跑工具体（工具应尊重新信号）
    // 我们的计时器赢了 → 替换成结构化 TOOL_TIMEOUT
    return d.timedOut() ? toolTimeoutResult(timeoutMs) : result
  } finally {
    d.dispose()
    exec.signal = upstream // 用完恢复：post-execute 看不到我们的信号
  }
})

async function main(): Promise<void> {
  // 一个声明 100ms 预算的慢工具（尊重信号：超时立刻停）
  registry.set('slow_api', {
    timeoutMs: 100,
    execute: (_args, exec) =>
      new Promise(resolve => {
        const timer = setInterval(() => {
          if (exec.signal.aborted) {
            clearInterval(timer)
            resolve('aborted by timeout')
            return
          }
          clearInterval(timer)
          resolve('api responded')
        }, 30)
      }),
  })
  // 一个 300ms 才响应的工具（也会被同一把锁拦住）
  registry.set('very_slow_api', {
    timeoutMs: 100,
    execute: (_args, exec) =>
      new Promise(resolve => {
        const timer = setTimeout(() => {
          resolve('api responded')
        }, 300)
        // 尊重信号：deadline 超时 → 立刻 settle（源码契约：工具必须 forward signal 并达到 quiescence）
        exec.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve('aborted by timeout')
          },
          { once: true },
        )
      }),
  })
  // 一个没声明预算的工具：永不超时
  registry.set('fast', {
    execute: async () => 'instant',
  })

  console.log('⏱️  超时环绕包装：tools/execute 插件（复刻 timeout-policy）')
  console.log('----------------------------------------')

  const r1 = await execute({ name: 'slow_api', args: {}, signal: new AbortController().signal })
  console.log(
    `① slow_api（30ms < 100ms 预算）→ code=${r1.isError ? r1.error.code : '-'}  "${r1.content}"`,
  )

  const r2 = await execute({
    name: 'very_slow_api',
    args: {},
    signal: new AbortController().signal,
  })
  console.log(
    `② very_slow_api（300ms > 100ms）→ code=${r2.isError ? r2.error.code : '-'}  "${r2.content}"`,
  )

  const r3 = await execute({ name: 'fast', args: {}, signal: new AbortController().signal })
  console.log(`③ fast（无预算）→ code=${r3.isError ? r3.error.code : '-'}  "${r3.content}"`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
