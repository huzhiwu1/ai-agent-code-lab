/**
 * Step 03 – 压力计算与触发：对话多长才该压缩？
 *
 * 学习目标：压缩不是定时炸弹，而是由"压力"驱动。token 压力 = 当前 token
 * 数 / 上下文窗口预算（tokenMeter.measure）。默认配置（文章 3.4 节）：
 *
 *   - thresholdRatio = 0.8：压力超过 80% 窗口才触发压缩信号；
 *   - retainRatio = 0.16：最近 16% 窗口的"逐字"历史保留（不压）——压缩后
 *     留出余量，避免刚压完又立刻触发；
 *   - 区域选择 = 头锚定 + 尾保留 + 工具配对平衡（不能把 tool/call 和它的
 *     tool/result 拆开，文章 3.5 节）。
 *
 * 对应源码：packages/compaction/basic/src/index.ts（compactIfNeeded）
 *           packages/compaction/basic/src/region.ts（selectCompactableRange）
 *           packages/llm/token-meter/
 *
 * 跑法：pnpm run step:03
 */

/** 简化消息：含 tool/call 与 tool/result 角色（区域选择需要配对信息） */
type Msg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'tool-call'; content: string }
  | { role: 'tool-result'; content: string }

/** 简化 token 估算：CJK 每字 1 token，其余按 4 字符 1 token（够教学用） */
function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

interface Measurement {
  tokens: number
  pressure: number
  thresholdTokens: number
  retainTokens: number
}

/**
 * 压力策略：把比例阈值换算成具体 token 预算（resolveCompactSpec，文章 3.4 节）。
 * contextWindow 来自最近一次路由请求的 provider/model。
 */
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

  /** tokenMeter.measure(session)：测当前压力 */
  measure(history: readonly Msg[]): Measurement {
    const tokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    return {
      tokens,
      pressure: tokens / this.contextWindow,
      thresholdTokens: this.thresholdTokens,
      retainTokens: this.retainTokens,
    }
  }

  isOverThreshold(m: Measurement): boolean {
    return m.pressure >= this.thresholdRatio
  }
}

/** 日志/消息 [0, count) 前缀内工具是否配对平衡（tool-call 与 tool-result 成对闭合） */
function toolPairingBalancedBefore(history: readonly Msg[], count: number): boolean {
  let balance = 0
  for (let i = 0; i < count; i++) {
    if (history[i].role === 'tool-call') balance++
    else if (history[i].role === 'tool-result') balance--
    if (balance < 0) return false
  }
  return balance === 0
}

/**
 * 区域选择（文章 3.5 节）：
 * 1. 从尾部往前累积 token，直到 retainTokens 预算——这部分逐字保留；
 * 2. 从保留起点往前回溯，找到"工具配对平衡"的边界（不能拆开工具对）；
 * 3. 返回 { start: 头, end: 保留区前一个 }——头锚定：自动压缩总是从表面
 *    头部开始，把旧 checkpoint 和新压的历史合并。
 */
function selectCompactableRange(
  history: readonly Msg[],
  retainTokens: number,
): { start: number; end: number; retainedFrom: number } {
  // 1) 尾→头累积 token 直到保留预算
  let tokens = 0
  let retainedFrom = history.length
  while (retainedFrom > 0 && tokens < retainTokens) {
    retainedFrom--
    tokens += estimateTokens(history[retainedFrom].content)
  }

  // 2) 从保留起点往前回溯到工具配对平衡的边界
  let end = retainedFrom - 1
  while (end > 0 && !toolPairingBalancedBefore(history, end + 1)) {
    end--
  }
  if (end < 0) end = 0

  return { start: 0, end, retainedFrom }
}

