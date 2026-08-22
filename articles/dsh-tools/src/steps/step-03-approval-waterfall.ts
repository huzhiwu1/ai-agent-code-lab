/**
 * Step 03 – 审批瀑布：为什么危险工具要问人？
 *
 * 痛苦场景：模型被 prompt injection 诱导时，"执行 delete_file(path=C.txt)"
 * 只是模型输出里的一行。如果 pre-execute 没有关卡，这一行就直接变成删库命令。
 *
 * 为什么这么设计：pre-execute 瀑布里每个钩子返回 allow / deny / ask 三态，
 * 任一钩子短路即终止；ask 把"要不要执行"从模型手里拿出来，交给审批服务
 * （真实场景是人工弹窗）。源码中 ask 走 serviceAsk()（index.ts:1689）：
 * 无审批通道或用户不是 "allowed-once" 确认，全部 fail-closed 降级 deny。
 *
 * 收益：危险工具必须过人类监督点；策略按工具声明（requiresApproval），
 * 模型无法绕过——"要不要执行"不再由模型单方面决定。
 *
 * 对应源码：prepareScheduledExecution()（index.ts:1459）pre-execute 瀑布 +
 *   serviceAsk()（index.ts:1689）审批服务
 * 跑法：pnpm run tools:step:03（或 articles/dsh-tools 内 pnpm run step:03）
 */

/** 执行上下文（简化：本步只关注 name / args） */
interface ToolExec {
  readonly callId: string
  readonly name: string
  readonly args: unknown
  readonly signal: AbortSignal
}

type ToolResult = { isError: boolean; content: string }

/** pre-execute 三态：allow 放行 / deny 拒绝 / ask 问人（源码 PreToolDecision，index.ts:588） */
type PreToolDecision =
  { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

/** 审批服务：真实场景是人工弹窗；这里用注入的回调模拟 */
type ApprovalService = {
  request: (req: { toolName: string }) => Promise<'allowed-once' | 'rejected'>
}

const preHooks: ((exec: ToolExec) => Promise<PreToolDecision>)[] = []
let approvalService: ApprovalService | undefined

/** 工具声明：requiresApproval = true 表示该工具需要人类确认 */
interface ToolDef {
  requiresApproval?: boolean
  execute: (args: unknown) => Promise<string>
}
const registry = new Map<string, ToolDef>()
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 简化版 serviceAsk（index.ts:1689）：只有 allowed-once 放行，其余全部 deny（fail-closed） */
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

/** 管线：② pre-execute 瀑布（本步聚焦；其他站简化透传） */
async function execute(exec: ToolExec): Promise<ToolResult> {
  for (const hook of preHooks) {
    const decision = await hook(exec)
    if (decision.kind === 'allow') continue
    if (decision.kind === 'deny') return { isError: true, content: `Error: ${decision.reason}` }
    const resolved = await resolveAsk(exec, decision.reason)
    if (resolved.decision === 'deny') return { isError: true, content: `Error: ${resolved.reason}` }
  }
  const tool = registry.get(exec.name)
  if (!tool) return { isError: true, content: `Error: unknown tool "${exec.name}"` }
  const value = await tool.execute(exec.args)
  return { isError: false, content: String(value) }
}

async function main(): Promise<void> {
  registry.set('delete_file', {
    requiresApproval: true, // 危险工具：声明需要审批
    execute: async args => {
      await sleep(30)
      return `已删除 ${(args as { path: string }).path}`
    },
  })
  registry.set('read_file', {
    execute: async args => `文件 ${(args as { path: string }).path} 的内容：...`,
  })

  // 策略钩子：requiresApproval 的工具 → ask；其余 → allow
  preHooks.push(async (exec): Promise<PreToolDecision> =>
    registry.get(exec.name)?.requiresApproval
      ? { kind: 'ask', reason: `${exec.name} needs human approval` }
      : { kind: 'allow' },
  )

  const exec = (name: string, path: string): ToolExec => ({
    callId: `call-${name}`,
    name,
    args: { path },
    signal: new AbortController().signal,
  })

  console.log('🚦 Step 03 – 审批瀑布：危险工具要问人')
  console.log('-------------------------------------------')

  // 场景 1：read_file 直接放行（无风险工具不问人）
  console.log('场景 1：模型读 notes.txt（read_file，无风险）')
  const r1 = await execute(exec('read_file', 'notes.txt'))
  console.log(`  → ${r1.content} ← 瀑布直接 allow，不问人`)

  // 场景 2：delete_file 走审批，用户拒绝
  console.log()
  console.log('场景 2：模型被诱导删 C.txt（delete_file）→ 弹窗，用户拒绝')
  approvalService = {
    request: async req => {
      console.log(`  👤 审批弹窗：允许 "${req.toolName}" 删除 C.txt？→ 用户点了「拒绝」`)
      return 'rejected'
    },
  }
  const r2 = await execute(exec('delete_file', 'C.txt'))
  console.log(`  → ${r2.content} ← 模型无法绕过`)

  // 场景 3：同一工具，用户确认 → 放行
  console.log()
  console.log('场景 3：模型再次删 D.txt → 弹窗，用户确认')
  approvalService = {
    request: async req => {
      console.log(`  👤 审批弹窗：允许 "${req.toolName}" 删除 D.txt？→ 用户点了「允许」`)
      return 'allowed-once'
    },
  }
  const r3 = await execute(exec('delete_file', 'D.txt'))
  console.log(`  → ${r3.content} ← 只有 allowed-once 放行`)

  // 场景 4：无审批通道 → fail-closed，绝不静默放行
  console.log()
  console.log('场景 4：审批服务不可用（真实场景：进程没接上审批通道）')
  approvalService = undefined
  const r4 = await execute(exec('delete_file', 'E.txt'))
  console.log(`  → ${r4.content} ← 无通道也拒绝，绝不静默放行`)

  console.log()
  console.log('🎯 一句话：要不要执行，从模型手里拿出来，交给政策（allow / deny / ask）')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：与其它 step 保持独立作用域
export {}
