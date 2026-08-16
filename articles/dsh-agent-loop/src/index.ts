/**
 * SimplifiedReactLoop – 复现 DeepSeek Harness Agent 主循环核心机制
 *
 * 源码参考：source/packages/core/agent-loop/src/agent.ts
 *   - ReactLoopAgent 类、turn()/step() 双层循环、Inbox 系统、工具调用
 *
 * 本文件是简化版教学实现，用真实 LLM（ChatOpenAI + bindTools）演示核心流程：
 *   1. turn/step 双层循环
 *   2. 上下文组装（system prompt + 消息序列）
 *   3. LLM 流式生成 + tool-calls 解析
 *   4. 工具并发调度（此处简化串行，注释说明生产是并发）
 *   5. 工具结果回填 + 再调 LLM
 *   6. turn 结束状态机
 */

import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'

// ─── 类型定义 ────────────────────────────────────────────────────────

/** Turn 结束原因，对应 agent.ts 中的 TurnEndReason */
type TurnEndReason =
  | { kind: 'completed' } // 无工具调用，正常结束
  | { kind: 'max-tokens' } // 模型输出触顶
  | { kind: 'aborted' } // 被取消
  | { kind: 'error'; error: Error } // 异常

/** 工具注册表中的条目 */
interface ToolEntry {
  name: string
  description: string
  /** 参数 JSON Schema，用于 bindTools 时告知模型参数格式 */
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

/** 简要诊断信息 */
interface StepDiagnostic {
  turn: number
  step: number
  toolCalls: number
  finishReason: string
  tokensUsed?: number
}

// ─── SimplifiedReactLoop ─────────────────────────────────────────────

/**
 * SimplifiedReactLoop – 简化版 Agent 主循环
 *
 * 对应 agent.ts 中 ReactLoopAgent 类的核心机制：
 *   - turn/step 双层循环 → 对应 agent.ts turn() 和 step() 方法
 *   - Inbox 消息队列 → 对应 agent.ts Inbox 类
 *   - 工具注册表 → 对应 dsh-tools 的 tool registry
 *   - 上下文组装 → 对应 assembleContextFor() + renderContextSections()
 *   - 流式生成 + tool-calls 解析 → 对应 step() 中的 stream 循环 + assembler
 *   - 工具结果回填 → 对应 executeToolCalls() 中的 acceptContext 回调
 *   - turn 结束状态机 → 对应 TurnEndReason 联合类型
 */
class SimplifiedReactLoop {
  // ── 核心状态 ──
  /** 消息队列（Inbox），对应 agent.ts 中 this.inbox */
  private inbox: BaseMessage[] = []

  /** 工具注册表，对应 dsh-tools 的 ctx.tools 注册 */
  private tools: Map<string, ToolEntry> = new Map()

  /** 当前 turn 号 */
  private turnNumber = 0

  /** 当前 step 号 */
  private stepNumber = 0

  /** 会话消息历史，对应 agent.ts 中 session.events 的事件流 */
  private messages: BaseMessage[] = []

  /** 是否已取消 */
  private aborted = false

  /** 诊断信息收集 */
  diagnostics: StepDiagnostic[] = []

  // ── LLM ──
  private llm: ChatOpenAI

  constructor(
    private modelName: string = process.env.LLM_MODEL || 'deepseek-v4-flash',
    private baseUrl: string = process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1',
    private apiKey: string = process.env.LLM_API_KEY || '',
  ) {
    this.llm = new ChatOpenAI({
      model: this.modelName,
      configuration: { baseURL: this.baseUrl },
      apiKey: this.apiKey,
      // 对应 agent.ts 中 adapters 的 maxTokens 配置
      maxTokens: 4096,
    })
  }

  // ── 工具注册 ──

  /**
   * 注册工具，对应 dsh-tools 中 ctx.tools.register()
   * 生产环境：通过 lifecycle 的 tool 注册，支持并行执行模式
   */
  registerTool(toolEntry: ToolEntry): void {
    this.tools.set(toolEntry.name, toolEntry)
  }

  // ── 消息队列操作 ──

  /**
   * 向 inbox 发送消息，对应 agent.ts 中 send() 方法
   * 生产环境：支持 next-turn / next-step 目标，支持 wakeup 机制
   * 简化版：直接追加到队列末尾
   */
  send(message: string): void {
    this.inbox.push(new HumanMessage(message))
  }

  /**
   * 清空 inbox，对应 agent.ts 中 cancel() 的 keepInbox 参数
   */
  clearInbox(): void {
    this.inbox = []
  }

