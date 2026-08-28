/**
 * Step 03 – 不可变消息与溯源：为什么消息一出生就"锁死"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「不可变」= 创建后任何路径都改不动（deepFreeze 后修改在严格模式直接抛
 *   TypeError）。想"改"只能新建一条（类比：手写账本一旦落笔只能划掉重开，
 *   不能把写过的一页擦干净）。
 * 「溯源（provenance）」= 每条消息随身携带"是谁生产的"——user 说的一句话、
 *   plugin 注入的上下文、model 生成的回答、tool 回填的结果，各带各的身份。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：消息就是 `{ role, content }` 散对象，谁都能改，改完还查不到
 * 是谁塞进来的。出了事（"这句话是哪来的？"）只能人肉考古。正解：消息一
 * 创建就冻结 + 随身携带 source 身份。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 1. freezeMessage = structuredClone + deepFreeze：先拷贝脱离原引用（创建者
 *    之后改原对象不影响消息），再深冻结（谁也别想改）。日志可信、重放可
 *    复现，靠的就是"没人能改历史"。
 * 2. MessageSource 四种 kind：user / plugin / model / tool。model 消息带
 *    provider/model 身份，tool 消息带 callId 关联原始调用。
 * 3. ContextForm 是"语义声明"：producer 声明"这是什么"（snapshot 快照 /
 *    notice 通知 / instructions 指令……），长什么样由消费方决定——语义与
 *    视觉解耦。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 会话日志、LLM 请求、UI 显示三个消费者读同一条消息，互不干扰、各取所需；
 * 出问题顺着 source 一秒定位。
 *
 * 对应源码：packages/llm/llm/src/message.ts 全文（createMessage/freezeMessage/
 *   MessageSource/ContextForm；deepFreeze 简化递归版，源码是迭代防循环版
 *   call-config.ts:88-117）
 * 跑法：pnpm run llm:step:03（或 articles/dsh-llm 内 pnpm run step:03）
 */

/** 内容块（本步只取演示相关的几种） */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError?: boolean }

/**
 * 消息溯源（对应源码 message.ts:100-105 MessageSourceMap，merge-extensible）。
 * 四种 kind 各带各的身份字段。
 */
type MessageSource =
  | { kind: 'user' }
  | ({ kind: 'plugin'; plugin: string; form?: ContextFormed['form'] } & ContextFormed)
  | { kind: 'model'; provider: string; model: string; replayState?: unknown }
  | { kind: 'tool'; callId: string }

/**
 * 上下文语义声明（对应源码 message.ts:48-94 ContextForm + ContextFormed）：
 * producer 说"这是什么"，消费方决定长什么样。snapshot 带 sections、
 * notice 带 summary——选了 form 就必须给对应字段。
 */
type ContextFormed =
  | { form?: never }
  | { form: 'snapshot'; sections: readonly { name: string; text: string }[] }
  | { form: 'notice'; summary: string }

/** 不可变消息（对应源码 message.ts:128-138 Message） */
interface Message {
  readonly id: string
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: readonly ContentBlock[]
  readonly source: MessageSource
}

/** 深冻结：递归冻结所有嵌套对象（对应源码 call-config.ts deepFreeze 简化递归版） */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/**
 * 冻结一条已带 id 的消息：先 structuredClone 脱离原引用，再深冻结
 * （对应源码 message.ts:169-171 freezeMessage）。
 */
function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/**
 * 创建一条带稳定 id 的消息，并在发布前冻结（对应源码 message.ts:178-185
 * createMessage；id = MessageId(crypto.randomUUID())）。
 */
function createMessage<T extends Omit<Message, 'id'>>(
  input: T & { id?: never },
): T & Pick<Message, 'id'> {
  return freezeMessage({ ...input, id: crypto.randomUUID() })
}

/** 创建 user 消息（对应源码 message.ts:192-199 createUserMessage） */
function createUserMessage(content: string): Message {
  return createMessage({
    role: 'user',
    content: [{ type: 'text', text: content }],
    source: { kind: 'user' },
  })
}

/** 创建 model 生成的 assistant 消息（对应源码 message.ts:206-217 createAssistantMessage） */
function createAssistantMessage(
  content: ContentBlock[],
  source: { provider: string; model: string },
): Message {
  return createMessage({ role: 'assistant', content, source: { kind: 'model', ...source } })
}

/** 创建 tool 回填的 user-role 消息（对应源码 message.ts:231-241 createToolResultMessage） */
function createToolResultMessage(
  callId: string,
  result: ContentBlock[],
  isError: boolean,
): Message {
  return createMessage({
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: result, isError }],
    source: { kind: 'tool', callId },
  })
}

/**
 * 创建 plugin 注入的上下文消息（对应源码 message.ts:102 plugin + ContextFormed）。
 * form 是判别联合：选了 snapshot 必须给 sections，选了 notice 必须给 summary。
 */
