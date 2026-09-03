# Qoder 任务：精读（五）配套复现——articles/dsh-subagent 8 步渐进式子代理编排

## 你的角色（三重身份，融合到每一行代码和注释里）

1. **资深 AI Agent 工程师**：写的代码要体现生产级 Agent 框架的设计取舍——不只是"能跑"，要让人看出"为什么这么设计"（权限边界、递归防护、可观测性、生命周期所有权）。
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。每步代码必须能独立运行、输出教学性结果，注释要讲清楚"这一步在解决什么问题、不这么做会怎样"。
3. **DeepSeek Harness 资深源码研究者**：所有简化实现必须忠实于真实源码的机制和命名，注释标注对应源码文件:行号，不能凭空发明与源码不符的行为。

## 项目背景

仓库 `~/workspace/ai-agent-code-lab` 是 **DeepSeek Harness 源码精读系列**的复现仓库：每篇精读 = 分析文档（docs/*.md）+ 渐进式从 0 复现的可运行 TS 代码（articles/dsh-xxx/src/steps/step-01~NN.ts）。

已完成的模式（**必须对齐的风格样本，先读再写**）：

- `articles/dsh-memory/src/steps/step-01-session-log.ts`（最新一期风格标杆：顶部注释四段式 + 类型驱动 + 每步独立可跑）
- `articles/dsh-context/src/steps/step-01-system-prompt-registry.ts`
- `articles/dsh-tools/src/steps/step-01-minimal-pipeline.ts`

已完成的 package.json 模式：

- `articles/dsh-memory/package.json`（@articles/dsh-memory，纯 Node 无外部依赖，tsx 跑，每步一个 script）

**⚠️ 本系列复现全部为纯自实现 TS，不需要真实 dsh 依赖、不需要 LLM API key**——机制（注册表/seed/深度/权限/事件/续对话）全部自己用最小代码实现，模型调用用"模拟 agent"（收到 prompt 立即产生确定性回复）代替。参考 `articles/dsh-memory` 的做法。

## 任务

为精读五《子代理编排》创建配套复现 `articles/dsh-subagent/`，8 步渐进式。

### 必读材料（动笔前先读，读懂再写）

1. **机制主线笔记（教学设计蓝本）**：`~/workspace/deepseek-harness-study/notes-subagent-summary.md` —— 完整拆解了子代理域 11 个子包的三层边界（核心 seam / provider 实现 / 消费工具）和 12 个主题，含源码行号锚点。重点读「0. 源码地图」和「1~11」各节。
2. **真实源码（对照核实，不要凭记忆写）**：`~/workspace/deepseek-harness-study/source/packages/subagent/`
   - `subagent/src/types.ts`（对外契约：SubagentProvider / SubagentRun / SubagentResult / SubagentCapabilities / SubagentStopReason）
   - `subagent/src/index.ts`（SubagentRuntime：registerProvider / start / assertCapabilities / startContinuable / followup）
   - `subagent/src/depth.ts`（delegationDepthOf / assertSubagentMaxDepth）
   - `subagent/src/child-agent.ts`（resolveChildDepth / childSessionMeta / applyChildComposition / captureDelegatedPolicyOverrides / appendDelegatedPolicyOverrides）
   - `subagent/src/lifecycle.ts`（observeRun：start/end 事件配对）
   - `subagent/src/continuation.ts`（SubagentContinuationManager：startContinuable / followup / coldResume / materialize）
   - `subagent-fork-in-process/src/index.ts`（completedTurnPrefix：seed 截到最后一个 turn/end）
   - `subagent-spawn-in-process/src/index.ts`（fresh child，零父上下文）
   - `tool-subagent/src/index.ts`（providerWording：按 inheritsParentContext 区分文案；mount：provider 生命周期镜像）
   - `tool-subagent-report/src/index.ts`（report 工具：scope-local 回传）
   - `tool-subagent-control/src/index.ts`（send_message / interrupt_agent）

## 8 步规格（文件名 + 学习目标 + 核心机制，按此实现）

每步一个独立可运行文件，**从最小骨架逐步加机制**，与笔记主线对应。顶部注释用 dsh-memory 的四段式风格（── 先懂几个词 / 这一步解决什么问题 / 为什么这么设计 / 收益 + 对应源码 + 跑法）。

### Step 01 — `step-01-provider-registry.ts`

**子代理为什么要做成"注册表 + 可插拔 provider"而不是写死一种实现？**

- 核心机制：
  - `SubagentProvider` 接口：`{ name, capabilities, inheritsParentContext, start(request) }`
  - `SubagentRuntime`（简化）：`registerProvider()` / `getProvider()` / `list()` / `start(name, request)`
  - `SubagentRun` = `{ id, result: Promise<SubagentResult>, dispose() }`；**发布边界**：发布前失败 → start() reject 并清理；发布后失败 → 通过 run.result 结算（stopReason 词汇：completed/aborted/error/max-tokens/refusal）
  - 重复注册同名 provider → DUPLICATE_PROVIDER 报错；不存在的名字 → NO_PROVIDER
- 演示：注册两个 mock provider（`spawn` 和 `acp`——acp 假装走"外部进程"），各自 start 一个模拟委托，打印 run 的 id/结果/stopReason；注册重名报错；start 不存在的 provider 报错
- 对应源码：`subagent/src/types.ts`（SubagentProvider/SubagentRun）+ `subagent/src/index.ts`（registerProvider/expectProvider）
- 必须写：provider 接口 + 注册表 + start 原语 + 发布边界语义（用注释 + 输出讲清"为什么 start reject 和 result 结算要分开"）
- 可省略：continuable 全部、capabilities 校验细节（Step 03 才讲）、事件（Step 06 才讲）

### Step 02 — `step-02-spawn-vs-fork.ts`

**spawn 和 fork 都是"派子代理"，差在哪？——委托的两种上下文哲学**

- 核心机制：
  - spawn = fresh child：自己的 Session、零父上下文（child 看不到父对话）
  - fork = seed child：把父 Session 的**已完成 turn 前缀**作为 seed 复制给 child（child 继承父对话上下文）
  - `completedTurnPrefix()`：seed 截到**最后一个 `turn/end`**——in-flight turn 排除（它的 subagent 调用还没结果，不能作为合法回放历史）
  - 父日志只记录 `tool/call` + `tool/result`（子代理最终输出），child 内部 step 不进父日志
- 演示：模拟父会话日志（几轮对话 + 一个正在进行的 turn），fork 一个 child 打印它继承的历史；spawn 一个 child 打印它是空的；演示 in-flight turn 不出现在 seed 里（注释解释为什么）
- 对应源码：`subagent-fork-in-process/src/index.ts`（completedTurnPrefix）+ `subagent-spawn-in-process/src/index.ts`
- 必须写：completedTurnPrefix 的"截到最后一个 turn/end"逻辑、spawn/fork 对比输出
- 可省略：真实 Session 事件系统（用简化日志数组即可）、persistence

### Step 03 — `step-03-capabilities.ts`

**能力声明 + fail loud：为什么不支持的请求要提前拒绝，而不是"接受后忽略"？**

- 核心机制：
  - `SubagentCapabilities = { outputSchema, depthLimit, toolFilter, persona }` 四个静态 flag（start 时特性）
  - `SubagentRuntime.start()` 委托前逐一校验请求字段 vs provider.capabilities，缺哪个抛 `UNSUPPORTED_CAPABILITY`——**绝不接受后忽略**（否则模型以为限制生效了）
  - **方法存在即能力**的对比：continuable 用可选方法 `prepareContinuable` 表示能力（TS narrowing 发现），不设独立 flag 防止与实现漂移（可只在注释讲，不必实现）
- 演示：一个"精简 provider"（capabilities 全 false）和一个"全功能 provider"（全 true）；向精简 provider 请求 persona → 提前抛 UNSUPPORTED_CAPABILITY；向全功能 provider 同请求 → 正常通过；打印"谁在什么时候拒绝的"
- 对应源码：`subagent/src/types.ts`（SubagentCapabilities）+ `subagent/src/index.ts`（assertCapabilities 方法）
- 必须写：四个 capability 声明 + assertCapabilities 校验循环 + fail loud 演示
- 可省略：outputSchema 结构化捕获机制（可一笔带过）、persona/toolFilter/maxDepth 的真实安装（Step 04 讲 maxDepth）

### Step 04 — `step-04-max-depth.ts`

**委托深度预算：怎么防止"子代理再派子代理"无限递归？**

- 核心机制：
  - delegationDepth：顶层 agent = 0，child = parent 的 depth + 1
  - 有效 depth = **max(持久化 header.delegationDepth, 运行时 options.subagentDepth)**——header 是 monotone floor：resume 时用新 options 从 0 算就会让 child 假装顶层再往下派，所以 header 说了算（**重启不能降低递归计数**）
  - maxDepth 是绝对上限：childDepth > maxDepth → start 拒绝（SubagentDepthError），不发布 child
  - 校验入参：负数/小数/-0/非有限/不安全整数全 reject（TypeError）
- 演示：root（maxDepth=2）派 child1 → child1 派 child2 → child2 想派 child3 被拒（打印 attemptedDepth=3 > maxDepth=2）；再演示"持久化 header 防作弊"：一个 header 记录 depth=2 的 child 用 options.subagentDepth=0 想重新委托 → 有效 depth 仍是 3（取 max），被拒
- 对应源码：`subagent/src/depth.ts`（delegationDepthOf/assertSubagentMaxDepth）+ `child-agent.ts`（resolveChildDepth）
- 必须写：depth 计算（取 max 语义）、maxDepth 拒绝、非法参数校验
- 可省略：真实 Session 持久化（用 mock header 对象演示 monotone floor 即可）

### Step 05 — `step-05-delegated-permission.ts`

**委托即权限快照：为什么子代理的 approval 要钉死 'never'？**

- 核心机制：
  - 委托边界是权限快照点：`captureDelegatedPolicyOverrides(parent)` 同步捕获父 session 的显式 sandbox override；`approvalPolicy` **钉死 'never'**（不读父的 approval 策略——后台 child 的审批升级是"没人看的阻塞"，与其造可见性机制不如让状态不可能出现）
  - 快照写成 child 自己 log 上的持久事件（`sandbox/mode` + `approval/policy`，source: 'delegation'）——cold resume 回放它，fork seed 的陈旧父策略输给它
  - **每个 child 被告知而非被坑**：child 的 system prompt 里有一条 delegation 声明（权限已固定、要审批的操作自动拒绝、需要更宽权限就报限制让父处理、别重试）
- 演示：模拟一个 child 尝试"需要审批的越权操作"（如改 sandbox 模式）→ 被确定性拒绝（policy='never'），打印拒绝原因 + child log 里的 delegation 事件；对比：如果没有钉死（继承父 'ask'）会发生什么（无人看的 pending）——注释解释
- 对应源码：`subagent/src/child-agent.ts`（captureDelegatedPolicyOverrides / appendDelegatedPolicyOverrides / SUBAGENT_DELEGATION_CONTEXT）
- 必须写：capture 钉死 never + append delegation 事件 + 越权拒绝演示 + delegation 声明文案
- 可省略：真实 ApprovalService（用一个 decide() 函数模拟即可）、sandbox 完整实现

### Step 06 — `step-06-lifecycle-events.ts`

**生命周期可观测：start/end 事件对怎么让子代理"看得见"？**

- 核心机制：
  - `observeRun()`：start 时发 `subagent/start`（runId + provider + child id），result 结算时发配对的 `subagent/end`（同 runId + stopReason + lastAssistantMessage）——**同一 runId 配对**，观察者看到统一词汇
  - provider 注册表广播 `provider-added` / `provider-removed`；消费方（工具）**镜像 provider 生命周期**而不是赌加载顺序：provider 在就注册工具、走就注销（异步状态不是同步状态——跨 fiber 依赖用事件，消除 load-order 需求）
  - listener 隔离：一个 listener throw 不饿死其他 listener（try/catch 包裹）
- 演示：实现一个极简事件总线（on/emit）；订阅 start/end；跑一次委托打印配对事件；注册/移除 provider 打印 added/removed；一个故意 throw 的 listener 不影响其他 listener 收到事件
- 对应源码：`subagent/src/lifecycle.ts`（observeRun / createLifecycleEmitter）+ `subagent/src/index.ts`（registerProvider 里的 ctx.effect）
- 必须写：start/end 配对（runId 关联）、provider-added/removed、listener 隔离
- 可省略：scoped dispatch（按父 agent 过滤）、continuable Activation observer（可提一句）

### Step 07 — `step-07-continuable.ts`

**从"一次性委托"到"可持续对话的子代理"：Session/Activation 分离 + inbox 单一 FIFO**

- 核心机制：
  - 结构：持久 Session（身份/转录/lineage/delegationDepth）→ 可选 live Activation（驻留 epoch，持一个 AgentHandle）→ Agent inbox 是唯一 turn FIFO（**单一排序权威**——不给两个队列）
  - Activation 不是 request/result/Task 边界：一个 Activation 可跑多个 FIFO turn；历史 Session 在 Activation 释放后零内存
  - `startContinuable(spec)` → 保留 childId → 创建/恢复 Agent → `followup(initialPrompt)` → inbox 接受返回 `{ childId, messageId }`（不等 turn 开始）
  - `followup(parent, childId, content)`：live Activation 在 → 直接入 inbox（running 排队 / waiting 唤醒）；不在 → **cold resume**（从持久 Session 重建 Activation）
  - 冷恢复授权：只有 durable child 的 **exact live direct parent** 能继续它
- 演示：简化实现 Activation 表（Map<childId, {handle, inbox}>）+ cold resume（模拟"进程重启"：清空 Activation 表但保留 Session 存储 → followup 自动重建）；先 startContinuable 派一个 child → followup 追加一轮对话 → 模拟重启 → 再 followup → 打印每轮输出，证明同一 Session 持续
- 对应源码：`subagent/src/continuation.ts`（startContinuable L403 / followup L476 / coldResume L883 / materialize L966）
- 必须写：Session/Activation 两层结构、followup 三分支（running/waiting/absent→cold resume）、exact live parent 授权
- 可省略：interrupt / report / drain / ownedChildren 全图（Step 08 讲 report）、真实持久化（内存 Map 模拟重启清 Activation 即可）

### Step 08 — `step-08-report-and-assembly.ts`

**child 怎么把结果送回父？——report 显式回传 + 总装**

- 核心机制：
  - `report` 工具只装在 **continuable in-process child**（scope-local：roots/one-shot/remote 看不到也执行不了——可见性与权威一致）
  - `reportFrom(child, content)`：exact live child 是发送凭证，service 从持久 `parentSession` 推导唯一接收者（不接受调用方选 recipient/ancestor）——**嵌套汇报只跨一条边**（grandchild → 它的 direct child parent）
  - report 是协作控制不是结果包装：成功不结束 turn、不结算 Activation、结束 turn 也从不自动 report；child 被指导"结束前调一次 report，自包含结果"
  - quiet vs wakeup 投递（可简化：都做成"父收到一条消息"）
- 演示：**总装 demo**——主 agent 并行派 2 个子代理（fork 一个带上下文的、spawn 一个独立调研的），每个 child 干活后用 report 把自包含结果送回父，父汇总打印；再演示"越级汇报被拒"（grandchild 想直接 report 给 root → 只能给它 direct parent）
- 对应源码：`tool-subagent-report/src/index.ts`（installReportTool）+ `subagent/src/continuation.ts`（reportFrom L583 / authorizeReporter L596）
- 必须写：report 单边投递语义（child→direct parent）、scope-local 安装（注释 + 演示）、越级汇报拒绝、双 child 并行汇总总装
- 可省略：settlement notice（manager 自动结算投递）细节、interrupt、后台 Task 集成（注释提一句即可）

## 铁律（对齐系列，必须遵守）

1. **每步独立可运行**：`cd articles/dsh-subagent && pnpm run step:0X` 能直接跑出教学性输出；不依赖上一步的文件（可复制少量公共代码，或用每步顶部注释说明）
2. **顶部注释四段式**：── 先懂几个词 / 这一步解决什么问题（痛苦场景）/ 为什么这么设计（哲学思想）/ 收益，结尾注明对应源码文件:行号 + 跑法
3. **代码注释即教学**：关键行为旁边用注释讲"为什么"（不这么做会怎样），像 dsh-memory step-01 那样
4. **忠实源码机制**：命名和机制对齐真实源码（SubagentRun/SubagentResult/stopReason/capabilities/delegationDepth/completedTurnPrefix/Activation/reportFrom），不发明源码没有的行为；拿不准的看必读材料里的源码文件
5. **纯自实现零依赖**：只用 Node 内置 + tsx；不需要真实 dsh 包、不需要 LLM API key（模拟 agent 回复用确定性文本，如 `[模拟 child ${id}] 收到任务：...，已完成`）
6. **输出教学性**：console.log 用清晰分隔（参考 dsh-memory 的 ── 分隔和 ✅/❌/🔍 标记），让初学者一眼看到"这步证明了什么"
7. 完成后自检：每步单独 `tsx src/steps/step-0X.ts` 跑一遍确认无报错；`package.json` 补好 scripts；根目录 `package.json` 的 `run:dsh-subagent` 总入口指向 step-08

## 交付物

- `articles/dsh-subagent/package.json`（@articles/dsh-subagent，scripts: step:01~08 + start）
- `articles/dsh-subagent/src/steps/step-01-provider-registry.ts` ~ `step-08-report-and-assembly.ts`
- 自检报告：每个 step 的实际运行输出贴到任务回复末尾
