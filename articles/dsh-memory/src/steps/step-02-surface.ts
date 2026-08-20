/**
 * Step 02 – 表面投影：模型看到的历史是"投影"，不是日志本身
 *
 * 学习目标：在事件日志之上加一层"表面"（surface）——模型可见历史的
 * 派生视图。表面只有两种操作（文章 2.2 节 SurfaceOp）：
 *
 *   - append：新事件追加到表面尾部（正常消息走这个）；
 *   - replace：把 [start, end]（含两端，表面位置）影子掉，插入新事件。
 *
 * 关键契约：replace 必须带 sourceEventSeqs——被影子掉的每个表面节点的
 * seq。重放时验证"点名了它移除的每个事件"，缺一个就拒绝。这就是压缩的
 * 可审计性：你压掉了什么，日志里永远有据可查（文章 2.3 节）。
 *
 * 只有三类事件能上表面（user/message、assistant/message、tool/result），
 * 且必须携带 surfaceOp；其他事件（turn 边界、tool/call）禁止携带。
 *
 * 对应源码：packages/core/session/src/surface.ts（SurfaceManager）
 *           packages/core/session/src/session.ts（deriveMessages）
 *
 * 跑法：pnpm run step:02
 */

/** 表面操作：append（正常尾部追加）或 replace（影子掉 [start, end]，含两端） */
type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }

/**
 * 能上表面的三类事件（SurfaceEventType）——必须带 surfaceOp + sourceEventSeqs。
 * sourceEventSeqs：append 时为 []；replace 时为被影子节点的 seq 列表（文章 2.3 节）。
 */
type SurfaceEvent =
  | { type: 'user/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'assistant/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'tool/result'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }

/** 日志专用事件：禁止携带 surfaceOp（文章 2.2 节） */
type LogOnlyEvent =
  { type: 'turn/start'; turn: number } | { type: 'tool/call'; name: string; arguments: string }

type SessionEvent = SurfaceEvent | LogOnlyEvent

interface StoredEvent {
  seq: number
  time: number
  event: SessionEvent
}

function isSurfaceEvent(ev: SessionEvent): ev is SurfaceEvent {
  return ev.type === 'user/message' || ev.type === 'assistant/message' || ev.type === 'tool/result'
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') Object.freeze(value)
  return value
}

/**
 * 表面管理器：增量维护"表面节点 = 表面事件的 seq 列表"（文章 2.4 节）。
 * - 只处理新事件，O(new events)，不重扫全日志；
 * - replace 用数组位置定位端点，splice 插入替换 seq——不需要链表或映射表；
 * - replaceGeneration 单调递增：这是"表面被重写过"的证据（文章 2.4 节）。
 */
class SurfaceManager {
  nodes: number[] = []
  replaceGeneration = 0

  /** 提交前校验：replace 端点必须在表面存在；sourceEventSeqs 必须点名全部被影子节点 */
  validateNext(stored: StoredEvent): void {
    const ev = stored.event
    if (!isSurfaceEvent(ev)) return
    if (typeof ev.surfaceOp === 'object') {
      const { start, end } = ev.surfaceOp
      if (start < 0 || end >= this.nodes.length || start > end) {
        throw new Error(
          `replace 端点 [${start}, ${end}] 不在当前表面（共 ${this.nodes.length} 个节点）`,
        )
      }
      const shadowed = this.nodes.slice(start, end + 1)
      if (
        ev.sourceEventSeqs.length !== shadowed.length ||
        ev.sourceEventSeqs.some((seq, i) => seq !== shadowed[i])
      ) {
        throw new Error(
          `replace 必须点名全部被影子节点：期望 [${shadowed.join(', ')}]，实际 [${ev.sourceEventSeqs.join(', ')}]`,
        )
      }
    }
  }

  /** 提交后增量应用：append 尾部插入；replace 用 splice 替换（文章 2.4 节） */
  apply(stored: StoredEvent): void {
    const ev = stored.event
    if (!isSurfaceEvent(ev)) return
    if (typeof ev.surfaceOp === 'object') {
      const { start, end } = ev.surfaceOp
      this.nodes.splice(start, end - start + 1, stored.seq)
      this.replaceGeneration++
    } else {
      this.nodes.push(stored.seq)
    }
  }
}

/** 会话：append-only 日志 + 增量表面（从 Step 01 演进） */
class Session {
  private log: StoredEvent[] = []
  private surface = new SurfaceManager()

  /** append：先校验表面契约（坏事件在源头拦下），入日志后再增量应用表面 */
  append(event: SessionEvent): StoredEvent {
    const stored: StoredEvent = { seq: this.log.length, time: Date.now(), event: deepFreeze(event) }
    this.surface.validateNext(stored) // 提交前校验（文章 2.4 节 validateNext）
    this.log.push(stored)
    this.surface.apply(stored) // 提交后增量应用
    return stored
  }

