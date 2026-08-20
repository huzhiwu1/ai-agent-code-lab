/**
 * Step 04 – 八段式 checkpoint：压缩不是"丢进垃圾桶"，而是结构化保留
 *
 * 学习目标：LLM 总结被约束成固定八段结构（Primary Request and Intent /
 * Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs /
 * Current Work / Next Step / Critical Context）。好处：后续模型"知道去哪里
 * 找什么"，比自由文本总结可恢复性强得多。两个硬约束（文章 3.6 / 3.12 节）：
 *
 *   1. 收敛：总结必须比它影子掉的内容小（framedSummaryTokenCount <
 *      shadowedTokenCount，否则报 "summary is not smaller"），不能无限压；
 *   2. 落地格式 = preamble + <compacted-summary> 块，checkpoint 骑在
 *      user/message 上上表面（source=compactCheckpointSource，文章 3.9 节）——
 *      识别 checkpoint 靠 source 标记，而不是内容嗅探。
 *
 * 本步不调真实 LLM：用规则式"总结器"从事件流提取八段（教学简化，规则简单，
 * 提取不到就写 "(none)"，结构本身才是重点）。
 *
 * 对应源码：packages/compaction/basic/src/summarizer.ts（COMPACTION_INSTRUCTION）
 *           packages/compaction/basic/src/index.ts（compactRegion → frameSummary）
 *
 * 跑法：pnpm run step:04
 */

// ---------- 复用 Step 02：append-only 日志 + 表面投影（浓缩版） ----------

type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }

type SurfaceEvent =
  | { type: 'user/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'assistant/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'tool/result'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }

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

class Session {
  private log: StoredEvent[] = []
  private surfaceNodes: number[] = []
  private generation = 0

