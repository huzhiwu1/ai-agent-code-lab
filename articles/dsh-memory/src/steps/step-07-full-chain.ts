/**
 * Step 07 – 全链路：一场长对话的"记忆一生"
 *
 * 学习目标：把 Step 01-06 串成完整演示——模拟一场 22 轮的开发对话，
 * 四层机制协同工作：
 *
 *   L1 事件日志：每轮交互 append-only 追加，历史永远派生、永不单独存储；
 *   L3 压力触发：每轮后测量 token 压力，超过 0.8 触发压缩信号；
 *   L3 区域选择：尾保留（0.16 逐字）+ 工具配对平衡（tool/call 不拆）；
 *   L3 八段式总结：规则总结 + 收敛校验（总结必须比影子内容小）；
 *   L3 KV cache 复用：压缩辅助调用 = 对话请求前缀扩展，指令放最后一条
 *      user 消息，只付指令增量；
 *   L2 表面 replace：checkpoint 作为 user/message 上表面（sourceEventSeqs
 *      全引用，可审计）；
 *   L4 write-behind：所有事件异步 200ms 窗口合并落盘，结尾 flush 静止屏障。
 *
 * 对应源码：packages/core/session/ + packages/compaction/* + packages/session/*
 *
 * 跑法：pnpm run step:07
 */

// ================= L1 / L2：append-only 日志 + 表面投影 =================

type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }

type SurfaceEvent =
  | { type: 'user/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'assistant/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'tool/result'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }

/** 日志专用事件：禁止携带 surfaceOp（文章 2.2 节） */
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

/** 完整日志投影用消息角色 */
type MsgRole = 'user' | 'assistant' | 'tool-call' | 'tool-result'
interface Msg {
  role: MsgRole
  content: string
}

/** 会话：append-only 日志 + 增量表面（Step 01/02 的组合） */
class Session {
  private log: StoredEvent[] = []
  private nodes: number[] = []
  private generation = 0

  /** append：校验表面契约（坏事件源头拦截）→ 入日志 → 增量应用表面 */
  append(event: SessionEvent): StoredEvent {
    const stored: StoredEvent = { seq: this.log.length, time: Date.now(), event: deepFreeze(event) }
    if (isSurfaceEvent(event)) {
      if (typeof event.surfaceOp === 'object') {
        const { start, end } = event.surfaceOp
        if (start < 0 || end >= this.nodes.length || start > end) {
          throw new Error(
            `replace 端点 [${start}, ${end}] 不在当前表面（共 ${this.nodes.length} 个节点）`,
          )
        }
        const shadowed = this.nodes.slice(start, end + 1)
        if (
          event.sourceEventSeqs.length !== shadowed.length ||
          event.sourceEventSeqs.some((seq, i) => seq !== shadowed[i])
        ) {
          throw new Error(
            `replace 必须点名全部被影子节点：期望 [${shadowed.join(', ')}]，实际 [${event.sourceEventSeqs.join(', ')}]`,
          )
        }
        this.nodes.splice(start, end - start + 1, stored.seq)
        this.generation++
      } else {
        this.nodes.push(stored.seq)
      }
    }
    this.log.push(stored)
    return stored
  }

  get length(): number {
    return this.log.length
  }

  get events(): readonly StoredEvent[] {
    return this.log
  }

  get surfaceNodesList(): readonly number[] {
    return this.nodes
  }

  get replaceGeneration(): number {
    return this.generation
  }

  /**
   * 完整日志投影（教学对照用）：含 tool/call，下标 = seq。
   * 注意：真实实现的压力测量 / 区域选择都基于**表面投影**（模型可见内容），
   * 影子掉的历史不占压力——否则压缩就失去意义了。
   */
  allMessages(): Msg[] {
    return this.log.map(s => {
      const ev = s.event
      if (ev.type === 'user/message') return { role: 'user', content: ev.content }
      if (ev.type === 'assistant/message') return { role: 'assistant', content: ev.content }
      if (ev.type === 'tool/call')
        return { role: 'tool-call', content: `${ev.name} ${ev.arguments}` }
      return { role: 'tool-result', content: ev.content }
    })
  }

