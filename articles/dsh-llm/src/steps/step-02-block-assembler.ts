/**
 * Step 02 – BlockAssembler 增量组装：碎片怎么拼成完整消息，还扛得住坏流？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「增量组装」= 边收边拼：text-delta 一块一块黏成整段文本，而不是攒齐了
 *   一次性拼（类比：拼图来一片贴一片，最后得到完整画面）。
 * 「坏流」= 违反协议或意外截断的 chunk 序列——没有 block-start 就来了
 *   delta、块已经结束后又漂来 delta、重复的 block-end……真实供应商都可能
 *   产出。组装器必须在这些输入下不崩、不出错消息。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：消费者自己用字符串拼接 delta，遇到 reasoning 和 text 交织、
 * tool-call 分片（id/name/arguments 分多次到达）就拼错；供应商发条畸形流
 * 直接崩。正解：一个中心化的组装算法，所有流都从它手里过。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * BlockAssembler 是唯一的"chunk → 消息"组装算法。四个容错契约：
 * 1. ensure() 隐式开块——没有 block-start 的 delta 也能拼（delta-only 协议
 *    容错，供应商不发 block-start/end 也能工作）；
 * 2. block-end 权威冻结——携带完整 block，first close wins，重复 block-end
 *    忽略（保证流式输出和最终组装结果一致）；
 * 3. 已冻结的块忽略迟到 delta——坏 adapter 不能撑爆内存或破坏已完成块；
 * 4. finish.kind === 'max-tokens' 时过滤 tool-call 块——截断的 tool-call
 *    参数不完整，无法安全执行，直接丢弃。
 * finish 缺省为 {kind:'stop'}；usage/replayState 透传。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 无论供应商协议好坏，核心循环拿到的永远是完整、一致、安全的 assistant 消息。
 *
 * 对应源码：packages/llm/llm/src/assembler.ts 全文（本步接近完整复刻，
 *   保留 partials Map + order 数组结构；assertNever 简化为 default 分支）
 * 跑法：pnpm run llm:step:02（或 articles/dsh-llm 内 pnpm run step:02）
 */

/** 内容块（对应源码 types.ts:53-93，本步取组装相关的四种） */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }

/** 统一流式 chunk（对应源码 types.ts:291-303，七种） */
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

/** 结束原因（对应源码 types.ts:116-125） */
type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

/** 序列化失败事实（本步只用到 error/aborted 的载体） */
interface LlmFailure {
  readonly message: string
  readonly code: string
}

/** 统一 token 记账（对应源码 types.ts:135-147，DISJOINT 约定本步只演示形态） */
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

/** 组装中的块（对应源码 assembler.ts:15-23 PartialBlock） */
interface PartialBlock {
  blockType: string
  text: string
  toolCallId?: string
  toolCallName?: string
  toolCallArguments: string
  /** block-end 设置的权威块，一旦存在即冻结该 partial */
  block?: ContentBlock
}

/** 简化消息：组装产物（完整 Message 形态见 step-03） */
interface AssembledMessage {
  role: 'assistant'
  content: ContentBlock[]
}

/**
 * 增量组装器（对应源码 assembler.ts:36-164 BlockAssembler，结构一致：
 * partials Map + order 数组）。push() 七分支 + 四个容错契约。
 */
class BlockAssembler {
  private partials = new Map<number, PartialBlock>()
  private order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined
  private _replayState: unknown = undefined