async function main(): Promise<void> {
  // 上下文窗口 2000 tokens：阈值 1600（0.8），保留 320（0.16）
  const policy = new PressurePolicy(2000)
  const history: Msg[] = []

  console.log('📊 第 3 层：压力计算与触发（contextWindow=2000）')
  console.log('--------------------------------------------------')
  console.log(
    `   阈值预算 = ${policy.thresholdTokens} tokens（${policy.thresholdRatio * 100}% 窗口）`,
  )
  console.log(
    `   保留预算 = ${policy.retainTokens} tokens（${policy.retainRatio * 100}% 窗口，逐字不压）`,
  )

  // 模拟长对话：每轮用户提问 + 助手长回答，偶发工具调用
  const features = ['防抖函数', 'LRU 缓存', '事件总线', '配置加载器']
  const answers = [
    '好的，实现要点：先定义泛型签名，用 setTimeout 包装并返回取消函数。关键在防抖窗口内清除上次定时器，同时透传 this 与参数，最后补单元测试覆盖连续调用与取消两种场景。',
    '可以，核心是双向链表加哈希表：get 时把节点移到头部，put 时淘汰尾部最久未用项。注意容量为 1 的边界情况，以及键值相同但引用不同对象的刷新语义。',
    '没问题，事件总线需要支持 on/off/emit/once 四个方法，用 Map 存事件名到监听器数组，off 时要处理迭代中删除的安全问题，错误处理要隔离单个监听器的异常。',
    '好的，配置加载器按优先级合并默认值、环境变量与文件配置，文件解析失败时给出清晰报错并回退默认值，支持嵌套对象用点号路径展开，缓存解析结果避免重复读盘。',
  ]
  for (let i = 0; i < 14; i++) {
    history.push({
      role: 'user',
      content: `第 ${i + 1} 轮：请帮我实现「${features[i % features.length]}」，要求支持配置项、错误处理和单元测试，代码写成 TypeScript 并给出完整示例。`,
    })
    history.push({ role: 'assistant', content: answers[i % answers.length] })
    if (i % 2 === 0) {
      history.push({ role: 'tool-call', content: 'check_code {"file":"src/util.ts"}' })
      history.push({
        role: 'tool-result',
        content: '检查完成：0 错误 0 警告，符合项目代码规范，可以提交',
      })
    }

    const m = policy.measure(history)
    const bar = '█'.repeat(Math.round(m.pressure * 40)).padEnd(40, '░')
    const flag = policy.isOverThreshold(m) ? '  ⚠️ 超阈值！' : ''
    console.log(
      `   轮 ${String(i + 1).padStart(2)}  tokens=${String(m.tokens).padStart(4)}  pressure=${m.pressure.toFixed(3)}  ${bar}${flag}`,
    )
  }

  // 触发压缩：选区域
  const final = policy.measure(history)
  console.log(
    `\n⚠️  压力 ${final.pressure.toFixed(3)} ≥ 0.8，触发压缩信号 → selectCompactableRange()`,
  )
  const range = selectCompactableRange(history, policy.retainTokens)
  const shadowedTokens = history
    .slice(0, range.end + 1)
    .reduce((sum, m) => sum + estimateTokens(m.content), 0)
  const retainedTokens = history
    .slice(range.retainedFrom)
    .reduce((sum, m) => sum + estimateTokens(m.content), 0)
  console.log(`   压缩区域：[0, ${range.end}]（${range.end + 1} 条消息，${shadowedTokens} tokens）`)
  console.log(
    `   逐字保留：[${range.retainedFrom}, ${history.length - 1}]（${history.length - range.retainedFrom} 条消息，${retainedTokens} tokens）`,
  )
  console.log(
    `   （保留起点 ${range.retainedFrom} 之前工具配对平衡，tool/call 与 tool/result 没有被拆开）`,
  )

  // 压缩后（假设总结占 120 tokens）：应回到安全区，且留出约 0.16 余量
  const summaryTokens = 120
  const afterTokens = retainedTokens + summaryTokens
  const afterPressure = afterTokens / policy.contextWindow
  const headroom = ((policy.thresholdTokens - afterTokens) / policy.contextWindow) * 100
  console.log(`\n压缩后（总结 ${summaryTokens} tokens + 保留 ${retainedTokens} tokens）：`)
  console.log(
    `   pressure = ${afterPressure.toFixed(3)} < 0.8 ✓，距离下次触发还有 ${headroom.toFixed(1)}% 窗口余量——刚压完不会立刻再触发`,
  )

  console.log('\n小结：压力超过 80% 才动手；保留最近 16% 逐字历史；区域从头压、工具对不拆。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
