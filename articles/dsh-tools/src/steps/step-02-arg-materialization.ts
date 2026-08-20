/**
 * Step 02 – 参数物化：为什么参数要"冻"起来？
 *
 * 学习目标：理解执行管线的第一道关——createExecution()。模型说"调 read_file"
 * 之后、任何政策检查之前，参数先被物化：验证可无损 JSON 化 → 快照克隆 →
 * 递归冻结，再分配一个不透明的 token 作为执行身份。
 *
 * 为什么？（对应源码 index.ts 的 createExecution 与 PreToolDecision 注释）
 *   - 参数已经在历史日志、审计记录、UI 展示里出现过了。执行时若允许改参数，
 *     三个读者就会看到三个版本——审计和回放将无法自证"当时到底执行了什么"。
 *   - 所以物化的语义是"隔离"：调用方改原对象不影响执行，执行方改参数直接抛错。
 *   - 有损参数（undefined/函数/循环引用）在物化阶段就拒绝——fail-closed，
 *     绝不带着"和被展示过的不一样"的参数进入政策管线。
 *
 * 本步骤把 Step 01 六段骨架的第 ① 段填实：
 *   ① 参数物化：callId + token 身份 + lossless 验证 + 快照 + deepFreeze
 *
 * 对应源码：packages/core/tools/src/index.ts
 *   createExecution() → snapshotJsonValue() + deepFreeze() + createExecutionToken()
 *
 * 跑法：pnpm run step:02
 */

/** 工具执行结果：成功携带规范 value，失败携带错误文本（简化版） */
type ToolResult = { isError: boolean; content: string; value?: unknown }

/** 不透明执行 token：brand 类型让它与普通 symbol 不互通，只能由物化函数创建 */
const toolExecutionTokenBrand = Symbol('dsh.tool.execution')
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }

/** 一次工具调用的执行上下文（Step 02 起 args 一定是"物化后"的参数） */
interface ToolExec {
  /** 执行身份：对外可读的调用 ID（写进日志/审计/UI） */
  readonly callId: string
  /** 执行身份：不透明的 token（brand Symbol），仅注册表内部识别，外界无法伪造 */
  readonly token: ToolExecutionToken
  readonly name: string
  /** 物化后的参数：快照 + 递归冻结（readonly 只是编译期约束，deepFreeze 才是运行时铁律） */
  readonly args: unknown
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
// ① 参数物化（本步骤的新内容）：lossless 验证 → 快照 → 冻结 → 身份
// ---------------------------------------------------------------------------

/**
 * 递归检查值是否可无损 JSON 化（对应源码 snapshotJsonValue 的语义）
 *
 * - 允许：null / string / number（含 NaN、-0，lossless JSON 保留它们）/ boolean / 普通对象 / 数组
 * - 拒绝：undefined / function / symbol / bigint / 循环引用——JSON 序列化会丢字段或抛错
 *
 * @param value 待检查的值
 * @param seen  已访问对象集合（检测循环引用）
 * @returns 是否可无损 JSON 化
 */
function isLosslessJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true
  // 内联 typeof 判断：让 TS 原生控制流收窄 value 的类型（存到变量再比较会丢失收窄）
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }
  // undefined / function / symbol / bigint 都不是合法 JSON 值
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

/**
 * 无损快照：先验证、再克隆（切断与调用方对象的引用）
 *
 * 注意用 structuredClone 而不是 JSON.stringify 往返——标准 JSON 会把
 * NaN 变 null、-0 变 0、undefined 属性丢弃，快照就"失真"了（见 main 里的演示）。
 * 真实源码用 lossless-json 库，语义与本函数一致：验证 + 保真克隆。
 *
 * @returns 克隆后的值；不可无损 JSON 化时返回 undefined（调用方视为拒绝）
 */
function snapshotJsonValue<T>(value: T): T | undefined {
  if (!isLosslessJson(value)) return undefined
  return structuredClone(value) as T
}

/**
 * 递归冻结：把对象深层的所有属性都变成只读
 *
 * Object.freeze 是浅冻结，不递归的话内层对象依然可被篡改。
 * 冻结后的对象在严格模式（tsx 默认）下任何写入都会抛 TypeError。
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/** 物化结果：要么拿到 ready 执行对象，要么被拒绝（fail-closed） */
type Materialized = { kind: 'ready'; exec: ToolExec } | { kind: 'rejected'; reason: string }

/**
 * 参数物化：创建一次工具调用的"执行身份 + 只读参数"
 *
 * 顺序很重要：先验证 + 快照（切断与调用方对象的引用）再冻结（禁止执行方修改）。
 * 从此以后这条执行链上的所有人看到的都是同一份不可变参数。
 */
function createExecution(input: { callId: string; name: string; args: unknown }): Materialized {
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
      token: Symbol('dsh.tool.execution') as ToolExecutionToken, // brand 身份：外界无法伪造
      name: input.name,
      args: deepFreeze(detached),
    },
  }
}