  /** 表面投影（模型可见 / KV cache 前缀 / 压力测量用，文章 2.5 节） */
  surfaceMessages(): { seq: number; role: 'user' | 'assistant' | 'tool'; content: string }[] {
    return this.nodes.map(seq => {
      const ev = this.log[seq].event as SurfaceEvent
      if (ev.type === 'user/message') return { seq, role: 'user', content: ev.content }
      if (ev.type === 'assistant/message') return { seq, role: 'assistant', content: ev.content }
      return { seq, role: 'tool', content: ev.content }
    })
  }

  /** 沿表面投影模型可见历史（字符串版，用于最终打印） */
  deriveMessages(): string[] {
    return this.surfaceMessages().map(m => `${m.role}: ${m.content}`)
  }
}

// ================= L3：压力 / 区域 / 总结 / KV cache =================

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

/** 压力策略（文章 3.4 节：thresholdRatio 0.8 / retainRatio 0.16） */
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

  /** tokenMeter.measure(session)：测当前压力（输入是模型可见内容，即表面投影） */
  measure(history: readonly { content: string }[]): { tokens: number; pressure: number } {
    const tokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    return { tokens, pressure: tokens / this.contextWindow }
  }

  isOverThreshold(m: { pressure: number }): boolean {
    return m.pressure >= this.thresholdRatio
  }
}

/** 日志前缀 [0, count) 内工具是否配对平衡（tool/call 与 tool/result 成对闭合） */
function toolPairingBalancedBefore(log: readonly StoredEvent[], count: number): boolean {
  let balance = 0
  for (let i = 0; i < count; i++) {
    const t = log[i].event.type
    if (t === 'tool/call') balance++
    else if (t === 'tool/result') balance--
    if (balance < 0) return false
  }
  return balance === 0
}

/**
 * 区域选择（文章 3.5 节）：在**表面**上选区域——压力是模型可见内容，
 * 影子掉的历史不参与。尾→头累积到保留预算，再回溯到工具配对平衡边界
 * （检查对应日志前缀，不能拆开 tool/call 与 tool/result）。返回表面坐标。
 */
function selectCompactableRange(
  surface: readonly { seq: number; role: string; content: string }[],
  log: readonly StoredEvent[],
  retainTokens: number,
): { end: number; retainedFrom: number } {
  // 1) 尾→头累积 token 直到保留预算（逐字保留区）
  let tokens = 0
  let retainedFrom = surface.length
  while (retainedFrom > 0 && tokens < retainTokens) {
    retainedFrom--
    tokens += estimateTokens(surface[retainedFrom].content)
  }
  // 2) 从保留起点往前回溯到工具配对平衡的边界
  let end = retainedFrom - 1
  while (end > 0 && !toolPairingBalancedBefore(log, surface[end].seq + 1)) end--
  if (end < 0) end = 0
  return { end, retainedFrom }
}

/** 八段结构（文章 3.6 节） */
const SECTION_NAMES = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code',
  'Errors and Fixes',
  'Pending Jobs',
  'Current Work',
  'Next Step',
  'Critical Context',
] as const

type SectionName = (typeof SECTION_NAMES)[number]
type Checkpoint = Record<SectionName, string>

/** 压缩指令（作为最后一条 user 消息拼接，文章 3.7 节） */
const COMPACTION_INSTRUCTION = `Summarize the conversation history above into a structured checkpoint with these sections: Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context. Preserve exact file paths, commands, error strings and identifiers. Do not mention that this is a summarization request.`

