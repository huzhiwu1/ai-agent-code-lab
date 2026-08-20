/**
 * Step 03 – pre-execute 瀑布：允许、拒绝，还是问用户？
 *
 * 学习目标：理解六段管线的第二道关——pre-execute 是第一个可插拔瀑布，
 * 每个监听者返回三态决策：allow 放行 / deny 拒绝 / ask 转人工审批。
 * 关键设计（fail-closed）：
 *   - ask 必须拿到审批服务的 allowed-once 才放行；
 *   - 审批服务缺失、用户拒绝、审批取消、无审批通道，全部降级成 deny——绝不静默放行；
 *   - agent-less 调用（没有会话可审计、没有 UI 可路由）也直接拒绝。
 *
 * 本步骤把 Step 02 六段骨架的第 ② 段填实：
 *   ② pre-execute 瀑布：PreToolDecision 三态 + serviceAsk 审批解析
 *
 * 对应源码：packages/core/tools/src/index.ts
 *   prepareExecution() → ctx.waterfall('tools/pre-execute') → serviceAsk()
 *   packages/interaction/user-approval：ApprovalOutcome 四值闭合联合
 *
 * 跑法：pnpm run step:03
 */

/** 工具执行结果：成功携带规范 value，失败携带错误文本（简化版） */
type ToolResult = { isError: boolean; content: string; value?: unknown }

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
  /** 发起调用的 agent（agent-less 调用 = undefined，ask 会被直接拒绝） */
  readonly agent?: { id: string }
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
// ① 参数物化（继承 Step 02）：lossless 验证 → 快照 → 冻结 → 身份
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
  if (seen.has(value)) return false // 循环引用
  seen.add(value)
  if (Array.isArray(value)) return value.every(item => isLosslessJson(item, seen))
  return Object.values(value).every(item => isLosslessJson(item, seen))
}

/** 无损快照：先验证、再克隆（structuredClone 保真，JSON 往返会失真） */
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
    },
  }
}

// ---------------------------------------------------------------------------
// ② pre-execute 瀑布（本步骤的新内容）：三态决策 + 审批服务
// ---------------------------------------------------------------------------

/**
 * pre-execute 决策三态：
 *   - allow：放行，继续后面的瀑布
 *   - deny：直接拒绝，产出 isError 结果（带理由）
 *   - ask：转人工审批，只有审批返回 allowed-once 才放行
 */
