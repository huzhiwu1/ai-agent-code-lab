/**
 * Step 03 – pre-execute 瀑布：允许、拒绝，还是问用户？
 *
 * 学习目标：源码里 pre-execute 是第一个可插拔瀑布，决策有三种——allow
 * 放行 / deny 拒绝 / ask 转人工审批。关键设计：ask 必须拿到审批服务的
 * allowed-once 才放行；审批服务缺失、被拒、取消、无通道，全部降级成
 * deny（fail-closed，绝不静默放行）。
 *
 * 对应源码：packages/core/tools/src/index.ts
 *   prepareExecution() → ctx.waterfall('tools/pre-execute') → serviceAsk()
 *   packages/interaction/user-approval：ApprovalOutcome 四值闭合联合
 *
 * 跑法：pnpm run step:03
 */

type PreToolDecision =
  { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface ApprovalService {
  request(req: { toolName: string; reason?: string }): Promise<ApprovalOutcome>
}

interface ToolExec {
  readonly name: string
  readonly args: unknown
  readonly agent?: { id: string }
}

/** pre-execute 监听者表：谁都可以注册一个决策钩子 */
const preHooks: ((exec: ToolExec) => Promise<PreToolDecision> | PreToolDecision)[] = []

/** 审批服务：可选的（没有就降级 deny），模拟实现 */
let approvalService: ApprovalService | undefined

/**
 * 解析 ask → allow/deny，复刻源码 serviceAsk 的 fail-closed 语义：
 *  - 没有审批服务 → deny（"requires approval (not yet supported)"）
 *  - 没有 agent → deny（没有会话可审计、没有 UI 可路由）
 *  - 四种 outcome 只有 allowed-once 放行
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

/** 执行入口：跑 pre-execute 瀑布，ask 走审批，其余短路 */
async function execute(exec: ToolExec): Promise<{ isError: boolean; content: string }> {
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
    // allowed-once：放行，继续（这里简化为直接成功，不真的执行工具体）
    return { isError: false, content: `approved-once: tool "${exec.name}" executed` }
  }
  return { isError: false, content: `tool "${exec.name}" executed` }
}

async function main(): Promise<void> {
  console.log('🚦 pre-execute 瀑布：allow / deny / ask（ask 缺审批 = deny）')
  console.log('----------------------------------------')

  // 场景 1：直接 deny
  preHooks.push(exec =>
    exec.name === 'rm'
      ? { kind: 'deny', reason: 'rm is not allowed for this agent' }
      : { kind: 'allow' },
  )
  const rm = await execute({ name: 'rm', args: {}, agent: { id: 'agent-1' } })
  console.log(`🚫 rm      → ${rm.content}`)

  // 场景 2：ask，但没有审批服务 → 降级 deny（fail-closed）
  preHooks.push(exec =>
    exec.name === 'bash' ? { kind: 'ask', reason: 'bash needs human approval' } : { kind: 'allow' },
  )
  const bashNoChannel = await execute({ name: 'bash', args: {}, agent: { id: 'agent-1' } })
  console.log(`❓ bash（无审批服务）→ ${bashNoChannel.content}`)

  // 场景 3：ask + 用户批准 → 放行；ask + 用户拒绝 → deny
  approvalService = {
    request: async req => {
      console.log(`  👤 审批弹窗: 允许调用 "${req.toolName}"? → 用户点了「允许」`)
      return 'allowed-once'
    },
  }
  const bashApproved = await execute({ name: 'bash', args: {}, agent: { id: 'agent-1' } })
  console.log(`✅ bash（用户批准）→ ${bashApproved.content}`)

  approvalService = {
    request: async () => {
      console.log(`  👤 审批弹窗: 允许调用 bash? → 用户点了「拒绝」`)
      return 'rejected'
    },
  }
  const bashRejected = await execute({ name: 'bash', args: {}, agent: { id: 'agent-1' } })
  console.log(`🚫 bash（用户拒绝）→ ${bashRejected.content}`)

  // 场景 4：ask + agent 缺失 → deny
  const noAgent = await execute({ name: 'bash', args: {} })
  console.log(`❓ bash（无 agent）→ ${noAgent.content}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
