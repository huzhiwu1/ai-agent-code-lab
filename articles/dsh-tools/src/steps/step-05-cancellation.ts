/**
 * Step 05 – 取消体系：ABORTED vs ABORTED_BEFORE_DISPATCH
 *
 * 学习目标：源码的取消是"协作式"的——body 一旦开始，注册表就等它自然
 * 结束（不竞速、不放弃 Promise），只是把最终结果替换成取消错误。两个
 * 错误码区分"停在哪了"：
 *   - ABORTED_BEFORE_DISPATCH：body 还没启动就取消（检查点命中）
 *   - ABORTED：body 已启动，成功结果被取消覆盖
 * 为什么区分？回放（replay）需要知道"这个调用到底跑没跑"。
 *
 * 对应源码：packages/core/tools/src/index.ts
 *   cancellationResult() / toolAbortedResult() / toolAbortedBeforeDispatchResult()
 *   .agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.md
 *
 * 跑法：pnpm run step:05
 */

type ToolResult =
  | { isError: false; content: string; value?: unknown }
  | { isError: true; content: string; error: { code: string } }

interface ToolExec {
  readonly name: string
  readonly args: unknown
  /** 必填：调用者拥有的取消信号（源码里 ToolExecutionInput.signal 是必填 readonly） */
  readonly signal: AbortSignal
}

type Body = (exec: ToolExec) => Promise<unknown>

const registry = new Map<string, Body>()

/** body 是否已启动：决定取消用哪个错误码 */
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

/**
 * 执行入口（聚焦取消语义）：
 *  1. 入口检查点：已取消 → ABORTED_BEFORE_DISPATCH（body 没跑）
 *  2. body 启动后协作式等待：即使取消也等它自然结束（quiescence），
 *     然后把成功结果替换成 ABORTED
 */
async function execute(exec: ToolExec): Promise<ToolResult> {
  // 检查点 ①：dispatch 前已取消
  if (exec.signal.aborted) return cancellationResult(false)

  const tool = registry.get(exec.name)
  if (!tool) {
    return {
      isError: true,
      content: `Error: unknown tool "${exec.name}"`,
      error: { code: 'UNKNOWN_TOOL' },
    }
  }

  // body 启动：置位标记（源码用 cancellationStates 的 bodyInvoked）
  const bodyInvoked = true
  try {
    const value = await tool(exec) // 协作式：不 race，等它结束
    // 检查点 ②：body 结束后若已取消 → 成功结果被 ABORTED 覆盖
    return exec.signal.aborted
      ? cancellationResult(bodyInvoked)
      : { isError: false, content: `result = ${String(value)}` }
  } catch (error) {
    // 工具自己抛的错保留（取消时可能保留工具自有的结构化错误）
    return { isError: true, content: `Error: ${String(error)}`, error: { code: 'TOOL_ERROR' } }
  }
}

/** 模拟工具：可感知取消（尊重 signal），也可不感知（演示"等它结束"） */
const slowButCooperative: Body = exec =>
  new Promise(resolve => {
    const timer = setInterval(() => {
      if (exec.signal.aborted) {
        clearInterval(timer)
        resolve('cancelled cooperatively')
        return
      }
      clearInterval(timer)
      resolve('done')
    }, 50)
  })

/** 模拟工具：完全无视 signal（糟糕的实现，但真实世界里存在） */
const ignoresSignal: Body = async () => {
  await new Promise(resolve => setTimeout(resolve, 80))
  return 'done eventually'
}

async function main(): Promise<void> {
  registry.set('slow', slowButCooperative)
  registry.set('stubborn', ignoresSignal)

  console.log('🛑 协作式取消：ABORTED / ABORTED_BEFORE_DISPATCH')
  console.log('----------------------------------------')

  // 场景 1：还没开始就取消 → ABORTED_BEFORE_DISPATCH
  const preAborted = new AbortController()
  preAborted.abort()
  const r1 = await execute({ name: 'slow', args: {}, signal: preAborted.signal })
  console.log(`① 入口已取消      → code=${r1.isError ? r1.error.code : '-'}  "${r1.content}"`)

  // 场景 2：body 运行中取消（协作式工具）→ 等它结束，结果被 ABORTED 覆盖
  const midAbort = new AbortController()
  const running = execute({ name: 'slow', args: {}, signal: midAbort.signal })
  setTimeout(() => midAbort.abort(), 20) // 20ms 后取消，工具 50ms 后才 settle
  const r2 = await running
  console.log(
    `② 运行中取消(协作) → code=${r2.isError ? r2.error.code : '-'}  "${r2.content}"（body 被等完了）`,
  )

  // 场景 3：body 无视 signal（不协作）→ 照样等它结束，结果仍被 ABORTED 覆盖
  const stubbornAbort = new AbortController()
  const running3 = execute({ name: 'stubborn', args: {}, signal: stubbornAbort.signal })
  setTimeout(() => stubbornAbort.abort(), 10)
  const r3 = await running3
  console.log(
    `③ 运行中取消(无视) → code=${r3.isError ? r3.error.code : '-'}  "${r3.content}"（不放弃 Promise）`,
  )

  // 场景 4：正常完成
  const r4 = await execute({ name: 'slow', args: {}, signal: new AbortController().signal })
  console.log(`④ 正常完成        → code=${r4.isError ? r4.error.code : '-'}  "${r4.content}"`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