/** 可插拔瀑布：pre-execute 决策、execute 环绕包装、post-execute 后处理 */
type PreDecision = 'allow' | 'deny' | 'ask'
const preHooks: ((exec: ToolExec) => PreDecision)[] = []
const wrappers: ((exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>)[] = []
const postHooks: ((exec: ToolExec, result: ToolResult) => ToolResult)[] = []

/**
 * 六段管线主入口
 *
 * ① 参数物化：调用方必须先过 createExecution()，execute 收到的 exec.args
 *    是"验证 + 快照 + 冻结"后的只读参数
 * ② pre-execute：允许 / 拒绝 / 询问（Step 03 补审批服务）
 * ③ 守卫：最终拒绝权（Step 04 补单调性论证）
 * ④ execute 环绕 + 工具体（Step 06 补超时包装）
 * ⑤ post-execute：接受 / 替换 / 阻止
 * ⑥ 最终化 + 通知（简化：直接返回）
 */
async function execute(exec: ToolExec): Promise<ToolResult> {
  // ② pre-execute 瀑布：任一钩子短路即终止
  for (const hook of preHooks) {
    const decision = hook(exec)
    if (decision === 'deny') {
      return { isError: true, content: `Error: tool "${exec.name}" denied by policy` }
    }
    if (decision === 'ask') {
      return { isError: true, content: `Error: tool "${exec.name}" requires approval (no channel)` }
    }
  }

  // ④ 环绕包装 + 工具体：reduceRight 让最外层 wrapper 最先执行
  const body = async (): Promise<ToolResult> => {
    const tool = registry.get(exec.name)
    if (!tool) return { isError: true, content: `Error: unknown tool "${exec.name}"` }
    const value = await tool.execute(exec.args, exec)
    // 成功：先渲染成模型可见内容（render 是纯函数，失败视为工具错误）
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
  console.log('🛠️  Step 02 – 参数物化：lossless 验证 + 快照 + 冻结 + 执行身份')
  console.log('--------------------------------------------------------------')

  register('add', {
    execute: async args =>
      (args as { a: number; b: number }).a + (args as { a: number; b: number }).b,
    output: {
      render: (_args, value) => `result = ${String(value)}`,
    },
  })

  // ── 演示 1：为什么用 structuredClone 而不是 JSON 往返 ──
  console.log('① 快照必须无损：JSON 往返破坏边缘类型，structuredClone 保真')
  const quirky = { minusZero: -0, nan: NaN }
  const jsonRoundTrip = JSON.parse(JSON.stringify(quirky)) as typeof quirky
  const structured = structuredClone(quirky)
  console.log(
    `   JSON 往返:      { minusZero: ${Object.is(jsonRoundTrip.minusZero, -0) ? '-0' : '0'}, nan: ${String(jsonRoundTrip.nan)} }  ← 失真`,
  )
  console.log(
    `   structuredClone: { minusZero: ${Object.is(structured.minusZero, -0) ? '-0' : '0'}, nan: ${String(structured.nan)} }  ← 保真`,
  )
  console.log()

  // ── 演示 2：快照隔离——调用方改原对象，执行看到的仍是物化时的参数 ──
  console.log('② 快照隔离：调用方修改原对象不影响执行参数')
  const rawArgs = { a: 1, b: 2 }
  const mat1 = createExecution({ callId: 'call-1', name: 'add', args: rawArgs })
  rawArgs.a = 100 // 调用方事后篡改
  rawArgs.b = 200
  if (mat1.kind === 'ready') {
    const r1 = await execute(mat1.exec)
    console.log(
      `   调用方把原对象改成 { a: 100, b: 200 }，执行结果: ${r1.content}（用的仍是快照 { a: 1, b: 2 }）`,
    )
  }
  console.log()

  // ── 演示 3：冻结——执行方修改参数直接抛 TypeError（strict 模式） ──
  console.log('③ 递归冻结：执行方修改参数直接抛 TypeError')
  const mat2 = createExecution({ callId: 'call-2', name: 'add', args: { a: 3, b: 4 } })
  if (mat2.kind === 'ready') {
    try {
      ;(mat2.exec.args as { a: number }).a = 999 // strict 模式下改冻结对象 → 抛错
    } catch (error) {
      console.log(
        `   修改 exec.args 被拒绝: ${error instanceof TypeError ? error.message : String(error)}`,
      )
    }
    const r2 = await execute(mat2.exec)
    console.log(`   正常执行不受影响: ${r2.content}`)
  }
  console.log()

  // ── 演示 4：身份——callId 对外可读，token 不透明且每次唯一 ──
  console.log('④ 执行身份：callId 对外可读，token 是不透明 brand Symbol')
  const mat3 = createExecution({ callId: 'call-3', name: 'add', args: { a: 5, b: 6 } })
  const mat4 = createExecution({ callId: 'call-3', name: 'add', args: { a: 5, b: 6 } })
  if (mat3.kind === 'ready' && mat4.kind === 'ready') {
    console.log(`   callId = "${mat3.exec.callId}"（写进日志/审计/UI）`)
    console.log(`   token  = ${String(mat3.exec.token)}（brand Symbol，外界无法伪造）`)
    console.log(
      `   相同 callId 的两次物化 token 不同: ${mat3.exec.token !== mat4.exec.token ? '✅ token 标识的是"这一次执行"' : '❌ 身份重复'}`,
    )
  }
  console.log()

  // ── 演示 5：有损参数在物化阶段就被拒绝（fail-closed） ──
  console.log('⑤ 有损参数（undefined / 函数 / 循环引用）→ 物化直接拒绝')
  const lossy = createExecution({ callId: 'call-4', name: 'add', args: { a: 1, extra: undefined } })
  if (lossy.kind === 'rejected') {
    console.log(`   🚫 ${lossy.reason}（undefined 属性会丢失，绝不让"失真参数"进入管线）`)
  }
  const circular: Record<string, unknown> = { a: 1 }
  circular.self = circular
  const cyclic = createExecution({ callId: 'call-5', name: 'add', args: circular })
  if (cyclic.kind === 'rejected') {
    console.log(`   🚫 ${cyclic.reason}（循环引用无法序列化，物化即拒绝）`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：每个 step 自包含，避免与其它 step 共享 TS 全局作用域
export {}