/** 按句号/换行切句，筛出含任一关键词的句子（教学简化规则） */
function sentencesContaining(text: string, keywords: readonly string[]): string[] {
  return text
    .split(/[。\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && keywords.some(k => s.includes(k)))
}

function firstOrNone(items: readonly string[], max = 2, maxLen = 140): string {
  const joined = items.slice(0, max).join('；')
  return joined.length > 0
    ? joined.length > maxLen
      ? joined.slice(0, maxLen) + '…'
      : joined
    : '(none)'
}

/** 规则式总结器：不调 LLM，演示"结构固定 + 信息结构化保留" */
class RuleBasedSummarizer {
  summarize(msgs: readonly { role: string; content: string }[]): Checkpoint {
    const joined = msgs.map(x => x.content).join('\n')
    const users = msgs.filter(x => x.role === 'user')
    const assistants = msgs.filter(x => x.role === 'assistant')
    return {
      'Primary Request and Intent': users[0]?.content ?? '(none)',
      'Key Technical Concepts': firstOrNone(
        sentencesContaining(joined, ['方案', '机制', '状态机', '优化', '解析']),
      ),
      'Files and Code': firstOrNone(joined.match(/[\w./-]+\.(ts|tsx|js|json|md)/g) ?? []),
      'Errors and Fixes': firstOrNone(
        sentencesContaining(joined, ['问题', '错误', '失败', '修复', '根因']),
      ),
      'Pending Jobs': firstOrNone(
        sentencesContaining(joined, ['需要', '还要', '待办', '下一步', '重点']),
      ),
      'Current Work': users[users.length - 1]?.content ?? '(none)',
      'Next Step': assistants[assistants.length - 1]?.content ?? '(none)',
      'Critical Context': firstOrNone(
        sentencesContaining(joined, ['不要', '必须', '严格', '规范']),
      ),
    }
  }
}

/** 落地格式：preamble + <compacted-summary> 块（文章 3.6 节 frameSummary） */
function frameSummary(checkpoint: Checkpoint): string {
  const body = SECTION_NAMES.map(name => `## ${name}\n${checkpoint[name]}`).join('\n\n')
  return [
    'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it.',
    '',
    '<compacted-summary>',
    body,
    '</compacted-summary>',
  ].join('\n')
}

/** 收敛不变量（文章 3.12 节）：总结必须比影子内容小 */
function assertConverges(framedSummary: string, shadowedTokenCount: number): number {
  const framedTokens = estimateTokens(framedSummary)
  if (framedTokens >= shadowedTokenCount) {
    throw new Error(
      `summary is not smaller：总结 ${framedTokens} tokens ≥ 影子内容 ${shadowedTokenCount} tokens`,
    )
  }
  return framedTokens
}

/** 模拟 provider 的 prefix KV cache（同 Step 05） */
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function prefixMatchTokens(prev: readonly Message[], next: readonly Message[]): number {
  let matched = 0
  for (let i = 0; i < Math.min(prev.length, next.length); i++) {
    if (prev[i].content !== next[i].content) break
    matched += estimateTokens(next[i].content)
  }
  return matched
}

class MockProvider {
  private lastRequest: readonly Message[] = []

  call(request: readonly Message[]): { total: number; cached: number; billed: number } {
    const total = request.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    const cached = prefixMatchTokens(this.lastRequest, request)
    this.lastRequest = request
    return { total, cached, billed: total - cached }
  }
}

// ================= L4：write-behind 持久化 =================

/** 后端抽象（真实实现：JSONL(zstd) / SQLite 双后端） */
interface WriteBackend {
  appendBatch(events: readonly StoredEvent[]): Promise<void>
  readonly persisted: readonly StoredEvent[]
}

/** 内存后端：可注入失败 */
class MemoryBackend implements WriteBackend {
  persisted: StoredEvent[] = []
  failNext = 0

  async appendBatch(events: readonly StoredEvent[]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--
      throw new Error('模拟磁盘 I/O 错误')
    }
    this.persisted.push(...events)
  }
}