type PreToolDecision =
  { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

/** 审批服务的四种结局（闭合联合，没有第五种可能） */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 审批服务接口：把一次 ask 交给人工通道裁决 */
interface ApprovalService {
  request(req: { toolName: string; reason?: string }): Promise<ApprovalOutcome>
}

/** pre-execute 监听者表：任何插件都可以注册一个决策钩子（数组模拟 Cordis 瀑布） */
const preHooks: ((exec: ToolExec) => Promise<PreToolDecision> | PreToolDecision)[] = []

/** 审批服务：可选——没有配置时 ask 直接降级 deny（fail-closed） */
let approvalService: ApprovalService | undefined

/**
 * 解析 ask → allow/deny，复刻源码 serviceAsk 的 fail-closed 语义：
 *   - 没有审批服务 → deny（ask 降级，绝不静默放行）
 *   - 没有 agent → deny（没有会话可审计、没有 UI 可路由）
 *   - 四种 outcome 中只有 allowed-once 放行，其余三种全部变成带不同理由的 deny
 */
async function resolveAsk(
  exec: ToolExec,
  ask: Extract<PreToolDecision, { kind: 'ask' }>,
): Promise<{ decision: 'allow' | 'deny'; reason?: string }> {
  if (approvalService === undefined) {
    return {
      decision: 'deny',
      reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`,
    }
  }
  if (exec.agent === undefined) {
    return {
      decision: 'deny',
      reason: `tool "${exec.name}" requires approval, but the call has no agent`,
    }
  }
  const outcome = await approvalService.request({ toolName: exec.name, reason: ask.reason })
  switch (outcome) {
    case 'allowed-once':
      return { decision: 'allow' }
    case 'rejected':
      return { decision: 'deny', reason: `the user rejected tool "${exec.name}"` }
    case 'cancelled':
      return { decision: 'deny', reason: `approval for tool "${exec.name}" was cancelled` }
    case 'unavailable':
      return {
        decision: 'deny',
        reason: `tool "${exec.name}" requires approval, but no channel is available`,
      }
  }
}

/** 可插拔瀑布：execute 环绕包装、post-execute 后处理（本步未动，保持 Step 02 结构） */
const wrappers: ((exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>)[] = []
const postHooks: ((exec: ToolExec, result: ToolResult) => ToolResult)[] = []

/**
 * 六段管线主入口
 *
 * ① 参数物化：调用方必须先过 createExecution()
 * ② pre-execute 瀑布：三态决策，ask 走 resolveAsk（fail-closed）
 * ③ 守卫：最终拒绝权（Step 04 补单调性论证）
 * ④ execute 环绕 + 工具体（Step 06 补超时包装）
 * ⑤ post-execute：接受 / 替换 / 阻止
 * ⑥ 最终化 + 通知（简化：直接返回）
 */
async function execute(exec: ToolExec): Promise<ToolResult> {
  // ② pre-execute 瀑布：每个监听者可以放行（allow），也可以返回决策短路瀑布
  for (const hook of preHooks) {
    const decision = await hook(exec)
    if (decision.kind === 'allow') continue
    if (decision.kind === 'deny') {
      return { isError: true, content: `Error: ${decision.reason}` }
    }
    // ask：转人工审批，只有 allowed-once 继续执行
    const resolved = await resolveAsk(exec, decision)
    if (resolved.decision === 'deny') {
      return { isError: true, content: `Error: ${resolved.reason}` }
    }
    // allowed-once：放行（真实源码放行后继续跑后面的监听者，这里简化直接执行）
  }

  // ④ 环绕包装 + 工具体：reduceRight 让最外层 wrapper 最先执行
  const body = async (): Promise<ToolResult> => {
    const tool = registry.get(exec.name)
    if (!tool) return { isError: true, content: `Error: unknown tool "${exec.name}"` }
    const value = await tool.execute(exec.args, exec)
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
  console.log('🚦 Step 03 – pre-execute 瀑布：allow / deny / ask（ask 缺审批 = deny）')
  console.log('--------------------------------------------------------------')

  register('bash', {
    execute: async () => 'bash ran fine',
    output: { render: (_args, value) => String(value) },
  })
  register('rm', {
    execute: async () => 'rm ran',
    output: { render: (_args, value) => String(value) },
  })

  /** 演示辅助：物化一个调用（正常参数一定 ready），并断言物化成功 */
  const execOf = (name: string, args: unknown, agent?: { id: string }): ToolExec => {
    const mat = createExecution({ callId: `call-${name}`, name, args, agent })
    if (mat.kind !== 'ready') throw new Error(mat.reason)
    return mat.exec
  }

  // 场景 1：直接 deny（策略钩子短路瀑布）
  preHooks.push(exec =>
    exec.name === 'rm'
      ? { kind: 'deny', reason: 'rm is not allowed for this agent' }
      : { kind: 'allow' },
  )
  const rm = await execute(execOf('rm', {}, { id: 'agent-1' }))
  console.log(`🚫 rm（策略拒绝）      → ${rm.content}`)
  console.log()

  // 场景 2：ask 但没有审批服务 → 降级 deny（fail-closed，绝不静默放行）
  preHooks.push(exec =>
    exec.name === 'bash' ? { kind: 'ask', reason: 'bash needs human approval' } : { kind: 'allow' },
  )
  const noChannel = await execute(execOf('bash', {}, { id: 'agent-1' }))
  console.log(`❓ bash（无审批服务）   → ${noChannel.content}`)
  console.log()

  // 场景 3：装上审批服务——用户点「允许」→ allowed-once 放行
  approvalService = {
    request: async req => {
      console.log(`  👤 审批弹窗: 允许调用 "${req.toolName}"? → 用户点了「允许」`)
      return 'allowed-once'
    },
  }
  const approved = await execute(execOf('bash', {}, { id: 'agent-1' }))
  console.log(`✅ bash（用户批准）     → ${approved.content}`)
  console.log()

  // 场景 4：用户点「拒绝」→ rejected 变 deny
  approvalService = {
    request: async () => {
      console.log(`  👤 审批弹窗: 允许调用 bash? → 用户点了「拒绝」`)
      return 'rejected'
    },
  }
  const rejected = await execute(execOf('bash', {}, { id: 'agent-1' }))
  console.log(`🚫 bash（用户拒绝）     → ${rejected.content}`)
  console.log()

  // 场景 5：审批窗口被取消 → cancelled 变 deny
  approvalService = {
    request: async () => {
      console.log(`  👤 审批弹窗超时自动关闭 → 审批被取消`)
      return 'cancelled'
    },
  }
  const cancelled = await execute(execOf('bash', {}, { id: 'agent-1' }))
  console.log(`🚫 bash（审批取消）     → ${cancelled.content}`)
  console.log()

  // 场景 6：agent-less 调用 ask → deny（没有会话可审计、没有 UI 可路由）
  const agentless = await execute(execOf('bash', {}))
  console.log(`❓ bash（无 agent 调用） → ${agentless.content}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：每个 step 自包含，避免与其它 step 共享 TS 全局作用域
export {}
