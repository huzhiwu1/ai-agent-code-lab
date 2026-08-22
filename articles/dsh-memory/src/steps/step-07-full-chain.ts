/**
 * Step 07 – 全链路：一场长对话的"记忆一生"——四层如何协作？
 *
 * ── 先懂六个词（前六步回顾，一句话各带过）─────────────────
 * 「事件日志」= 全部真相的流水账，append-only（step-01）；
 * 「surface 投影」= 从日志里挑出模型该看的事件，现算现给（step-02）；
 * 「token 压力」= 模型可见历史占上下文预算的比例，超阈值才压缩（step-03）；
 * 「checkpoint」= 结构化存档点，replace + sourceEventSeqs 审计（step-04）；
 * 「KV cache」= 请求开头前缀复用，总结指令放最后一条 user 消息（step-05）；
 * 「write-behind」= 先记内存立即返回，后台批量落盘（step-06）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 前六步单独看都能懂，但真实会话里它们是接力的：用户发了 15 轮消息、模型
 * 回了 15 条、中间调了工具、压力超 80%……哪层先动？哪层后动？没有整体视角，
 * 永远不知道"全貌"。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 一层一层接力：L1 日志 append → L2 表面投影 → L3 压力超阈值 → 区域选择 →
 * KV cache 复用的总结 → 表面 replace（带审计）→ L4 write-behind 异步落盘。
 * 每轮对话都走完这条管道，接近真实 Harness 的 pre-step 检查。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 朴素版"消息数组 + 超预算截断"走到结尾只剩最近几条、最早需求全丢；
 * harness 四层接力走到结尾：日志全在、表面有 checkpoint、磁盘 0 丢失。
 *
 * 对应源码：packages/core/session/ + packages/compaction/* + packages/session/*
 * 跑法：pnpm run memory:step:07
 */

// ================= L1 / L2：append-only 日志 + surface 投影 =================