/** 200ms 固定窗口 coalescing + 失败保留 + flush 静止屏障（文章 4.2 节） */
class SessionWriteBehind {
  private queue: StoredEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> | null = null
  stats = { appended: 0, writes: 0, failedWrites: 0 }

  constructor(
    private readonly backend: WriteBackend,
    private readonly windowMs = 200,
  ) {}

  enqueue(event: StoredEvent): void {
    this.queue.push(event)
    this.stats.appended++
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.drain()
      }, this.windowMs)
    }
  }

  /** 静止屏障：取消等待，等活动写，再排空期间到达的事件 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.writing) await this.writing
    await this.drain()
    if (this.queue.length > 0) {
      throw new Error(`flush 失败：仍有 ${this.queue.length} 个事件未落盘`)
    }
  }

  private drain(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve()
    if (this.writing) return this.writing
    const run = this.doDrain().finally(() => {
      this.writing = null
    })
    this.writing = run
    return run
  }

  private async doDrain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length)
      this.stats.writes++
      try {
        await this.backend.appendBatch(batch)
      } catch {
        this.stats.failedWrites++
        this.queue.unshift(...batch)
        break
      }
    }
  }
}

// ================= 编排：会自我压缩的会话 =================

const SYSTEM_PROMPT =
  'You are a helpful coding agent. You have access to tools and should use them when useful.'

/** 把四层机制装进一个会话：每轮对话后做 pre-step 压力检查（文章 3.3 节） */
class CompactingSession {
  readonly session = new Session()
  readonly policy = new PressurePolicy(2500)
  readonly backend = new MemoryBackend()
  readonly writeBehind = new SessionWriteBehind(this.backend, 200)
  readonly provider = new MockProvider()
  readonly summarizer = new RuleBasedSummarizer()

  /** KV cache 计费统计 */
  readonly billing = { dialogue: 0, compact: 0, cached: 0 }
  compactionCount = 0
  /** 每个 checkpoint 的 sourceEventSeqs（演示"压掉什么永远有据可查"） */
  readonly checkpointSources: number[][] = []

  /** 追加事件：L1 入日志（同步）+ L4 异步缓冲落盘（append 永不阻塞 I/O） */
  private append(event: SessionEvent): void {
    const stored = this.session.append(event)
    this.writeBehind.enqueue(stored)
  }

  /** 一轮交互：user → assistant →（可选）工具调用，之后检查压力 */
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

