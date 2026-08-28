/**
 * Step 08 – token 估算：为什么发送前就要知道大概多少钱？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「启发式（heuristic）」= 用经验规则快速近似，不追求精确。token 计费
 *   只有模型自己的 tokenizer 才知道精确值，但精确 tokenizer 贵又慢。
 * 「固定密度」= 假设"每 4 个字符 ≈ 1 个 token"——不分语言、不看词表，
 *   一套常数走天下。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：不估算——请求发出去了都不知道花了多少 token，预算失控后才
 * 回来查账单；或者每次估算都现写一份逻辑，两个界面（meter 服务 vs 上下
 * 文投影）显示的数字对不上。正解：一份共享的估算逻辑，发送前就算清楚。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 固定密度启发式：4 chars/token + 每块结构 overhead 4 + 每消息 role
 * overhead 4；tool-result 嵌套内容递归估算。同一份 estimateContent /
 * estimateMessage 被 meter 服务和上下文投影共用——同内容同价格，两个
 * 表面数字永远一致。精确 tokenizer 留给"必须精确"的场景（如上下文窗口
 * 裁剪前），预算管理只需要快和一致。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 发送前就知道大概多少钱；所有界面报同一个数；O(n) 一次遍历算完。
 *
 * 对应源码：packages/llm/token-meter/src/estimate.ts 全文（本步接近完整
 *   复刻；projection / surface-fold 等投影部分不属于本步）
 * 跑法：pnpm run llm:step:08（或 articles/dsh-llm 内 pnpm run step:08）
 */

/** 固定文本密度估算：每 4 字符 ≈ 1 token（对应源码 estimate.ts:13 CHARS_PER_TOKEN） */
const CHARS_PER_TOKEN = 4

/** 每块结构 overhead：JSON 框架 + type 标签（对应源码 estimate.ts:16 BLOCK_OVERHEAD） */
const BLOCK_OVERHEAD = 4

/** 每消息 role 字段框架 overhead（对应源码 estimate.ts:19 ROLE_OVERHEAD） */
const ROLE_OVERHEAD = 4

/** 内容块（对应源码 types.ts ContentBlock，本步取估算涉及的四种 + 未知块兜底） */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError?: boolean }

/** 最小消息形态：role + content（对应源码 message.ts Message 的估算所需子集） */
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: readonly ContentBlock[]
}

/**
 * 递归估算内容块 token（对应源码 estimate.ts:26-49 estimateContent）：
 * - text/reasoning：ceil(长度/4) + 块 overhead；
 * - tool-call：name 与 arguments 各按密度算 + 块 overhead；
 * - tool-result：递归估算嵌套 content + 块 overhead；
 * - 未知块：JSON.stringify 后按密度算（merge-extensible 兜底）。
 */
function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens +=
          Math.ceil(block.name.length / CHARS_PER_TOKEN) +
          Math.ceil(block.arguments.length / CHARS_PER_TOKEN) +
          BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD
        break
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/** 估算一条消息：内容 + role overhead（对应源码 estimate.ts:56-58 estimateMessage） */
function estimateMessage(message: Message): number {
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/** 估算整个 messages 数组（真实场景是 loop 组装请求前先算一遍预算） */
function estimateMessages(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessage(message), 0)
}

/** 模拟"精确 tokenizer"：教学对照用，代表逐词查词表的分词（真实中又贵又慢） */
function exactTokenCount(blocks: readonly ContentBlock[]): number {
  // 模拟：英文按空格分词，中文按字分词，带结构性 token
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += block.text.split(/\s+/).filter(word => word.length > 0).length
        tokens += [...block.text].filter(char => /[\u4e00-\u9fff]/.test(char)).length
        break
      case 'tool-call':
        tokens +=
          block.name.split(/\s+/).length +
          block.arguments.split(/\s+/).filter(w => w.length > 0).length
        break
      case 'tool-result':
        tokens += exactTokenCount(block.content)
        break
      default:
        tokens += 1
    }
  }
  return tokens
}

/** 按行打印块级估算明细，供演示复用 */
function dumpEstimate(label: string, blocks: readonly ContentBlock[]): void {
  const heuristic = estimateContent(blocks)
  const exact = exactTokenCount(blocks)
  console.log(
    `   ${label.padEnd(30)} 启发式=${heuristic} 模拟精确=${exact} 差异=${heuristic - exact >= 0 ? '+' : ''}${heuristic - exact}`,
  )
}

async function main(): Promise<void> {
  console.log('🧮 Step 08 – token 估算：发送前就知道大概多少钱')
  console.log('='.repeat(64))

  // ========== ① 各类型内容块估算 ==========
  console.log('\n① 各类型块：text / reasoning / tool-call / 嵌套 tool-result')
  const text: ContentBlock = { type: 'text', text: '帮我写一个 debounce 工具函数' }
  const reasoning: ContentBlock = {
    type: 'reasoning',
    text: '先确认他想要的是经典版还是带 cancel 的版本……',
  }
  const toolCall: ContentBlock = {
    type: 'tool-call',
    id: 'call-1',
    name: 'read_file',
    arguments: '{"path":"src/utils.ts"}',
  }
  const nestedToolResult: ContentBlock = {
    type: 'tool-result',
    toolCallId: 'call-1',
    content: [
      { type: 'text', text: '文件内容如下：' },
      {
        type: 'tool-result',
        toolCallId: 'call-0',
        content: [{ type: 'text', text: '上一轮工具结果' }],
      }, // 嵌套！
    ],
  }
  dumpEstimate('text', [text])
  dumpEstimate('reasoning', [reasoning])
  dumpEstimate('tool-call', [toolCall])
  dumpEstimate('嵌套 tool-result', [nestedToolResult])
  console.log('   💡 tool-result 递归下钻：内层块 + 每层各自的结构 overhead 都算进去')

  // ========== ② 整个 messages 数组（含 role overhead） ==========
  console.log('\n② 估算整个 messages 数组（每条消息 +4 role overhead）')
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] },
    { role: 'user', content: [{ type: 'text', text: '帮我写个 debounce' }] },
    { role: 'assistant', content: [reasoning, toolCall] },
    { role: 'user', content: [nestedToolResult] },
  ]
  const perMessage = messages.map(message => estimateMessage(message))
  const total = estimateMessages(messages)
  console.log(
    `   每条：${perMessage.join(' + ')} = ${total} tokens（含 ${messages.length} 条消息的 role overhead）`,
  )
  console.log('   💡 预算管理用这个数做决策：发送前就知道这一发大概多少钱')

  // ========== ③ 启发式 vs 模拟精确：差异与取舍 ==========
  console.log('\n③ 启发式 vs 模拟精确：有差异，但预算管理不在乎')
  console.log('   启发式：4 chars/token 固定密度，O(n) 一次遍历，纯 CPU 常数级开销')
  console.log('   精确计数：要加载模型词表逐 token 匹配，慢且内存贵')
  console.log('   取舍：预算管理不需要精确——需要"快"和"所有界面报同一个数"')
  console.log('   💡 同一份 estimateContent 被 meter 服务和上下文投影共用 → 同内容同价格')

  console.log('\n🎯 一句话：固定密度启发式——不精确但够用，且两处界面永远一致。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
