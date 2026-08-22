/**
 * Step 04 – 结构化 checkpoint：为什么压缩是"结构化保留"，而不是"丢进垃圾桶"？
 *
 * ── 先懂三个词 ──────────────────────────────────────────────
 * 「checkpoint」= 压缩产生的"存档点"：把旧历史折叠成结构化摘要（类比：游戏
 *   存档——不是删档重来，而是把进度整理好存下来，随时能接着玩）。
 * 「replace」= 用新事件（摘要）在视图里**替换**一段旧事件的操作（step-02 提到
 *   过 surface 支持替换，本步正式讲它）。
 * 「sourceEventSeqs」= replace 必须声明"我替换掉了哪几条事件"（seq 列表）——
 *   少了任何一条都会被拒绝。这就是可审计性：每次压缩都有据可查。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：把旧消息直接截断丢弃（slice 掉头部），或让 LLM"随便总结一下"。
 * 截断丢信息——后续模型不知道"之前说过什么、做到哪了"；无结构摘要——
 * 模型不知道去哪找细节；替换没有记录——审计查无实据。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * checkpoint = 折叠旧消息 + 固定结构摘要（完整八段：Primary Request / Key
 * Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs /
 * Current Work / Next Step / Critical Context，这里演示 3 段代表）。
 * 摘要作为一条 user 消息，用 replace 上表面，并强制携带 sourceEventSeqs
 * 点名被替换的每条事件（越界 / 少报都拒绝）。硬约束：总结必须比影子掉的
 * 内容小（收敛不变量），否则拒绝提交。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 压缩后信息仍可回溯——模型"知道去哪里找"；每次替换有据可查。
 *
 * 对应源码：packages/compaction/basic/src/summarizer.ts（COMPACTION_INSTRUCTION）
 *           packages/core/session/src/surface.ts（replace 机制）
 * 跑法：pnpm run memory:step:04（或 articles/dsh-memory 内 pnpm run step:04）
 */

// ===== 复用 Session（append-only 日志 + 表面投影 + replace 机制）=====

type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }

type SurfaceEvent =
  | { type: 'user/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'assistant/message'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }
  | { type: 'tool/result'; content: string; surfaceOp: SurfaceOp; sourceEventSeqs: number[] }

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
 * 会话 = 日志 + 表面。append 时校验 replace 契约（对应源码 surface.ts）：
 * 端点必须在表面内；sourceEventSeqs 必须点名全部被影子节点——坏事件在源头拦下。
 */
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

  /** 审计：按 sourceEventSeqs 从日志取回被替换事件 */
  auditShadowed(sourceEventSeqs: readonly number[]): readonly StoredEvent[] {
    return sourceEventSeqs.map(seq => this.log[seq])
  }
}

function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

// ===== 本步核心：checkpoint + replace + 审计 =====

/** 演示 3 段（完整八段见 JSDoc） */
const DEMO_SECTIONS = ['Primary Request and Intent', 'Current Work', 'Next Step'] as const

/** 规则式总结器（教学简化，不调 LLM）：提取关键信息成固定结构 */
class RuleBasedSummarizer {
  summarize(events: readonly StoredEvent[]): Record<string, string> {
    const userMsgs = events.filter(
      (s): s is StoredEvent & { event: SurfaceEvent & { type: 'user/message' } } =>
        s.event.type === 'user/message',
    )
    const assistantMsgs = events.filter(
      (s): s is StoredEvent & { event: SurfaceEvent & { type: 'assistant/message' } } =>
        s.event.type === 'assistant/message',
    )
    return {
      'Primary Request and Intent': userMsgs[0]?.event.content ?? '(none)',
      'Current Work': userMsgs[userMsgs.length - 1]?.event.content ?? '(none)',
      'Next Step': assistantMsgs[assistantMsgs.length - 1]?.event.content ?? '(none)',
    }
  }
}

/** 落地格式：preamble + <compacted-summary> 块（对应源码 frameSummary） */
function frameSummary(checkpoint: Record<string, string>): string {
  const body = DEMO_SECTIONS.map(name => `## ${name}\n${checkpoint[name]}`).join('\n\n')
  return [
    'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it.',
    '',
    '<compacted-summary>',
    body,
    '</compacted-summary>',
  ].join('\n')
}

/** 收敛不变量：总结必须比影子掉的内容小（用完整原文估算，不截断） */
function assertConverges(framedSummary: string, shadowedTokenCount: number): number {
  const framedTokens = estimateTokens(framedSummary)
  if (framedTokens >= shadowedTokenCount) {
    throw new Error(
      `summary is not smaller：总结 ${framedTokens} tokens ≥ 影子内容 ${shadowedTokenCount} tokens`,
    )
  }
  return framedTokens
}

