# Qoder 任务：精读（五）配套复现——articles/dsh-llm 8 步渐进式 LLM 层

## 你的角色（三重身份，融合到每一行代码和注释里）

1. **资深 AI Agent 工程师**：写的代码要体现生产级 Agent 框架的设计取舍——不只是"能跑"，要让人看出"为什么这么设计"（流式协议容错、token 成本、错误边界、防御性）。
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。每步代码必须能独立运行、输出教学性结果，注释要讲清楚"这一步在解决什么问题、不这么做会怎样"。
3. **DeepSeek Harness 资深源码研究者**：所有简化实现必须忠实于真实源码的机制和命名，注释标注对应源码文件:行号，不能凭空发明与源码不符的行为。

## 项目背景

仓库 `~/workspace/ai-agent-code-lab` 是 **DeepSeek Harness 源码精读系列**的复现仓库：每篇精读 = 分析文档（docs/*.md）+ 渐进式从 0 复现的可运行 TS 代码（articles/dsh-xxx/src/steps/step-01~NN.ts）。

已完成的模式（**必须对齐的风格样本，先读再写**）：

- `articles/dsh-tools/src/steps/step-01-pipeline-skeleton.ts`（工具管线）
- `articles/dsh-memory/src/steps/step-01-session-log.ts`（记忆管理，最新一期，JSDoc 风格标杆）
- `articles/dsh-context/src/steps/step-04-runtime-context-snapshot.ts`（上下文管理）

已完成的 package.json 模式：

- `articles/dsh-tools/package.json`（@articles/dsh-tools，纯 Node 无依赖，tsx 跑，scripts 里 step:01~NN）
- 根 `package.json` scripts 里有 `run:dsh-tools` 总入口 + `tools:step:01`~~`tools:step:NN`（记忆是 `memory:step:NN`）——**LLM 层按 `run:dsh-llm` + `llm:step:01`~~`llm:step:08` 命名**

## 任务

为精读五《LLM 层》创建配套复现 `articles/dsh-llm/`，8 步渐进式。**每步只解决一个哲学点，小而精，不要一步塞多机制。**

### 必读材料（动笔前先读，读懂再写）

真实源码（对照核实，不要凭记忆写）：`~/workspace/deepseek-harness-study/source/packages/llm/`

1. `llm/llm/src/types.ts` — **StreamChunk 统一流式词汇表**（291-302 行七种 chunk）、FinishReasonMap（116-125）、TokenUsage（135-147，**DISJOINT 计数约定**：cacheRead 从 inputTokens 里减掉）
2. `llm/llm/src/assembler.ts` — **BlockAssembler**（全文 164 行，增量组装 + 容错，可接近完整复刻）
3. `llm/llm/src/message.ts` — **不可变消息 + 溯源**（全文 261 行：createMessage/freezeMessage/MessageSource/ContextForm）
4. `llm/llm/src/index.ts` — **LlmRuntime 适配器注册表**（947 行：registerAdapter / prepareCall / stream + llm/stream waterfall）
5. `llm/llm/src/call-config.ts` — **调用配置**（117 行：LlmCallConfig / callConfigEquals / deepFreeze / markAgentLoopRequest）
6. `llm/llm/src/adapter-failure.ts` — **错误归一化**（全文 104 行：normalizeLlmFailure）
7. `llm/llm/src/retry-policy.ts` — **重试策略**（191 行：resolveRetryPolicy，normal/always 两模式）
8. `llm/llm-retry/src/index.ts` — **重试执行器**（226 行：apply，挂在 agent/request-error 扩展点）
9. `llm/token-meter/src/estimate.ts` — **token 估算**（全文：固定密度启发式）
10. `llm/llm-deepseek/src/translate.ts` — **真实 adapter 翻译样本**（wire SSE → 统一 chunk，重点看：reasoning 先于 text 开块、block-end/usage/finish 全部延迟到 [DONE] 哨兵、finish 后无 chunk 的保证）

## 8 步规格（文件名 + 学习目标 + 核心机制 + 演示，按此实现）

每步一个独立可运行文件，从最小骨架逐步加机制。**不写死行数**，写清楚、写到位即可；宁可每步小而精，不要一步大而全。

### Step 01 — `step-01-unified-stream-protocol.ts`

**统一流式 chunk 词汇表：为什么 Agent 核心循环只认一种协议？**

- 核心机制：`StreamChunk` 七种 chunk（block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish）；`index` 关联交织块（reasoning 和 text 可以交替到达）；adapter 边界负责把供应商 wire 协议翻译成统一词汇表
- 演示：两个模拟供应商 wire 流——OpenAI 风格（`choices[].delta.content` 单文本流）和 DeepSeek 风格（`reasoning_content` 与 `content` 交织 + `[DONE]` 哨兵末尾才给 finish_reason/usage）——各自写一个翻译函数，输出统一 chunk 流；打印"翻译前 vs 翻译后"对照，点明：**核心循环的消费代码只需要写一遍**
- 对应源码：`llm/llm/src/types.ts`（StreamChunk 定义）+ `llm/llm-deepseek/src/translate.ts`（真实翻译逻辑，简化）
- 必须写：七种 chunk 类型定义、两个模拟 wire 数据、两个翻译函数、翻译后逐 chunk 打印
- 可省略：真实 SSE 解析细节（用数组模拟 payload 即可，一笔带过说明真实是 SSE）

### Step 02 — `step-02-block-assembler.ts`

**BlockAssembler 增量组装：碎片怎么拼成完整消息，还扛得住坏流？**

- 核心机制：
  - `ensure()` 隐式开块：没有 block-start 的 delta 也能拼（**delta-only 协议容错**）
  - `block-end` 权威冻结：携带完整 block，first close wins，重复 block-end 忽略
  - 已冻结的块忽略迟到 delta（**防坏 adapter 撑爆内存/破坏已完成块**）
  - `finish.kind === 'max-tokens'` 时过滤 tool-call 块（**截断的 tool-call 无法安全执行**，直接丢弃）
  - finish 缺省为 `{kind:'stop'}`；usage/replayState 透传
- 演示：喂正常流（text + tool-call 交织）→ 拼出完整 assistant 消息；喂 delta-only 流（无 block-start/end）→ 也能拼；喂迟到 delta / 重复 block-end → 忽略不崩；max-tokens 截断 → tool-call 被过滤、text 保留
- 对应源码：`llm/llm/src/assembler.ts` 全文（可以接近完整复刻，注意保持 partials Map + order 数组的结构）
- 必须写：PartialBlock、push() 七分支、assemble/blocks/message/finish/usage
- 可省略：replayState 透传可简化（一行说明即可）

### Step 03 — `step-03-immutable-message.ts`

**不可变消息与溯源：为什么消息一出生就"锁死"？**

- 核心机制：
  - `createMessage`/`freezeMessage`：structuredClone + deepFreeze，**任何路径改不动**（严格模式直接抛错）；稳定 MessageId（crypto.randomUUID）
  - `MessageSource` 溯源：user / plugin / model / tool 四种 kind，merge-extensible（插件可加新 kind）；model 消息带 provider/model 身份、tool 消息带 callId 关联
  - `ContextForm` 语义声明：producer 声明"这是什么"（instructions/catalog/snapshot/notice/relay/recall），消费方决定长什么样——语义与视觉解耦
- 演示：创建 user/assistant/tool-result 三类消息；尝试修改冻结消息 → 严格模式抛错（注释解释为什么这是特性不是缺陷：**日志可信、重放可复现，靠的就是没人能改历史**）；同一消息被"会话日志"和"LLM 请求"两个消费者读取，打印各自视角；plugin 消息带 form: 'snapshot' + sections 演示溯源排查（这条消息是谁塞进上下文的）
- 对应源码：`llm/llm/src/message.ts` 全文
- 必须写：Message 类型 + 三个创建函数 + 冻结抛错演示 + source 溯源演示
- 可省略：ContextForm 六种全写（演示 snapshot + notice 两种即可，其余类型定义可带过）

### Step 04 — `step-04-adapter-registry.ts`

**适配器注册表 + llm/stream waterfall：调用方怎么做到"不知道供应商是谁"？**

- 核心机制：
  - `registerAdapter(providers, adapter)`：provider 路由表；**all-or-nothing**（一个冲突全拒，DUPLICATE_ADAPTER）；原子 replace（同步段内无间隙切换，观察者看不到中间态）
  - `llm/stream` waterfall：每次流式调用都过一条可拦截链——中间件能读请求、改写、甚至**短路**（yield 自己的 chunk 就不调 adapter）；日志/重放/mock 都挂在这
- 演示：注册 mock-deepseek / mock-openai 两个 adapter（各自 providerInfo + stream）；重复注册 → 报错且原注册不受影响；replace 原子切换路由（打印切换前后 listProviders）；waterfall 链：一个"请求日志中间件"（打印 provider/model）+ 一个"mock 短路中间件"（不真调 adapter，直接 yield 一个 text-delta + finish）→ 展示短路效果
- 对应源码：`llm/llm/src/index.ts`（registerAdapter / commitRoutes / stream + streamWithRegistration 的 ctx.waterfall）
- 必须写：注册表、all-or-nothing 校验、replace、简化 waterfall 链（函数数组即可，不必引入 Cordis）
- 可省略：registerConfigurableProviders / discoverModels / listModels / resolveModelInfo（可只留签名注释或不写）

### Step 05 — `step-05-call-config-resolution.ts`

**调用配置解析：为什么发请求前要先"对一下模型能力"？**

- 核心机制：
  - `resolveCallFor`：按精确模型能力解析配置——请求的 reasoningEffort 模型不支持 → 提前抛 UNSUPPORTED_REASONING_EFFORT（**不发浪费的请求**）；maxTokens 没填但模型有 defaultMaxTokens → 物化默认值；模型有默认 effort → 落定
  - `deepFreeze`：解析后的配置深冻结，**请求发出后不可变**（缓存复用键稳定，防止静默漂移）
  - prepared call 单次派发：prepareCall 绑定注册快照 + 冻结配置，stream() 只能调一次、config 必须一致 → INVALID_PREPARED_CALL（**HMR 时能力解析和派发不能跨 adapter 混搭**）
- 演示：一个带 reasoning 元数据（efforts + defaultEffort）的模型 → 请求不带 effort 自动落定默认、请求支持的 effort 通过、请求不支持的 → 抛错；maxTokens 物化演示；deepFreeze 后修改 → 抛错；prepared call 二次 stream / 换 config → INVALID_PREPARED_CALL
- 对应源码：`llm/llm/src/index.ts`（resolveCallFor / resolveModelInfoFor / prepareCall）+ `call-config.ts`（callConfigEquals / deepFreeze）
- 必须写：resolveCallFor 核心逻辑（effort 校验 + maxTokens 物化）、deepFreeze、prepared call 单次派发
- 可省略：AdapterDefaults 记录（reasoningEffort/maxTokens 物化标记）可简化说明

### Step 06 — `step-06-failure-normalization.ts`

**错误归一化：adapter 边界为什么是"最后的故障翻译点"？**

- 核心机制：
  - adapter 抛出的东西千奇百怪（SDK Error、字符串 throw、带 getter 的宿主对象）——`normalizeLlmFailure` 统一归一化成结构化 `LlmFailure`（message / code / status / providerRetryAfterMs / requestId 五字段序列化事实）
  - **只信任 Harness 自己的 code taxonomy**：第三方 SDK 的 code 不是我们的分类，一律归 `UNKNOWN`（防 SDK 错误码混入错误路由/重试判定）
  - 归一化后**变成终态 finish chunk**（`{kind:'error', failure}` 或 `{kind:'aborted'}`）而不是向上 throw——消费者只 switch finish.kind，流协议永远完整
- 演示：抛 HarnessError（带 code）、抛普通 Error、抛字符串、抛带恶意 getter 的对象 → 全部归一化成标准 failure 打印；流中途抛错 → 终端 error chunk；signal.aborted → aborted chunk；演示消费者 switch finish.kind 统一处理
- 对应源码：`llm/llm/src/adapter-failure.ts` 全文 + `index.ts`（adapterStream：adapter 选择/派发/迭代失败全部变终态 chunk）
- 必须写：normalizeLlmFailure 核心（Error 判断 + 序列化五字段 + 非 Harness code 归 UNKNOWN）、终态 chunk 演示
- 可省略：ownFailureSnapshot 对跨包错误对象的 getter 防御细节（可一笔带过或简化）

### Step 07 — `step-07-retry-policy.ts`

**重试策略与执行器：怎么重试才不浪费、不雪崩？**

- 核心机制：
  - **策略与执行分离**：provider 注册时捕获策略（`ResolvedRetryPolicy`）——normal 模式限次重试指定错误码（默认 RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE）/ always 模式无限重试；执行器挂在 `agent/request-error` 扩展点
  - **指数退避 + 对称 jitter**：initialDelayMs 500 起、2 倍指数、maxDelayMs 上限、jitterRatio 0.1 抖动（防同时重试打爆供应商）
  - **尊重 providerRetryAfterMs**：供应商明确说"等多久"就等多久；超过 maxDelayMs 时 normal 放弃（走 next()）、always 用本地退避
  - **重试计数从会话事件日志 derive**：`llm/retry` 事件找同 turn/step/provider/policyKey 的上次重试 → durable、重启不丢、防重复计数
- 演示：normal 策略 RATE_LIMIT 重试 2 次后成功（打印退避序列含 jitter）；AUTH（非 retryable）→ 不重试直接失败；always 模式连续失败一直重试（演示 3 次即可，注明真实是无限）；providerRetryAfterMs 覆盖本地延迟；同 step 第二次失败 → 事件日志 derive 出 retry=3 超限不再重试
- 对应源码：`llm/llm/src/retry-policy.ts`（resolveRetryPolicy）+ `llm/llm-retry/src/index.ts`（localDelay / recover / backoff）
- 必须写：两种策略解析、retryableCodes 判定、指数退避+jitter、事件日志计数（简化：内存数组模拟会话事件）
- 可省略：AbortSignal.any 融合、插件 dispose 生命周期（一笔带过）

### Step 08 — `step-08-token-meter.ts`

**token 估算：为什么发送前就要知道大概多少钱？**

- 核心机制：**固定密度启发式**——4 chars/token + 每块结构 overhead 4 + role overhead 4；递归估算嵌套 tool-result；同一估算逻辑被 meter 服务和上下文投影共用（**同内容同价格，两个表面数字一致**）；精确 tokenizer 贵又慢，启发式够用于预算管理
- 演示：估算 text / reasoning / tool-call / 嵌套 tool-result 消息 → 打印 token 数；估算整个 messages 数组（含 role overhead）；对照"启发式估算 vs 模拟精确计数"的差异，说明取舍（预算管理不需要精确，需要快和一致）
- 对应源码：`llm/token-meter/src/estimate.ts` 全文（可以接近完整复刻）
- 必须写：estimateContent / estimateMessage 递归逻辑、演示输出
- 可省略：projection / surface-fold 等投影部分（不属于本步）

## 工程要求

1. **目录结构**：`articles/dsh-llm/src/steps/step-01~08-*.ts` + `articles/dsh-llm/package.json`
2. **package.json**（对齐 dsh-memory）：name `@articles/dsh-llm`，纯 Node 无依赖（只用 tsx 跑），scripts：`run:dsh-llm` → step-08、`step:01`~`step:08` 各自映射
3. **根 package.json**：追加 `run:dsh-llm`（对齐 `run:dsh-tools`）+ `llm:step:01`~`llm:step:08`（对齐 `tools:step:NN` / `memory:step:NN` 模式）
4. **代码风格**（严格对齐样本）：
   - 每个文件顶部 JSDoc **四段式**：① 这一步解决什么问题（痛苦场景，新手做法 vs 正解）② 为什么 harness 这么设计（哲学思想）③ 好处/收益 ④ 对应源码（文件:行号）+ 跑法。参考 `articles/dsh-memory/src/steps/step-01-session-log.ts` 的开头写法
   - 简化实现，但机制和命名忠于源码；关键注释标注"对应源码 xxx"
   - 教学性：每步 main() 演示多种情况（正常/异常/边界），console.log 输出清晰、有 emoji 前缀（✅🚫❓⚠️ 等，对齐样本）
   - 用 `export {}` 结尾
   - 全程 TS 严格模式友好（不要 any 泛滥），能过 ESLint（typescript-eslint + prettier）
5. **验证**：写完必须逐个跑通 `pnpm run llm:step:01` ~ `llm:step:08`（在 ai-agent-code-lab 根目录），确保无类型错误、无运行时崩溃，输出有教学价值
6. **README**：在 ai-agent-code-lab/README.md 的文章列表追加第五篇（文章名《LLM 层》，飞书链接先留 TODO 占位，分析文档链接 `docs/dsh-llm-analysis.md`）；渐进式步骤表追加精读五区块（8 行，每行：step 链接 + 一句话机制 + 跑法 `pnpm run llm:step:NN`）

## 输出要求

1. 直接创建/修改上述文件，不要只给方案
2. 完成后逐个跑通验证，报告每步的输出摘要（一两行即可）
3. 总结里说明：每步复现了源码的哪个核心机制、与真实源码的差异（简化了什么）——方便 reviewer 核对
4. 如有拿不准的源码行为，以真实源码为准，并在总结里指出

## 验收标准

- [ ] articles/dsh-llm/ 8 个 step 文件齐全，结构对齐 dsh-tools/dsh-memory/dsh-context
- [ ] 根目录 `pnpm run llm:step:01`~`llm:step:08` 全部跑通（tsx）
- [ ] 每步注释标注了对应源码位置（可追溯到 packages/llm/ 真实路径）
- [ ] step-01 展示了两种供应商 wire 流翻译成统一 chunk 词汇表（核心循环只写一遍）
- [ ] step-02 完整复刻 BlockAssembler 容错语义（delta-only / block-end 冻结 / 迟到忽略 / max-tokens 过滤 tool-call）
- [ ] step-03 冻结消息修改抛错 + MessageSource 溯源演示
- [ ] step-04 注册表 all-or-nothing + 原子 replace + waterfall 短路演示
- [ ] step-05 不支持的 reasoningEffort 提前拒绝 + maxTokens 物化 + prepared call 单次派发
- [ ] step-06 各种 throw 归一化成结构化 failure + 终态 finish chunk（不向上 throw）
- [ ] step-07 两种重试模式 + 指数退避 jitter + providerRetryAfterMs + 事件日志 derive 计数
- [ ] step-08 token 启发式估算递归逻辑完整
- [ ] README 已更新（文章列表 + 步骤表 8 行）