function createPluginMessage(
  plugin: string,
  content: ContentBlock[],
  form?:
    | { form: 'snapshot'; sections: readonly { name: string; text: string }[] }
    | { form: 'notice'; summary: string },
): Message {
  return createMessage({
    role: 'user',
    content,
    source: form === undefined ? { kind: 'plugin', plugin } : { kind: 'plugin', plugin, ...form },
  })
}

/** 消费者视角一：会话日志——按事件顺序照抄，只关心角色与文本 */
function renderAsSessionLog(message: Message): string {
  const text = message.content
    .map(block => (block.type === 'text' ? block.text : `[tool-result ${block.toolCallId}]`))
    .join('')
  return `${message.role.padEnd(9)} | ${text}`
}

/** 消费者视角二：LLM 请求——按 API 形态取字段，source 不入请求体 */
function renderAsLlmRequest(message: Message): string {
  return JSON.stringify({ role: message.role, content: message.content })
}

/** 消费者视角三：溯源排查——只看 source，回答"这是谁塞进来的" */
function renderAsProvenance(message: Message): string {
  switch (message.source.kind) {
    case 'user':
      return '来源: user（用户直接输入）'
    case 'plugin': {
      const extra =
        message.source.form === 'snapshot'
          ? ` form=snapshot sections=[${message.source.sections.map(s => s.name).join(', ')}]`
          : message.source.form === 'notice'
            ? ` form=notice summary="${message.source.summary}"`
            : ''
      return `来源: plugin=${message.source.plugin}${extra}`
    }
    case 'model':
      return `来源: model provider=${message.source.provider} model=${message.source.model}`
    case 'tool':
      return `来源: tool callId=${message.source.callId}`
  }
}

async function main(): Promise<void> {
  console.log('🔒 Step 03 – 不可变消息与溯源：出生即锁死，随身带身份证')
  console.log('='.repeat(64))

  // ========== ① 创建三类消息 ==========
  console.log('\n① 创建 user / assistant / tool-result 三类消息')
  const userMessage = createUserMessage('帮我写个 debounce')
  const assistantMessage = createAssistantMessage([{ type: 'text', text: '我先查一下现有代码' }], {
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  const toolResultMessage = createToolResultMessage(
    'call-1',
    [{ type: 'text', text: 'lint 通过，0 错误' }],
    false,
  )
  for (const message of [userMessage, assistantMessage, toolResultMessage]) {
    console.log(`   ✅ ${renderAsSessionLog(message)}  id=${message.id.slice(0, 8)}…`)
  }

  // ========== ② 冻结消息修改 → 严格模式抛错 ==========
  console.log('\n② 尝试篡改冻结消息 → 严格模式抛 TypeError')
  try {
    // 严格模式下（tsx 默认 ESM 严格模式）写冻结属性直接抛错
    const textBlock = userMessage.content[0] as { type: 'text'; text: string }
    textBlock.text = '被篡改！'
    console.log('   ❌ 意外：篡改没报错')
  } catch {
    console.log(
      `   ✅ 篡改被拒（Object.isFrozen(message)=${Object.isFrozen(userMessage)}，content 也冻结=${Object.isFrozen(userMessage.content)}）`,
    )
  }
  console.log('   💡 为什么这是特性不是缺陷：日志可信、重放可复现，靠的就是没人能改历史。')
  console.log('   💡 想"改"怎么办：追加一条新消息（step-01 的会话日志语义），旧消息永远不动。')

  // ========== ③ 同一消息，三个消费者 ==========
  console.log('\n③ 同一消息被三个消费者读取，各取所需')
  for (const message of [userMessage, assistantMessage, toolResultMessage]) {
    console.log(`   🧾 会话日志：${renderAsSessionLog(message)}`)
    console.log(`   📨 LLM 请求：${renderAsLlmRequest(message)}`)
    console.log(`   🔍 溯源排查：${renderAsProvenance(message)}`)
  }

  // ========== ④ plugin 消息：ContextForm 语义声明 ==========
  console.log('\n④ plugin 注入的上下文消息：form 声明"这是什么"')
  const snapshotMessage = createPluginMessage(
    '@deepseek-ai/dsh-system-prompt',
    [{ type: 'text', text: 'Current runtime context: cwd=/repo, git=clean' }],
    {
      form: 'snapshot',
      sections: [
        { name: 'cwd', text: '/repo' },
        { name: 'git', text: 'clean' },
      ],
    },
  )
  const noticeMessage = createPluginMessage(
    '@deepseek-ai/dsh-session',
    [{ type: 'text', text: 'checkpoint 完成，历史已压缩' }],
    { form: 'notice', summary: 'checkpoint 完成' },
  )
  for (const message of [snapshotMessage, noticeMessage]) {
    console.log(`   ✅ ${renderAsProvenance(message)}`)
  }
  console.log('   💡 form 是语义不是视觉：producer 只声明"这是快照/通知"，')
  console.log('     折叠还是展开、什么图标什么颜色，由消费方（UI）决定。')

  console.log('\n🎯 一句话：消息不可变 + 带溯源，历史才值得信。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
