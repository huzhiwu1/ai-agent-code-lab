/**
 * Step 02 – 外部驱动：谁启动了 Agent？
 *
 * 学习目标：Agent 不是自己凭空转的——它需要外部驱动来启动。
 * Step 01 里我们直接调 turn()，但生产环境里 turn() 前面还有两层：
 *   1. kick()：外部驱动入口，循环调用 turn() 直到队列为空
 *   2. wakeDriver()：Phase 状态机，决定"收到唤醒信号后该怎么办"
 *
 * 对应源码 agent.ts：
 *   - kick() → agent.ts:197-210（while (await this.turn()) {}）
 *   - wakeDriver() → agent.ts:163-183（latch / replay 逻辑）
 *   - Phase 状态机 → agent.ts:37-53（idle / running / maintenance）
 *   - followup/steer/inject → agent.ts:120-146（三种注入）
 *
 * 关键机制：
 *   - Phase 状态机：idle（空闲）→ running（跑模型）→ idle（收尾）
 *   - 每次 turn 结束换新 AbortController，旧信号上的 latch 失效
 *   - 取消收敛窗口：abort() 返回后驱动还没收敛到 idle，此时到达的唤醒
 *     会被 latch，等驱动收敛后自动重放
 *
 * 跑法：pnpm run step:02
 */

import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'

// ─── Phase 状态机 ────────────────────────────────────────────────────

/** Agent 生命周期阶段，对应 agent.ts:37-53 */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/**
 * SimpleAgent  – 带外部驱动的 Agent 循环
 *
 * 对应 agent.ts 中 ReactLoopAgent 的外部驱动层：
 *   - kick()：while (await this.turn()) {}
 *   - wakeDriver()：Phase 状态机 + latch 机制
 *   - followup() / steer() / inject()：三种消息注入
 *
 * 与 Step 01 的区别：Step 01 直接调 turn()，Step 02 先接消息再 kick
 */
class SimpleAgent {
  private messages: BaseMessage[] = []
  private inbox: BaseMessage[] = []
  private phase: Phase
  private turnNumber = 0
  private stepNumber = 0
  private llm: ChatOpenAI

  constructor(
    modelName = process.env.LLM_MODEL || 'deepseek-v4-flash',
    baseUrl = process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    apiKey = process.env.LLM_API_KEY || '',
  ) {
    this.llm = new ChatOpenAI({
      model: modelName,
      configuration: { baseURL: baseUrl },
      apiKey,
      maxTokens: 1024,
    })
    this.phase = { kind: 'idle', lastTurn: 0 }
  }

  // ── 三种消息注入 ─────────────────────────────────────────────────
  // 对应 agent.ts:120-146
  // followup / steer 都唤醒驱动，inject 只排队不唤醒

  /** 常规下一轮输入（用户发新问题），对应 agent.ts followup() */
  followup(message: string): void {
    this.inbox.push(new HumanMessage(message))
    this.wakeDriver()
  }

  /** 打断当前步（插件中途插话），对应 agent.ts steer() */
  steer(message: string): void {
    this.inbox.push(new HumanMessage(message))
    this.wakeDriver()
  }

  /** 只预埋上下文不唤醒，对应 agent.ts inject() */
  inject(message: string): void {
    this.inbox.push(new HumanMessage(message))
    // 不调 wakeDriver() —— 这是 inject 和 followup/steer 的唯一区别
  }

  // ── 外部驱动层 ───────────────────────────────────────────────────

