/**
 * Step 07 – 并行/独占调度 + 完整整合：滚动池、独占屏障、保序提交
 *
 * 学习目标：模型一次返回多个工具调用时，调度器按 executionMode 分类——
 * isConcurrencySafe 精确返回 true 才进并行滚动池，其余全部独占（fail-closed）。
 * 三个铁律：
 *   1. 只有 dispatch/body 阶段能重叠；pre/post 和结果提交全部按模型顺序串行
 *   2. 启动前重新分类（注册表中途变更可把 parallel 翻成 exclusive）
 *   3. 提交保序：head-of-line cursor，前面的没结算完，后面的先完成也得等
 *
 * 对应源码：packages/core/agent-loop/src/tool-calls.ts（289 行）
 *   executeToolCalls() → runGroup() → commitReady() / startCall() / fillPool()
 *
 * 跑法：pnpm run step:07
 */

type ToolResult = { isError: boolean; content: string; value?: unknown }

/** 一次待调度调用：模型顺序 = 数组顺序 */
interface PlannedCall {
  id: string
  name: string
  args: unknown
}

interface ToolDef {
  execute: (args: unknown, signal: AbortSignal) => Promise<unknown>
  /** 纯函数分类器：精确 true 才可并行（抛异常/非 true = 独占） */
  isConcurrencySafe?: (args: unknown) => boolean
}

const registry = new Map<string, ToolDef>()

/** 分类：fail-closed，只有精确 true 是 parallel */
function executionMode(name: string, args: unknown): 'parallel' | 'exclusive' {
  const tool = registry.get(name)
  if (!tool?.isConcurrencySafe) return 'exclusive'
  try {
    return tool.isConcurrencySafe(args) === true ? 'parallel' : 'exclusive'
  } catch {
    return 'exclusive' // 分类器抛异常 = 独占
  }
}

/** 已结算的槽位：等待按模型顺序提交 */
interface Slot {
  exec: PlannedCall
  result: ToolResult
  settled: boolean
}

/**
 * 调度一组调用（简化版，聚焦三个铁律）：
 *  - 滚动池：并行调用最多 maxParallel 个在飞
 *  - 独占屏障：exclusive 调用等池子排空、单独跑、等它提交完才继续
 *  - 保序提交：commitReady 只推进连续 settled 的槽位
 */
async function runGroup(calls: PlannedCall[], maxParallel: number): Promise<void> {
  const slots: (Slot | undefined)[] = calls.map(() => undefined)
  const inFlight = new Map<number, Promise<void>>()
  let nextToStart = 0
  let committed = 0

  const commitReady = async (): Promise<void> => {
    while (committed < calls.length) {
      const slot = slots[committed]
      if (slot === undefined || !slot.settled) break // head-of-line：前面没结算就等
      console.log(`    📦 提交[${slot.exec.id}] ${slot.exec.name} → ${slot.result.content}`)
      committed++
    }
  }

  const startCall = async (index: number): Promise<void> => {
    const call = calls[index]!
    const tool = registry.get(call.name)!
    const promise = (async () => {
      // 只有 body 阶段与兄弟重叠；这里把"执行"当作 body
      const value = await tool.execute(call.args, new AbortController().signal)
      slots[index] = {
        exec: call,
        result: { isError: false, content: `${String(value)}` },
        settled: true,
      }
    })()
    inFlight.set(index, promise)
    await promise.finally(() => inFlight.delete(index))
  }

  const fillPool = async (): Promise<void> => {
    while (nextToStart < calls.length && inFlight.size < maxParallel) {
      const next = calls[nextToStart]!
      // 铁律 2：启动前重新分类（这里为演示简化：只查一次）
      const mode = executionMode(next.name, next.args)
      if (mode === 'exclusive') break // 独占 = 屏障，等池子排空单独跑
      await startCall(nextToStart)
      nextToStart++
      await commitReady()
    }
  }

  // 主循环
  await fillPool()
  while (nextToStart < calls.length || inFlight.size > 0) {
    if (inFlight.size > 0) {
      // 等任意一个 body 完成，然后尝试提交
      await Promise.race(inFlight.values())
      await commitReady()
      continue
    }
    // 池子空了：处理下一个（可能是独占）
    const call = calls[nextToStart]!
    const mode = executionMode(call.name, call.args)
    if (mode === 'exclusive') {
      console.log(`    🚧 屏障：${call.name} 单独执行（等池子排空）`)
      await startCall(nextToStart)
      nextToStart++
      await commitReady()
      console.log(`    ✅ 屏障释放：${call.name} 已提交`)
      continue
    }
    await fillPool()
  }
  await commitReady()
}

async function main(): Promise<void> {
  // 注册 5 个工具：前两个可并行（读操作），write 和 bash 独占，最后一个可并行
  registry.set('read_file', {
    isConcurrencySafe: () => true, // 读操作：无副作用，可重叠
    execute: async args => {
      const { path } = args as { path: string }
      await new Promise(r => setTimeout(r, 40 + Math.random() * 60))
      return `read ${path}`
    },
  })
  registry.set('search', {
    isConcurrencySafe: () => true,
    execute: async args => {
      const { q } = args as { q: string }
      await new Promise(r => setTimeout(r, 30 + Math.random() * 40))
      return `found ${q}`
    },
  })
  registry.set('write_file', {
    // 不声明 isConcurrencySafe → 独占（写入有副作用，绝不和兄弟重叠）
    execute: async args => {
      const { path } = args as { path: string }
      await new Promise(r => setTimeout(r, 50))
      return `wrote ${path}`
    },
  })
  registry.set('bash', {
    execute: async () => {
      await new Promise(r => setTimeout(r, 60))
      return 'bash output'
    },
  })
  registry.set('grep', {
    isConcurrencySafe: () => true,
    execute: async args => {
      const { pattern } = args as { pattern: string }
      await new Promise(r => setTimeout(r, 30 + Math.random() * 40))
      return `grep ${pattern}: 3 matches`
    },
  })

  // 模拟模型一次返回 5 个调用（模型顺序）
  const calls: PlannedCall[] = [
    { id: 'call_1', name: 'read_file', args: { path: 'a.ts' } },
    { id: 'call_2', name: 'search', args: { q: 'TODO' } },
    { id: 'call_3', name: 'write_file', args: { path: 'b.ts' } }, // 独占屏障
    { id: 'call_4', name: 'bash', args: {} }, // 独占屏障
    { id: 'call_5', name: 'grep', args: { pattern: 'FIXME' } },
  ]

  console.log('🧵 并行/独占调度：滚动池(max=2) + 独占屏障 + 保序提交')
  console.log('----------------------------------------')
  console.log(
    '模型顺序: call_1(read) call_2(search) call_3(write=独占) call_4(bash=独占) call_5(grep)',
  )
  console.log('')

  const started = Date.now()
  await runGroup(calls, 2)
  console.log(`\n⏱️  总耗时 ${Date.now() - started}ms（若全串行约 270ms+，这就是并行的价值）`)

  console.log(`
💡 观察要点：
  - call_1/call_2 并行重叠；call_3 是屏障（等前两个提交完才启动）
  - call_4 又是屏障；call_5 最后与空池并行
  - 提交顺序永远是 call_1 → call_2 → call_3 → call_4 → call_5（模型顺序）
  - 即使某个调用先完成，只要前面的没结算，它也得等（head-of-line）`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
