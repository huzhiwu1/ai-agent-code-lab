/**
 * Step 07 – 完整管线：一次工具调用的完整旅程，六道关如何协作？
 *
 * 痛苦场景：前六步每道关单独看都能懂，但真实调用里它们是协作的：审批放行后
 * 守卫还能拒绝；守卫放行后超时还能截断；执行结果还会被脱敏。关与关如何衔接、
 * 短路如何传播，只有看完整旅程才知道。
 *
 * 为什么这么设计：六道关的顺序不是随意的——物化在前（参数定型），pre-execute
 * 和守卫在 execute 之前（决策先于动作），环绕包住 execute（横切关注点），
 * post-execute 在结果进模型上下文之前（输出把关），最终化收尾（通知/日志）。
 *
 * 收益：一次调用 = 一个完整旅程；任何一道关都能独立短路，互不干扰。
 *
 * 对应源码：execute() 完整主流程（index.ts:1342）
 * 跑法：pnpm run tools:step:07（或 articles/dsh-tools 内 pnpm run step:07）
 */

/** 执行上下文：args 是物化后的冻结快照；token 是执行身份（源码 createExecutionToken，index.ts:1866） */
interface ToolExec {
  readonly callId: string
  readonly name: string
  readonly args: unknown
  readonly token: symbol
  readonly signal: AbortSignal
}

type ToolResult = { isError: boolean; content: string; error?: { code: string } }

// ── 第①站：参数物化（createExecution，index.ts:1364）──

/** 无损 JSON 校验：undefined/函数/symbol/bigint/循环引用等会丢信息的值一律拒绝（fail-closed） */
function isLosslessJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Array.isArray(value)
    ? value.every(v => isLosslessJson(v, seen))
    : Object.values(value).every(v => isLosslessJson(v, seen))
}

/** 递归冻结：对冻结对象任何路径的写入都会抛 TypeError */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value as object))
      deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/** 物化：验证 → 快照（切断引用）→ 冻结 → 分配 token */
function createExecution(input: {
  callId: string
  name: string
  args: unknown
  signal: AbortSignal
}): { kind: 'ready'; exec: ToolExec } | { kind: 'rejected'; reason: string } {
  if (!isLosslessJson(input.args)) {
    return {
      kind: 'rejected',
      reason: `tool "${input.name}" arguments must be losslessly JSON-serializable`,
    }
  }
  return {
    kind: 'ready',
    exec: {
      callId: input.callId,
      name: input.name,
      args: deepFreeze(structuredClone(input.args)),
      token: Symbol('dsh.tool.execution'),
      signal: input.signal,
    },
  }
}

// ── 第②站：pre-execute 瀑布（prepareScheduledExecution，index.ts:1459）──

