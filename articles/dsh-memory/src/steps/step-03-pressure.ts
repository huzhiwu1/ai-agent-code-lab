/**
 * Step 03 – 压力计算与触发：为什么"该压缩"由 token 压力决定，而不是定时触发？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「token 压力」= 当前历史折算成 token 数，占模型上下文预算的比例（类比：
 *   水杯里的水位——80% 水位就该倒掉一点，不然下一口水会溢出来）。
 * 「压缩」= 把旧历史折叠成摘要腾出空间（本步只讲"什么时候该压缩"，不讲
 *   "怎么压缩"——怎么压是 step-04）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：每 N 轮固定压缩一次。简单对话（聊两句就完）白白压缩浪费钱；
 * 复杂对话（代码 + 工具往返，一轮顶十轮）还没到 N 轮就爆了上下文窗口。
 * 定时炸弹式压缩没有依据。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 估算当前模型可见历史的 token 数（tokenMeter.measure），超过上下文窗口
 * 预算的 80%（thresholdRatio）才触发压缩。压力是真实需求，压缩是需求的结果。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 压缩时机由真实需求驱动：短对话不浪费、长对话及时救，不会"拍脑袋"。
 *
 * 对应源码：packages/compaction/basic/src/index.ts（compactIfNeeded 的压力检测）
 * 跑法：pnpm run memory:step:03（或 articles/dsh-memory 内 pnpm run step:03）
 *
 * 注：源码里还有 retainRatio（保留最近 16% 窗口逐字不压，压缩后留余量）、
 * 区域选择 selectCompactableRange（压哪一段）——step-07 全链路会用到，
 * 本步只讲"什么时候触发"。
 */

type Msg = { role: 'user' | 'assistant' | 'tool-call' | 'tool-result'; content: string }

/** 简化 token 估算：CJK 每字 1 token，其余按 4 字符 1 token */
function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** 压力策略：把比例阈值换算成具体 token 预算（对应源码 resolveCompactSpec） */
class PressurePolicy {
  constructor(
    readonly contextWindow: number,
    readonly thresholdRatio = 0.8,
  ) {}

  get thresholdTokens(): number {
    return Math.floor(this.contextWindow * this.thresholdRatio)
  }

  /** tokenMeter.measure：测当前压力（0~1+，1 表示窗口满了） */
  measure(history: readonly Msg[]): { tokens: number; pressure: number } {
    const tokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    return { tokens, pressure: tokens / this.contextWindow }
  }

  isOverThreshold(m: { pressure: number }): boolean {
    return m.pressure >= this.thresholdRatio
  }
}

/** 生成对话：mode='simple' 每轮 2 条；mode='complex' 每轮 4 条（含工具往返） */
function buildConversation(rounds: number, mode: 'simple' | 'complex'): Msg[] {
  const history: Msg[] = []
  const simple = ['好的，这个很简单，马上好。', '没问题，已实现。', '搞定，请查看。']
  const complex = [
    '好的，实现要点：先定义泛型签名，用 setTimeout 包装并返回取消函数。关键在防抖窗口内清除上次定时器，同时透传 this 与参数，最后补单元测试覆盖连续调用与取消两种场景。',
    '可以，核心是双向链表加哈希表：get 时把节点移到头部，put 时淘汰尾部最久未用项。注意容量为 1 的边界情况，以及键值相同但引用不同对象的刷新语义。',
    '没问题，事件总线需要支持 on/off/emit/once 四个方法，用 Map 存事件名到监听器数组，off 时要处理迭代中删除的安全问题。',
  ]
  for (let i = 0; i < rounds; i++) {
    history.push({
      role: 'user',
      content: `第 ${i + 1} 轮：请帮我实现「工具函数 ${i + 1}」，要求支持配置项、错误处理和单元测试，代码写成 TypeScript 并给出完整示例。`,
    })
    history.push({
      role: 'assistant',
      content: mode === 'simple' ? simple[i % simple.length] : complex[i % complex.length],
    })
    if (mode === 'complex') {
      history.push({ role: 'tool-call', content: 'check_code {"file":"src/util.ts"}' })
      history.push({
        role: 'tool-result',
        content: '检查完成：0 错误 0 警告，符合项目代码规范，可以提交',
      })
    }
  }
  return history
}

