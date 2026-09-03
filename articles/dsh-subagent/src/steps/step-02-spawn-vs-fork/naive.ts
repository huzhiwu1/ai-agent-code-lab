/**
 * Step 02 对照组：朴素 fork = 把父日志全量复制
 *
 * 演示事故：父正在派另一个子代理（tool/call 已发出、结果未回），朴素 fork
 * 把这个"调用已发出、结果不存在"的半本账复制给 child——child 会读到一个
 * 它无法解释的鬼状态（事件不平衡）。
 */

import { Session, type SessionEvent } from './session'

/**
 * 💥 朴素版 fork：把父日志全量复制（含 in-flight turn）
 * 不区分"已完成 turn"和"正在进行的 turn"，全部塞给 child。
 */
function naiveForkSeed(parent: Session): readonly SessionEvent[] {
  return parent.events // ⚠️ 全量复制，包括 tool/call 没 tool/result 的半本账
}

/** 检查事件是否平衡：每个 turn/start 都有对应的 turn/end */
function isBalanced(events: readonly SessionEvent[]): boolean {
  let depth = 0
  for (const e of events) {
    if (e.type === 'turn/start') depth++
    if (e.type === 'turn/end') depth--
  }
  return depth === 0
}

export function naiveDemo(): void {
  console.log('── A. 对照组：朴素 fork 翻车现场 ──')

  // 造一个含 in-flight turn 的父日志
  const parent = new Session()
  parent.append({ type: 'turn/start' })
  parent.append({ type: 'user/message', content: '帮我审计登录接口。' })
  parent.append({ type: 'assistant/message', content: '好的，我派一个子代理去审计。' })
  parent.append({
    type: 'tool/call',
    name: 'subagent',
    arguments: '{"description":"审计登录接口"}',
  })
  // ⚠️ 注意：没有 tool/result，没有 turn/end——turn 2 是 in-flight

  console.log('🚫 事故：朴素 fork = 把父日志全量复制（含 in-flight turn）')
  const seed = naiveForkSeed(parent)
  console.log(`   父日志共 ${parent.events.length} 条事件`)
  console.log(`   朴素 fork seed 含 ${seed.length} 条（全量复制）`)

  // 检查平衡性
  const balanced = isBalanced(seed)
  console.log(`   事件平衡检查：${balanced ? '✅ 平衡' : '💥 不平衡！'}`)
  if (!balanced) {
    console.log('   → child 看到的日志里：tool/call 已发出，但 tool/result 不存在')
    console.log('     这是一份 child 无法解释的损坏账本——"调用去哪了？结果呢？"')
    console.log('     如果 child 试图回放这段历史，它会卡在"等待工具结果"的鬼状态。')
  }

  console.log(
    '   → harness 的做法：completedTurnPrefix 只截到最后一个 turn/end，in-flight turn 不进 seed。',
  )
}

export {}
