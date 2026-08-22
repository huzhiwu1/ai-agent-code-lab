/**
 * Step 02 – 参数物化：为什么参数要"冻"起来？
 *
 * 痛苦场景：参数已经出现在模型历史 / 审计日志 / UI 里（三个读者），但工具执行
 * 时才真正读参数。如果执行期间参数还能被改——"展示的是 A，执行的是 B"，
 * 审计无法自证"当时到底执行了什么"。
 *
 * 为什么这么设计：物化 = 验证 → 快照 → 冻结 → 发 token。验证保证参数是无损
 * JSON（undefined / 函数 / 循环引用在序列化时丢信息，fail-closed 直接拒绝）；
 * 快照克隆切断与调用方的引用；冻结让任何路径的写入都抛 TypeError；token 是
 * 执行身份的凭据（源码用 brand 类型，这里用 symbol 简化）。
 *
 * 收益：参数一进管线就"定型"，审计、重放、并行调度看到的永远是同一份。
 *
 * 对应源码：createExecution()（index.ts:1364）/ snapshotJsonValue() / deepFreeze() /
 *   createExecutionToken()（index.ts:1866，本步用 symbol 简化）
 * 跑法：pnpm run tools:step:02（或 articles/dsh-tools 内 pnpm run step:02）
 */

/** 执行上下文：args 是物化后的冻结快照，只读 */
interface ToolExec {
  readonly callId: string
  readonly name: string
  readonly args: unknown
  readonly signal: AbortSignal
}

/** 无损 JSON 校验：JSON 会丢信息的值（undefined/函数/symbol/bigint/循环引用）一律拒绝 */
function isLosslessJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Array.isArray(value)
    ? value.every(v => isLosslessJson(v, seen))
    : Object.values(value).every(v => isLosslessJson(v, seen))
}

/** 递归冻结：strict 模式下对冻结对象任何路径的写入都会抛 TypeError */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value as object))
      deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/** 物化：验证 → 快照（structuredClone 切断引用）→ 冻结 → 分配 token */
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
      signal: input.signal,
    },
  }
}

// 工具注册表（本步只演示 delete_file）
type Tool = { execute: (args: unknown) => Promise<string> }
const registry = new Map<string, Tool>()
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 演示辅助：物化一次调用；失败直接 throw（正常路径不会走到） */
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

async function main(): Promise<void> {
  registry.set('delete_file', {
    execute: async args => {
      await sleep(50) // 异步删除：await 期间调用方可能改参数（崩点舞台）
      return `已删除 ${(args as { path: string }).path}`
    },
  })

  console.log('🧊 Step 02 – 参数物化：参数要"冻"起来')
  console.log('------------------------------------------')

  // 演示 1：await 期间外部篡改 → 执行用的是冻结快照
  console.log('场景 1：模型说删 A.txt，await 期间外部把参数改成 B.txt')
  const rawArgs = { path: 'A.txt' }
  const exec1 = execOf('delete_file', rawArgs) // 先物化：快照 + 冻结
  rawArgs.path = 'B.txt' // 调用方改的是原对象，与冻结快照无关
  const r1 = await registry.get('delete_file')!.execute(exec1.args)
  console.log('  展示/审计/UI 看到：A.txt')
  console.log(`  实际执行：${r1} ← 删的是 A！三个读者永远看到同一份`)

  // 演示 2：冻结参数写入 → TypeError（严格模式）
  console.log()
  console.log('场景 2：有人想写冻结参数')
  try {
    const frozen = exec1.args as { path: string }
    frozen.path = 'C.txt' // 对冻结对象赋值：strict 模式抛 TypeError
    console.log('  ❌ 意外：写入没报错')
  } catch (error) {
    console.log(`  💥 抛错：${(error as Error).message}`)
  }

  // 演示 3：有损参数 fail-closed → 物化阶段就拒绝
  console.log()
  console.log('场景 3：传有损参数（path: undefined，JSON 序列化会丢这个字段）')
  const mat = createExecution({
    callId: 'call-bad',
    name: 'delete_file',
    args: { path: undefined },
    signal: new AbortController().signal,
  })
  console.log(`  物化结果：${mat.kind === 'rejected' ? `💥 拒绝（${mat.reason}）` : '❌ 意外通过'}`)

  console.log()
  console.log('🎯 一句话：参数一进管线就定型——审计自证靠"冻结"，不是靠自觉')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：与其它 step 保持独立作用域
export {}
