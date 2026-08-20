/**
 * Step 04 – 单调守卫：为什么守卫只能"拒绝"，不能"放行"？
 *
 * 学习目标：理解六段管线的第三道关——guards。pre-execute 瀑布之后是一道
 * 单调守卫：ToolGuard 的返回类型故意只有 `string | undefined`，
 * **没有 allow 分支**。为什么？源码注释一句话说透：
 *   "Because guards have no allow result, listener ordering cannot turn
 *    a denial back into permission."
 * 如果守卫能放行，注册顺序就能决定"谁说了算"：A 拒绝、B 放行 → 结果变成
 * 放行，守卫之间开始互相踩。只允许拒绝 = 任何一道守卫的拒绝都是终局，
 * 监听者顺序永远不会把拒绝翻回许可。
 *
 * 守卫还是分层的：全局注册的守卫对所有 agent 生效；agent 自己的守卫
 * 只对该 agent 生效。查询顺序沿 scope 链从远到近（全局 → agent）。
 *
 * 本步骤把 Step 03 六段骨架的第 ③ 段填实：
 *   ③ 守卫：ToolGuard 只能拒绝 + 全局层/agent 层分层查询
 *
 * 对应源码：packages/core/tools/src/index.ts
 *   ToolGuard 类型注释 / guardReason() 的 scope 链查询（index.ts:708 / 1132）
 *
 * 跑法：pnpm run step:04
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
  /** 发起调用的 agent（agent-less 调用 = undefined） */
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
// ① 参数物化（继承 Step 02/03）：lossless 验证 → 快照 → 冻结 → 身份
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
// ② pre-execute 瀑布（继承 Step 03）：三态决策 + 审批服务
// ---------------------------------------------------------------------------