  // ── 主循环 ──

  /**
   * 运行整个 Agent 循环，从 inbox 消费消息直到结束
   *
   * 对应 agent.ts 中 kick() 方法：
   *   - kick() 调用 turn() 直到返回 false
   *   - turn() 打开一个 turn 边界，在其内部循环 step()
   *   - step() 内循环：调 LLM → 解析 tool-calls → 执行 → 回填 → 再调 LLM
   */
  async run(): Promise<string> {
    // 对应 agent.ts 中 kick() 的 while (await this.turn()) {}
    while (await this.turn()) {
      /* 持续消费 inbox 直到队列为空 */
    }
    // 返回最终回答
    const lastMsg = [...this.messages].reverse().find(m => m._getType() === 'ai')
    return (lastMsg?.content as string) ?? '(无回答)'
  }

  /**
   * 打开一个 turn 边界，消费 inbox 中当前批次的消息
   *
   * 对应 agent.ts 中 turn() 方法：
   *   - 递增 turn 号
   *   - 在 while 循环中调用 step()
   *   - 根据 turnEnds 决定是否继续下一个 turn
   *   - 生产环境：还处理 turn/start、turn/end 事件持久化
   */
  private async turn(): Promise<boolean> {
    if (this.inbox.length === 0) return false

    this.turnNumber++
    this.stepNumber = 0
    console.log(`\n🔄 === Turn ${this.turnNumber} 开始 ===\n`)

    // 消费 inbox 中的所有消息，加入会话历史
    // 对应 agent.ts 中 preStep() 的 inbox.claim()
    while (this.inbox.length > 0) {
      const msg = this.inbox.shift()!
      this.messages.push(msg)
    }

    let turnEnds: TurnEndReason | null = null

    // 对应 agent.ts: while(true) { preStep → step → check break }
    while (true) {
      if (this.aborted) {
        turnEnds = { kind: 'aborted' }
        break
      }

      this.stepNumber++

      // 执行一个 step
      // 对应 agent.ts: const stepEnd = await this.step(decision.assembly)
      const stepEnd = await this.executeStep()

      // max-tokens 是"粘性的"：一旦某个 step 触顶，后续 step 不能降级 turn 结果
      // 对应 agent.ts: if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
      if (turnEnds === null || turnEnds.kind !== 'max-tokens') {
        turnEnds = stepEnd
      }

      // 如果 step 结束且没有更多 inbox 消息 → 结束当前 turn
      // 对应 agent.ts: if (turnEnds && this.inbox.nextStep.length === 0) break
      if (turnEnds && this.inbox.length === 0) break
    }

    // 记录 turn 结束原因，对应 agent.ts: session.append('turn/end', { turn, reason: turnEnds })
    console.log(`\n🔄 === Turn ${this.turnNumber} 结束 (${turnEnds.kind}) ===\n`)

    // 如果有更多消息 → 继续下一个 turn
    // 对应 agent.ts: if (!this.inbox.hasPending) return false
    return this.inbox.length > 0
  }

