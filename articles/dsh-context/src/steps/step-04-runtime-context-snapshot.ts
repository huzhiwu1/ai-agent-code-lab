/**
 * Step 04 – 动态上下文快照投影：为什么"变了才说"能省 token？
 *
 * 学习目标：时间、tmux 位置、工作区状态这些动态上下文如果每轮都原样塞进历史，
 * 每轮多花几百 token 还稀释注意力。解法是快照投影（RuntimeContextProjection）：
 * 渲染当前快照，与上次保留的比对——内容没变就不注入；变了才作为 user 消息注入；
 * 从"有"变"无"也要注入显式 CLEARED 作废标记（告诉模型"之前的快照不再适用"）；
 * 首次无快照 + 当前为空 → 什么都不发（第一轮别发废话）。快照被 compaction
 * 压缩掉（影子掉 seq）后 retained 置 null，下次装配自动补发一份——"表面可见性"
 * 驱动的自我修复。本文件核心逻辑完整复刻源码，只简化了会话层。
 *
 * 对应源码：packages/core/agent-loop/src/runtime-context.ts 全文（76 行）
 *           packages/core/system-prompt/src/index.ts:236-240（joinContextSections）
 *
 * 跑法：pnpm run step:04（articles/dsh-context 目录内）或根目录 pnpm run context:step:04
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
  id: string
  seq: number
  content: string
  /** kind/form 双维度追溯：kind 回答"谁产生的"，form 回答"这是什么形状" */
  source: { kind: 'plugin'; plugin: string; form?: 'snapshot'; sections?: ContextSnapshotSection[] }
}

/** 会话事件（简化：只保留投影关心的事件类型） */
type SessionEvent =
  | { type: 'user/message'; seq: number; data: UserMessage }
  | { type: 'replace-surface'; sourceEventSeqs: number[] }

/**
 * 简化会话：消息 append + 事件监听（对应源码 Session + ctx.on('session/event')）。
 * RuntimeContextProjection 不拥有提交权——它只读会话事件，维护 retained。
 */
class Session {
  events: SessionEvent[] = []
  /** 当前可见表面节点（对应源码 session.surface.nodes；compaction 会把节点从这里摘掉） */
  surfaceNodes: number[] = []
  private listeners: ((event: SessionEvent) => void)[] = []
  private seqCounter = 0

  /** 追加一条 user 消息并通知投影（对应源码 session.append('user/message')） */
  appendUser(message: Omit<UserMessage, 'id' | 'seq'>): UserMessage {
    const stored: UserMessage = { ...message, id: `m${this.seqCounter}`, seq: this.seqCounter }
    this.seqCounter += 1
    this.events.push({ type: 'user/message', seq: stored.seq, data: stored })
    this.surfaceNodes.push(stored.seq)
    for (const listener of this.listeners)
      listener({ type: 'user/message', seq: stored.seq, data: stored })
    return stored
  }

  /** 压缩替换事件：把旧快照从表面摘掉（对应源码 isReplacementSurfaceEvent 的场景） */
  replaceSurface(sourceEventSeqs: number[]): void {
    this.events.push({ type: 'replace-surface', sourceEventSeqs })
    this.surfaceNodes = this.surfaceNodes.filter(seq => !sourceEventSeqs.includes(seq))
    for (const listener of this.listeners) listener({ type: 'replace-surface', sourceEventSeqs })
  }

  onEvent(listener: (event: SessionEvent) => void): void {
    this.listeners.push(listener)
  }
}

/**
 * 快照投影（对应源码 RuntimeContextProjection，runtime-context.ts:25-76）。
 * retained 三态：undefined = 从未有过快照；null = 曾有过但已不可见；对象 = 当前保留的快照。
 */
class RuntimeContextProjection {
  private retained: { seq: number; text: string | undefined } | null | undefined

  constructor(session: Session) {
    // 恢复投影状态：从事件日志倒着找最近一条"自己拥有"的 user 消息
    // （source.kind === 'plugin' && plugin === SOURCE），且它还在表面可见
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event?.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (session.surfaceNodes.includes(event.seq)) {
        this.retained = { seq: event.seq, text: event.data.content }
        break
      }
    }
    // 跟随会话事件：新快照进入 → 更新 retained；压缩影子掉 retained.seq → 置 null
    session.onEvent(event => {
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: event.data.content }
      } else if (
        this.retained !== undefined &&
        this.retained !== null &&
        event.type === 'replace-surface' &&
        event.sourceEventSeqs.includes(this.retained.seq)
      ) {
        this.retained = null
      }
    })
  }

  /**
   * 只在内容变化时产出候选消息（runtime-context.ts:64-75）：
   * - 从未有快照 + 当前为空 → 不注入（第一轮别发"runtime context: none"）；
   * - 当前为空 → 快照文本换成 CLEARED 显式作废标记；
   * - 与 retained 相同 → 不注入；
   * - 否则 → 注入，带 sections 元数据。
   */
  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return {
      id: `projected-${Date.now()}`,
      seq: -1, // 未提交；真实实现由 session.append 分配
      content: snapshot,
      source:
        sections.length === 0
          ? { kind: 'plugin', plugin: SOURCE }
          : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections: [...sections] },
    }
  }
}

/** 判断消息是否属于本投影的拥有者（runtime-context.ts:15-17） */
function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

/** 渲染上下文段列表（对应源码 renderContextSections，system-prompt/index.ts:251-255） */
function renderContextSections(
  contexts: { name: string; text: string }[],
): ContextSnapshotSection[] {
  return contexts
    .map(context => ({ name: context.name, text: context.text }))
    .filter(section => section.text.length > 0)
}

