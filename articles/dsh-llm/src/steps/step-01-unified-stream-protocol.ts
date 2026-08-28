/**
 * Step 01 – 统一流式 chunk 词汇表：为什么 Agent 核心循环只认一种协议？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「wire 协议」= 供应商自己定的线上格式（OpenAI 的 SSE 长
 *   `choices[].delta.content` 这样的字段；DeepSeek 额外给 `reasoning_content`）。
 * 「统一词汇表」= harness 自己定义的、与供应商无关的一套管流式内容的"单词"
 *   （chunk 类型）。每个 adapter 的任务就是把供应商的 wire 协议翻译成这套词汇。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：核心循环里直接消费供应商原始字段（`if (chunk.choices?.[0]?.delta?.content)`）。
 * 换一家供应商 → 循环里到处补 `if`；换三家 → 循环变成"供应商博物馆"。
 * 正解：协议翻译发生在 adapter 边界，循环只消费统一词汇表。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * StreamChunk 是七种 chunk 的 union（block-start / text-delta / reasoning-delta /
 * tool-call-delta / block-end / usage / finish）。`index` 把交织到达的块关联起来：
 * 思考模式下 reasoning 和 text 可以交替到达，靠 index 各归各家。DeepSeek 的真实
 * 翻译器（translate.ts）还有个细节：reasoning 先于 text 开块，block-end / usage /
 * finish 全部延迟到 [DONE] 哨兵才发——保证 finish 之后没有任何 chunk。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 核心循环、会话日志、插件只消费一种协议；新增供应商 = 写一个翻译函数，
 * 下游一行都不用改。
 *
 * 对应源码：packages/llm/llm/src/types.ts:291-303（StreamChunk 七种 chunk）
 *   + packages/llm/llm-deepseek/src/translate.ts:86-185（真实翻译逻辑，本步简化）
 * 跑法：pnpm run llm:step:01（或 articles/dsh-llm 内 pnpm run step:01）
 */

/** 内容块类型：chunk 里 blockType / block.type 的取值（对应源码 types.ts:99-108） */
type ContentBlockType = 'text' | 'reasoning' | 'tool-call'

/**
 * 统一流式 chunk 词汇表（对应源码 types.ts:291-303，七种）。
 * 本步演示流式形态，content block 只取流式相关的三种。
 */
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** 组装完成的块（block-end 携带的权威形态，对应源码 types.ts:53-93） */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }

