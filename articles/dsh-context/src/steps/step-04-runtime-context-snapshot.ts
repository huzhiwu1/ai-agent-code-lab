/**
 * Step 04 – 为什么"变了才说"能省 token？（快照投影）
 *
 * ── 先懂三个词 ──────────────────────────────────────────────
 * 「动态上下文」= 每轮都可能变的实时情报（当前时间、位置、工作区状态）。
 * 「快照」= 某一时刻这些情报的完整拷贝（类比：拍照——拍下来的是按下快门
 *   那一刻的画面）。
 * 「投影」= 把快照和上次的比对，变了才产出消息（类比：只有画面变了才发照片，
 *   画面没变就不打扰）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：每轮都把"当前时间 + 位置 + 状态"原样塞进历史 → 每轮多花几百
 * token，模型注意力被噪声稀释；或者完全不塞 → 模型不知道"现在是几点"，
 * 时间从 00:00 到 00:05，模型还在用 00:00 的情报。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * RuntimeContextProjection 维护"上次保留的快照"（retained），装配时渲染当前
 * 快照与之比对：内容没变 → 什么都不注入；变了 → 注入新快照。从"有"变"无"
 * 也要注入显式 CLEARED 作废标记——告诉模型"之前的快照不再适用"，否则模型
 * 还在用过期情报。快照被压缩掉后 retained 置 null，下次装配自动补发——
 * "表面可见性"驱动的自我修复。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 模型永远看到最新快照，且不为不变的内容付费。
 *
 * 对应源码：packages/core/agent-loop/src/runtime-context.ts 全文（76 行，
 *   核心逻辑完整复刻；压缩交互对应 isReplacementSurfaceEvent）
 * 跑法：pnpm run context:step:04（或 articles/dsh-context 内 pnpm run step:04）
 */

/** 快照的显式作废标记：上下文从"有"变"无"也是变化，必须告诉模型（runtime-context.ts:13） */
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/** 快照生产者标识（runtime-context.ts:12） */
const SOURCE = '@deepseek-ai/dsh-system-prompt'

/** 一个动态上下文贡献方（对应源码 ContextSnapshotSection） */
interface ContextSnapshotSection {
  name: string
  text: string
}

/** 投影产出的 user 消息（简化：只保留投影需要的字段） */
interface UserMessage {
  content: string
  source: { kind: 'plugin'; plugin: string; form?: 'snapshot'; sections?: ContextSnapshotSection[] }
}

/**
 * 快照投影（对应源码 RuntimeContextProjection，runtime-context.ts:25-76）。
 * retained 三态：undefined = 从未有过快照；null = 曾有过但已不可见（被压缩掉）；
 * 对象 = 当前保留的快照。
 */
class RuntimeContextProjection {
  private retained: { text: string | undefined } | null | undefined

  constructor() {
    // 简化：从"会话日志恢复投影状态"一步省略，从空状态开始（真实实现在
    // 构造器里倒着扫会话日志找最近一条自己拥有的消息，runtime-context.ts:35-44）
    this.retained = undefined
  }

  /**
   * 只在内容变化时产出候选消息（runtime-context.ts:64-75）：
   * - 从未有快照 + 当前为空 → 不注入（第一轮别发"runtime context: none"废话）；
   * - 当前为空 → 快照文本换成 CLEARED 显式作废标记；
   * - 与 retained 相同 → 不注入；
   * - 否则 → 注入，带 sections 元数据。
   */
  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return {
      content: snapshot,
      source:
        sections.length === 0
          ? { kind: 'plugin', plugin: SOURCE }
          : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections: [...sections] },
    }
  }

  /** 快照被提交进会话后调用：更新 retained（对应源码 session/event 监听，runtime-context.ts:46-55） */
  commit(message: UserMessage): void {
    this.retained = { text: message.content }
  }

  /** 压缩 replace 事件把快照影子掉时调用：retained 置 null（runtime-context.ts:50-54） */
  onCompacted(): void {
    this.retained = null
  }
}

