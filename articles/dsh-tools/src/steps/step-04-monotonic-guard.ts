/**
 * Step 04 – 单调守卫：为什么守卫只能"拒绝"？
 *
 * 痛苦场景：审批放行之后，还有策略红线（禁删 AGENTS.md、禁读 .env）。如果守卫
 * 既能拒绝又能放行，注册顺序就决定"谁说了算"：A 拒绝、B 放行 → 结果变放行，
 * 守卫互相踩——加一个守卫反而可能解除另一个守卫的拒绝。
 *
 * 为什么这么设计：ToolGuard 的返回类型只有 `string | undefined`——拒绝理由或
 * "不表态"，**没有 allow 分支**。源码注释："Because guards have no allow result,
 * listener ordering cannot turn a denial back into permission"（守卫没有放行结果，
 * 监听顺序永远无法把拒绝翻回许可）。拒绝是幂等安全的，放行不是。
 *
 * 收益：守卫注册顺序无关，任何一道拒绝都是终局；策略可叠加、不会互相抵消。
 *
 * 对应源码：ToolGuard 类型（index.ts:711）+ guardReason() 的 scope 链查询（index.ts:1119）
 * 跑法：pnpm run tools:step:04（或 articles/dsh-tools 内 pnpm run step:04）
 */

/** 执行上下文（简化：本步只关注 name / args） */
interface ToolExec {
  readonly callId: string
  readonly name: string
  readonly args: unknown
  readonly signal: AbortSignal
}

/** 守卫：string = 拒绝理由；undefined = 不表态。故意没有 allow 分支 */
type ToolGuard = (exec: Readonly<ToolExec>) => string | undefined

const guards: ToolGuard[] = []

/** 任一守卫的拒绝都是终局（简化版 guardReason，源码还查全局 + scope 链） */
function guardReason(exec: ToolExec): string | undefined {
  for (const guard of guards) {
    const reason = guard(exec)
    if (reason !== undefined) return reason
  }
  return undefined
}

async function main(): Promise<void> {
  const exec = (name: string, path: string): ToolExec => ({
    callId: `call-${name}`,
    name,
    args: { path },
    signal: new AbortController().signal,
  })

  // 两道守卫：保护 .env + 保护 AGENTS.md（注册顺序与"严重度"无关，这正是单调性的意义）
  guards.push(exec =>
    exec.name === 'delete_file' && (exec.args as { path: string }).path === '.env'
      ? '.env is protected'
      : undefined,
  )
  guards.push(exec =>
    exec.name === 'delete_file' && (exec.args as { path: string }).path === 'AGENTS.md'
      ? 'AGENTS.md is protected'
      : undefined,
  )

  console.log('🛡️ Step 04 – 单调守卫：守卫只能拒绝')
  console.log('----------------------------------------')

  // 场景 1：普通文件——两道守卫都不表态 → 放行
  console.log('场景 1：删除 notes.txt（无红线）')
  const r1 = guardReason(exec('delete_file', 'notes.txt'))
  console.log(`  guardReason → ${r1 ?? 'undefined（放行）'}`)

  // 场景 2：AGENTS.md——第二道守卫拒绝（第一道没表态也不影响）
  console.log()
  console.log('场景 2：删除 AGENTS.md（红线）')
  const r2 = guardReason(exec('delete_file', 'AGENTS.md'))
  console.log(`  guardReason → ${r2} ← 终局，后续守卫不用再看`)

  // 场景 3：.env——第一道守卫就拒绝
  console.log()
  console.log('场景 3：删除 .env（红线，注册在最前）')
  const r3 = guardReason(exec('delete_file', '.env'))
  console.log(`  guardReason → ${r3}`)

  // 反例论证：如果守卫有 allow 分支会怎样（只论证，不写代码）
  console.log()
  console.log('反例：假设守卫能返回 allow——')
  console.log('  守卫 A（拒绝 .env）→ 守卫 B（放行 delete_file）：顺序 先A后B = 放行')
  console.log('  同一组守卫顺序颠倒：先B后A = 拒绝 → 结果由注册顺序决定，守卫互相踩')
  console.log('  所以类型上就没有 allow：拒绝是幂等的，放行不是。')

  console.log()
  console.log('🎯 一句话：审批管"能不能"，守卫管"绝对不行"——拒绝永远是终局')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：与其它 step 保持独立作用域
export {}
