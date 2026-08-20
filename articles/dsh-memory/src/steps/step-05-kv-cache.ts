/**
 * Step 05 – KV cache 复用：压缩指令必须放在"最后一条 user 消息"
 *
 * 学习目标：provider 按请求**开头**的 token 序列做 KV cache。曾经的 bug
 * （文章 3.7 节）：总结调用是"独立辅助请求"——自己的 system prompt + 把
 * 旧历史压成一段字符串。第一 token 就不同 → 整个缓存前缀失效 → 每次压缩
 * 都双倍付费（对话请求付一次、总结请求再付一次），恰好在对话最大时最烧钱。
 *
 * 修复后的形态：辅助调用**逐字复现最近一次路由请求的前缀**（同一个 system、
 * 同一份 tools、同一段派生历史），只在末尾追加总结指令——它是 warm 请求的
 * "前缀扩展"，provider 直接复用缓存 token。
 *
 * 魔鬼细节：
 *   - tools 也要带上，即使总结器从不调工具——去掉会让 token 序列变短，
 *     破坏与缓存请求的对齐；
 *   - system 必须是对话自己的 system prompt——system 槽是 provider 缓存的
 *     第一个 token 区域，换了就全废。
 *
 * 对应源码：packages/compaction/basic/src/summarizer.ts
 *   （设计笔记 compaction-summary-prefix-cache-reuse）
 *
 * 跑法：pnpm run step:05
 */

/** 简化请求消息：system / user / assistant */
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 压缩指令：引导模型输出八段式 checkpoint（文章 3.6 节，同 Step 04） */
const COMPACTION_INSTRUCTION = `Summarize the conversation history above into a structured checkpoint with these sections: Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context. Preserve exact file paths, commands, error strings and identifiers. Do not mention that this is a summarization request.`

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

/**
 * 模拟 provider 的 prefix KV cache：按消息序列从头部逐条比较，
 * 与上次请求前缀相同的部分 = 缓存命中（不计费）。
 * 真实 provider 按 token 序列匹配，这里按消息粒度对齐（教学简化）。
 */
function prefixMatchTokens(prev: readonly Message[], next: readonly Message[]): number {
  let matched = 0
  for (let i = 0; i < Math.min(prev.length, next.length); i++) {
    if (prev[i].content !== next[i].content) break // 第一个不同 token 之后全失效
    matched += estimateTokens(next[i].content)
  }
  return matched
}

/** 模拟 provider：记住上一次请求作为缓存基准 */
class MockProvider {
  private lastRequest: readonly Message[] = []

  /** 发起一次请求：返回计费明细（命中的缓存 token 免费） */
  call(request: readonly Message[]): { total: number; cached: number; billed: number } {
    const total = request.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    const cached = prefixMatchTokens(this.lastRequest, request)
    this.lastRequest = request // 本次请求成为新的缓存前缀基准
    return { total, cached, billed: total - cached }
  }
}

/** 组装对话请求：system + tools（简化成 system 槽）+ 派生历史 */
function buildDialogueRequest(
  system: string,
  tools: readonly string[],
  history: readonly Message[],
): Message[] {
  return [
    { role: 'system', content: system },
    ...tools.map(tool => ({ role: 'system' as const, content: `# Tools\n${tool}` })),
    ...history,
  ]
}