type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }
type SurfaceEvent =
  | { type: 'user/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'assistant/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'tool/result'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
// 日志专用事件（step-02）：只进日志、不进表面
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

class Session {
  private log: StoredEvent[] = []
  private nodes: number[] = []
  private generation = 0

  append(event: SessionEvent): StoredEvent {
    const stored: StoredEvent = { seq: this.log.length, time: Date.now(), event: deepFreeze(event) }
    if (isSurfaceEvent(event)) {
      if (typeof event.surfaceOp === 'object') {
        // replace（step-04）：用新事件替换视图里一段旧事件，必须声明换掉了谁
        const { start, end } = event.surfaceOp
        if (start < 0 || end >= this.nodes.length || start > end)
          throw new Error(`replace 端点越界`)
        const shadowed = this.nodes.slice(start, end + 1)
        // sourceEventSeqs 审计：点名被影子节点，少报/对不上都拒绝
        if (
          event.sourceEventSeqs.length !== shadowed.length ||
          event.sourceEventSeqs.some((seq, i) => seq !== shadowed[i])
        )
          throw new Error(`replace sourceEventSeqs 不匹配`)
        this.nodes.splice(start, end - start + 1, stored.seq)
        this.generation++
      } else {
        this.nodes.push(stored.seq)
      }
    }
    this.log.push(stored)
    return stored
  }

  get events(): readonly StoredEvent[] {
    return this.log
  }
  get surfaceNodes(): readonly number[] {
    return this.nodes
  }
  get replaceGeneration(): number {
    return this.generation
  }

  surfaceMessages(): { seq: number; role: 'user' | 'assistant' | 'tool'; content: string }[] {
    return this.nodes.map(seq => {
      const ev = this.log[seq].event as SurfaceEvent
      if (ev.type === 'user/message') return { seq, role: 'user', content: ev.content }
      if (ev.type === 'assistant/message') return { seq, role: 'assistant', content: ev.content }
      return { seq, role: 'tool', content: ev.content }
    })
  }
}

// ================= L3：压力 / 区域 / 总结 / KV cache =================

function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

class PressurePolicy {
  constructor(
    readonly contextWindow: number,
    readonly thresholdRatio = 0.8,
    readonly retainRatio = 0.16,
  ) {}
  get thresholdTokens(): number {
    return Math.floor(this.contextWindow * this.thresholdRatio)
  }
  get retainTokens(): number {
    return Math.floor(this.contextWindow * this.retainRatio)
  }
  measure(history: readonly { content: string }[]): { tokens: number; pressure: number } {
    return { tokens: history.reduce((s, m) => s + estimateTokens(m.content), 0), pressure: 0 }
  }
  isOverThreshold(m: { pressure: number }): boolean {
    return m.pressure >= this.thresholdRatio
  }
}

/** 区域选择（step-03 提到的压缩点之一）：保留尾部最新 retainTokens，前面全折叠 */
function selectCompactableRange(
  surface: readonly { seq: number; content: string }[],
  retainTokens: number,
): { end: number; retainedFrom: number } {
  let tokens = 0
  let retainedFrom = surface.length
  while (retainedFrom > 0 && tokens < retainTokens) {
    retainedFrom--
    tokens += estimateTokens(surface[retainedFrom].content)
  }
  return { end: Math.max(retainedFrom - 1, 0), retainedFrom }
}

const DEMO_SECTIONS = ['Primary Request and Intent', 'Current Work', 'Next Step'] as const

class RuleBasedSummarizer {
  summarize(msgs: readonly { role: string; content: string }[]): Record<string, string> {
    const users = msgs.filter(x => x.role === 'user')
    const assistants = msgs.filter(x => x.role === 'assistant')
    return {
      'Primary Request and Intent': (users[0]?.content ?? '(none)').slice(0, 120),
      'Current Work': (users[users.length - 1]?.content ?? '(none)').slice(0, 80),
      'Next Step': (assistants[assistants.length - 1]?.content ?? '(none)').slice(0, 80),
    }
  }
}

function frameSummary(checkpoint: Record<string, string>): string {
  return [
    'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it.',
    '',
    '<compacted-summary>',
    DEMO_SECTIONS.map(n => `## ${n}\n${checkpoint[n]}`).join('\n\n'),
    '</compacted-summary>',
  ].join('\n')
}

// 收敛不变量（step-04）：总结必须比被替换的影子内容更小，否则白压
function assertConverges(framedSummary: string, shadowedTokenCount: number): number {
  const framedTokens = estimateTokens(framedSummary)
  if (framedTokens >= shadowedTokenCount)
    throw new Error(`summary is not smaller：${framedTokens} ≥ ${shadowedTokenCount}`)
  return framedTokens
}

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 模拟 provider 的 prefix KV cache（step-05）：记住所有历史请求，取最长前缀命中 */
class MockProvider {
  private seen: Message[][] = []

  call(request: readonly Message[]): { total: number; cached: number; billed: number } {
    const total = request.reduce((s, m) => s + estimateTokens(m.content), 0)
    let cached = 0
    for (const prev of this.seen) {
      let hit = 0
      for (let i = 0; i < Math.min(prev.length, request.length); i++) {
        if (prev[i].content !== request[i].content) break
        hit += estimateTokens(request[i].content)
      }
      if (hit > cached) cached = hit
    }
    this.seen.push([...request])
    return { total, cached, billed: total - cached }
  }
}

// ================= L4：write-behind 持久化（step-06） =================

class MemoryBackend {
  persisted: StoredEvent[] = []
  async appendBatch(events: readonly StoredEvent[]): Promise<void> {
    this.persisted.push(...events)
  }
}

class SessionWriteBehind {
  private queue: StoredEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> | null = null
  stats = { appended: 0, writes: 0 }

  constructor(
    private readonly backend: MemoryBackend,
    private readonly windowMs = 200,
  ) {}

  enqueue(event: StoredEvent): void {
    this.queue.push(event)
    this.stats.appended++
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        void this.drain()
      }, this.windowMs)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.writing) await this.writing
    await this.drain()
    if (this.queue.length > 0) throw new Error(`flush 失败：${this.queue.length} 事件未落盘`)
  }

  private drain(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve()
    if (this.writing) return this.writing
    const r = this.doDrain().finally(() => {
      this.writing = null
    })
    this.writing = r
    return r
  }

  private async doDrain(): Promise<void> {
    while (this.queue.length > 0) {
      const b = this.queue.splice(0, this.queue.length)
      this.stats.writes++
      await this.backend.appendBatch(b)
    }
  }
}

// ================= 朴素版：消息数组 + 超预算截断 =================

/** 朴素版"记忆"：一个消息数组，超过预算就截断丢开头——最早的需求最先丢 */
class NaiveSession {
  messages: { role: string; content: string }[] = []
  truncated = 0
  readonly budgetTokens = 900

  append(role: string, content: string): void {
    this.messages.push({ role, content })
    const tokens = this.messages.reduce((s, m) => s + estimateTokens(m.content), 0)
    if (tokens > this.budgetTokens) {
      const dropped = this.messages.splice(0, Math.ceil(this.messages.length / 2))
      this.truncated++
      console.log(
        `   💥 截断 #${this.truncated}：丢 ${dropped.length} 条（含 "${dropped[0].content.slice(0, 18)}…"）`,
      )
    }
  }
}