type PreToolDecision =
  { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface ApprovalService {
  request(req: { toolName: string; reason?: string }): Promise<ApprovalOutcome>
}

const preHooks: ((exec: ToolExec) => Promise<PreToolDecision> | PreToolDecision)[] = []

let approvalService: ApprovalService | undefined

/** 解析 ask → allow/deny，fail-closed：无服务 deny、无 agent deny、仅 allowed-once 放行 */
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

// ---------------------------------------------------------------------------
// ③ 单调守卫（本步骤的新内容）：只能拒绝 + 分层
// ---------------------------------------------------------------------------

/**
 * 守卫签名：返回 string = 拒绝（reason）；返回 undefined = 不改变决策。
 *
 * 注意类型上**故意没有 allow 分支**——这是单调性的来源：
 * 只要任何一道守卫返回 reason，拒绝就是终局；注册顺序、监听者数量
 * 都无法把"拒绝"翻回"许可"。
 */
type ToolGuard = (exec: Readonly<ToolExec>) => string | undefined

/** 分层注册：全局层对所有 agent 生效；agent 层只对该 agent 生效 */
const globalGuards: ToolGuard[] = []
const agentGuards = new Map<string, ToolGuard[]>()

/**
 * 沿 scope 链查询守卫：先全局层，再 agent 层（从远到近）。
 * 任一守卫返回 reason 即拒绝；全部返回 undefined 才放行。
 */
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

/**
 * 反例演示：如果守卫有 allow 分支会发生什么？
 * 结果会被"谁最后注册"决定——A 拒绝、B 放行 vs B 放行、A 拒绝，
 * 同样两个守卫、不同注册顺序 → 不同结局。这正是真实源码不给 allow 的原因。
 */
function demoWhyNoAllow(): void {
  console.log('💭 反例论证：如果守卫能"放行"，注册顺序就决定了谁说了算')
  type FlawedGuard = (exec: ToolExec) => 'allow' | 'deny'
  const evaluate = (guards: FlawedGuard[]): string => {
    // 有 allow 分支的守卫模型：最后一个表态者覆盖前面所有人的意见
    let decision: 'allow' | 'deny' = 'allow'
    for (const g of guards) decision = g({ name: 'x' } as ToolExec)
    return decision
  }
  const guardA: FlawedGuard = () => 'deny' // A 认为危险
  const guardB: FlawedGuard = () => 'allow' // B 认为没事
  console.log(`   注册顺序 [A 拒绝, B 放行] → ${evaluate([guardA, guardB])}  ← B 覆盖了 A 的拒绝`)
  console.log(`   注册顺序 [B 放行, A 拒绝] → ${evaluate([guardB, guardA])}  ← A 又覆盖了 B`)
  console.log(
    '   同一组守卫、不同顺序 → 不同结局：审计无法回答"为什么放行/拒绝"。\n' +
      '   真实设计（只允许拒绝）：任何顺序下，拒绝都是终局，结局唯一。',
  )
  console.log()
}

/** 可插拔瀑布：execute 环绕包装、post-execute 后处理（本步未动，保持 Step 03 结构） */
const wrappers: ((exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>)[] = []
const postHooks: ((exec: ToolExec, result: ToolResult) => ToolResult)[] = []

/**
 * 六段管线主入口
 *
 * ① 参数物化 → ② pre-execute 瀑布 → ③ 单调守卫（新）→ ④ execute 环绕 + body
 * → ⑤ post-execute → ⑥ 最终化
 */
async function execute(exec: ToolExec): Promise<ToolResult> {
  // ② pre-execute 瀑布
  for (const hook of preHooks) {
    const decision = await hook(exec)
    if (decision.kind === 'allow') continue
    if (decision.kind === 'deny') {
      return { isError: true, content: `Error: ${decision.reason}` }
    }
    const resolved = await resolveAsk(exec, decision)
    if (resolved.decision === 'deny') {
      return { isError: true, content: `Error: ${resolved.reason}` }
    }
  }

  // ③ 单调守卫：pre-execute 全部放行后，任何一道守卫的拒绝都是终局
  const reason = guardReason(exec)
  if (reason !== undefined) {
    return { isError: true, content: `Error: guarded: ${reason}` }
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
  console.log('🛡️  Step 04 – 单调守卫：只能拒绝 + 全局层/agent 层')
  console.log('----------------------------------------------------')

  register('bash', {
    execute: async () => 'bash ran fine',
    output: { render: (_args, value) => String(value) },
  })
  register('read', {
    execute: async () => 'read ok',
    output: { render: (_args, value) => String(value) },
  })

  /** 演示辅助：物化一个调用（正常参数一定 ready），并断言物化成功 */
  const execOf = (name: string, agent?: { id: string }): ToolExec => {
    const mat = createExecution({ callId: `call-${name}`, name, args: {}, agent })
    if (mat.kind !== 'ready') throw new Error(mat.reason)
    return mat.exec
  }

  // 场景 0：给 bash 挂上 ask 钩子 + 审批服务（用户点「允许」）
  // 用来展示管线的顺序：审批放行 ≠ 守卫放行，两道关都要过
  preHooks.push(exec =>
    exec.name === 'bash' ? { kind: 'ask', reason: 'bash needs human approval' } : { kind: 'allow' },
  )
  approvalService = {
    request: async req => {
      console.log(`  👤 审批弹窗: 允许调用 "${req.toolName}"? → 用户点了「允许」`)
      return 'allowed-once'
    },
  }

  // 场景 1：全局守卫拒绝 bash → 即使审批通过，守卫的拒绝仍是终局
  globalGuards.push(exec => (exec.name === 'bash' ? 'bash is globally disabled' : undefined))
  const r1 = await execute(execOf('bash', { id: 'agent-1' }))
  console.log(`① 审批放行 ≠ 守卫放行  → ${r1.content}`)
  console.log()

  // 场景 2：agent 层守卫只影响该 agent，其他 agent 不受影响
  agentGuards.set('agent-2', [exec => (exec.name === 'read' ? 'agent-2 forbids read' : undefined)])
  const r2 = await execute(execOf('read', { id: 'agent-2' }))
  const r3 = await execute(execOf('read', { id: 'agent-1' }))
  console.log(`② agent-2 守卫拒绝 read  → ${r2.content}`)
  console.log(`③ agent-1 不受影响       → ${r3.content}`)
  console.log()

  // 场景 3：守卫"放行"（返回 undefined）不改变其他守卫的拒绝——拒绝是终局
  globalGuards.push(() => undefined) // 一个"什么都不说"的守卫
  const r4 = await execute(execOf('bash', { id: 'agent-1' }))
  console.log(`④ 加一个"沉默"守卫后     → ${r4.content}（拒绝仍是终局，顺序无关）`)
  console.log()

  demoWhyNoAllow()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：每个 step 自包含，避免与其它 step 共享 TS 全局作用域
export {}