async function main(): Promise<void> {
  // 一段已到压缩时机的长对话（派生历史，不含 system/tools）
  const history: Message[] = []
  const topics = ['防抖函数', 'LRU 缓存', '事件总线', '配置加载器', '发布订阅']
  for (let i = 0; i < 10; i++) {
    history.push({
      role: 'user',
      content: `第 ${i + 1} 轮：请帮我实现「${topics[i % topics.length]}」，要求支持配置项、错误处理和单元测试，代码写成 TypeScript 并给出完整示例。`,
    })
    history.push({
      role: 'assistant',
      content: `好的，实现要点：先定义接口与类型，再实现核心逻辑，注意边界条件与错误处理，最后补测试。这是第 ${i + 1} 轮的详细方案与代码说明，覆盖了参数校验、异常路径和性能优化三个维度。`,
    })
  }
  const SYSTEM_PROMPT =
    'You are a helpful coding agent. You have access to tools and should use them when useful.'
  const TOOLS = [
    'read_file 读取文件内容',
    'write_file 写入文件内容',
    'run_shell 执行命令并返回输出',
  ]
  const dialogueReq = buildDialogueRequest(SYSTEM_PROMPT, TOOLS, history)
  const dialogueTokens = dialogueReq.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  console.log('⚡ 第 3 层（压缩引擎）：KV cache 复用——指令放最后一条 user 消息')
  console.log('----------------------------------------')
  console.log(`   对话派生历史：10 条消息，system + tools + history = ${dialogueTokens} tokens`)

  // ---------- 场景 A：修复前——独立辅助请求 ----------
  console.log('\n场景 A（修复前）：总结调用是独立请求——自带一套 system prompt')
  const providerA = new MockProvider()
  const dialogA = providerA.call(dialogueReq) // 对话请求：全量计费，成为缓存基准
  const standaloneSummary: Message[] = [
    {
      role: 'system',
      content: 'You are a conversation summarizer. Summarize the following history.',
    }, // ❌ 换了 system
    ...history,
    { role: 'user', content: COMPACTION_INSTRUCTION },
  ]
  const summaryA = providerA.call(standaloneSummary)
  console.log(
    `   对话请求：  billed=${String(dialogA.billed).padStart(5)}  cached=${dialogA.cached}`,
  )
  console.log(
    `   总结请求：  billed=${String(summaryA.billed).padStart(5)}  cached=${summaryA.cached}  ← system 槽不同，第一个 token 就失配`,
  )
  console.log(
    `   合计付费 ${dialogA.billed + summaryA.billed} tokens，缓存命中 ${dialogA.cached + summaryA.cached}（双倍付费！）`,
  )

  // ---------- 场景 B：修复后——前缀扩展 ----------
  console.log('\n场景 B（修复后）：总结请求 = 对话请求逐字复现 + 指令放最后一条 user 消息')
  const providerB = new MockProvider()
  const dialogB = providerB.call(dialogueReq) // 对话请求：全量计费，成为缓存基准
  const prefixExtendedSummary: Message[] = [
    ...dialogueReq, // ✅ 同一个 system、同一份 tools、同一段派生历史
    { role: 'user', content: COMPACTION_INSTRUCTION }, // 指令作为最后一条 user 消息
  ]
  const summaryB = providerB.call(prefixExtendedSummary)
  console.log(
    `   对话请求：  billed=${String(dialogB.billed).padStart(5)}  cached=${dialogB.cached}`,
  )
  console.log(
    `   总结请求：  billed=${String(summaryB.billed).padStart(5)}  cached=${summaryB.cached}  ← 只付指令增量，前缀全部命中`,
  )
  console.log(`   合计付费 ${dialogB.billed + summaryB.billed} tokens，缓存命中 ${summaryB.cached}`)

  // ---------- 对比 ----------
  const saved = dialogA.billed + summaryA.billed - (dialogB.billed + summaryB.billed)
  console.log('\n对比：')
  console.log(`   场景 A（独立请求）：${dialogA.billed + summaryA.billed} tokens`)
  console.log(`   场景 B（前缀扩展）：${dialogB.billed + summaryB.billed} tokens`)
  console.log(
    `   每次压缩节省 ${saved} tokens（${((saved / (dialogA.billed + summaryA.billed)) * 100).toFixed(1)}%）——对话越长，省得越多`,
  )

  console.log(
    '\n小结：辅助调用复现 warm 请求前缀、指令放末尾 = "前缀扩展"而非"独立请求"；tools/system 一个都不能少，否则缓存全废。',
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
