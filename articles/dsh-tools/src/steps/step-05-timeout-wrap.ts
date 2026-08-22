/**
 * Step 05 – 超时环绕：为什么超时是"包一层"？
 *
 * 痛苦场景：慢工具（读 100MB 日志）无限等待会拖垮整个 agent。如果让每个工具
 * 自己写超时，20 个工具 20 份重复代码，而且容易漏——漏一个就是挂死。
 *
 * 为什么这么设计：超时是"横切关注点"——超时 / 日志 / 重试是包在工具外面的
 * 能力，不该是工具自己的责任。execute 环绕（wrapper）把超时做成插件，
 * 工具声明 timeoutMs 预算即可，任何工具注册后自动获得超时能力，工具函数
 * 一行都不用改。
 *
 * 收益：关注点分离——工具只管"做什么"，超时管"多久"，改策略不用改工具。
 *
 * 对应源码：dispatchScheduledExecution()（index.ts:1569）+ timeout-policy 插件
 *   （源码用融合信号 + 协作式等待，本步简化成 Promise.race）
 * 跑法：pnpm run tools:step:05（或 articles/dsh-tools 内 pnpm run step:05）
 */

/** 执行上下文（简化：本步只关注 name / args） */
interface ToolExec {
  readonly callId: string
  readonly name: string
  readonly args: unknown
  readonly signal: AbortSignal
}

type ToolResult = { isError: boolean; content: string; error?: { code: string } }

/** 工具定义：timeoutMs 是"声明"，由超时插件执行（工具函数里没有任何超时代码） */
interface ToolDef {
  timeoutMs?: number
  execute: (args: unknown) => Promise<string>
}

const registry = new Map<string, ToolDef>()
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 环绕包装：wrapper 从外到内包住工具体（源码 dispatchScheduledExecution，index.ts:1569） */
type Wrapper = (exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>
const wrappers: Wrapper[] = []

/** 超时插件：Promise.race 包一层，超时就返回 TOOL_TIMEOUT 错误（简化版） */
function installTimeoutPolicy(): void {
  wrappers.push(async (exec, next) => {
    const timeoutMs = registry.get(exec.name)?.timeoutMs
    if (timeoutMs === undefined) return next() // 没声明预算就不管

    const timer = new Promise<ToolResult>(resolve => {
      setTimeout(
        () =>
          resolve({
            isError: true,
            content: `Error: tool "${exec.name}" timed out after ${timeoutMs}ms`,
            error: { code: 'TOOL_TIMEOUT' },
          }),
        timeoutMs,
      )
    })
    return await Promise.race([next(), timer])
  })
}

/** 管线：④ execute 环绕（本步聚焦；其他站简化透传） */
async function execute(exec: ToolExec): Promise<ToolResult> {
  const body = async (): Promise<ToolResult> => {
    const tool = registry.get(exec.name)
    if (!tool) return { isError: true, content: `Error: unknown tool "${exec.name}"` }
    return { isError: false, content: await tool.execute(exec.args) }
  }
  return wrappers.reduceRight(
    (next: () => Promise<ToolResult>, wrap) => () => wrap(exec, next),
    body,
  )()
}

async function main(): Promise<void> {
  // 同一个慢工具函数体，注册成两个"配置"：预算 500ms vs 3000ms
  const readHuge = async (args: unknown): Promise<string> => {
    await sleep(2000) // 模拟慢工具：真实场景 100MB 日志 5s
    return `文件 ${(args as { path: string }).path} 的内容：...`
  }
  registry.set('read_file', { timeoutMs: 500, execute: readHuge })
  registry.set('read_file_slow', { timeoutMs: 3000, execute: readHuge })
  registry.set('echo', {
    execute: async args => `echo: ${String((args as { text: string }).text)}`,
  })
  installTimeoutPolicy()

  const exec = (name: string, args: unknown): ToolExec => ({
    callId: `call-${name}`,
    name,
    args,
    signal: new AbortController().signal,
  })

  console.log('⏱️ Step 05 – 超时环绕：超时是"包一层"')
  console.log('---------------------------------------------')

  // 场景 1：慢工具超时（工具函数没写一行超时代码）
  console.log('场景 1：读 huge.log（工具要 2s，预算 500ms）')
  const started = Date.now()
  const r1 = await execute(exec('read_file', { path: 'huge.log' }))
  console.log(`  ${Date.now() - started}ms 后返回：${r1.content}`)
  console.log('  调用方不挂死——超时是插件给的，不是工具自己写的')

  // 场景 2：同一函数体，换预算 → 成功（证明超时策略与工具逻辑解耦）
  console.log()
  console.log('场景 2：同一工具函数，预算改成 3000ms（工具代码一行没改）')
  const started2 = Date.now()
  const r2 = await execute(exec('read_file_slow', { path: 'huge.log' }))
  console.log(`  ${Date.now() - started2}ms 后成功：${r2.content}`)

  // 场景 3：快工具不受影响
  console.log()
  console.log('场景 3：echo（没声明预算，照常执行）')
  const r3 = await execute(exec('echo', { text: 'hi' }))
  console.log(`  → ${r3.content}`)

  console.log()
  console.log('🎯 一句话：超时是工具外面的插件——注册即获得，工具专注"做什么"')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：与其它 step 保持独立作用域
export {}