  append(event: SessionEvent): StoredEvent {
    const stored: StoredEvent = { seq: this.log.length, time: Date.now(), event: deepFreeze(event) }
    if (isSurfaceEvent(event)) {
      if (typeof event.surfaceOp === 'object') {
        const { start, end } = event.surfaceOp
        if (start < 0 || end >= this.surfaceNodes.length || start > end) {
          throw new Error(
            `replace 端点 [${start}, ${end}] 不在当前表面（共 ${this.surfaceNodes.length} 个节点）`,
          )
        }
        const shadowed = this.surfaceNodes.slice(start, end + 1)
        if (
          event.sourceEventSeqs.length !== shadowed.length ||
          event.sourceEventSeqs.some((seq, i) => seq !== shadowed[i])
        ) {
          throw new Error(
            `replace 必须点名全部被影子节点：期望 [${shadowed.join(', ')}]，实际 [${event.sourceEventSeqs.join(', ')}]`,
          )
        }
        this.surfaceNodes.splice(start, end - start + 1, stored.seq)
        this.generation++
      } else {
        this.surfaceNodes.push(stored.seq)
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
    return this.surfaceNodes
  }

  get replaceGeneration(): number {
    return this.generation
  }

  /** 沿表面投影模型可见历史（checkpoint 会以 user 角色出现在这里） */
  deriveMessages(): string[] {
    return this.surfaceNodes.map(seq => {
      const ev = this.log[seq].event as SurfaceEvent
      if (ev.type === 'user/message') return `user: ${ev.content}`
      if (ev.type === 'assistant/message') return `assistant: ${ev.content}`
      return `tool: ${ev.content}`
    })
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') Object.freeze(value)
  return value
}

/** 简化 token 估算（同 Step 03） */
function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

// ---------- 本步核心：八段式 checkpoint ----------

/** 八段结构（文章 3.6 节，实际是八段） */
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

/** 类型守卫：从日志条目里筛出 user / assistant 消息（窄化 content 字段） */
type UserMessageEvent = Extract<SessionEvent, { type: 'user/message' }>
type AssistantMessageEvent = Extract<SessionEvent, { type: 'assistant/message' }>

function isUserMessage(s: StoredEvent): s is StoredEvent & { event: UserMessageEvent } {
  return s.event.type === 'user/message'
}

function isAssistantMessage(s: StoredEvent): s is StoredEvent & { event: AssistantMessageEvent } {
  return s.event.type === 'assistant/message'
}

/** 按句号/换行切句，筛出包含任一关键词的句子（教学用简单规则） */
function sentencesContaining(text: string, keywords: readonly string[]): string[] {
  return text
    .split(/[。\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && keywords.some(k => s.includes(k)))
}

/**
 * 规则式总结器（教学简化，不调 LLM）：从事件流提取八段信息。
 * 真实实现是 COMPACTION_INSTRUCTION 引导 LLM 输出同样的结构——本步只演示
 * "结构固定 + 信息结构化保留"这件事。
 */
class RuleBasedSummarizer {
  summarize(events: readonly StoredEvent[]): Checkpoint {
    const userMessages = events.filter(isUserMessage)
    const assistantMessages = events.filter(isAssistantMessage)
    const joined = events
      .map(s => {
        const ev = s.event
        if (ev.type === 'tool/call') return `[tool call] ${ev.name} ${ev.arguments}`
        return isSurfaceEvent(ev) ? ev.content : ''
      })
      .filter(Boolean)
      .join('\n')

    return {
      'Primary Request and Intent': userMessages[0]?.event.content ?? '(none)',
      'Key Technical Concepts': firstOrNone(
        sentencesContaining(joined, ['方案', '设计', '机制', '模式', '策略']),
      ),
      'Files and Code': firstOrNone(joined.match(/[\w./-]+\.(ts|tsx|js|json|md|py)/g) ?? []),
      'Errors and Fixes': firstOrNone(
        sentencesContaining(joined, ['错误', '失败', 'Error', '修复']),
      ),
      'Pending Jobs': firstOrNone(
        sentencesContaining(joined, ['待办', '还差', '还没', '接下来', '需要补']),
      ),
      'Current Work': userMessages[userMessages.length - 1]?.event.content ?? '(none)',
      'Next Step': assistantMessages[assistantMessages.length - 1]?.event.content ?? '(none)',
      'Critical Context': firstOrNone(
        sentencesContaining(joined, ['不要', '必须', '偏好', '约定', '风格']),
      ),
    }
  }
}

function firstOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.slice(0, 3).join('；') : '(none)'
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

/** 收敛不变量（文章 3.12 节）：总结必须比影子掉的内容小 */
function assertConverges(framedSummary: string, shadowedTokenCount: number): number {
  const framedTokens = estimateTokens(framedSummary)
  if (framedTokens >= shadowedTokenCount) {
    throw new Error(
      `summary is not smaller：总结 ${framedTokens} tokens ≥ 影子内容 ${shadowedTokenCount} tokens`,
    )
  }
  return framedTokens
}

async function main(): Promise<void> {
  const session = new Session()

  console.log('🗂️  第 3 层（压缩引擎）：八段式结构化 checkpoint')
  console.log('----------------------------------------')

  // 构造一段特征丰富的开发对话：需求 / 方案 / 文件 / 错误 / 待办 / 偏好
  session.append({ type: 'turn/start', turn: 1 })
  session.append({
    type: 'user/message',
    content:
      '帮我开发一个 todo CLI 工具，用 Node.js + TypeScript，输出支持 JSON 格式，不要用任何第三方框架',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content:
      '好的。技术方案：用 Node.js 内置 fs 模块做持久化，命令解析用参数模式设计，核心文件 src/cli.ts，测试用 node:test。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({ type: 'tool/call', name: 'check_code', arguments: '{"file":"src/cli.ts"}' })
  session.append({
    type: 'tool/result',
    content:
      '检查发现 1 个错误：Cannot read properties of undefined (reading length)，位置 src/cli.ts 第 12 行，原因是 split 前未判空',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content: '已修复：给输入参数加默认值 []，并补充判空处理，代码风格遵循项目约定，检查通过。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'user/message',
    content: '很好。待办：还差单元测试（test/cli.test.ts），以及 --json 输出的文档没写。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content: '收到。下一步我先补单元测试覆盖增删改查四个命令，再更新 README 说明 --json 用法。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  // 再追加几轮，让"影子内容"远大于总结（真实压缩压的是一大段历史）
  session.append({
    type: 'user/message',
    content: '另外把列表命令的输出格式改成表格样式，方便阅读，颜色用 ANSI 转义序列实现。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content:
      '好的，列表输出改为终端表格：名称与状态两列对齐，完成用绿色、进行中用黄色标记，保持 --json 选项不受影响。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({ type: 'tool/call', name: 'check_code', arguments: '{"file":"src/render.ts"}' })
  session.append({
    type: 'tool/result',
    content: '检查通过：0 错误 0 警告，ANSI 转义已按 tty 检测做降级处理',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'user/message',
    content:
      '不错。最后记得补全 package.json 的 npm scripts（build/test），README 增加 --json 的示例。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content:
      '收到，我会补全 scripts（build: tsc，test: node --test），README 增加 --json 示例与表格输出说明。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  // 再加三轮：批量删除与发布（影子区域更接近真实场景的"一大段历史"）
  session.append({
    type: 'user/message',
    content: '还有，删除命令要支持批量删除多个 id，逗号分隔，删除前先打印将要删除的条数。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content:
      '好的，delete 命令支持 --ids 参数逗号分隔多个 id，删除前确认总数，输出删除结果统计，空列表与不存在 id 的边界已处理。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'tool/call',
    name: 'check_code',
    arguments: '{"file":"src/commands/delete.ts"}',
  })
  session.append({
    type: 'tool/result',
    content: '检查通过：批量删除逻辑覆盖空列表与不存在 id 两种边界，无警告',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'user/message',
    content: '发布前把版本号升到 1.0.0，写 changelog，README 补批量删除的用法。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content:
      '收到，版本号升 1.0.0，CHANGELOG 记录新增表格输出与批量删除两个特性，README 补充 --ids 用法示例。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })

  console.log('① 原始事件（20 条，将整个影子掉）：')
  for (const stored of session.events) {
    console.log(
      `   seq=${stored.seq}  ${stored.event.type.padEnd(20)} ${clip(describe(stored), 44)}`,
    )
  }

  // 总结：规则式提取八段
  console.log('\n② 总结为八段式 checkpoint：')
  const summarizer = new RuleBasedSummarizer()
  const checkpoint = summarizer.summarize(session.events)
  for (const name of SECTION_NAMES) {
    console.log(`   ## ${name}`)
    console.log(`      ${checkpoint[name].slice(0, 80)}`)
  }

  // 收敛校验 + 落地格式
  const eventText = (ev: SessionEvent): string =>
    ev.type === 'tool/call'
      ? `[tool call] ${ev.name} ${ev.arguments}`
      : isSurfaceEvent(ev)
        ? ev.content
        : ''
  const shadowedTokens = session.events.reduce(
    (sum, s) => sum + estimateTokens(eventText(s.event)),
    0,
  )
  const framed = frameSummary(checkpoint)
  const framedTokens = assertConverges(framed, shadowedTokens)
  console.log(
    `\n③ 收敛约束：总结 ${framedTokens} tokens < 影子内容 ${shadowedTokens} tokens ✓（framedSummaryTokenCount < shadowedTokenCount）`,
  )
  console.log(`   落地格式（前 3 行）：`)
  for (const line of framed.split('\n').slice(0, 3)) console.log(`   ${line}`)
  console.log('   …<compacted-summary> 块内含八段…')

  // 表面替换：checkpoint 骑在 user/message 上（source=compactCheckpointSource）
  console.log('\n④ 表面 replace：整个历史影子掉，checkpoint 作为 user/message 上表面')
  const shadowedSeqs = session.surfaceNodesList.slice()
  const cp: SurfaceEvent = {
    type: 'user/message',
    content: framed,
    surfaceOp: { op: 'replace', start: 0, end: shadowedSeqs.length - 1 },
    sourceEventSeqs: shadowedSeqs,
  }
  session.append(cp)
  console.log(
    `   replaceGeneration = ${session.replaceGeneration}，表面节点 = [${session.surfaceNodesList.join(', ')}]`,
  )
  console.log('   模型现在看到的视图（checkpoint 代替了整段历史）：')
  console.log(`   user: ${clip(framed, 72)}`)

  // 结构化保留：后续模型"知道去哪里找什么"
  console.log('\n⑤ 信息可恢复（这就是"结构化保留"的意义）：')
  console.log(`   Q: 用户最初要什么？  → ${checkpoint['Primary Request and Intent'].slice(0, 60)}…`)
  console.log(`   Q: 哪里出过错？      → ${checkpoint['Errors and Fixes'].slice(0, 60)}…`)
  console.log(`   Q: 还欠什么没做？    → ${checkpoint['Pending Jobs'].slice(0, 60)}…`)

  console.log('\n小结：总结必须比原文小（收敛）；八段结构让信息可检索可恢复，不是丢进垃圾桶。')
}

/** 打印用：事件简短描述 */
function describe(stored: StoredEvent): string {
  const ev = stored.event
  if (ev.type === 'tool/call') return `call ${ev.name} ${ev.arguments}`
  if (ev.type === 'turn/start') return `turn ${ev.turn}`
  return ev.content
}

/** 打印用：长文本截断 */
function clip(text: string, max = 40): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
