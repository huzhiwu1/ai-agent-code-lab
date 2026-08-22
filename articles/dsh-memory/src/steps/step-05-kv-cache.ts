/**
 * Step 05 – KV cache 复用：为什么压缩指令必须放在"最后一条 user 消息"？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「KV cache」= LLM 服务商按请求**开头**的 token 序列缓存中间计算结果，前缀
 *   相同就复用（类比：做菜时"前 5 道工序"做完的锅留在灶上——下一道菜只要
 *   从第 6 道工序开始做，不用重头再来）。
 * 「前缀命中」= 两次请求开头一样，第二次的公共前缀不用重新计算、不收费。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：压缩要总结历史，随手把总结指令拼在历史**中间**（或开头）。
 * 前缀变了 → 第二次请求从指令处起全部失配 → 整段历史重新计算——压缩省下的
 * token 又全烧回去了，恰好在对话最大时最烧钱。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 总结指令作为**最后一条 user 消息**：历史前缀保持不变（同一个 system、
 * 同一份 tools、同一段派生历史），总结请求 = 对话请求的"前缀扩展"——
 * provider 直接复用缓存，只付指令增量。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 压缩后的长对话继续省钱，不是压缩完就白烧。
 *
 * 对应源码：packages/compaction/basic/src/summarizer.ts（设计笔记
 *   compaction-summary-prefix-cache-reuse）
 * 跑法：pnpm run memory:step:05（或 articles/dsh-memory 内 pnpm run step:05）
 */

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const COMPACTION_INSTRUCTION = `Summarize the conversation history above into a structured checkpoint with sections: Primary Request and Intent / Current Work / Next Step. Preserve exact file paths and error strings. Do not mention that this is a summarization request.`

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
 * 模拟 provider 的 prefix KV cache（教学简化）：记住**所有**历史请求，
 * 新请求与每个历史请求逐条比对内容，取最长公共前缀——第一个不同 token
 * 之后全部失效（对应源码 provider 的 prefix caching，本质是前缀树）。
 */
class MockProvider {
  private seen: Message[][] = []

  call(request: readonly Message[]): { total: number; cached: number; billed: number } {
    const total = request.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    let cached = 0
    for (const prev of this.seen) {
      let hit = 0
      for (let i = 0; i < Math.min(prev.length, request.length); i++) {
        if (prev[i].content !== request[i].content) break // 第一个失配点 = 该请求的缓存终点
        hit += estimateTokens(request[i].content)
      }
      if (hit > cached) cached = hit // 取所有历史请求中的最长前缀命中
    }
    this.seen.push([...request]) // 复制入缓存树，调用方后续仍可自由改动数组
    return { total, cached, billed: total - cached }
  }
}

async function main(): Promise<void> {
  // 对话历史：8 条（user/assistant 各 4），provider 已缓存"对话请求"
  const history: Message[] = []
  const topics = ['防抖函数', 'LRU 缓存', '事件总线', '配置加载器']
  for (let i = 0; i < 4; i++) {
    history.push({
      role: 'user',
      content: `第 ${i + 1} 轮：请实现「${topics[i]}」，支持配置和错误处理`,
    })
    history.push({
      role: 'assistant',
      content: `实现要点：定义类型与接口，注意边界条件。第 ${i + 1} 轮完成。`,
    })
  }
  const SYSTEM_PROMPT =
    'You are a helpful coding agent. You have access to tools and should use them when useful.'
  const dialogueReq: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history]

  console.log('⚡ Step 05 – KV cache 复用：指令放最后一条 user 消息')
  console.log('='.repeat(56))

  const provider = new MockProvider()
  const dialog = provider.call(dialogueReq) // 对话请求：全量计费，成为缓存基准
  console.log(`   对话请求（缓存基准）：${dialog.total} tokens 全量计费`)
  console.log(`   历史 = system + ${history.length} 条消息`)

  // ========== 朴素版：指令拼在历史中间 ==========
  console.log('\n① 朴素版：总结指令拼在历史中间')
  const naiveReq: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(0, 3), // 前 3 条历史
    { role: 'user', content: COMPACTION_INSTRUCTION }, // 指令插在中间！
    ...history.slice(3), // 后 5 条历史
  ]
  const naive = provider.call(naiveReq)
  console.log(`   总结请求结构：system + 3条历史 + 💥指令 + 5条历史`)
  console.log(`   cached=${naive.cached} tokens（只命中 system + 前 3 条），billed=${naive.billed}`)
  console.log('   💥 崩点：指令插进历史中间 → 前缀从指令处失配 → 后半段全部重算')

  // ========== harness 版：指令放最后一条 user 消息 ==========
  console.log('\n② harness 版：指令作为最后一条 user 消息')
  const harnessReq: Message[] = [...dialogueReq, { role: 'user', content: COMPACTION_INSTRUCTION }]
  const harness = provider.call(harnessReq)
  console.log(`   总结请求结构：system + 8条历史 + ✅指令（末尾）`)
  console.log(
    `   cached=${harness.cached} tokens（前缀全部命中），billed=${harness.billed}（只付指令增量）`,
  )

  // ========== 对比 ==========
  const saved = naive.billed - harness.billed
  console.log(`\n对比：朴素版付费 ${naive.billed} vs harness 版付费 ${harness.billed}`)
  console.log(
    `   每次压缩多付 ${saved} tokens（${((saved / naive.billed) * 100).toFixed(1)}%）——对话越长，损失越大`,
  )

  console.log('\n🎯 一句话：指令放末尾 = 前缀扩展（只付增量）；放中间 = 前缀断裂（全量重算）。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
