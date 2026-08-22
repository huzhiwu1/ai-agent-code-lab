/**
 * Step 06 – post-execute：为什么执行结果也要过一道门？
 *
 * 痛苦场景：工具返回的值不一定适合直接给模型看——read_file 可能返回
 * api_key=sk-xxx，日志导出可能混着 password 字段。如果结果直接进模型上下文，
 * 密钥就"过了一次模型"（可能在历史里留存、被模型引用、被泄露）。
 *
 * 为什么这么设计：输出同输入一样不可信。post-execute 是接受 / 替换 / 阻止
 * 三道门（源码 PostToolDecision，index.ts:597）：脱敏、校验、重渲染都挂这里，
 * 和工具逻辑解耦——工具不知道也不关心谁在看结果。
 *
 * 收益：结果处理（脱敏 / 校验 / 重渲染）集中一处，策略可叠加，工具保持纯粹。
 *
 * 对应源码：finalizeScheduledExecution()（index.ts:1609）post-execute 阶段
 * 跑法：pnpm run tools:step:06（或 articles/dsh-tools 内 pnpm run step:06）
 */

/** 执行上下文（简化：本步只关注 name / args） */
interface ToolExec {
  readonly callId: string
  readonly name: string
  readonly args: unknown
  readonly signal: AbortSignal
}

type ToolResult = { isError: boolean; content: string }

/** post-execute 三态：接受 / 替换 / 阻止（源码 PostToolDecision，index.ts:597） */
type PostToolDecision =
  { kind: 'accept' } | { kind: 'replace'; content: string } | { kind: 'block'; reason: string }

type PostHook = (exec: ToolExec, result: ToolResult) => PostToolDecision
const postHooks: PostHook[] = []

const registry = new Map<string, { execute: (args: unknown) => Promise<string> }>()

/** 管线：⑤ post-execute（本步聚焦；其他站简化透传） */
async function execute(exec: ToolExec): Promise<ToolResult> {
  const tool = registry.get(exec.name)
  if (!tool) return { isError: true, content: `Error: unknown tool "${exec.name}"` }
  const result: ToolResult = { isError: false, content: await tool.execute(exec.args) }

  for (const hook of postHooks) {
    const decision = hook(exec, result)
    if (decision.kind === 'accept') continue
    if (decision.kind === 'replace') result.content = decision.content
    if (decision.kind === 'block')
      return { isError: true, content: `Error: blocked by post-execute: ${decision.reason}` }
  }
  return result
}

async function main(): Promise<void> {
  registry.set('read_file', {
    execute: async args => `文件 ${(args as { path: string }).path} 的内容：api_key=sk-abc123456`,
  })
  registry.set('read_db', {
    execute: async () => 'username=alice,password=hunter2',
  })

  // 钩子 1：脱敏——结果含密钥就替换成 ***（replace）
  postHooks.push((_exec, result) => {
    const masked = result.content.replace(/sk-[a-z0-9]+/gi, '***')
    return masked === result.content ? { kind: 'accept' } : { kind: 'replace', content: masked }
  })
  // 钩子 2：内容策略——结果含 "password" 就整份阻止（block）
  postHooks.push((_exec, result) =>
    result.content.includes('password')
      ? { kind: 'block', reason: 'result contains sensitive keyword "password"' }
      : { kind: 'accept' },
  )

  const exec = (name: string, path: string): ToolExec => ({
    callId: `call-${name}`,
    name,
    args: { path },
    signal: new AbortController().signal,
  })

  console.log('🚪 Step 06 – post-execute：结果也要过一道门')
  console.log('--------------------------------------------------')

  // 场景 1：结果含密钥 → 脱敏（replace）
  console.log('场景 1：读 config.json（含 api_key）')
  const r1 = await execute(exec('read_file', 'config.json'))
  console.log('  工具原始返回：文件 config.json 的内容：api_key=sk-abc123456')
  console.log(`  模型看到：${r1.content} ← 密钥在进入模型上下文前被替换`)

  // 场景 2：结果含禁止关键词 → 阻止（block）
  console.log()
  console.log('场景 2：读 user.db 导出（含 password 字段）')
  const r2 = await execute(exec('read_db', 'user.db'))
  console.log('  工具原始返回：username=alice,password=hunter2')
  console.log(`  模型看到：${r2.content} ← 整份结果被阻止，不进模型上下文`)

  // 场景 3：正常结果 → 接受（accept），原样透传
  console.log()
  console.log('场景 3：读 notes.txt（干净内容）')
  registry.set('read_notes', { execute: async () => '会议记录：明天 10 点评审' })
  const r3 = await execute(exec('read_notes', 'notes.txt'))
  console.log(`  模型看到：${r3.content} ← accept，原样透传`)

  console.log()
  console.log('🎯 一句话：输出同输入一样不可信——进出都要过门，脱敏/校验和工具逻辑解耦')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：与其它 step 保持独立作用域
export {}