  get length(): number {
    return this.log.length
  }

  get events(): readonly StoredEvent[] {
    return this.log
  }

  /** 表面节点 seq 列表（只读） */
  get surfaceNodes(): readonly number[] {
    return this.surface.nodes
  }

  /** 表面被重写过的次数（溢出恢复靠它判断是否真的发生了改动，文章 3.11 节） */
  get replaceGeneration(): number {
    return this.surface.replaceGeneration
  }

  /** 沿表面投影模型可见历史（文章 2.5 节 deriveMessages）：只有表面节点能投影 */
  deriveMessages(): string[] {
    return this.surface.nodes.map(seq => {
      const ev = this.log[seq].event as SurfaceEvent
      if (ev.type === 'user/message') return `user: ${ev.content}`
      if (ev.type === 'assistant/message') return `assistant: ${ev.content}`
      return `tool: ${ev.content}`
    })
  }

  /** 审计：按 sourceEventSeqs 从日志原样取回被影子事件（含日志专用事件） */
  auditShadowed(sourceEventSeqs: readonly number[]): readonly StoredEvent[] {
    return sourceEventSeqs.map(seq => this.log[seq])
  }
}

/** 打印用：长文本截断 */
function clip(text: string, max = 40): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 打印用：任意事件的简短描述（含日志专用事件） */
function describeEvent(ev: SessionEvent): string {
  if (isSurfaceEvent(ev)) return clip(ev.content)
  if (ev.type === 'tool/call') return clip(ev.arguments)
  return `turn ${ev.turn}`
}

async function main(): Promise<void> {
  const session = new Session()

  console.log('🧩 第 2 层：表面投影——模型看到的是视图，不是日志')
  console.log('----------------------------------------')

  // 一段"写 debounce"的对话：tool/call 只进日志，不上表面
  session.append({
    type: 'user/message',
    content: '帮我写一个 debounce 函数',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content:
      '```ts\nfunction debounce(fn: () => void, ms: number) {\n  let timer\n  return () => { clearTimeout(timer); timer = setTimeout(fn, ms) }\n}\n```',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({ type: 'tool/call', name: 'check_code', arguments: '{"file":"debounce.ts"}' })
  session.append({
    type: 'tool/result',
    content: 'lint 通过，0 错误',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content: '完成，已给出带类型标注的实现',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })

  console.log('① 日志共 5 条事件，但表面只有 4 个节点（tool/call 是日志专用，不上表面）：')
  console.log(`   表面节点 seq = [${session.surfaceNodes.join(', ')}]`)
  console.log('   模型看到的视图（deriveMessages）：')
  for (const line of session.deriveMessages()) console.log(`     ${clip(line, 56)}`)

  // 压缩雏形：把 assistant 回答 + tool/result 影子掉，插入一条总结
  console.log('\n② replace：影子掉表面位置 [1, 2]（assistant + tool/result），插入一条总结')
  const summary: SurfaceEvent = {
    type: 'user/message',
    content: '【压缩摘要】已提供 debounce 实现（含类型标注），代码通过 lint 检查',
    surfaceOp: { op: 'replace', start: 1, end: 2 },
    sourceEventSeqs: [1, 3], // 点名被影子掉的两个表面节点
  }
  const replaced = session.append(summary)
  console.log(`   新事件 seq=${replaced.seq}，replaceGeneration=${session.replaceGeneration}`)
  console.log('   替换后的表面视图：')
  for (const line of session.deriveMessages()) console.log(`     ${line}`)

  // 审计：这段话怎么来的？
  console.log('\n③ 审计：sourceEventSeqs → 被影子的事件从日志原样可查')
  for (const stored of session.auditShadowed([1, 3])) {
    console.log(
      `   seq=${stored.seq}  ${stored.event.type.padEnd(20)} "${describeEvent(stored.event)}"`,
    )
  }
  console.log('   注意 seq=2 的 tool/call 还在日志里——日志保留一切，表面只是视图')

  // 契约校验：坏事件在源头拦下
  console.log('\n④ 契约校验（坏事件在 append 处就失败）：')
  try {
    session.append({
      type: 'user/message',
      content: 'x',
      surfaceOp: { op: 'replace', start: 1, end: 9 }, // 端点越界
      sourceEventSeqs: [1, 3],
    })
  } catch (error) {
    console.log(`   端点越界被拒：${(error as Error).message}`)
  }
  try {
    session.append({
      type: 'user/message',
      content: 'y',
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [], // 少报：没有点名被影子节点
    })
  } catch (error) {
    console.log(`   sourceEventSeqs 少报被拒：${(error as Error).message}`)
  }

  console.log(
    '\n小结：表面 = 日志的增量投影；replace 必须报出全部来源（sourceEventSeqs），压缩永远可审计。',
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
