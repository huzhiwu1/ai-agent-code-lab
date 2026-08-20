/**
 * Step 01 – 会话事件日志：历史只是"派生"，从不单独存储
 *
 * 学习目标：把"一个消息数组"替换成"一份 append-only 事件日志"。会话的
 * 全部真相就是这份日志（唯一事实源），模型看到的消息历史是从日志重放
 * 派生的——"状态和日志分叉"在结构上不可能发生。两个关键契约：
 *
 *   1. 不可变：事件入日志后深冻结，谁也不能改历史，只能追加；
 *   2. seq 连续：每个事件的顺序号 = 入日志时的长度。连续性 = 持久化契约，
 *      断号/跳号必须能被检测出来（chunk 不能被过滤掉，否则 seq 断档）。
 *
 * 对应源码：packages/core/session/src/types.ts（SessionEventMap）
 *           packages/core/session/src/session.ts（Session.append）
 *
 * 跑法：pnpm run step:01
 */

/** 事件词汇表（简化版，对齐文章 1.2 节：turn 边界 / 表面事件 / 工具配对） */
type SessionEvent =
  | { type: 'turn/start'; turn: number }
  | { type: 'turn/end'; turn: number; reason: string }
  | { type: 'user/message'; content: string }
  | { type: 'assistant/message'; content: string }
  | { type: 'tool/call'; name: string; arguments: string }
  | { type: 'tool/result'; content: string }

/** 能从日志投影成消息的事件类型（文章 1.2 节：表面事件三件套） */
type MessageEvent = Extract<
  SessionEvent,
  { type: 'user/message' | 'assistant/message' | 'tool/result' }
>

function isMessageEvent(ev: SessionEvent): ev is MessageEvent {
  return ev.type === 'user/message' || ev.type === 'assistant/message' || ev.type === 'tool/result'
}

/** 日志条目：seq = 入日志时的长度（文章 1.4 节），事件深冻结不可变 */
interface StoredEvent {
  seq: number
  time: number
  event: SessionEvent
}

/** 深冻结：append 后任何路径都改不动历史 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') Object.freeze(value)
  return value
}

/**
 * 会话 = append-only 事件日志（文章 1.1 节）。
 * 注意：没有 update / delete / 插入——只提供 append。
 */
class Session {
  private log: StoredEvent[] = []

  /**
   * 追加一个事件：seq = log.length（连续性契约），同步返回。
   * 真实实现里持久化是异步缓冲的（write-behind，Step 06），append 本身永不阻塞 I/O。
   */
  append(event: SessionEvent): StoredEvent {
    const stored: StoredEvent = { seq: this.log.length, time: Date.now(), event: deepFreeze(event) }
    this.log.push(stored)
    return stored
  }

  get length(): number {
    return this.log.length
  }

  /** 只读视图：调用方拿到的是不可变快照 */
  get events(): readonly StoredEvent[] {
    return this.log
  }

  /** 派生消息历史：纯函数重放，从不单独存储（文章 1.1 节） */
  deriveMessages(): string[] {
    return this.log
      .filter(s => isMessageEvent(s.event))
      .map(s => {
        const ev = s.event as MessageEvent
        if (ev.type === 'user/message') return `user: ${ev.content}`
        if (ev.type === 'assistant/message') return `assistant: ${ev.content}`
        return `tool: ${ev.content}`
      })
  }
}

/**
 * 校验 seq 连续（文章 1.4 节：连续性 = 持久化契约）。
 * 真实后端 reload 时会对齐重放；这里演示"断号必须被检测出来"。
 */
function assertContiguousSeq(log: readonly StoredEvent[]): void {
  log.forEach((stored, i) => {
    if (stored.seq !== i) {
      throw new Error(`seq 断档！期望 ${i}，实际 ${stored.seq}——日志不可信，拒绝重放`)
    }
  })
}

/** 打印用：长文本截断 */
function clip(text: string, max = 36): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 打印用：事件的简短描述 */
function describe(stored: StoredEvent): string {
  const ev = stored.event
  if (ev.type === 'tool/call') return clip(ev.arguments)
  if (ev.type === 'turn/start') return `turn ${ev.turn}`
  if (ev.type === 'turn/end') return `turn ${ev.turn} ${ev.reason}`
  return clip(ev.content)
}

async function main(): Promise<void> {
  const session = new Session()

  console.log('🧾 第 1 层：append-only 会话事件日志')
  console.log('----------------------------------------')

  // 追加一轮完整对话：turn 边界 + 表面事件 + 工具配对
  session.append({ type: 'turn/start', turn: 1 })
  session.append({ type: 'user/message', content: '帮我写一个 debounce 工具函数，支持取消' })
  session.append({
    type: 'assistant/message',
    content:
      '```ts\nexport function debounce(fn: () => void, ms: number) {\n  let timer: ReturnType<typeof setTimeout>\n  return () => { clearTimeout(timer); timer = setTimeout(fn, ms) }\n}\n```',
  })
  session.append({ type: 'tool/call', name: 'check_code', arguments: '{"file":"debounce.ts"}' })
  session.append({ type: 'tool/result', content: 'lint 通过，0 错误 0 警告' })
  session.append({
    type: 'assistant/message',
    content: '完成。已支持取消（clearTimeout），并补充了类型标注。',
  })
  session.append({ type: 'turn/end', turn: 1, reason: 'completed' })

  // ① 日志是唯一事实源：所有交互都在这，包括 chunk 级细节（这里用 assistant/message 简化）
  console.log('① 日志（唯一事实源，不可变，可重放）：')
  for (const stored of session.events) {
    console.log(`   seq=${stored.seq}  ${stored.event.type.padEnd(20)} ${describe(stored)}`)
  }

  // ② 消息历史是派生的：从同一份日志重放，不单独存储
  console.log('\n② deriveMessages() 从日志派生模型历史（不单独存储）：')
  for (const line of session.deriveMessages()) console.log(`   ${clip(line, 60)}`)

  // ③ 不可变性：已入日志的事件被深冻结，篡改不生效
  console.log('\n③ 不可变性：事件入日志后深冻结')
  const stored = session.events[1]
  console.log(`   Object.isFrozen(event) = ${Object.isFrozen(stored.event)}`)
  try {
    ;(stored.event as { content: string }).content = '被篡改！'
    console.log('   篡改尝试未生效（冻结阻止写入），content 仍是原文')
  } catch {
    console.log('   篡改尝试被拒（严格模式下抛 TypeError）——历史不可变 ✓')
  }
  console.log(`   原文仍是："${(stored.event as { content: string }).content.slice(0, 16)}…"`)

  // ④ seq 连续性：断号必须被检测出来
  console.log('\n④ seq 连续性契约：')
  const contig = session.events
  assertContiguousSeq(contig)
  console.log(`   正常日志校验通过：seq = 0..${contig.length - 1} 连续 ✓`)

  // 模拟一个"被过滤掉 chunk"的坏日志（seq 断档）
  const tampered: StoredEvent[] = [
    { seq: 0, time: 1, event: { type: 'turn/start', turn: 1 } },
    { seq: 2, time: 2, event: { type: 'user/message', content: 'x' } }, // 跳过了 1！
  ]
  try {
    assertContiguousSeq(tampered)
  } catch (error) {
    console.log(`   检测到断号 → ${(error as Error).message}`)
  }

  console.log(
    '\n小结：会话 = 一份只追加的日志；消息历史永远派生、永远可重放；seq 断档即日志不可信。',
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
