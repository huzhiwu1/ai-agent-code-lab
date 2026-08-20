/**
 * Step 04 – 单调守卫：为什么守卫只能"拒绝"不能"放行"？
 *
 * 学习目标：源码里 ToolGuard 的返回类型故意没有 allow 分支——返回
 * reason 拒绝，返回 undefined 不改变决策。如果守卫能放行，注册顺序就
 * 能决定"谁说了算"（A 拒绝、B 放行 → 结果放行），守卫之间互相踩。
 * 只允许拒绝 = 任何一道守卫的拒绝都是终局，监听者顺序永远不会把拒绝
 * 变回许可。这就是"单调性"。
 *
 * 对应源码：packages/core/tools/src/index.ts
 *   type ToolGuard / guardReason() / ToolLayer.guardReason()
 *
 * 跑法：pnpm run step:04
 */

interface ToolExec {
  readonly name: string
  readonly args: unknown
  /** 发起调用的 agent（决定走哪个作用域链） */
  readonly agent?: { id: string }
}

/** 全局守卫 + 各 agent 级守卫（简化：一个 Map 按 agentId 分层） */
const globalGuards: ((exec: ToolExec) => string | undefined)[] = []
const agentGuards = new Map<string, ((exec: ToolExec) => string | undefined)[]>()

/**
 * 查守卫：先全局层，再沿作用域链从远到近（简化版只有一层 agent）。
 * 任一守卫返回 reason 即拒绝；没有守卫能"撤销"别人的拒绝。
 */
function guardReason(exec: ToolExec): string | undefined {
  for (const guard of globalGuards) {
    const reason = guard(exec)
    if (reason !== undefined) return reason
  }
  if (exec.agent !== undefined) {
    for (const guard of agentGuards.get(exec.agent.id) ?? []) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
  }
  return undefined
}

/** 演示：守卫永远只是"附加拒绝"，把守卫数组倒过来结果不变 */
function withReversedOrder(
  guards: ((exec: ToolExec) => string | undefined)[],
): ((exec: ToolExec) => string | undefined)[] {
  return [...guards].reverse()
}

async function main(): Promise<void> {
  console.log('🛡️  单调守卫：只能拒绝，顺序无关')
  console.log('----------------------------------------')

  // 两个守卫：一个拒绝写操作，一个拒绝危险路径
  const guardWrite = (exec: ToolExec): string | undefined =>
    exec.name.startsWith('write') ? 'write tools are frozen for this task' : undefined
  const guardDanger = (exec: ToolExec): string | undefined =>
    (exec.args as { path?: string }).path?.includes('..') ? 'path escapes workspace' : undefined

  globalGuards.push(guardWrite, guardDanger)

  const exec = { name: 'write_file', args: { path: '../etc/passwd' }, agent: { id: 'agent-1' } }

  // 顺序 1：write 先拒绝
  console.log(`🚫 write_file(../etc/passwd) 顺序[write, danger] → ${guardReason(exec) ?? '放行'}`)

  // 顺序 2：danger 先拒绝 —— 结果一样，谁先谁后无所谓
  globalGuards.length = 0
  globalGuards.push(...withReversedOrder([guardWrite, guardDanger]))
  console.log(`🚫 write_file(../etc/passwd) 顺序[danger, write] → ${guardReason(exec) ?? '放行'}`)

  // 正常路径：两个守卫都返回 undefined → 放行
  globalGuards.length = 0
  globalGuards.push(guardWrite, guardDanger)
  const ok = { name: 'read_file', args: { path: 'src/index.ts' }, agent: { id: 'agent-1' } }
  console.log(`✅ read_file(src/index.ts)   → ${guardReason(ok) ?? '放行'}`)

  // agent 级守卫：只对特定 agent 生效
  agentGuards.set('agent-1', [
    e => (e.name === 'subagent' ? 'agent-1 cannot spawn subagents' : undefined),
  ])
  const spawnByA1 = { name: 'subagent', args: {}, agent: { id: 'agent-1' } }
  const spawnByA2 = { name: 'subagent', args: {}, agent: { id: 'agent-2' } }
  console.log(`🔒 subagent 被 agent-1 调 → ${guardReason(spawnByA1) ?? '放行'}`)
  console.log(`🔓 subagent 被 agent-2 调 → ${guardReason(spawnByA2) ?? '放行'}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