/** 结束原因（本步简化三种，完整五种见 types.ts:116-125） */
type FinishReason = { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' }

/** 统一 token 记账（本步只用两个必填字段，完整五字段见 types.ts:135-147） */
interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/** OpenAI 风格 wire payload：单文本流，choices[].delta.content（教学模拟，真实是 SSE 事件） */
interface OpenAiWirePayload {
  choices?: Array<{
    delta?: { content?: string }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

/** DeepSeek 风格 wire payload：reasoning_content 与 content 交织（教学模拟） */
interface DeepSeekWirePayload {
  choices?: Array<{
    delta?: {
      reasoning_content?: string
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

/**
 * 翻译 OpenAI 风格的 wire 流 → 统一 chunk 词汇表。
 * OpenAI 的协议很简单：一个 text 块，finish_reason 随最后一条 delta 一起到达。
 */
function translateOpenAi(payloads: OpenAiWirePayload[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let text = ''
  let finish: FinishReason = { kind: 'stop' }
  let usage: TokenUsage | undefined

  for (const payload of payloads) {
    const delta = payload.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta.length > 0) {
      if (text.length === 0) chunks.push({ type: 'block-start', index: 0, blockType: 'text' })
      text += delta
      chunks.push({ type: 'text-delta', index: 0, text: delta })
    }
    const wireReason = payload.choices?.[0]?.finish_reason
    if (wireReason === 'stop') finish = { kind: 'stop' }
    if (wireReason === 'tool_calls') finish = { kind: 'tool-calls' }
    if (wireReason === 'length') finish = { kind: 'max-tokens' }
    if (payload.usage) {
      usage = {
        inputTokens: payload.usage.prompt_tokens,
        outputTokens: payload.usage.completion_tokens,
      }
    }
  }

  // 供应商在流末尾给的块收尾（真实 OpenAI 翻译器同样在结束前补 block-end）
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  if (usage) chunks.push({ type: 'usage', usage })
  chunks.push({ type: 'finish', reason: finish })
  return chunks
}

/**
 * 翻译 DeepSeek 风格的 wire 流 → 统一 chunk 词汇表。
 * 忠实还原 translate.ts 的三个契约（translate.ts:101-186）：
 * 1. reasoning 先于 text 开块，空 reasoning 不开块（translate.ts:130-140）；
 * 2. index 关联交织块：reasoning 和 text 交替到达也各归各家；
 * 3. block-end / usage / finish 全部延迟到 [DONE] 哨兵（translate.ts:102-117）。
 */
/** 一个正在组装的块（对应源码 translate.ts:16-24 OpenBlock，kind 判别三种形态） */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call 专用 */
  id?: string
  name?: string
}

/** 把开块收成完整 ContentBlock（对应源码 translate.ts:64-76 closeBlock） */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: block.id ?? '',
        name: block.name ?? '',
        arguments: block.text,
      }
  }
}

function translateDeepSeek(payloads: (DeepSeekWirePayload | '[DONE]')[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  let pendingFinish: FinishReason = { kind: 'stop' }
  let pendingUsage: TokenUsage | undefined

  for (const payload of payloads) {
    if (payload === '[DONE]') {
      // [DONE] 哨兵：此刻才统一发 block-end → usage → finish（finish 之后无任何 chunk）
      for (const block of [reasoningBlock, textBlock, ...toolBlocks.values()]) {
        if (!block) continue
        chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
      }
      if (pendingUsage) chunks.push({ type: 'usage', usage: pendingUsage })
      chunks.push({ type: 'finish', reason: pendingFinish })
      return chunks
    }

    for (const choice of payload.choices ?? []) {
      const delta = choice.delta

      // reasoning 先于 text 开块；空字符串第一个 delta 不开块（translate.ts:132-140）
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = { index: nextIndex++, kind: 'reasoning', text: '' }
          chunks.push({ type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' })
        }
        reasoningBlock.text += reasoning
        chunks.push({ type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning })
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = { index: nextIndex++, kind: 'text', text: '' }
          chunks.push({ type: 'block-start', index: textBlock.index, blockType: 'text' })
        }
        textBlock.text += content
        chunks.push({ type: 'text-delta', index: textBlock.index, text: content })
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = { index: nextIndex++, kind: 'tool-call', text: '' }
          toolBlocks.set(call.index, block)
          chunks.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
        }
        if (call.id !== undefined) block.id = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        chunks.push({
          type: 'tool-call-delta',
          index: block.index,
          id: block.id ?? '',
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        })
      }

      if (typeof choice.finish_reason === 'string') {
        if (choice.finish_reason === 'tool_calls') pendingFinish = { kind: 'tool-calls' }
        if (choice.finish_reason === 'length') pendingFinish = { kind: 'max-tokens' }
      }
    }

    if (payload.usage) {
      pendingUsage = {
        inputTokens: payload.usage.prompt_tokens,
        outputTokens: payload.usage.completion_tokens,
      }
    }
  }
  return chunks
}

/**
 * 核心循环的消费代码：只 switch 统一词汇表，不认识任何供应商字段。
 * 换供应商 = 换翻译函数，这里一行都不用改。
 */
function consume(chunks: StreamChunk[]): void {
  const label = (c: StreamChunk): string => {
    switch (c.type) {
      case 'block-start':
        return `block-start     idx=${c.index} ${c.blockType}`
      case 'text-delta':
        return `text-delta      idx=${c.index} "${c.text}"`
      case 'reasoning-delta':
        return `reasoning-delta idx=${c.index} "${c.text}"`
      case 'tool-call-delta':
        return `tool-call-delta idx=${c.index} id=${c.id} args+="${c.argumentsDelta}"`
      case 'block-end':
        return `block-end       idx=${c.index} ${c.block.type}`
      case 'usage':
        return `usage           in=${c.usage.inputTokens} out=${c.usage.outputTokens}`
      case 'finish':
        return `finish          ${c.reason.kind}`
    }
  }
  for (const chunk of chunks) console.log(`       ${label(chunk)}`)
}

/** 把 wire payload 序列化成一行，用于"翻译前"对照打印 */
function showWire(payloads: (OpenAiWirePayload | DeepSeekWirePayload | '[DONE]')[]): void {
  for (const payload of payloads) {
    if (payload === '[DONE]') {
      console.log('       data: [DONE]')
      continue
    }
    const delta = payload.choices?.[0]?.delta ?? {}
    console.log(
      `       data: ${JSON.stringify(delta)}${payload.choices?.[0]?.finish_reason ? `  finish_reason=${payload.choices[0].finish_reason}` : ''}${payload.usage ? `  usage` : ''}`,
    )
  }
}

async function main(): Promise<void> {
  console.log('🌐 Step 01 – 统一流式 chunk 词汇表：供应商协议在 adapter 边界翻译')
  console.log('='.repeat(64))

  // ========== ① OpenAI 风格 wire 流：单文本 ==========
  console.log('\n① OpenAI 风格 wire 流（choices[].delta.content 单文本流）')
  const openAiWire: OpenAiWirePayload[] = [
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { content: '，我是' } }] },
    {
      choices: [{ delta: { content: ' Claude' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    },
  ]
  console.log('   翻译前（wire 协议）：')
  showWire(openAiWire)
  console.log('   翻译后（统一词汇表）：')
  consume(translateOpenAi(openAiWire))

  // ========== ② DeepSeek 风格 wire 流：reasoning 与 text 交织 ==========
  console.log('\n② DeepSeek 风格 wire 流（reasoning_content 与 content 交织）')
  const deepSeekWire: (DeepSeekWirePayload | '[DONE]')[] = [
    { choices: [{ delta: { reasoning_content: '让我先思考' } }] },
    { choices: [{ delta: { content: '答案' } }] }, // text 开块，插在 reasoning 中间
    { choices: [{ delta: { reasoning_content: '一下……' } }] }, // reasoning 继续（与 text 交织！）
    { choices: [{ delta: { content: '是 42' }, finish_reason: 'stop' }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 15, completion_tokens: 20 } }, // usage 延迟到最后一条
    '[DONE]',
  ]
  console.log('   翻译前（wire 协议）：')
  showWire(deepSeekWire)
  console.log('   翻译后（统一词汇表）：')
  consume(translateDeepSeek(deepSeekWire))

  // ========== ③ 核心循环消费代码只写一遍 ==========
  console.log('\n③ 核心循环只认一种协议：换供应商，消费代码零改动')
  console.log('   ✅ OpenAI 流 → 翻译函数 A → 统一词汇表 → 循环（consume，一次编写）')
  console.log('   ✅ DeepSeek 流 → 翻译函数 B → 统一词汇表 → 循环（同一份 consume）')
  console.log('   ❌ 反例：循环里直接读 choices[].delta.content → 每接一家供应商，循环里加一串 if')

  console.log('\n🎯 一句话：adapter 边界翻译 wire 协议，统一词汇表让下游永远只写一遍。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