  /** pre-step 压力检查：超阈值 → 选区域 → KV cache 前缀扩展总结 → 表面 replace */
  private async maybeCompact(): Promise<void> {
    // 压力 = 模型可见内容（表面投影），影子掉的历史不占压力
    const surface = this.session.surfaceMessages()
    const m = this.policy.measure(surface)
    if (!this.policy.isOverThreshold(m)) return

    console.log(`   ⚡ 压力 ${m.pressure.toFixed(3)} ≥ 0.8 → 触发压缩 #${this.compactionCount + 1}`)

    // ① 区域选择：表面上的尾保留 + 工具配对平衡（检查对应日志前缀）
    const range = selectCompactableRange(surface, this.session.events, this.policy.retainTokens)
    const shadowedMsgs = surface.slice(0, range.end + 1)
    const shadowedTokens = shadowedMsgs.reduce((sum, x) => sum + estimateTokens(x.content), 0)
    console.log(
      `      区域：压缩表面 [0, ${range.end}]（${shadowedMsgs.length} 节点，${shadowedTokens} tokens），逐字保留自表面 ${range.retainedFrom}`,
    )

    // ② KV cache 复用：压缩请求 = 对话请求前缀 + 指令放最后一条 user 消息
    const dialogueReq = this.buildDialogueRequest()
    const compactReq: Message[] = [
      ...dialogueReq,
      { role: 'user', content: COMPACTION_INSTRUCTION },
    ]
    const d = this.provider.call(dialogueReq)
    const c = this.provider.call(compactReq)
    this.billing.dialogue += d.billed
    this.billing.compact += c.billed
    this.billing.cached += c.cached
    console.log(
      `      KV cache：压缩请求付费 ${c.billed} tokens，命中前缀缓存 ${c.cached} tokens（只付指令增量）`,
    )

    // ③ 八段式总结 + 收敛校验
    const checkpoint = this.summarizer.summarize(shadowedMsgs)
    const framed = frameSummary(checkpoint)
    const framedTokens = assertConverges(framed, shadowedTokens)
    console.log(`      收敛：checkpoint ${framedTokens} tokens < 影子 ${shadowedTokens} tokens ✓`)

    // ④ 表面 replace：checkpoint 作为 user/message 上表面（带 sourceEventSeqs）
    const shadowedSurfaceSeqs = shadowedMsgs.map(x => x.seq)
    this.append({
      type: 'user/message',
      content: framed,
      surfaceOp: { op: 'replace', start: 0, end: range.end },
      sourceEventSeqs: shadowedSurfaceSeqs,
    })
    this.checkpointSources.push(shadowedSurfaceSeqs)
    this.compactionCount++

    // ⑤ 压缩后重新测量：回到安全区（约 0.16 余量），不会刚压完又触发
    const after = this.policy.measure(this.session.surfaceMessages())
    console.log(
      `      压缩后压力 ${after.pressure.toFixed(3)} < 0.8 ✓（保留区逐字 + checkpoint，余量 ${this.policy.retainRatio * 100}%）`,
    )
  }

  /** 对话请求：同一个 system + 表面派生历史（压缩请求逐字复现它） */
  private buildDialogueRequest(): Message[] {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.session
        .surfaceMessages()
        .map(m =>
          m.role === 'tool'
            ? { role: 'user' as const, content: `[tool result] ${m.content}` }
            : { role: m.role, content: m.content },
        ),
    ]
  }
}

// ================= 演示 =================

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function bar(pressure: number): string {
  return '█'.repeat(Math.round(pressure * 30)).padEnd(30, '░')
}

function clip(text: string, max = 84): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 一场"开发 markdown 转换器"的长对话剧本（轮询 4 组，{n} 是轮次号） */
const QUESTIONS = [
  '第 {n} 轮：帮我设计一个 markdown 转 HTML 的转换器，要支持代码块、表格、链接和有序/无序列表，输出要严格符合 HTML5 规范，核心文件放在 src/parser.ts，先给出整体架构设计。',
  '第 {n} 轮：代码块解析有问题：嵌套的 ``` 会提前结束，导致后面的内容被吞掉，需要改成按行扫描而不是正则匹配，错误信息要给出行号，并补充对应的回归测试。',
  '第 {n} 轮：表格支持不够：需要合并单元格（colspan/rowspan），还要处理转义字符和表头对齐，测试文件是 test/table.test.ts，请先把现有失败用例跑通。',
  '第 {n} 轮：性能太差：3000 行文档解析要 5 秒，需要优化到 1 秒以内，不要用第三方库，重点优化 tokenizer 和块解析两处热点。',
]

const ANSWERS = [
  '好的，架构方案：先做 tokenizer 按行分块，再做 AST 节点树，最后渲染器输出 HTML。核心文件 src/parser.ts，用栈处理嵌套块，错误处理统一走 ParserError，每个阶段单独测试，单元测试放在 test/parser.test.ts。',
  '明白，问题根因是正则无法处理嵌套边界。改为逐行扫描：维护 codeFence 状态机，遇到 ``` 时切换状态，嵌套内容按原始行保留，并在错误时携带行号，修复方案已同步到注释，回归测试覆盖三层嵌套场景。',
  '收到，表格解析改为两遍：第一遍切分行与单元格，第二遍处理合并标记（|> 表示 colspan，^ 表示 rowspan），转义字符在切分时先保护再还原，表头对齐用宽度计算补齐，覆盖 test/table.test.ts 全部用例。',
  '可以，优化点：tokenizer 用单遍扫描替代多次 split，块解析用数组指针而非 splice，渲染用字符串拼接替代模板嵌套，另外给大文件加缓存标志位，预计 3000 行降到 0.8 秒，指标写进 README 并做基准测试。',
]