// ================= harness 版：四层编排 =================

const SYSTEM_PROMPT = 'You are a helpful coding agent.'
const COMPACTION_INSTRUCTION =
  'Summarize the conversation history above into a structured checkpoint with sections: Primary Request and Intent / Current Work / Next Step. Preserve exact file paths, error strings. Do not mention that this is a summarization request.'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

class CompactingSession {
  session = new Session()
  policy = new PressurePolicy(1000)
  backend = new MemoryBackend()
  writeBehind = new SessionWriteBehind(this.backend, 200)
  provider = new MockProvider()
  summarizer = new RuleBasedSummarizer()
  billing = { dialogue: 0, compact: 0, cached: 0 }
  compactionCount = 0

  private append(event: SessionEvent): void {
    this.writeBehind.enqueue(this.session.append(event))
  }

  async turn(
    question: string,
    answer: string,
    tool?: { name: string; args: string; result: string },
  ): Promise<void> {
    this.append({
      type: 'user/message',
      content: question,
      surfaceOp: 'append',
      sourceEventSeqs: [],
    })
    this.append({
      type: 'assistant/message',
      content: answer,
      surfaceOp: 'append',
      sourceEventSeqs: [],
    })
    if (tool) {
      // 工具调用细节只进 L1 日志（日志专用事件），不进 L2 表面
      this.append({ type: 'tool/call', name: tool.name, arguments: tool.args })
      this.append({
        type: 'tool/result',
        content: tool.result,
        surfaceOp: 'append',
        sourceEventSeqs: [],
      })
    }
    await this.maybeCompact()
  }

  private async maybeCompact(): Promise<void> {
    const surface = this.session.surfaceMessages()
    const m = this.policy.measure(surface)
    m.pressure = m.tokens / this.policy.contextWindow
    if (!this.policy.isOverThreshold(m)) return

    console.log(`   ⚡ L3 压缩 #${this.compactionCount + 1}：压力 ${m.pressure.toFixed(3)} ≥ 0.8`)

    const range = selectCompactableRange(surface, this.policy.retainTokens)
    const shadowedMsgs = surface.slice(0, range.end + 1)
    const shadowedTokens = shadowedMsgs.reduce((s, x) => s + estimateTokens(x.content), 0)
    console.log(
      `     区域：表面 [0, ${range.end}]（${shadowedMsgs.length} 节点，${shadowedTokens} tokens）`,
    )

    // KV cache 复用（step-05）：总结指令放最后一条 user 消息 = 对话请求的前缀扩展
    const dialogueReq: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.session
        .surfaceMessages()
        .map(m => ({ role: m.role === 'tool' ? ('user' as const) : m.role, content: m.content })),
    ]
    const compactReq: Message[] = [
      ...dialogueReq,
      { role: 'user', content: COMPACTION_INSTRUCTION },
    ]
    this.billing.dialogue += this.provider.call(dialogueReq).billed
    const c = this.provider.call(compactReq)
    this.billing.compact += c.billed
    this.billing.cached += c.cached
    console.log(`     KV cache：压缩付费 ${c.billed} tokens，命中缓存 ${c.cached}`)

    // 总结 + 收敛（step-04）
    const checkpoint = this.summarizer.summarize(shadowedMsgs)
    const framed = frameSummary(checkpoint)
    const tokens = assertConverges(framed, shadowedTokens)
    console.log(`     收敛：checkpoint ${tokens} tokens < 影子 ${shadowedTokens}`)

    // 表面 replace（step-04）：带 sourceEventSeqs 审计
    this.append({
      type: 'user/message',
      content: framed,
      surfaceOp: { op: 'replace', start: 0, end: range.end },
      sourceEventSeqs: shadowedMsgs.map(x => x.seq),
    })
    this.compactionCount++

    const after = this.policy.measure(this.session.surfaceMessages())
    after.pressure = after.tokens / this.policy.contextWindow
    console.log(`     压缩后压力 ${after.pressure.toFixed(3)} < 0.8 ✓`)
  }
}

function bar(p: number): string {
  return '█'.repeat(Math.round(p * 30)).padEnd(30, '░')
}