  /**
   * 外部驱动入口：循环消费 inbox 直到队列为空
   *
   * 对应 agent.ts:197-210 的 kick()：
   *   while (await this.turn()) {}
   *
   * 关键设计：kick() 失败不崩——错误在驱动边界内收敛，
   * 上一个 turn 的失败不影响下一个 turn 的启动
   */
  async kick(): Promise<void> {
    try {
      // 对应 agent.ts: while (await this.turn()) {}
      while (await this.turn()) {
        /* 持续消费 inbox 直到队列为空 */
      }
    } catch {
      // 对应 agent.ts: catch block — 错误在驱动边界内收敛
      console.log('  ⚠️  驱动层捕获错误，不影响后续 turn')
    } finally {
      // 对应 agent.ts kick() 的 finally：收敛到 idle 后重放 latch
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.phase = { kind: 'idle', lastTurn: turn }
        // 如果收敛期间有 latch 的唤醒 → 重放
        if (wakeRequested && this.inbox.length > 0) this.wakeDriver()
      }
    }
  }

  /**
   * Phase 状态机：收到唤醒信号后决定何时启动驱动
   *
   * 对应 agent.ts:163-183 的 wakeDriver()：
   *   - idle → 直接启动驱动
   *   - running → 正在跑的驱动自己会 claim 队列，不需要 latch
   *   - aborted → 驱动还在收敛，latch 唤醒信号，收敛后重放
   *   - maintenance → 后台任务不读队列，latch 后等任务结束再重放
   *
   * 简化版：只实现 idle → running 和 aborted → latch
   */
  private wakeDriver(): void {
    if (this.phase.kind !== 'idle') {
      // 驱动还在跑或正在收敛 → latch 唤醒信号
      if (this.phase.kind === 'running') {
        this.phase.wakeRequested = true
      }
      return
    }
    // idle → running：启动新驱动
    this.phase = {
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    }
    // 异步启动 kick，不阻塞调用方
    this.kick()
  }

  // ── 主循环 ────────────────────────────────────────────────────────

  /**
   * 一次 turn：从 inbox 消费消息，在 step 循环中处理
   *
   * 对应 agent.ts:245-329 的 turn()：
   *   - 递增 turn 号
   *   - while(true) 循环中反复调 step()
   *   - 根据 turnEnds 决定是否继续
   *
   * 简化版：保持 Step 01 的 turn/step 机制，但加上 Phase 管理
   */
  private async turn(): Promise<boolean> {
    if (this.inbox.length === 0) return false
    if (this.phase.kind !== 'running') return false

    this.turnNumber++
    this.stepNumber = 0
    console.log(`\n🔄 === Turn ${this.turnNumber} 开始 ===\n`)

    // 消费 inbox 中的消息
    // 对应 agent.ts preStep() 的 inbox.claim()
    while (this.inbox.length > 0) {
      const msg = this.inbox.shift()!
      this.messages.push(msg)
    }

    // 对应 agent.ts: while(true) { preStep → step → check break }
    let result: string | null = null
    while (result === null) {
      this.stepNumber++
      result = await this.step()
    }

    console.log(`\n🔄 === Turn ${this.turnNumber} 结束 ===\n`)

    // 换新 AbortController，旧信号上的 latch 失效
    // 对应 agent.ts: if (!this.inbox.hasPending) return false
    return this.inbox.length > 0
  }

  /** 一次 step：调模型 → 拿回答（尚无工具） */
  private async step(): Promise<string | null> {
    const systemPrompt = new SystemMessage('你是一个简洁的 AI 助手，用一两句话回答问题。')
    const llmMessages: BaseMessage[] = [systemPrompt, ...this.messages]

    console.log(`  ⚡ Step ${this.turnNumber}.${this.stepNumber}: 调 LLM ...`)
    const result = await this.llm.invoke(llmMessages)
    this.messages.push(result)

    const content =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
    console.log(`  📨 回答: ${content.substring(0, 80)}...`)
    return content
  }
}

// ─── 场景演示 ────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  Step 02 – 外部驱动：kick / wake / Phase 状态机             ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()

  const agent = new SimpleAgent()

  // 场景：用户发一条消息，followup 触发 kick
  console.log('👤 用户: 你好，请用一句话介绍你自己。')
  agent.followup('你好，请用一句话介绍你自己。')

  // 等待异步 kick 完成
  // 生产环境：whenIdle() 等待 activityDone 稳定
  await new Promise(resolve => setTimeout(resolve, 8000))

  // 场景：中途 steer（打断当前步）
  // 简化版演示：先 followup 启动第一个 turn，再 steer 打断
  console.log('\n--- 场景 2：steer 打断 ---')
  console.log('👤 用户: 帮我查天气')
  agent.followup('帮我查天气')
  await new Promise(resolve => setTimeout(resolve, 3000))

  console.log('👤 插件 steer: 等一下，先确认城市')
  agent.steer('等一下，先确认城市')
  await new Promise(resolve => setTimeout(resolve, 8000))

  console.log('\n✅ 演示完成')
}

main().catch(e => {
  console.error('❌', e)
  process.exit(1)
})