function clip(text: string, max = 50): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 构造一段"开发 todo CLI"对话（8 条事件） */
function buildDialogue(session: Session): void {
  session.append({
    type: 'user/message',
    content: '帮我开发一个 todo CLI 工具，用 Node.js + TypeScript，不要用第三方框架',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content: '好的，技术方案：用 fs 模块做持久化，命令用参数模式，核心文件 src/cli.ts。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({ type: 'tool/call', name: 'check_code', arguments: '{"file":"src/cli.ts"}' })
  session.append({
    type: 'tool/result',
    content: '检查发现 1 个错误：Cannot read properties of undefined，位置第 12 行',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content: '已修复：给输入参数加默认值 []，补充判空处理。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'user/message',
    content: '很好。还差单元测试和 --json 输出的文档。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  session.append({
    type: 'assistant/message',
    content: '收到，我先补单元测试覆盖增删改查，再更新 README 说明 --json 用法。',
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
}

async function main(): Promise<void> {
  console.log('🗂️  Step 04 – 结构化 checkpoint：压缩不是丢进垃圾桶')
  console.log('='.repeat(56))

  // ========== 朴素版：截断丢弃 ==========
  console.log('\n① 朴素版：超预算就 slice 截断（丢进垃圾桶）')
  const naiveMsgs = [
    { role: 'user', content: '帮我开发一个 todo CLI 工具，用 Node.js + TypeScript' },
    { role: 'assistant', content: '技术方案：fs 持久化，核心文件 src/cli.ts' },
    { role: 'assistant', content: '检查发现错误：Cannot read properties of undefined' },
    { role: 'assistant', content: '已修复：参数加默认值 []' },
    { role: 'user', content: '还差单元测试和 --json 文档' },
    { role: 'assistant', content: '收到，先补测试再更新 README' },
  ]
  const truncated = naiveMsgs.slice(-3) // 截断：丢掉前 3 条
  console.log(`   截断后模型看到：${truncated.map(m => m.role).join(' → ')}`)
  console.log('   💥 崩点 1：问"用户最初要什么？"→ 需求已被截断，查无此内容')
  console.log('   💥 崩点 2：审计"截断了什么？"→ 没有记录，查无实据')

  // ========== harness 版：checkpoint + replace + 审计 ==========
  console.log('\n② harness 版：checkpoint 结构化保留 + replace 可审计')
  const session = new Session()
  buildDialogue(session)

  console.log('   原始事件（8 条，将整个影子掉）：')
  for (const stored of session.events) {
    console.log(
      `     seq=${stored.seq}  ${stored.event.type.padEnd(20)} ${clip(stored.event.type === 'tool/call' ? stored.event.arguments : (stored.event as SurfaceEvent).content)}`,
    )
  }

  // 规则式总结 3 段
  console.log('\n   → 总结为 3 段 checkpoint：')
  const checkpoint = new RuleBasedSummarizer().summarize(session.events)
  for (const name of DEMO_SECTIONS) console.log(`     ## ${name}：${clip(checkpoint[name], 60)}`)

  // 收敛校验
  const fullText = (ev: SessionEvent): string =>
    ev.type === 'tool/call'
      ? `[tool call] ${ev.name} ${ev.arguments}`
      : isSurfaceEvent(ev)
        ? ev.content
        : ''
  const shadowedTokens = session.events.reduce(
    (sum, s) => sum + estimateTokens(fullText(s.event)),
    0,
  )
  const framed = frameSummary(checkpoint)
  const framedTokens = assertConverges(framed, shadowedTokens)
  console.log(`   ✅ 收敛约束：总结 ${framedTokens} tokens < 影子 ${shadowedTokens} tokens ✓`)

  // replace 上表面
  const shadowedSeqs = [...session.surfaceNodesList]
  session.append({
    type: 'user/message',
    content: framed,
    surfaceOp: { op: 'replace', start: 0, end: shadowedSeqs.length - 1 },
    sourceEventSeqs: shadowedSeqs,
  })
  console.log(
    `   ✅ replace：表面 [0, ${shadowedSeqs.length - 1}] 被替换为 checkpoint（sourceEventSeqs=[${shadowedSeqs.join(',')}]）`,
  )
  console.log('   模型现在看到的视图：')
  for (const line of session.deriveMessages()) console.log(`     ${clip(line, 70)}`)

  // 审计 + 信息可恢复
  console.log(
    `\n   ✅ 审计：被替换的 ${shadowedSeqs.length} 条表面节点从日志原样可查（seq=${shadowedSeqs.join(',')}）：`,
  )
  for (const stored of session.auditShadowed(shadowedSeqs).slice(0, 3)) {
    console.log(
      `     seq=${stored.seq}  ${stored.event.type.padEnd(20)} ${clip(stored.event.type === 'tool/call' ? stored.event.arguments : (stored.event as SurfaceEvent).content)}`,
    )
  }
  console.log(`     …（其余 ${shadowedSeqs.length - 3} 条同理；seq=2 的 tool/call 也在日志里）`)
  console.log('\n   ✅ 信息可检索（这就是"结构化保留"的意义）：')
  console.log(`     Q: 用户最初要什么？ → ${clip(checkpoint['Primary Request and Intent'], 50)}`)
  console.log(`     Q: 下一步做什么？   → ${clip(checkpoint['Next Step'], 50)}`)

  // 坏 replace 被拒
  console.log('\n   ✅ 契约校验：坏 replace 在源头被拒')
  try {
    session.append({
      type: 'user/message',
      content: 'x',
      surfaceOp: { op: 'replace', start: 1, end: 9 },
      sourceEventSeqs: [1, 3],
    })
  } catch (error) {
    console.log(`     端点越界被拒：${(error as Error).message}`)
  }
  try {
    session.append({
      type: 'user/message',
      content: 'y',
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [],
    })
  } catch (error) {
    console.log(`     sourceEventSeqs 少报被拒：${(error as Error).message}`)
  }

  console.log('\n🎯 一句话：总结比原文小 + 结构固定 + 替换可审计——不是丢进垃圾桶。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