/**
 * 快照的模型-facing 文本（对应源码 joinContextSections，index.ts:236-240）。
 * "supersedes earlier snapshots" 是给模型的显式指令——避免它把新快照当补充信息
 * 叠加在旧快照上理解。
 */
function joinContextSections(sections: readonly ContextSnapshotSection[]): string {
  const body = sections.map(section => section.text).join('\n\n')
  if (body.length === 0) return ''
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

/** 打印辅助：消息的简短描述 */
function describeMessage(message: UserMessage | undefined): string {
  if (message === undefined) return '（不注入）'
  return message.source.form === 'snapshot'
    ? `[snapshot: ${message.source.sections!.map(section => section.name).join(', ')}]`
    : '[cleared]'
}

async function main(): Promise<void> {
  const session = new Session()
  const projection = new RuntimeContextProjection(session)

  console.log('📸 Step 04：动态上下文快照投影——"变了才说"，不变就闭嘴')
  console.log('-----------------------------------------------------')

  // 模拟三个上下文贡献方：时间 / tmux 位置 / 会话引用计数
  const contexts = {
    time: (t: string) => ({ name: 'time-context', text: `Time: ${t}` }),
    tmux: (pane: string) => ({ name: 'tmux-context', text: `Location: pane ${pane}` }),
    refs: (n: number) => ({ name: 'session-reference', text: `Referenced sessions: ${n}` }),
  }

  // ① 首次无快照 + 当前为空 → 不注入（第一轮别发"runtime context: none"废话）
  console.log('① 首轮：无快照且上下文为空 → 不注入：')
  const none = projection.project('', [])
  console.log(`   project('', []) → ${describeMessage(none)}`)

  // ② 内容变了 → 注入新快照（sections 元数据追溯每个贡献方）
  console.log('\n② 第二轮：时间从 00:00 变到 00:05 → 注入新快照：')
  const sections1 = renderContextSections([contexts.time('00:05'), contexts.tmux('0')])
  const shot1 = projection.project(joinContextSections(sections1), sections1)
  console.log(`   project(...) → ${describeMessage(shot1)}`)
  if (shot1 !== undefined) {
    session.appendUser(shot1) // 提交进会话
    console.log(`   注入文本（首行）："${shot1.content.split('\n')[0]}"`)
    console.log(
      `   sections 元数据：${shot1.source.sections!.map(section => `${section.name}=${JSON.stringify(section.text)}`).join(' | ')}`,
    )
  }

  // ③ 内容没变 → 不注入（省 token 的核心）
  console.log('\n③ 第三轮：内容没变（还是 00:05 / pane 0）→ 不注入：')
  const shot2 = projection.project(joinContextSections(sections1), sections1)
  console.log(`   project(...) → ${describeMessage(shot2)}（快照去重，省下几百 token）`)

  // ④ 内容变了 → 注入
  console.log('\n④ 第四轮：时间变到 00:30 → 注入新快照：')
  const sections2 = renderContextSections([contexts.time('00:30'), contexts.tmux('0')])
  const shot3 = projection.project(joinContextSections(sections2), sections2)
  console.log(`   project(...) → ${describeMessage(shot3)}`)
  if (shot3 !== undefined) session.appendUser(shot3)

  // ⑤ 从有到无 → 注入 CLEARED 显式作废标记
  console.log('\n⑤ 第五轮：上下文全部清空 → 注入 CLEARED 作废标记（不是静默跳过）：')
  const shot4 = projection.project('', [])
  console.log(`   project('', []) → ${describeMessage(shot4)}`)
  if (shot4 !== undefined) {
    session.appendUser(shot4)
    console.log(`   全文：${JSON.stringify(shot4.content)}`)
    console.log('   注释：上下文从"有"变"无"也是变化——模型必须知道旧快照作废，否则还在用过期情报。')
  }

  // ⑥ compaction 交互：快照被压缩影子掉 → retained 置 null → 自动补发
  console.log('\n⑥ 压缩交互：快照被 compaction 影子掉（seq 出表面）→ 下次装配自动补发：')
  const shadowedSeqs = session.surfaceNodes.filter(seq => {
    const event = session.events.find(e => e.type === 'user/message' && e.seq === seq)!
    return event.type === 'user/message' && isOwned(event.data)
  })
  console.log(`   压缩 replace 事件影子掉 seq=${shadowedSeqs.join(', ')}（模型看不见旧快照了）`)
  session.replaceSurface(shadowedSeqs)
  const sections3 = renderContextSections([contexts.time('00:45'), contexts.tmux('0')])
  const refilled = projection.project(joinContextSections(sections3), sections3)
  console.log(
    `   project(...) → ${describeMessage(refilled)}（retained 已置 null，当前有内容 → 重新注入）`,
  )
  if (refilled !== undefined) {
    session.appendUser(refilled)
    console.log('   ✅ 模型看不见旧快照了，就补一份新的——"表面可见性"驱动的自我修复')
  }

  // ⑦ 补发后再去重：同一内容不重复注入
  console.log('\n⑦ 补发后：同一内容再次装配 → 不注入（retained 已更新为新快照）：')
  const dedup = projection.project(joinContextSections(sections3), sections3)
  console.log(`   project(...) → ${describeMessage(dedup)}`)

  console.log(
    '\n小结：快照投影 = 渲染当前上下文 → 与 retained 比对 → 变了才注入；从有到无发 CLEARED 作废标记；' +
      '快照被压缩掉后 retained=null 自动补发。每一条都在回答"模型现在看到的，是不是最新的"。',
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
