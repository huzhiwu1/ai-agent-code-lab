/**
 * Step 01 – 最小六段执行管线：一个工具调用要过几道关？
 *
 * 学习目标：建立"工具执行 ≠ 调个函数"的直觉。源码里一次工具调用要过
 * 六道关：参数物化 → pre-execute 瀑布 → 守卫 → execute 环绕 → post-execute
 * → 最终化。这一步先把骨架立起来（用数组模拟 Cordis 瀑布），后面的步骤
 * 逐个把每道关的机制填实。
 *
 * 对应源码：packages/core/tools/src/index.ts
 *   execute() → prepareExecution() → dispatchScheduledExecution()
 *   → finalizeScheduledExecution() → finishScheduledExecution()
 *
 * 跑法：pnpm run step:01
 */

/** 工具执行结果：成功携带规范 value，失败携带错误文本（简化版） */
type ToolResult = { isError: boolean; content: string; value?: unknown }

/** 一次工具调用的执行上下文（简化版，Step 05 才加 AbortSignal） */
interface ToolExec {
  name: string
  args: unknown
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

/** 可插拔瀑布：pre-execute 决策、execute 环绕包装、post-execute 后处理 */
type PreDecision = 'allow' | 'deny' | 'ask'
const preHooks: ((exec: ToolExec) => PreDecision)[] = []
const wrappers: ((exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>)[] = []
const postHooks: ((exec: ToolExec, result: ToolResult) => ToolResult)[] = []

/**
 * 六段管线主入口（最小版）
 *
 * ① 参数物化（简化：原样透传，Step 02 补 lossless 快照 + 冻结）
 * ② pre-execute：允许 / 拒绝 / 询问（Step 03 补审批服务）
 * ③ 守卫：最终拒绝权（Step 04 补单调性论证）
 * ④ execute 环绕 + 工具体（Step 06 补超时包装）
 * ⑤ post-execute：接受 / 替换 / 阻止
 * ⑥ 最终化 + 通知（简化：直接返回）
 */
async function execute(exec: ToolExec): Promise<ToolResult> {
  // ② pre-execute 瀑布：任一钩子短路即终止
  for (const hook of preHooks) {
    const decision = hook(exec)
    if (decision === 'deny') {
      return { isError: true, content: `Error: tool "${exec.name}" denied by policy` }
    }
    if (decision === 'ask') {
      return { isError: true, content: `Error: tool "${exec.name}" requires approval (no channel)` }
    }
  }

  // ④ 环绕包装 + 工具体：reduceRight 让最外层 wrapper 最先执行
  const body = async (): Promise<ToolResult> => {
    const tool = registry.get(exec.name)
    if (!tool) return { isError: true, content: `Error: unknown tool "${exec.name}"` }
    const value = await tool.execute(exec.args, exec)
    // 成功：先渲染成模型可见内容（render 是纯函数，失败视为工具错误）
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

async function main(): Promise<void> {
  // 注册两个工具：一个算加法（规范化输出），一个不存在（演示 UNKNOWN_TOOL）
  register('add', {
    execute: async args =>
      (args as { a: number; b: number }).a + (args as { a: number; b: number }).b,
    output: {
      render: (_args, value) => `result = ${String(value)}`,
    },
  })

  console.log('🛠️  六段管线最小版（数组模拟瀑布）')
  console.log('----------------------------------------')

  const ok = await execute({ name: 'add', args: { a: 1, b: 2 } })
  console.log(`✅ add(1,2)        → isError=${ok.isError}  content="${ok.content}"`)

  // 挂一个拒绝钩子，演示 pre-execute 短路
  preHooks.push(exec => (exec.name === 'add' ? 'deny' : 'allow'))
  const denied = await execute({ name: 'add', args: { a: 3, b: 4 } })
  console.log(`🚫 add(3,4) 有拒绝钩子 → isError=${denied.isError}  content="${denied.content}"`)

  const unknown = await execute({ name: 'rm -rf /', args: {} })
  console.log(`❓ 未知工具         → isError=${unknown.isError}  content="${unknown.content}"`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：每个 step 自包含，避免与其它 step 共享 TS 全局作用域
export {}
