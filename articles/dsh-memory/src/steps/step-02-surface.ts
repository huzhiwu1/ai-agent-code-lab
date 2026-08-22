/**
 * Step 02 – 表面投影：为什么模型看到的是"投影"，不是日志本身？
 *
 * ── 先懂三个词 ──────────────────────────────────────────────
 * 「surface 投影」= 从日志里"只挑出模型该看的事件"组成一份视图，只挑不复制，
 *   每次现算（类比：仓库货架 = 日志，存全部；橱窗陈列 = surface，只摆客人该
 *   看的。橱窗里的货永远在仓库有对应货位）。
 * 「视图 / view」= 模型实际看到的对话历史，是投影的结果（橱窗摆出来的样子）。
 * 「日志专用事件」= 只进日志、不进视图的事件（如 tool/call 的工具调用细节——
 *   模型不需要看到内部调用过程，但日志必须留着它）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：给模型单独存一份"干净历史"副本，日志每次更新时手动同步副本。
 * 副本同步靠自觉——日志更新了副本忘了更新，两处就漂移了；模型看到的是
 * 过期的历史，而"哪一份是对的"说不清。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * surface 只维护"该展示哪些事件的 seq 列表"（一行数字），deriveMessages()
 * 每次从日志现算视图。日志是唯一事实源，视图永远可重算——投影坏了重新投影
 * 即可，不需要修数据。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 视图永远不会和日志漂移；压缩/审计等后续机制只需操作 seq 列表。
 *
 * 对应源码：packages/core/session/src/surface.ts（SurfaceManager）
 * 跑法：pnpm run memory:step:02（或 articles/dsh-memory 内 pnpm run step:02）
 *
 * 注：真实源码里 surface 还支持 replace（替换视图里的一段）——那是压缩的
 * 机制，step-04 会讲，本步只讲"投影"本身。
 */

/** 能上表面的三类事件（SurfaceEventType）：模型可见的消息三件套 */
type SurfaceEvent =
  | { type: 'user/message'; content: string }
  | { type: 'assistant/message'; content: string }
  | { type: 'tool/result'; content: string }

/** 日志专用事件：只进日志，不进视图（如工具调用细节） */
type LogOnlyEvent = { type: 'tool/call'; name: string; arguments: string }

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
 * 表面管理器（对应源码 surface.ts SurfaceManager）：增量维护"表面节点 =
 * 能上表面的事件的 seq 列表"。只有新事件时才更新（O(new events)），
 * 不重扫全日志。
 */
class SurfaceManager {
  /** 表面节点：能上表面的事件的 seq，按入日志顺序排列 */
  nodes: number[] = []

  /** 新事件入日志后调用：是表面事件就记下它的 seq */
  apply(stored: StoredEvent): void {
    if (isSurfaceEvent(stored.event)) this.nodes.push(stored.seq)
  }
}

class Session {
  private log: StoredEvent[] = []
  private surface = new SurfaceManager()

  append(event: SessionEvent): StoredEvent {
    const stored: StoredEvent = { seq: this.log.length, time: Date.now(), event: deepFreeze(event) }
    this.log.push(stored)
    this.surface.apply(stored) // 表面同步更新——这就是"自动"，不需要手动维护副本
    return stored
  }

  get events(): readonly StoredEvent[] {
    return this.log
  }

  /** 表面节点 seq 列表（只读） */
  get surfaceNodes(): readonly number[] {
    return this.surface.nodes
  }

  /** 沿表面投影模型可见历史（对应源码 deriveMessages）：只有表面节点能投影 */
  deriveMessages(): string[] {
    return this.surface.nodes.map(seq => {
      const ev = this.log[seq].event as SurfaceEvent
      if (ev.type === 'user/message') return `user: ${ev.content}`
      if (ev.type === 'assistant/message') return `assistant: ${ev.content}`
      return `tool: ${ev.content}`
    })
  }
}

function clip(text: string, max = 50): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

async function main(): Promise<void> {
  console.log('🧩 Step 02 – 表面投影：模型看到的是视图，不是日志本身')
  console.log('='.repeat(56))

  // ========== 朴素版：手动同步"干净历史"副本 ==========
  console.log('\n① 朴素版：单独维护一份"干净历史"副本，手动同步')
  const naiveCleanHistory: { role: string; content: string }[] = []
  // 日志和副本两条线，同步全靠写代码的人记得
  const naiveLog: { type: string; content: string }[] = []
  const naiveAppend = (ev: { type: string; content: string }, visible: boolean): void => {
    naiveLog.push(ev)
    if (visible) naiveCleanHistory.push({ role: ev.type, content: ev.content }) // 手动同步副本
  }

  naiveAppend({ type: 'user/message', content: '帮我写一个 debounce 函数' }, true)
  naiveAppend({ type: 'assistant/message', content: '我先调工具检查现有代码' }, true)
  naiveAppend({ type: 'tool/call', content: '{"file":"debounce.ts"}' }, false) // 日志有，副本不加
  // 开发者忘了同步 assistant 的下一步……
  naiveAppend({ type: 'assistant/message', content: '完成，已给实现' }, false) // 💥 忘了同步！

  console.log(`   日志：${naiveLog.map(e => e.type).join(' → ')}`)
  console.log(`   副本：${naiveCleanHistory.map(m => m.role).join(' → ')}`)
  console.log('   💥 崩点：日志里有 4 条，副本只有 3 条——模型看到的是过期的历史，漂移了')

  // ========== harness 版：surface 投影 ==========
  console.log('\n② harness 版：surface 只记 seq 列表，视图每次现算')
  const session = new Session()
  session.append({ type: 'user/message', content: '帮我写一个 debounce 函数' })
  session.append({ type: 'assistant/message', content: '我先调工具检查现有代码' })
  session.append({ type: 'tool/call', name: 'check_code', arguments: '{"file":"debounce.ts"}' }) // 日志专用
  session.append({ type: 'tool/result', content: 'lint 通过，0 错误' })
  session.append({ type: 'assistant/message', content: '完成，已给实现' })

  console.log(
    `   日志共 ${session.events.length} 条，表面节点 seq = [${session.surfaceNodes.join(', ')}]`,
  )
  console.log('   tool/call 是日志专用事件 → 不上表面（模型不需要看内部调用）')
  console.log('   模型看到的视图（deriveMessages 现算）：')
  for (const line of session.deriveMessages()) console.log(`     ${clip(line, 56)}`)

  // 追加新消息 → 视图自动更新，无需手动同步
  console.log('\n③ 日志追加新消息 → 视图自动包含（不用手动同步副本）')
  session.append({ type: 'user/message', content: '再补一个 throttle 函数' })
  session.append({ type: 'assistant/message', content: '好，throttle 用时间戳实现' })
  console.log(`   追加后表面节点 seq = [${session.surfaceNodes.join(', ')}]（自动加了 seq 5、6）`)
  console.log('   最新视图：')
  for (const line of session.deriveMessages().slice(-2)) console.log(`     ${clip(line, 56)}`)

  console.log('\n🎯 一句话：投影只挑不复制、每次现算——视图永远跟得上日志，漂移不可能。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
