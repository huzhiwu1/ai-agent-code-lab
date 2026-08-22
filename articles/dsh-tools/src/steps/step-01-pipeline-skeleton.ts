/**
 * Step 01 – 管线骨架：工具调用 ≠ 调个函数
 *
 * 痛苦场景：模型说"调工具"，如果实现只是 `registry.get(name)(args)` 直接调函数，
 * 一切看起来都正常——直到某天出现：参数被篡改、危险工具被诱导执行、慢工具挂死、
 * 结果泄露密钥。问题不是"哪个工具坏了"，而是调用本身没有任何关卡。
 *
 * 为什么这么设计：一次工具调用要过六道关（参数物化 → pre-execute → 守卫 →
 * execute 环绕 → post-execute → 最终化），每道关在源码里都是一段独立流程，
 * 这里用数组模拟 Cordis 瀑布。本步只搭骨架，每站留注释说明"未来这一站要干什么"。
 *
 * 收益：先建立"一次调用过六道关"的地图，后面每步填实一道关。
 *
 * 对应源码：packages/core/tools/src/index.ts – execute() 主流程（index.ts:1342）
 * 跑法：pnpm run tools:step:01（或 articles/dsh-tools 内 pnpm run step:01）
 */

/** 执行上下文：一次工具调用的"身份证"，管线各站共享 */
interface ToolExec {
  readonly callId: string
  readonly name: string
  readonly args: unknown
  readonly signal: AbortSignal
}

/** 工具执行结果：管线各站都返回或透传这个结构 */
type ToolResult = { isError: boolean; content: string; value?: unknown }

/** 朴素实现（对照）：没有管线，直接调函数——崩点从这一行开始 */
async function naiveCall(name: string, args: { path: string }): Promise<string> {
  return `已删除 ${args.path}` // 假设工具立即执行，没有任何关卡
}

// ── 六段管线骨架（数组模拟 Cordis 瀑布）──

/** 第②站：pre-execute 钩子。未来：审批瀑布（allow / deny / ask，index.ts:588） */
type PreHook = (exec: ToolExec) => Promise<{ kind: 'allow' | 'deny'; reason?: string }>
const preHooks: PreHook[] = []

/** 第③站：守卫。未来：单调拒绝（string = 拒绝理由，无 allow 分支，index.ts:711） */
type Guard = (exec: Readonly<ToolExec>) => string | undefined
const guards: Guard[] = []

/** 第④站：execute 环绕。未来：超时 / 重试 / 日志插件 */
type Wrapper = (exec: ToolExec, next: () => Promise<ToolResult>) => Promise<ToolResult>
const wrappers: Wrapper[] = []

/** 第⑤站：post-execute。未来：脱敏 / 校验 / 重渲染（index.ts:597） */
type PostHook = (exec: ToolExec, result: ToolResult) => ToolResult
const postHooks: PostHook[] = []

/** 六段管线主入口：骨架先跑通，每一站都留好位置 */
async function execute(exec: ToolExec): Promise<ToolResult> {
  // ① 参数物化：验证 → 快照 → 冻结 → token（未来在 createExecution，index.ts:1364）
  //    —— 本步先直接透传，step-02 填实

  // ② pre-execute 瀑布：任一钩子短路即终止（未来：审批，index.ts:1459）
  for (const hook of preHooks) {
    const decision = await hook(exec)
    if (decision.kind === 'deny') return { isError: true, content: `Error: ${decision.reason}` }
  }

  // ③ 单调守卫：只能拒绝，任一拒绝都是终局（未来：guardReason，index.ts:1119）
  for (const guard of guards) {
    const reason = guard(exec)
    if (reason !== undefined) return { isError: true, content: `Error: guarded: ${reason}` }
  }

  // ④ execute 环绕：wrapper 从外到内包住工具体（未来：超时插件，index.ts:1569）
  const body = async (): Promise<ToolResult> => ({
    isError: false,
    content: `已删除 ${(exec.args as { path: string }).path}`,
  })
  const result = await wrappers.reduceRight(
    (next: () => Promise<ToolResult>, wrap) => () => wrap(exec, next),
    body,
  )()

  // ⑤ post-execute：接受 / 替换 / 阻止（未来：脱敏，index.ts:1609）
  // ⑥ 最终化：事件通知、日志收尾（未来：finishScheduledExecution，index.ts:1631）
  return postHooks.reduce((r, hook) => hook(exec, r), result)
}

async function main(): Promise<void> {
  console.log('🧩 Step 01 – 管线骨架：工具调用 ≠ 调个函数')
  console.log('-----------------------------------------------')

  // 对照：朴素实现——直接调函数，看起来没问题？
  console.log('模型说：删除 A.txt')
  console.log(
    `  朴素实现：${await naiveCall('delete_file', { path: 'A.txt' })} ← 删了就删了，没有任何关卡`,
  )

  // 骨架管线：同一调用走六道关（当前全是"透传"，位置已留好）
  const exec: ToolExec = {
    callId: 'call-1',
    name: 'delete_file',
    args: { path: 'A.txt' },
    signal: new AbortController().signal,
  }
  const result = await execute(exec)
  console.log(`  管线实现：${result.content} ← 六道关全部通过`)
  console.log()
  console.log('六道关（本步只有骨架，注释标注了未来职责）：')
  console.log('  ① 参数物化 —— 参数已进审计，执行时不许变（step-02 填实）')
  console.log('  ② pre-execute —— 危险工具要问人（step-03 填实）')
  console.log('  ③ 单调守卫 —— 策略红线，只能拒绝（step-04 填实）')
  console.log('  ④ execute 环绕 —— 超时/重试包在外面（step-05 填实）')
  console.log('  ⑤ post-execute —— 结果也要过门（step-06 填实）')
  console.log('  ⑥ 最终化 —— 事件通知、日志收尾')
  console.log()
  console.log('🎯 一句话：直接调函数 = 裸奔；管线 = 每道关一个失败模式的答案')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

// 使本文件成为 ES 模块：与其它 step 保持独立作用域
export {}