  /**
   * 执行一个 step：调 LLM → 解析 tool-calls → 执行 → 回填 → 再调
   *
   * 对应 agent.ts 中 step() 方法的核心循环：
   *   while (true) {
   *     buildRequest → stream → assembler.finish
   *     if (finish.kind === 'error' || 'aborted') → retry / throw
   *     if (no tool-calls) → return { kind: 'completed' }
   *     executeToolCalls → acceptContext → re-loop
   *   }
   */
  private async executeStep(): Promise<TurnEndReason> {
    try {
      // ── 组装上下文 ──
      // 对应 agent.ts: renderPrompt(assembly) 生成 system prompt
      // 以及 assembleContextFor() 组装消息上下文
      const systemPrompt = new SystemMessage(
        '你是一个 AI Agent，可以调用工具来完成任务。' +
          '当用户需要查询天气或进行计算时，请使用对应的工具。' +
          '如果用户同时提出多个请求，你可以一次性调用多个工具（并行）。',
      )

      // 准备消息列表（system + 历史）
      const llmMessages: BaseMessage[] = [systemPrompt, ...this.messages]

      // ── 绑定工具（生产环境：在 buildRequest 中通过 prepareCall 绑定）──
      // 对应 agent.ts: const { request, preparedCall } = await this.buildRequest(...)
      // 其中 tools 来自 assembly.tools
      const toolBindings = this.buildToolBindings()
      const llmWithTools = toolBindings.length > 0 ? this.llm.bindTools(toolBindings) : this.llm

      // ── 调用 LLM 流式生成 ──
      // 对应 agent.ts: const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
      console.log(`  ⚡ Step ${this.turnNumber}.${this.stepNumber}: 调 LLM (${this.modelName})`)

      // 这里用简洁方式：非流式调用，但注释说明生产是流式
      // 对应 agent.ts: for await (const chunk of stream) { assembler.push(chunk) }
      const result = await llmWithTools.invoke(llmMessages)
      const finishReason: string =
        ((result.response_metadata as Record<string, unknown> | undefined)
          ?.finish_reason as string) ?? 'stop'

      // ── 解析 tool-calls ──
      // 对应 agent.ts: const toolCalls = message.content.filter(block => block.type === 'tool-call')
      const toolCalls = result.tool_calls || []

      console.log(
        `  📨 Step ${this.turnNumber}.${this.stepNumber}: ` +
          `finish_reason=${finishReason}, tool_calls=${toolCalls.length}`,
      )

      // 记录诊断信息
      this.diagnostics.push({
        turn: this.turnNumber,
        step: this.stepNumber,
        toolCalls: toolCalls.length,
        finishReason,
        tokensUsed: (
          (result.response_metadata as Record<string, unknown> | undefined)?.usage as
            Record<string, unknown> | undefined
        )?.total_tokens as number | undefined,
      })

      // ── 处理结束条件 ──
      // 对应 agent.ts: if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }
      if (finishReason === 'length' || finishReason === 'max_tokens') {
        this.messages.push(result) // 保存部分生成
        return { kind: 'max-tokens' }
      }

      // 将 assistant 消息加入会话历史
      // 对应 agent.ts: session.append('assistant/message', { turn, step, message })
      this.messages.push(result)

      // ── 处理工具调用 ──
      // 对应 agent.ts: if (toolCalls.length === 0) return { kind: 'completed' }
      if (toolCalls.length === 0) {
        return { kind: 'completed' }
      }

      // ── 执行工具调用 ──
      // 对应 agent.ts: const { concluded } = await executeToolCalls(...)
      // 生产环境实现并发调度（executeToolCalls.ts 中的 runGroup 函数）
      // 这里简化串行执行，但保留模型有序提交
      for (const tc of toolCalls) {
        const toolName = tc.name
        const toolArgs = tc.args as Record<string, unknown>

        // 对应 agent.ts: appendToolCall(session, turn, step, block)
        console.log(`  🛠️  执行工具: ${toolName}(${JSON.stringify(toolArgs)})`)

        const entry = this.tools.get(toolName)
        let resultContent: string

        if (entry) {
          try {
            // 对应 agent.ts: ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(exec)
            resultContent = await entry.execute(toolArgs)
          } catch (e: unknown) {
            resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
          }
        } else {
          resultContent = `Error: 未知工具 "${toolName}"`
        }

        // 将工具结果作为 ToolMessage 加入会话历史
        // 对应 agent.ts: appendToolResult(session, turn, step, block, result)
        // 工具结果通过 acceptContext 回调回填到 next-step inbox
        this.messages.push(
          new ToolMessage({
            content: resultContent,
            tool_call_id: tc.id ?? '',
          }),
        )

        console.log(`  ✅ 工具结果: ${resultContent.substring(0, 80)}`)
      }

      // 工具结果已回填，继续循环 → 再调 LLM
      // 对应 agent.ts: return concluded ? { kind: 'completed' } : null
      // null 表示继续 step 循环（再调 LLM）
      return null as unknown as TurnEndReason
    } catch (e: unknown) {
      // 对应 agent.ts: the catch in turn() that wraps errors
      if (this.aborted) return { kind: 'aborted' }
      return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) }
    }
  }

  /**
   * 构建工具绑定列表，用于 ChatOpenAI.bindTools()
   * 使用注册时保存的 parameters JSON Schema 告知模型正确参数名
   * 对应 agent.ts: assembly.tools 中的工具声明
   */
  private buildToolBindings(): Record<string, unknown>[] {
    const bindings: Record<string, unknown>[] = []
    for (const [name, entry] of this.tools) {
      bindings.push({
        type: 'function',
        function: {
          name,
          description: entry.description,
          parameters: entry.parameters,
        },
      })
    }
    return bindings
  }

  /**
   * 取消当前操作，对应 agent.ts: cancel() 方法
   */
  cancel(): void {
    this.aborted = true
  }
}

// ─── 工具定义 ────────────────────────────────────────────────────────