async function main(): Promise<void> {
  const agent = new CompactingSession()
  const win = agent.policy.contextWindow

  console.log('🎬 Step 07：全链路——一场 22 轮开发对话的"记忆一生"')
  console.log('========================================')
  console.log(
    `   contextWindow=${win}（阈值 ${Math.round(agent.policy.thresholdRatio * 100)}% = ${agent.policy.thresholdTokens}，保留 ${Math.round(agent.policy.retainRatio * 100)}% = ${agent.policy.retainTokens}）`,
  )

  // 模拟长对话：事件持续追加 → 压力到 0.8 自动压缩 → write-behind 异步落盘
  for (let i = 0; i < 22; i++) {
    const tool =
      i % 3 === 2
        ? {
            name: 'run_tests',
            args: '{"file":"src/parser.ts"}',
            result: '3 passed, 1 failed: table row merge',
          }
        : undefined
    await agent.turn(
      QUESTIONS[i % QUESTIONS.length].replace('{n}', String(i + 1)),
      ANSWERS[i % ANSWERS.length],
      tool,
    )

    const m = agent.policy.measure(agent.session.surfaceMessages())
    console.log(
      `   轮 ${String(i + 1).padStart(2)}  tokens=${String(m.tokens).padStart(4)}  pressure=${m.pressure.toFixed(3)}  ${bar(m.pressure)}`,
    )
    await sleep(60) // 给 write-behind 一点时间自然窗口落盘
  }

  // 生命周期 teardown：flush 静止屏障（不等定时器）
  await agent.writeBehind.flush()

  // ============ 最终状态 ============
  const s = agent.session
  console.log('\n' + '='.repeat(50))
  console.log('📦 最终状态')
  console.log('='.repeat(50))
  console.log(`L1 事件日志：${s.length} 条（append-only，不可变，可重放）`)
  console.log(
    `L2 表面投影：${s.surfaceNodesList.length} 个节点（模型可见），replaceGeneration=${s.replaceGeneration}`,
  )
  console.log(`L3 压缩 checkpoint：${agent.compactionCount} 个（每次总结都比影子内容小）`)
  console.log(
    `L3 KV cache：对话请求付费 ${agent.billing.dialogue}，压缩请求付费 ${agent.billing.compact}（其中命中缓存 ${agent.billing.cached}）`,
  )
  console.log(
    `L4 write-behind：追加 ${agent.writeBehind.stats.appended} 事件 → ${agent.writeBehind.stats.writes} 次写（${((agent.writeBehind.stats.writes / agent.writeBehind.stats.appended) * 100).toFixed(1)}%），落盘 ${agent.backend.persisted.length} 条，失败 ${agent.writeBehind.stats.failedWrites} 次，0 丢失`,
  )

  console.log('\n可审计（你压掉了什么，日志里永远有据可查）：')
  agent.checkpointSources.forEach((seqs, i) => {
    console.log(`   checkpoint #${i + 1} 影子掉 ${seqs.length} 个表面节点：seq=[${seqs.join(',')}]`)
  })

  console.log('\n最终投影视图（模型看到的历史，checkpoint 取代了旧对话）：')
  for (const line of s.deriveMessages()) console.log(`   ${clip(line)}`)

  console.log(
    '\n全链路走完：日志是真相，表面是视图，压力触发压缩，checkpoint 结构化保留，KV cache 复用省钱，write-behind 批量落盘。',
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