/** 取前 n 轮的消息（simple 每轮 2 条，complex 每轮 4 条） */
function upToRound(history: readonly Msg[], rounds: number, mode: 'simple' | 'complex'): Msg[] {
  const perRound = mode === 'simple' ? 2 : 4
  return history.slice(0, rounds * perRound)
}

function bar(p: number): string {
  return '█'.repeat(Math.round(p * 40)).padEnd(40, '░')
}

async function main(): Promise<void> {
  const policy = new PressurePolicy(2000)

  console.log('📊 Step 03 – 压力驱动压缩：不是定时炸弹，是按需触发')
  console.log('='.repeat(56))
  console.log(
    `   上下文窗口 = 2000，阈值 = ${policy.thresholdTokens} tokens（${policy.thresholdRatio * 100}%）`,
  )

  // ========== 朴素版：每 5 轮固定压缩 ==========
  console.log('\n① 朴素版：每 5 轮固定压缩一次')
  const FIXED_INTERVAL = 5

  // 短对话：6 轮简单问答
  const shortTalk = buildConversation(6, 'simple')
  const shortM = policy.measure(shortTalk)
  const shortAt5 = policy.measure(buildConversation(5, 'simple'))
  console.log(`   短对话（6 轮简单问答）：压力 = ${shortM.pressure.toFixed(3)}`)
  console.log(
    `   💥 崩点：第 ${FIXED_INTERVAL} 轮定时器到了 → 强制压缩——可压力才 ${shortAt5.pressure.toFixed(2)}，白白总结花钱！`,
  )

  // 长对话：15 轮复杂问答（含工具往返）
  const longTalk = buildConversation(15, 'complex')
  let overAt = -1
  for (let i = 1; i <= 15; i++) {
    const m = policy.measure(upToRound(longTalk, i, 'complex'))
    if (overAt < 0 && m.pressure >= 0.8) overAt = i
  }
  const longM = policy.measure(longTalk)
  const naiveCompactRounds = Array.from({ length: 15 }, (_, i) => i + 1).filter(
    r => r % FIXED_INTERVAL === 0,
  )
  const nextCompact = naiveCompactRounds.find(r => r > overAt) ?? '?'
  console.log(`   长对话（15 轮复杂问答）：压力实际在轮 ${overAt} 就超过 0.8`)
  console.log(
    `   朴素版压缩点：${naiveCompactRounds.join('、')} 轮——轮 ${nextCompact} 才压（晚了 ${(nextCompact as number) - overAt} 轮，此时压力已到 ${longM.pressure.toFixed(2)}，窗口已爆）`,
  )
  console.log('   💥 崩点：超阈值后还要干等定时器——窗口可能已经爆了')

  // ========== harness 版：压力触发 ==========
  console.log('\n② harness 版：每轮测压力，超过 80% 立即触发')

  const shortM2 = policy.measure(buildConversation(6, 'simple'))
  console.log(`   短对话：压力 ${shortM2.pressure.toFixed(3)} < 0.8 → ✅ 不触发（不浪费）`)

  const longM2 = policy.measure(buildConversation(12, 'complex'))
  console.log(`   长对话：压力 ${longM2.pressure.toFixed(3)} ≥ 0.8 → ✅ 立即触发压缩`)

  // 逐轮展示压力爬升
  console.log('\n   逐轮压力（harness 版在超阈值那一轮就触发）：')
  const complexTalk = buildConversation(15, 'complex')
  for (const n of [2, 4, 6, 8, 10, 12, 13, 15]) {
    const m = policy.measure(upToRound(complexTalk, n, 'complex'))
    const flag = m.pressure >= 0.8 ? '  ⚠️ 超阈值' : ''
    console.log(
      `     轮 ${String(n).padStart(2)}  tokens=${String(m.tokens).padStart(4)}  pressure=${m.pressure.toFixed(3)}  ${bar(m.pressure)}${flag}`,
    )
  }

  console.log('\n🎯 一句话：pressure ≥ 80% 才动手——短对话不浪费、长对话不迟到。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