/**
 * 天气查询工具（Mock 实现）
 *
 * 生产环境：接入真实天气 API
 * 这里返回固定值，标注"演示工具"
 */
const weatherTool: ToolEntry = {
  name: 'get_weather',
  description: '查询指定城市的天气情况（演示工具，返回固定值）',
  parameters: {
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description: '城市名称，例如"北京"、"上海"、"广州"',
      },
    },
    required: ['city'],
  },
  execute: async (args: Record<string, unknown>) => {
    const city = (args.city as string) || '未知城市'
    // 模拟不同城市返回不同天气
    const weathers: Record<string, string> = {
      北京: '晴天，25°C，湿度 40%，微风',
      上海: '多云，28°C，湿度 65%，东南风 3级',
      广州: '阵雨，32°C，湿度 80%，南风 2级',
      深圳: '晴天，30°C，湿度 70%，微风',
      杭州: '阴天，26°C，湿度 75%，东北风 2级',
      成都: '多云，24°C，湿度 60%，西北风 1级',
    }
    const weather = weathers[city] || `晴天，22°C，湿度 50%`
    return `📍 ${city} 天气：${weather}`
  },
}

/**
 * 计算工具（真实执行）
 *
 * 生产环境：通过 ctx.tools 注册，支持 prepare → dispatch → finalize 生命周期
 */
const calculatorTool: ToolEntry = {
  name: 'calculator',
  description: '执行数学计算，支持加减乘除运算',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: '数学表达式，例如"1+1"、"2*3+4"、"10/2"',
      },
    },
    required: ['expression'],
  },
  execute: async (args: Record<string, unknown>) => {
    const expression = (args.expression as string) || ''
    if (!expression) return 'Error: 未提供表达式'
    try {
      // 安全计算：只允许数字、运算符、括号、小数点
      // 生产环境：使用更安全的表达式解析器
      const sanitized = expression.replace(/\s+/g, '')
      if (!/^[\d+\-*/().%]+$/.test(sanitized)) {
        return 'Error: 表达式包含非法字符'
      }
      // biome-ignore lint/security/noGlobalEval: 消毒过的数学表达式，仅教学用途
      const result = Function(`"use strict"; return (${sanitized})`)()
      return `计算结果: ${expression} = ${result}`
    } catch (e: unknown) {
      return `Error: 计算失败 - ${e instanceof Error ? e.message : String(e)}`
    }
  },
}

// ─── 场景演示 ────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║   SimplifiedReactLoop — 复现 DeepSeek Harness Agent 主循环  ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`模型: ${process.env.LLM_MODEL || 'deepseek-v4-flash'}`)
  console.log(`API Base: ${process.env.LLM_BASE_URL || 'https://llm.gw.dachensky.com/v1'}`)
  console.log()

  // ── 创建 Agent 循环 ──
  const loop = new SimplifiedReactLoop()

  // ── 注册工具 ──
  loop.registerTool(weatherTool)
  loop.registerTool(calculatorTool)

  // ── 场景：用户说"帮我查天气并计算 1+1" ──
  // 预期行为：
  //   1. 模型第一轮返回 2 个 tool-calls（get_weather + calculator）
  //   2. 执行工具（天气 mock + 计算真实）
  //   3. 工具结果回填
  //   4. 模型第二轮生成最终回答
  const userMessage = '帮我查一下北京的天气，并计算 1+1 等于多少？'
  console.log(`👤 用户: ${userMessage}`)
  loop.send(userMessage)

  try {
    const answer = await loop.run()
    console.log()
    console.log('╔══════════════════════════════════════════════════════════════╗')
    console.log('║                    最终回答                                 ║')
    console.log('╚══════════════════════════════════════════════════════════════╝')
    console.log()
    console.log(answer)
    console.log()

    // ── 打印诊断信息 ──
    console.log('╔══════════════════════════════════════════════════════════════╗')
    console.log('║                    诊断信息                                 ║')
    console.log('╚══════════════════════════════════════════════════════════════╝')
    console.log()
    for (const d of loop.diagnostics) {
      console.log(
        `  Turn ${d.turn}, Step ${d.step}: ` +
          `tool_calls=${d.toolCalls}, finish=${d.finishReason}` +
          (d.tokensUsed ? `, tokens=${d.tokensUsed}` : ''),
      )
    }
    console.log()
    console.log('✅ 主循环演示完成')
  } catch (e) {
    console.error('❌ 错误:', e)
    process.exit(1)
  }
}

main()
