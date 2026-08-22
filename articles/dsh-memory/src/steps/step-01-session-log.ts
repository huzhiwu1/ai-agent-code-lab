/**
 * Step 01 – 会话事件日志：为什么"历史"是派生的，从不单独存储？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「事件日志」= 按时间顺序追加的流水账，一条一条记下来，每条不可变（类比：
 *   收银机的小票存根——谁也不能改过去那笔账，只能再开一张新的）。
 * 「派生」= 模型看到的历史不是"存出来的一份文件"，而是"每次从日志现算出来
 *   的"（类比：每天结账时把存根重新加一遍——结果总对得上，因为源头只有一份）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：直接维护一个"消息数组"当历史，聊一句 push 一句。数组里只有
 * 模型可见的消息，工具内部细节（调了哪个工具、传了什么参数）根本没有——
 * 等要回滚、修正、审计的时候，原始记录找不到了。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 事件溯源（event sourcing）：会话只有一份 append-only 的 SessionEvent 日志
 * （唯一事实源），消息历史 = 从日志重放派生（deriveMessages 是纯函数）。
 * "状态和日志分叉"在结构上不可能发生。两个契约：事件深冻结不可变；
 * seq = 入日志时的长度（连续），断号 = 日志不可信。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 调试、回放、审计全免费；修正历史 = 追加新事件，不改旧事件。
 *
 * 对应源码：packages/core/session/src/session.ts（Session.append）
 * 跑法：pnpm run memory:step:01（或 articles/dsh-memory 内 pnpm run step:01）
 */

type SessionEvent =
  | { type: 'user/message'; content: string }
  | { type: 'assistant/message'; content: string }
  | { type: 'tool/call'; name: string; arguments: string }
  | { type: 'tool/result'; content: string }

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
 * 会话 = append-only 事件日志（对应源码 session.ts Session）。
 * 注意：没有 update / delete / 插入——只提供 append。
 */
class Session {
  private log: StoredEvent[] = []

  /** 追加一个事件：seq = log.length（连续性契约） */
  append(event: SessionEvent): StoredEvent {
    const stored: StoredEvent = { seq: this.log.length, time: Date.now(), event: deepFreeze(event) }
    this.log.push(stored)
    return stored
  }

  get length(): number {
    return this.log.length
  }

  get events(): readonly StoredEvent[] {
    return this.log
  }

  /** 派生消息历史：纯函数重放，从不单独存储（对应源码 deriveMessages） */
  deriveMessages(): string[] {
    return this.log
      .filter(
        s =>
          s.event.type === 'user/message' ||
          s.event.type === 'assistant/message' ||
          s.event.type === 'tool/result',
      )
      .map(s => {
        const ev = s.event as Extract<SessionEvent, { content: string }>
        if (ev.type === 'user/message') return `user: ${ev.content}`
        if (ev.type === 'assistant/message') return `assistant: ${ev.content}`
        return `tool: ${ev.content}`
      })
  }
}

/** 校验 seq 连续：断号 = 日志不可信，拒绝重放（对应源码 seq 连续性契约） */
function assertContiguousSeq(log: readonly StoredEvent[]): void {
  log.forEach((stored, i) => {
    if (stored.seq !== i) {
      throw new Error(`seq 断档！期望 ${i}，实际 ${stored.seq}——日志不可信，拒绝重放`)
    }
  })
}

function clip(text: string, max = 40): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

async function main(): Promise<void> {
  console.log('🧾 Step 01 – 事件日志：历史是派生的，从不单独存储')
  console.log('='.repeat(56))

  // ========== 朴素版：一个可变"消息数组"当历史 ==========
  console.log('\n① 朴素版：消息数组当历史')
  const naiveHistory: { role: string; content: string }[] = []
  const naivePush = (role: string, content: string): void => {
    naiveHistory.push({ role, content })
  }
  naivePush('user', '帮我写一个 debounce 工具函数')
  naivePush('assistant', '好，我调工具检查一下现有代码')
  naivePush('tool', 'lint 通过，0 错误') // 工具结果进数组，但"调了什么工具、传了什么参数"没有
  naivePush('assistant', '完成。')

  console.log(`   数组内容：${naiveHistory.map(m => m.role).join(' → ')}`)
  console.log('   💥 崩点 1：要审计"当时工具传了什么参数"→ 数组里只有结果，参数查无实据')
  console.log('   💥 崩点 2：发现 assistant 回答有误，直接改数组 → 原始回答被覆盖，历史被篡改')

  // ========== harness 版：append-only 事件日志 ==========
  console.log('\n② harness 版：append-only 事件日志（唯一事实源）')
  const session = new Session()
  session.append({ type: 'user/message', content: '帮我写一个 debounce 工具函数' })
  session.append({ type: 'assistant/message', content: '好，我调工具检查一下现有代码' })
  session.append({ type: 'tool/call', name: 'check_code', arguments: '{"file":"debounce.ts"}' })
  session.append({ type: 'tool/result', content: 'lint 通过，0 错误' })
  session.append({ type: 'assistant/message', content: '完成。' })

  console.log('   日志（每一条都留着，包括工具调用细节）：')
  for (const stored of session.events) {
    console.log(
      `     seq=${stored.seq}  ${stored.event.type.padEnd(20)} ${clip(stored.event.type === 'tool/call' ? stored.event.arguments : stored.event.content)}`,
    )
  }

  // ✅ 审计：工具参数从日志原样可查
  const callEvent = session.events.find(s => s.event.type === 'tool/call')
  console.log(
    `   ✅ 审计：找到 tool/call，原始参数 = ${callEvent ? (callEvent.event as Extract<SessionEvent, { type: 'tool/call' }>).arguments : '?'}`,
  )

  // 模型看到的是派生视图
  console.log('   模型看到的历史（deriveMessages 派生，不单独存储）：')
  for (const line of session.deriveMessages()) console.log(`     ${clip(line, 60)}`)

  // ✅ 修正 = 追加新事件，不覆盖旧的
  session.append({ type: 'user/message', content: '补充：还需要支持取消（cancel）' })
  console.log(`   ✅ 修正需求：追加新事件（seq=${session.length - 1}），旧事件原封不动`)

  // 不可变性
  const frozen = session.events[1]
  try {
    ;(frozen.event as { content: string }).content = '被篡改！'
    console.log('   ❌ 意外：篡改没报错')
  } catch {
    console.log(`   ✅ 不可变：篡改 seq=1 被拒（Object.isFrozen=${Object.isFrozen(frozen.event)}）`)
  }

  // seq 连续校验
  assertContiguousSeq(session.events)
  console.log(`   ✅ seq 连续：0..${session.length - 1} ✓`)
  const tampered: StoredEvent[] = [
    { seq: 0, time: 1, event: { type: 'user/message', content: 'hi' } },
    { seq: 2, time: 2, event: { type: 'user/message', content: 'x' } }, // 跳过 1！
  ]
  try {
    assertContiguousSeq(tampered)
  } catch (error) {
    console.log(`   ✅ 断号检测：${(error as Error).message}`)
  }

  console.log('\n🎯 一句话：日志是真相，消息是派生——分叉在结构上不可能。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