const QUESTIONS = [
  '第 {n} 轮：帮我设计一个 markdown 转 HTML 的转换器，要支持代码块、表格、链接和有序/无序列表，输出符合 HTML5 规范，核心文件放在 src/parser.ts，先给出整体架构设计。',
  '第 {n} 轮：代码块解析有问题：嵌套的 ``` 会提前结束导致后面被吞，需要改成按行扫描而不是正则匹配，错误信息要给出行号，并补充回归测试。',
  '第 {n} 轮：表格支持不够：需要合并单元格（colspan/rowspan），还要处理转义字符和表头对齐，测试文件在 test/table.test.ts，请先把现有失败用例跑通。',
  '第 {n} 轮：性能太差：3000 行文档解析要 5 秒，需要优化到 1 秒以内，不用第三方库，重点优化 tokenizer 和块解析两处热点。',
]
const ANSWERS = [
  '好，架构方案：先做 tokenizer 按行分块，再做 AST 节点树，最后渲染器输出 HTML。核心文件 src/parser.ts，用栈处理嵌套块，错误处理统一走 ParserError，每个阶段单独测试覆盖。',
  '明白，问题根因是正则无法处理嵌套边界。改为逐行扫描：维护 codeFence 状态机，遇到 ``` 时切换状态，嵌套内容按原始行保留，出错时携带行号信息，回归测试覆盖三层嵌套场景。',
  '收到，两遍解析：第一遍切分行与单元格，第二遍处理合并标记（|> 表示 colspan，^ 表示 rowspan），转义字符先保护再还原，表头对齐用宽度补齐。',
  '可以，优化点：tokenizer 用单遍扫描替代多次 split，块解析用数组指针替代 splice，渲染用字符串拼接替代模板嵌套，大文件加缓存标志位，预计降到 0.8 秒。',
]

async function main(): Promise<void> {
  console.log('🎬 Step 07 – 全链路：一场对话的"记忆一生"')
  console.log('='.repeat(56))

  // ========== 朴素版：消息数组 + 超预算截断 ==========
  console.log('\n① 朴素版"记忆"：一个消息数组，超预算就截断丢开头')
  const naive = new NaiveSession()
  for (let i = 0; i < 15; i++) {
    naive.append('user', QUESTIONS[i % QUESTIONS.length].replace('{n}', String(i + 1)))
    naive.append('assistant', ANSWERS[i % ANSWERS.length])
  }
  const naiveTokens = naive.messages.reduce((s, m) => s + estimateTokens(m.content), 0)
  console.log(
    `   对话结束：${naive.messages.length} 条消息（${naiveTokens} tokens），共截断 ${naive.truncated} 次`,
  )
  console.log(`   最早剩的是："${naive.messages[0].content.slice(0, 20)}…"`)
  console.log('   💥 崩点：最初的需求 + 中间的修正全丢了，工具调用从未记录，审计查无实据')

  // ========== harness 版：四层接力 ==========
  console.log('\n② harness 版：四层接力（L1 append → L2 surface → L3 压缩 → L4 落盘）')
  const agent = new CompactingSession()
  console.log(
    `   contextWindow=1000, 阈值=${agent.policy.thresholdTokens}, 保留=${agent.policy.retainTokens}`,
  )

  for (let i = 0; i < 15; i++) {
    const tool =
      i % 3 === 1
        ? { name: 'run_tests', args: '{"file":"parser.ts"}', result: '3 passed, 1 failed' }
        : undefined
    console.log(`\n--- 轮 ${i + 1} ---`)
    await agent.turn(
      QUESTIONS[i % QUESTIONS.length].replace('{n}', String(i + 1)),
      ANSWERS[i % ANSWERS.length],
      tool,
    )
    const m = agent.policy.measure(agent.session.surfaceMessages())
    m.pressure = m.tokens / agent.policy.contextWindow
    console.log(
      `   L3 压力：tokens=${String(m.tokens).padStart(4)}  pressure=${m.pressure.toFixed(3)}  ${bar(m.pressure)}${m.pressure >= 0.8 ? '  ⚠️' : ''}`,
    )
    await sleep(80)
  }

  await agent.writeBehind.flush()

  // ========== 结尾对比 ==========
  console.log('\n' + '='.repeat(50))
  console.log('📊 结尾对比：朴素版 vs harness 版各剩什么')
  console.log('='.repeat(50))
  console.log(`   朴素版：${naive.messages.length} 条原始消息（最早需求已丢）｜无工具记录｜无审计`)
  console.log(
    `   harness：L1 日志 ${agent.session.events.length} 条全在（含工具调用）｜L2 表面 ${agent.session.surfaceNodes.length} 节点（含 ${agent.compactionCount} 个 checkpoint）｜L4 落盘 ${agent.backend.persisted.length} 条 0 丢失`,
  )
  console.log(
    `   L3 账单：对话 ${agent.billing.dialogue} + 压缩 ${agent.billing.compact}（命中 ${agent.billing.cached}）`,
  )

  console.log(
    '\n🎯 一句话：日志是真相 → 表面是视图 → 压力驱动压缩 → checkpoint 结构化保留 → write-behind 落盘。',
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
