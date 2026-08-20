/**
 * Step 02 – 参数物化：为什么参数要"冻"起来？
 *
 * 学习目标：源码在参数进入政策管线前，先做一次 lossless-JSON 快照 +
 * deepFreeze，再分配一个不透明 token 作为执行身份。原因：参数已经在
 * 历史日志、审计、UI 里展示过了——执行时改参数 = 三个读者看到三个版本。
 *
 * 对应源码：packages/core/tools/src/index.ts
 *   createExecution() 里的 snapshotJsonValue + deepFreeze + createExecutionToken
 *
 * 跑法：pnpm run step:02
 */

/** lossless 快照：值必须是可无损 JSON 化的（拒绝 undefined/函数/符号/循环引用），再克隆 */
function snapshotJsonValue<T>(value: T): T | undefined {
  if (!isLosslessJson(value)) return undefined
  return structuredClone(value) as T
}

/** 递归检查：是不是 lossless JSON 值（源码里 snapshotJsonValue 的语义） */
function isLosslessJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return true
  // undefined / function / symbol / bigint 都不是合法 JSON
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint')
    return false
  if (type === 'object') {
    if (seen.has(value)) return false // 循环引用
    seen.add(value)
    if (Array.isArray(value)) return value.every(v => isLosslessJson(v, seen))
    return Object.values(value).every(v => isLosslessJson(v, seen))
  }
  return false
}

/** 递归冻结：任何路径上的修改都会在严格模式下抛 TypeError */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/** 不透明执行 token：只用于身份比较，不暴露任何可变状态 */
const toolExecutionTokenBrand = Symbol('token-brand')
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }
function createExecutionToken(): ToolExecutionToken {
  return Symbol('dsh.tool.execution') as ToolExecutionToken
}

interface ToolExec {
  readonly token: ToolExecutionToken
  readonly callId: string
  readonly name: string
  /** 冻结后的参数：readonly 只是编译期约束，deepFreeze 才是运行时铁律 */
  readonly arguments: unknown
}

/** 物化一次调用：快照失败 → 拒绝；成功 → 冻结 + 分配 token */
function createExecution(input: {
  callId: string
  name: string
  arguments: unknown
}): { kind: 'ready'; exec: ToolExec } | { kind: 'rejected'; reason: string } {
  const detached = snapshotJsonValue(input.arguments)
  if (detached === undefined) {
    return {
      kind: 'rejected',
      reason: `tool "${input.name}" arguments must be losslessly JSON-serializable`,
    }
  }
  return {
    kind: 'ready',
    exec: {
      token: createExecutionToken(),
      callId: input.callId,
      name: input.name,
      arguments: deepFreeze(detached),
    },
  }
}

async function main(): Promise<void> {
  console.log('🧊 参数物化：lossless 快照 + deepFreeze + token 身份')
  console.log('----------------------------------------')

  // ① 正常参数：物化成功，参数被冻结
  const good = createExecution({
    callId: 'call_1',
    name: 'read_file',
    arguments: { path: '/a/b.txt', offset: 10 },
  })
  if (good.kind === 'ready') {
    console.log('✅ 合法参数物化成功，token =', String(good.exec.token))
    try {
      // 严格模式下修改冻结对象 → TypeError（tsx 默认严格模式）
      ;(good.exec.arguments as Record<string, unknown>).path = '/evil.txt'
      console.log('⚠️  修改成功（意外，说明没冻住）')
    } catch (error) {
      console.log(`🚫 尝试修改冻结参数 → ${(error as Error).name}: ${(error as Error).message}`)
    }
  }

  // ② 带 undefined / 函数的参数：JSON 往返后丢字段 → 拒绝
  const lossy = createExecution({
    callId: 'call_2',
    name: 'read_file',
    arguments: { path: '/a.txt', extra: undefined },
  })
  console.log(
    lossy.kind === 'rejected'
      ? `🚫 有损参数被拒绝：${lossy.reason}`
      : '⚠️  有损参数居然通过了（意外）',
  )

  // ③ 同一个调用对象可以跨钩子传递 token：身份不变、内容不可变
  const callA = createExecution({ callId: 'call_3', name: 'add', arguments: { a: 1 } })
  const callB = createExecution({ callId: 'call_3', name: 'add', arguments: { a: 1 } })
  if (callA.kind === 'ready' && callB.kind === 'ready') {
    console.log(
      `🔑 相同 callId 的两次物化：token 不同（${callA.exec.token !== callB.exec.token ? '是' : '否'}）——token 标识的是"这一次执行"`,
    )
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