type PreToolDecision =
  { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

const preHooks: ((exec: ToolExec) => Promise<PreToolDecision>)[] = []
let approvalService:
  { request: (req: { toolName: string }) => Promise<'allowed-once' | 'rejected'> } | undefined

/** 简化版 serviceAsk（index.ts:1689）：无通道或非 allowed-once → deny（fail-closed） */
async function resolveAsk(
  exec: ToolExec,
  reason?: string,
): Promise<{ decision: 'allow' | 'deny'; reason?: string }> {
  if (approvalService === undefined) {
    return {
      decision: 'deny',
      reason: reason ?? `tool "${exec.name}" requires approval (no channel)`,
    }
  }
  const outcome = await approvalService.request({ toolName: exec.name })
  return outcome === 'allowed-once'
    ? { decision: 'allow' }
    : { decision: 'deny', reason: `the user rejected tool "${exec.name}"` }
}

// ── 第③站：单调守卫（ToolGuard，index.ts:711）──

type ToolGuard = (exec: Readonly<ToolExec>) => string | undefined
const guards: ToolGuard[] = []

function guardReason(exec: ToolExec): string | undefined {
  for (const guard of guards) {
    const reason = guard(exec)
    if (reason !== undefined) return reason // 任一守卫的拒绝都是终局
  }
  return undefined
}

// ── 第④站：execute 环绕（dispatchScheduledExecution，index.ts:1569）──

type Wrapper = (exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>
const wrappers: Wrapper[] = []
const registry = new Map<
  string,
  { timeoutMs?: number; requiresApproval?: boolean; execute: (args: unknown) => Promise<string> }
>()
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 超时插件：Promise.race 包一层（简化版；源码用融合信号 + 协作式等待） */
function installTimeoutPolicy(): void {
  wrappers.push(async (exec, next) => {
    const timeoutMs = registry.get(exec.name)?.timeoutMs
    if (timeoutMs === undefined) return next()
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

// ── 第⑤站：post-execute（finalizeScheduledExecution，index.ts:1609）──

type PostHook = (exec: ToolExec, result: ToolResult) => ToolResult
const postHooks: PostHook[] = []

// ── 六段管线主入口（execute，index.ts:1342）──
async function execute(exec: ToolExec): Promise<ToolResult> {
  console.log('  ① 物化 → ready（快照 + 冻结 + token）')

  // ② pre-execute 瀑布：任一钩子短路即终止
  for (const hook of preHooks) {
    const decision = await hook(exec)
    if (decision.kind === 'allow') {
      console.log('  ② pre-execute → allow（无风险工具）')
      continue
    }
    if (decision.kind === 'deny') {
      console.log(`  ② pre-execute → deny（${decision.reason}）`)
      return { isError: true, content: `Error: ${decision.reason}` }
    }
    console.log(`  ② pre-execute → ask（${decision.reason}）`)
    const resolved = await resolveAsk(exec, decision.reason)
    if (resolved.decision === 'deny') {
      console.log(`  👤 审批 → deny（${resolved.reason}）`)
      return { isError: true, content: `Error: ${resolved.reason}` }
    }
    console.log('  👤 审批 → allowed-once，放行')
  }

  // ③ 单调守卫：任何一道拒绝都是终局
  const reason = guardReason(exec)
  if (reason !== undefined) {
    console.log(`  ③ guard → deny（${reason}）← 审批放行 ≠ 守卫放行`)
    return { isError: true, content: `Error: guarded: ${reason}` }
  }
  console.log('  ③ guard → 全部放行（无守卫拒绝）')

  // ④ 环绕包装 + 工具体
  const body = async (): Promise<ToolResult> => {
    const tool = registry.get(exec.name)
    if (!tool)
      return {
        isError: true,
        content: `Error: unknown tool "${exec.name}"`,
        error: { code: 'UNKNOWN_TOOL' },
      }
    const value = await tool.execute(exec.args)
    return { isError: false, content: String(value) }
  }
  const result = await wrappers.reduceRight(
    (next: () => Promise<ToolResult>, wrap) => () => wrap(exec, next),
    body,
  )()

  // ⑤ post-execute：脱敏 / 校验（简化：接受 / 替换）
  // ⑥ 最终化：事件通知、日志收尾（简化省略）
  const final = postHooks.reduce((r, hook) => hook(exec, r), result)
  console.log(final.isError ? `  ④ wrapper → 超时截断` : '  ④ wrapper → 无超时 / 正常返回')
  console.log(`  ⑤ post-execute → ${final.content.includes('***') ? 'replace（脱敏）' : 'accept'}`)
  console.log('  ⑥ 最终化 → 事件通知 + 日志（简化省略）')
  return final
}

async function main(): Promise<void> {
  // 同一批工具：delete_file（危险 + 慢删）+ read_file（慢读大文件）
  registry.set('delete_file', {
    requiresApproval: true,
    execute: async args => {
      await sleep(30)
      return `已删除 ${(args as { path: string }).path}`
    },
  })
  registry.set('read_file', {
    timeoutMs: 500,
    execute: async args => {
      const { path } = args as { path: string }
      await sleep(path === 'huge.log' ? 2000 : 10)
      return `文件 ${path} 的内容：api_key=sk-abc123456`
    },
  })

  // 策略：危险工具 → ask；禁删 AGENTS.md；结果脱敏；超时插件
  preHooks.push(async (exec): Promise<PreToolDecision> =>
    registry.get(exec.name)?.requiresApproval
      ? { kind: 'ask', reason: `${exec.name} needs human approval` }
      : { kind: 'allow' },
  )
  guards.push(exec =>
    exec.name === 'delete_file' && (exec.args as { path: string }).path === 'AGENTS.md'
      ? 'AGENTS.md is protected'
      : undefined,
  )
  postHooks.push((_exec, result) => {
    const masked = result.content.replace(/sk-[a-z0-9]+/gi, '***')
    return masked === result.content ? result : { ...result, content: masked }
  })
  installTimeoutPolicy()

  /** 审批工厂：allowed-once = 用户点「允许」，其余 = 「拒绝」 */
  const approval = (answer: 'allowed-once' | 'rejected') => ({
    request: async (req: { toolName: string }) => {
      console.log(
        `  👤 审批弹窗：允许 "${req.toolName}"？→ 用户点了「${answer === 'allowed-once' ? '允许' : '拒绝'}」`,
      )
      return answer
    },
  })
  /** 演示辅助：物化一次调用并断言成功 */
  const execOf = (name: string, args: unknown): ToolExec => {
    const mat = createExecution({
      callId: `call-${name}`,
      name,
      args,
      signal: new AbortController().signal,
    })
    if (mat.kind !== 'ready') throw new Error(mat.reason)
    return mat.exec
  }

  console.log('🧩 Step 07 – 完整管线：一次调用六道关的协作')
  console.log('--------------------------------------------------')

  // 场景 1：无风险调用——六道关全部通过
  console.log('场景 1：模型读 notes.txt（read_file，无风险）')
  approvalService = approval('allowed-once')
  const r1 = await execute(execOf('read_file', { path: 'notes.txt' }))
  console.log(`  结果：${r1.content} ✅`)
  console.log()

  // 场景 2：危险调用——审批确认后放行
  console.log('场景 2：模型删 A.txt（delete_file，危险）→ 审批确认')
  approvalService = approval('allowed-once')
  const r2 = await execute(execOf('delete_file', { path: 'A.txt' }))
  console.log(`  结果：${r2.content} ✅`)
  console.log()

  // 场景 3：红线调用——审批放行后，守卫终局拒绝（短路传播）
  console.log('场景 3：模型删 AGENTS.md（红线）→ 审批也过了，但守卫拒绝')
  approvalService = approval('allowed-once')
  const r3 = await execute(execOf('delete_file', { path: 'AGENTS.md' }))
  console.log(`  结果：${r3.content} 🚫`)
  console.log()

  // 场景 4：慢工具——超时截断，调用方不挂死
  console.log('场景 4：模型读 huge.log（慢工具）→ 500ms 预算截断')
  approvalService = approval('allowed-once')
  const started = Date.now()
  const r4 = await execute(execOf('read_file', { path: 'huge.log' }))
  console.log(`  ${Date.now() - started}ms 后：${r4.content} 🚫`)

  console.log()
  console.log('🎯 六道关协作：物化定型 → 审批问人 → 守卫兜底 → 环绕限时 → 脱敏把关 → 收尾')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：与其它 step 保持独立作用域
export {}