  /** 喂一个 chunk（对应源码 assembler.ts:47-94 push，七分支） */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        // 已存在的 index 不重复开块（duplicate block-start 容忍）
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return // 已被 block-end 冻结：迟到 delta 忽略
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return // 已被 block-end 冻结：迟到 delta 忽略
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        // First close wins：重复 block-end 忽略，流式输出与最终块保持一致
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage': {
        this._usage = chunk.usage
        return
      }
      case 'finish': {
        this._finish = chunk.reason
        this._replayState = chunk.replayState
        return
      }
    }
  }

  /** 隐式开块：没有 block-start 的 delta 也能拼（对应源码 assembler.ts:96-104） */
  private ensure(index: number, blockType: string): PartialBlock {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  /** 把一个 partial 收成完整块（对应源码 assembler.ts:106-119 assemble） */
  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text':
        return { type: 'text', text: partial.text }
      case 'reasoning':
        return { type: 'reasoning', text: partial.text }
      case 'tool-call':
        return {
          type: 'tool-call',
          id: partial.toolCallId ?? `call-${index}`,
          name: partial.toolCallName ?? '',
          arguments: partial.toolCallArguments,
        }
      default:
        throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  /** 组装目前见到的全部块，按流序（对应源码 assembler.ts:134-139 blocks） */
  blocks(): ContentBlock[] {
    const blocks = this.order.map(index => this.assemble(this.mustGet(index), index))
    // max-tokens 截断：tool-call 参数不完整无法安全执行，整体丢弃
    return this.finish.kind === 'max-tokens'
      ? blocks.filter(block => block.type !== 'tool-call')
      : blocks
  }

  private mustGet(index: number): PartialBlock {
    const partial = this.partials.get(index)
    if (!partial)
      throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`)
    return partial
  }

  /** usage 透传；没收到 usage chunk 时为 undefined（对应源码 assembler.ts:142-144） */
  get usage(): TokenUsage | undefined {
    return this._usage
  }

  /** finish 缺省 {kind:'stop'}：流正常结束但没发 finish 也成立（对应源码 assembler.ts:147-149） */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' }
  }

  /** adapter 私有回放状态透传（对应源码 assembler.ts:152-154） */
  get replayState(): unknown {
    return this._replayState
  }

  /** 组装成 assistant 消息（对应源码 assembler.ts:161-163 message，溯源见 step-03） */
  message(): AssembledMessage {
    return { role: 'assistant', content: this.blocks() }
  }
}

/** 打印组装结果，供演示复用 */
function dump(assembler: BlockAssembler): void {
  const message = assembler.message()
  console.log(`   ✅ 组装消息 role=${message.role}，共 ${message.content.length} 块：`)
  for (const block of message.content) {
    console.log(
      `      - ${block.type}: ${block.type === 'tool-call' ? `${block.name}(${block.arguments})` : block.text}`,
    )
  }
  console.log(
    `   ✅ finish=${assembler.finish.kind}${'failure' in assembler.finish ? ` code=${assembler.finish.failure.code}` : ''}${assembler.usage ? ` usage in=${assembler.usage.inputTokens} out=${assembler.usage.outputTokens}` : ''}`,
  )
}

async function main(): Promise<void> {
  console.log('🧩 Step 02 – BlockAssembler：增量组装 + 坏流容错')
  console.log('='.repeat(64))

  // ========== ① 正常流：text + tool-call 交织 ==========
  console.log('\n① 正常流（text 与 tool-call 交织）→ 拼出完整 assistant 消息')
  const good = new BlockAssembler()
  good.push({ type: 'block-start', index: 0, blockType: 'text' })
  good.push({ type: 'text-delta', index: 0, text: '我来' })
  good.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
  good.push({ type: 'text-delta', index: 0, text: '查一下' }) // 与 tool-call 交织，index 各归各家
  good.push({
    type: 'tool-call-delta',
    index: 1,
    id: 'call-1',
    name: 'read_file',
    argumentsDelta: '{"path"',
  })
  good.push({ type: 'tool-call-delta', index: 1, id: 'call-1', argumentsDelta: ':"a.ts"}' })
  good.push({ type: 'block-end', index: 0, block: { type: 'text', text: '我来查一下' } })
  good.push({
    type: 'block-end',
    index: 1,
    block: { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
  })
  good.push({ type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } })
  good.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  dump(good)

  // ========== ② delta-only 流：没有 block-start / block-end ==========
  console.log('\n② delta-only 流（无 block-start/end）→ ensure() 隐式开块，照拼不误')
  const deltaOnly = new BlockAssembler()
  deltaOnly.push({ type: 'text-delta', index: 0, text: '直接' })
  deltaOnly.push({ type: 'text-delta', index: 0, text: '开始' })
  deltaOnly.push({ type: 'finish', reason: { kind: 'stop' } })
  dump(deltaOnly)

  // ========== ③ 迟到 delta / 重复 block-end：忽略不崩 ==========
  console.log('\n③ 迟到 delta + 重复 block-end → 忽略，已完成块不被破坏')
  const straggler = new BlockAssembler()
  straggler.push({ type: 'block-start', index: 0, blockType: 'text' })
  straggler.push({ type: 'text-delta', index: 0, text: '权威内容' })
  straggler.push({ type: 'block-end', index: 0, block: { type: 'text', text: '权威内容' } })
  straggler.push({ type: 'text-delta', index: 0, text: '迟到的篡改' }) // 冻结后迟到 → 忽略
  straggler.push({ type: 'block-end', index: 0, block: { type: 'text', text: '第二次结束' } }) // 重复 → 忽略
  straggler.push({ type: 'finish', reason: { kind: 'stop' } })
  dump(straggler)

  // ========== ④ max-tokens 截断：tool-call 被过滤、text 保留 ==========
  console.log('\n④ max-tokens 截断 → tool-call 被过滤（参数不完整不可执行）、text 保留')
  const truncated = new BlockAssembler()
  truncated.push({ type: 'block-start', index: 0, blockType: 'text' })
  truncated.push({ type: 'text-delta', index: 0, text: '我调工具：' })
  truncated.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
  truncated.push({
    type: 'tool-call-delta',
    index: 1,
    id: 'call-9',
    name: 'run_cmd',
    argumentsDelta: '{"command":"rm -rf /"',
  })
  // 输出上限到了：tool-call 的 arguments 只传了一半
  truncated.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  dump(truncated)

  console.log('\n🎯 一句话：组装器是"chunk 语义"的唯一权威，坏流进、好消息出。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