/** 渲染上下文段列表 + 拼接快照正文（对应源码 renderContextSections + joinContextSections） */
function joinContextSections(sections: readonly ContextSnapshotSection[]): string {
  const body = sections.map(section => section.text).join('\n\n')
  if (body.length === 0) return ''
  // "supersedes earlier snapshots" 是给模型的显式指令——避免它把新快照当补充叠加在旧快照上
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

/** 估算 token 数（教学简化）：CJK 一字一 token，其他约 4 字符一 token */
function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** 打印辅助：消息的简短描述 */
function describeMessage(message: UserMessage | undefined): string {
  if (message === undefined) return '不注入'
  return message.source.form === 'snapshot'
    ? `注入 [snapshot: ${message.source.sections!.map(section => section.name).join(', ')}]`
    : '注入 [CLEARED 作废标记]'
}

function main(): void {
  console.log('📸 Step 04 – 快照投影："变了才说"，不变就闭嘴')
  console.log('='.repeat(56))

  // ========== 朴素版：每轮全量塞 ==========
  console.log('\n① 朴素版：每轮把时间/位置原样塞进历史')
  const timeText = 'Time: 2026-08-22 00:05:00 GMT+08:00. Location: /home/u/proj, tmux pane 0.'
  const turns = 30
  const naiveTokens = estimateTokens(timeText) * turns
  console.log(`   每轮塞 ${estimateTokens(timeText)} tokens 的实时情报 × ${turns} 轮对话`)
  console.log(
    `   💥 崩点：${naiveTokens} tokens 全烧在重复内容上（30 轮里 29 轮一字不差）——注意力被噪声稀释`,
  )

  console.log('\n② 朴素版反面：完全不塞 → 模型用过期情报')
  console.log('   时间从 00:00 到 00:05，模型还在用 00:00 的情报（"现在是 00:00"）')
  console.log('   💥 崩点：模型按过期时间决策——"5 分钟了，该任务早就该完成了"')

  // ========== harness 版：快照投影 ==========
  console.log('\n③ harness 版：RuntimeContextProjection——变了才注入')
  const projection = new RuntimeContextProjection()
  const time = (t: string) => ({ name: 'time-context', text: `Time: ${t}` })
  const tmux = (pane: string) => ({ name: 'tmux-context', text: `Location: pane ${pane}` })

  // 第 1 轮：从未有快照 + 当前为空 → 不注入（第一轮别发"runtime context: none"废话）
  const first = projection.project('', [])
  console.log(`   第 1 轮 project('', []) → ${describeMessage(first)}（首轮无上下文，不发废话）`)

  // 第 2 轮：时间变了 → 注入新快照（带 sections 元数据，每个贡献方可追溯）
  const sections1 = [time('00:05'), tmux('0')]
  const shot1 = projection.project(joinContextSections(sections1), sections1)
  console.log(`   第 2 轮 时间 00:00→00:05 → ${describeMessage(shot1)}`)
  if (shot1 !== undefined) {
    projection.commit(shot1)
    console.log(`   注入文本首行："${shot1.content.split('\n')[0]}"`)
    console.log(
      `   sections 元数据：${shot1.source.sections!.map(s => s.name).join(', ')}（每个部分归属到产生它的子系统）`,
    )
  }

  // 第 3 轮：内容没变 → 不注入（省 token 的核心）
  const shot2 = projection.project(joinContextSections(sections1), sections1)
  console.log(
    `   第 3 轮 内容没变（还是 00:05 / pane 0）→ ${describeMessage(shot2)}（省下 ${estimateTokens(joinContextSections(sections1))} tokens）`,
  )

  // 第 4 轮：内容变了 → 注入
  const sections2 = [time('00:30'), tmux('0')]
  const shot3 = projection.project(joinContextSections(sections2), sections2)
  console.log(`   第 4 轮 时间变到 00:30 → ${describeMessage(shot3)}`)
  if (shot3 !== undefined) projection.commit(shot3)

  // 第 5 轮：从有到无 → 注入 CLEARED 作废标记（不是静默跳过）
  const shot4 = projection.project('', [])
  console.log(`   第 5 轮 上下文全部清空 → ${describeMessage(shot4)}`)
  if (shot4 !== undefined) {
    projection.commit(shot4)
    console.log(`   全文：${JSON.stringify(shot4.content)}`)
    console.log('   注释：上下文从"有"变"无"也是变化——模型必须知道旧快照作废，否则还在用过期情报')
  }

  // 第 6 轮：压缩把快照影子掉 → retained 置 null → 下次装配自动补发
  console.log('\n④ 压缩交互：快照被 compaction 影子掉 → 下次装配自动补发')
  projection.onCompacted() // 对应源码：replace-surface 事件命中 retained.seq → retained=null
  console.log('   压缩把旧快照从模型可见历史里摘掉了（retained → null）')
  const sections3 = [time('00:45'), tmux('0')]
  const refilled = projection.project(joinContextSections(sections3), sections3)
  console.log(
    `   下次装配 → ${describeMessage(refilled)}（当前有内容但 retained 为 null → 重新注入）`,
  )
  if (refilled !== undefined) {
    projection.commit(refilled)
    console.log('   ✅ 模型看不见旧快照了，就补一份新的——"表面可见性"驱动的自我修复')
  }
  const dedup = projection.project(joinContextSections(sections3), sections3)
  console.log(`   补发后同一内容再装配 → ${describeMessage(dedup)}（retained 已更新，去重）`)

  console.log(
    '\n🎯 一句话：快照投影 = 渲染当前快照 → 与 retained 比对 → 变了才注入；从有到无发 CLEARED；被压缩掉自动补发。',
  )
}

main()

export {}
