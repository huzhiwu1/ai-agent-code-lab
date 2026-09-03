# Qoder 任务：重构 articles/dsh-subagent —— 每步加对照组 + 多文件拆分

## 为什么改（背景）

用户反馈（2026-09-03）：`articles/dsh-subagent` 的 8 步复现代码有两个问题：

1. **没有对照组**：对比系列里重构过的 `articles/dsh-tools`，dsh-tools 每步都先演示"朴素做法会怎样"（如 step-01 的 `naiveCall` 直接调函数对照、step-04 的"假设守卫能放行"反例），让读者先看到**不这么设计会出什么问题**，再引出 harness 的设计。dsh-subagent 现在的每步只有"正确实现 + 输出"，缺了"错误前提 → 事故现场 → 设计如何解决"的教学弧线。
2. **单文件太大**：8 个文件每个 200~372 行（共约 2300 行）。类型定义、机制实现、LLM 客户端、演示 main 全塞一个文件，单文件阅读负担重。

**保留 step-1~N 渐进式格式，保留每步"机制自实现 + child 干活走真实 LLM"的铁律**，重构目标是：每步加"对照组"演示、把大单文件拆成多个聚焦单一关注点的短文件（原版 200~372 行的大单文件消除，具体拆多细你自己把握）。

## 你的角色（三重身份）

1. **资深 AI Agent 工程师**：代码体现生产级设计取舍。对照组不是凑字数——对照组要真实暴露"朴素方案在什么场景下崩、怎么崩、代价是什么"，harness 方案要展示它如何精确补上那个洞。
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。每步的教学弧线必须是：**先看朴素做法翻车 → 再看 harness 为什么这么设计 → 收益是什么**。注释讲清"不这么做会怎样"。
3. **DeepSeek Harness 资深源码研究者**：简化实现忠实于真实源码的机制和命名，注释标注对应源码文件:行号，不发明源码没有的行为。

## 必读材料（动笔前先读，读懂再写）

1. **对照组写法标杆**（最重要，先精读这两处再动笔）：
   - `articles/dsh-tools/src/steps/step-01-pipeline-skeleton.ts`：朴素实现 `naiveCall`（直接调函数、无任何关卡）vs 六段管线骨架——**同一个动作两条路，对照输出**
   - `articles/dsh-tools/src/steps/step-04-monotonic-guard.ts`：反例段"假设守卫能返回 allow → 注册顺序决定结果，守卫互相踩"
   - `articles/dsh-tools/src/steps/step-06-post-execute.ts`：场景对照（干净内容 accept / 含密钥 replace / 敏感字段 block）
2. **现有实现**（读懂机制，全部重写组织结构）：
   - `articles/dsh-subagent/src/steps/step-01-provider-registry.ts` ~ `step-08-report-and-assembly.ts`（8 个单文件，约 2300 行）
3. **机制主线笔记（教学设计蓝本）**：`~/workspace/deepseek-harness-study/notes-subagent-summary.md`（11 主题 + 源码行号锚点，重点「0. 源码地图」和「1~11」）
4. **真实源码（对照核实）**：`~/workspace/deepseek-harness-study/source/packages/subagent/`
   - `subagent/src/types.ts`（SubagentProvider L285 / SubagentRun L249 / SubagentResult L219 / SubagentStopReasonMap L200 / SubagentCapabilities L86）
   - `subagent/src/index.ts`（registerProvider L369 / start L414 / expectProvider L449 / assertCapabilities L481-496）
   - `subagent/src/depth.ts`（delegationDepthOf L28-36 / assertSubagentMaxDepth L42-51，全文 51 行）
   - `subagent/src/child-agent.ts`（captureDelegatedPolicyOverrides L199-204 / SUBAGENT_DELEGATION_CONTEXT L135-139 / applyChildComposition L177-196）
   - `subagent/src/lifecycle.ts`（observeRun L133-162 / createLifecycleEmitter L100-123）
   - `subagent/src/continuation.ts`（startContinuable L403 / followup L476 / coldResume L883 / reportFrom L583 / authorizeReporter L596 / resolveReportParent L616）
   - `subagent-fork-in-process/src/index.ts`（completedTurnPrefix L48-54）
   - `tool-subagent-report/src/index.ts`（installReportTool L49）

## 新目录结构

**每步一个目录**，目录内拆文件（入口薄、机制独立、对照组独立）。跨步共享的 LLM 客户端抽到 `src/shared/`：

```
articles/dsh-subagent/
├── package.json                # scripts 指向各 step 目录的 index.ts（见下）
└── src/
    ├── shared/                 # 跨步共享（少量、克制，只放真正重复 3+ 次的东西）
    │   ├── llm.ts              # ChatOpenAI 客户端封装（读根 .env LLM_*，供各步 child 用）
    │   └── clip.ts             # 输出截断工具（clip(text, max)）
    └── steps/
        ├── step-01-provider-registry/
        │   ├── index.ts        # 入口：顶部四段式 JSDoc + main() 演示编排（薄，只组装场景）
        │   ├── types.ts        # 本步类型：SubagentProvider/Run/Result/StopReason/StartRequest
        │   ├── runtime.ts      # SubagentRuntime 注册表（registerProvider/expectProvider/start）
        │   ├── naive.ts        # 对照组：主循环写死 new ChildAgent
        │   └── providers.ts    # spawn / acp 两个 provider 实现
        ├── step-02-spawn-vs-fork/
        │   ├── index.ts        # 入口 + main
        │   ├── session.ts      # 简化 Session 日志（append/events）
        │   ├── prefix.ts       # completedTurnPrefix（截到最后一个 turn/end）
        │   ├── naive.ts        # 对照组：朴素 fork = 复制全日志（含 in-flight 鬼状态）
        │   └── children.ts     # spawnChild / forkChild（真实 LLM 执行器）
        ├── step-03-capabilities/
        │   ├── index.ts
        │   ├── types.ts        # SubagentCapabilities + StartRequest + Provider
        │   ├── runtime.ts      # SubagentRuntime.start + assertCapabilities（fail loud）
        │   ├── naive.ts        # 对照组：接受后忽略（不校验，persona 静默失效）
        │   └── providers.ts    # MinimalProvider（全 false）/ FullProvider（全 true）
        ├── step-04-max-depth/
        │   ├── index.ts
        │   ├── depth.ts        # delegationDepthOf / assertSubagentMaxDepth / resolveChildDepth
        │   ├── naive.ts        # 对照组①：无深度限制 → 无限递归；对照组②：重启后从 0 算 → 假装顶层
        │   └── chain.ts        # 委托链演示工具（makeChild / ROOT）
        ├── step-05-delegated-permission/
        │   ├── index.ts
        │   ├── policy.ts       # captureDelegatedPolicyOverrides / appendDelegatedPolicyOverrides
        │   ├── approval.ts     # decide(policy, operation) 极简审批裁决
        │   ├── naive.ts        # 对照组：继承父的 ask → 后台 pending 无人批准（死锁现场）
        │   └── session.ts      # ChildSession（append-only 日志）
        ├── step-06-lifecycle-events/
        │   ├── index.ts
        │   ├── bus.ts          # EventBus（on/emit + listener 隔离）
        │   ├── observe.ts      # observeRun（start/end 同 runId 配对）
        │   ├── naive.ts        # 对照组①：无事件，只能轮询内部状态；对照组②：工具赌加载顺序
        │   └── tool.ts         # 工具层镜像 provider 生命周期（added 注册/removed 注销）
        ├── step-07-continuable/
        │   ├── index.ts
        │   ├── store.ts        # SessionStore（持久 Session，模拟"磁盘"）
        │   ├── activation.ts   # AgentHandle / Activation / inbox
        │   ├── manager.ts      # ContinuationManager（startContinuable/followup/cold resume/授权）
        │   ├── naive.ts        # 对照组：每个 followup 新建 child → 重启丢上下文
        │   └── llm-child.ts    # child 真实 LLM 对话执行器
        └── step-08-report-and-assembly/
            ├── index.ts        # 总装 demo：双 child 并行 + report + 汇总（真实 LLM）
            ├── report.ts       # reportToolVisible（scope-local）/ reportFrom（单边投递 direct parent）
            ├── naive.ts        # 对照组：最后一条消息自动算结果（隐式协议，父要猜）
            └── manager.ts      # ContinuationManager 简化（child 表 + inbox + 越级拒绝）
```

**拆分纪律**：

- 入口 `index.ts` 只做"组装场景 + 打印"，核心逻辑都在被 import 的文件里；入口顶部保留四段式 JSDoc（── 先懂几个词 / 这一步解决什么问题 / 为什么这么设计 / 收益 + 对应源码 + 跑法）
- 机制文件只放机制，注释标注"对应源码 xxx:Lyyy"
- 对照组文件（`naive.ts`）结构统一：**朴素做法函数 + 注释说明它会怎么崩 + main 里先跑对照组看事故现场，再跑 harness 方案看如何解决**——输出里要能清楚看到"朴素版翻了什么车"
- 按"类型 / 机制 / 对照 / 演示"四个关注点切文件，每个文件聚焦单一关注点、阅读负担小即可；**具体文件怎么分、拆多细由你发挥**——不要为了凑数拆分（一个函数一个文件是过度设计），也不要为了压行数牺牲可读性（写完就是终稿，不回头反复压缩）
- `shared/llm.ts` 只放 ChatOpenAI 初始化 + invoke 封装（现有 8 个文件里重复的 `llmTask`/`childAnswer`/`childLlm` 等统一收敛到这里）；每步通过相对路径 `../../shared/llm.ts` 引用。**不要**把每步特有的机制代码塞进 shared

## 8 步规格：每步必须加"对照组"（核心改动）

> 通用要求：每步 main() 的演示顺序统一为 **A. 对照组（朴素做法 → 事故现场）→ B. harness 方案（如何解决）→ C. 收益小结（🎯 一句话）**。对照组可以用确定性假输出（它演示的是"错误行为"，不需要真实 LLM）；harness 方案的 child 干活必须走真实 LLM。

### Step 01 — provider registry（目录 `step-01-provider-registry/`）

**哲学点：子代理为什么要做成"注册表 + 可插拔 provider"？**

- **对照组（naive.ts）**：主循环里直接 `new ChildAgent()` 写死一种实现。演示"想加第二种运输方式（本地进程 → 远程 ACP）"时，代码必须到处加 `if (mode === 'acp')`；再加第三种时核心文件继续膨胀。输出：打印两段"伪代码演进"，让读者看到 if/else 地狱是怎么长出来的。同时对照**发布边界**：朴素版把"没派出去"和"干坏了"混成一个 try/catch 吞掉——调用方分不清"委托不存在"和"委托失败"。
- **harness 方案**：注册表 + 名字点单；发布前失败 reject（无 run）、发布后失败 result 结算 stopReason（result 永不 reject）。child 真实 LLM 干活。
- 对应源码：`types.ts`（SubagentProvider L285 / SubagentRun L249 / SubagentResult L219）+ `index.ts`（registerProvider L369 / start L414 / expectProvider L449）
- 保留演示：注册重名报错、start 不存在 provider 报错、⑦ 发布边界两种结局

### Step 02 — spawn vs fork（目录 `step-02-spawn-vs-fork/`）

**哲学点：委托的两种上下文哲学——fresh 干净 vs seed 继承，且 seed 只到最后一个 turn/end**

- **对照组（naive.ts）**：朴素 fork = **把父日志全量复制**（含 in-flight turn）。演示事故：父正在派另一个子代理（tool/call 已发出、结果未回），朴素 fork 把这个"调用已发出、结果不存在"的半本账复制给 child——打印 child 视角看到的日志，注释解释为什么这是一份 child 无法解释的损坏账本（事件不平衡）。
- **harness 方案**：`completedTurnPrefix` 截到最后一个 turn/end；spawn 空上下文 vs fork 有 seed，同一个追问两种结果（真实 LLM：fork 答得出父对话、spawn 答不出）。
- 对应源码：`subagent-fork-in-process/src/index.ts`（completedTurnPrefix L48-54）+ `subagent-spawn-in-process/src/index.ts`
- 保留演示：父日志记账纪律（child 内部 step 不进父日志，只记 tool/call + tool/result）

### Step 03 — capabilities（目录 `step-03-capabilities/`）

**哲学点：能力声明 fail loud，不接受后忽略**

- **对照组（naive.ts）**：朴素实现 = **不校验直接收下**。演示事故：父请求"给 child 装海盗人设"，provider 根本不支持 persona，但默默接受——child 收到的是普通 system prompt，开口不是海盗腔。输出：父 agent 以为人设生效、实际没生效的"信任崩塌现场"（父后来发现 child 行为完全没人设）。
- **harness 方案**：`assertCapabilities` 委托前逐项校验，缺能力抛 `UNSUPPORTED_CAPABILITY`（child 从未创建）；FullProvider 真实生效（海盗人设真的进 system prompt，child 真实 LLM 开口海盗腔）。附带对比设计：continuable 用"方法存在即能力"（prepareContinuable 可选方法 + TS narrowing），不设 flag 防漂移。
- 对应源码：`index.ts`（assertCapabilities L481-496）+ `types.ts`（SubagentCapabilities L86）

### Step 04 — max depth（目录 `step-04-max-depth/`）

**哲学点：委托深度是预算——发布前拒绝 + header 单调下限防重启作弊**

- **对照组（naive.ts）** 两个事故：
  - ① **无深度限制**：child 派 grandchild、grandchild 派曾孙……打印"无限递归"的委托树膨胀（到第 6 层就标注失控），没有预算 = 靠运气防递归。
  - ② **重启后从 0 算**：一个 header 已烙 depth=2 的 child，重启后用 options.subagentDepth=0 重新委托 → 它假装顶层继续往下派，递归预算失效。打印"重启作弊"前后对比。
- **harness 方案**：`delegationDepthOf` 取 max(header, runtime)（header 是 monotone floor）+ `resolveChildDepth` 超限发布前抛 `SubagentDepthError`；非法参数（负数/小数/-0/Infinity/NaN）TypeError。
- 对应源码：`depth.ts`（delegationDepthOf L28-36 / assertSubagentMaxDepth L42-51）+ `child-agent.ts`（resolveChildDepth）

### Step 05 — delegated permission（目录 `step-05-delegated-permission/`）

**哲学点：委托即权限快照——后台 child 的审批钉死 never，让挂起状态不可能出现**

- **对照组（naive.ts）**：朴素实现 = child **继承父的 approval 策略（ask）**。演示事故现场：后台 child 申请升级权限（改 sandbox 模式）→ 进入 pending → 打印"这条审批谁会批准？"——父 agent 不在 UI 前、人类看不到后台 child 的弹窗 → **任务永久卡死 + 一条无人认领的待审批记录**。这是全篇最重要的反例，要演足。
- **harness 方案**：委托边界 `captureDelegatedPolicyOverrides` 快照（sandbox 继承显式 override + approval 钉死 'never'）；快照写成 child log 持久事件（source: 'delegation'）；越权操作被**确定性拒绝**（decide('never') 直接 denied，不等人不排队）；child system prompt 带 delegation 声明（真实 LLM 回答"权限外怎么办"→ 说明限制让父处理、不重试）。
- 对应源码：`child-agent.ts`（captureDelegatedPolicyOverrides L199-204 / SUBAGENT_DELEGATION_CONTEXT L135-139 / appendDelegatedPolicyOverrides）

### Step 06 — lifecycle events（目录 `step-06-lifecycle-events/`）

**哲学点：run 的一生 = 一对同 runId 的 start/end 事件；消费方镜像 provider，不赌加载顺序**

- **对照组（naive.ts）** 两个事故：
  - ① **没有事件**：想知道子代理跑到哪了只能**轮询内部状态**——打印"轮询循环"的伪代码，展示没有边界时监控/日志/UI 各自猜的混乱。
  - ② **赌加载顺序**：工具层假设"provider 一定先于工具加载好"，直接写死文案——Cordis Loader 并发启动时 provider 没到，工具 description 就错了（fork 文案该说"继承对话"却说成"独立上下文"）。
- **harness 方案**：`observeRun` start/end 同 runId 配对（真实 LLM 跑一次委托打印配对事件）；provider-added/removed 广播 + 工具层镜像（在就注册、走就注销、缺席时工具不存在）；listener 隔离（坏 observer 不传染）。
- 对应源码：`lifecycle.ts`（observeRun L133-162 / createLifecycleEmitter L100-123）+ `index.ts`（registerProvider 的 ctx.effect）

### Step 07 — continuable（目录 `step-07-continuable/`）

**哲学点：Session（持久身份）与 Activation（进程内驻留）分离；重启丢驻留、不丢对话**

- **对照组（naive.ts）**：朴素实现 = **每个 followup 都新建一个 child**（没有持久 Session 概念）。演示事故：追问一轮 → 新 child 完全不记得上一轮（上下文丢失）；或者把 Task/run/result 当同一个对象生命周期 → 双 FIFO（Jobs 队列 + inbox）没有单一排序权威。挑最有教学性的一个演（推荐"每次追问都失忆"——最容易看懂）。
- **harness 方案**：startContinuable（建 Session + Activation，立即返回 { childId, messageId }）→ followup（live 在直接入 inbox；真实 LLM 记得上文）→ 模拟进程重启（清空 Activation 表、Session 存储保留）→ 再 followup（cold resume 成功，上下文仍在）→ 别的 agent 接管 → UNAUTHORIZED。
- 对应源码：`continuation.ts`（startContinuable L403 / followup L476 / coldResume L883 / materialize L966）
- 保留演示：授权依据是持久 parentSession lineage，不是"谁知道 childId"

### Step 08 — report + 总装（目录 `step-08-report-and-assembly/`）

**哲学点：回传是显式协议——report 单边投递 direct parent；scope-local 安装；越级被结构性拦住**

- **对照组（naive.ts）**：朴素实现 = **"最后一条消息自动算结果"**（隐式协议）。演示事故：父 agent 不知道 child 什么时候算"说完了"，只能猜——child 中间态消息被当成结论、或 child 干完没说话父永远等不到。打印"父在猜"的尴尬现场（两条消息，父无法判断哪条是最终结论）。
- **harness 方案**：report 工具 scope-local（root/one-shot/remote 不可见，continuable in-process child 可见）；`reportFrom` 接收者从持久 parentSession 推导（API 无 recipient 参数）；嵌套汇报只跨一条边（grandchild → direct parent，不跳级）；report 是协作控制（不结束 turn、不结算 Activation）。**总装 demo**：主 agent 并行派 2 个 child（fork 带上下文 + spawn 独立调研），真实 LLM 干活后各自 report，父真实 LLM 汇总。
- 对应源码：`tool-subagent-report/src/index.ts`（installReportTool L49）+ `continuation.ts`（reportFrom L583 / authorizeReporter L596 / resolveReportParent L616）

## package.json scripts（指向目录入口）

```json
{
  "name": "@articles/dsh-subagent",
  "version": "1.0.0",
  "private": true,
  "description": "子代理编排设计哲学渐进式复现：注册表/spawn-fork/capabilities/深度预算/权限快照/生命周期/continuable/report 总装（每步含朴素对照组，8 步）",
  "main": "src/steps/step-08-report-and-assembly/index.ts",
  "scripts": {
    "start": "tsx src/steps/step-08-report-and-assembly/index.ts",
    "run:dsh-subagent": "tsx src/steps/step-08-report-and-assembly/index.ts",
    "step:01": "tsx src/steps/step-01-provider-registry/index.ts",
    "step:02": "tsx src/steps/step-02-spawn-vs-fork/index.ts",
    "step:03": "tsx src/steps/step-03-capabilities/index.ts",
    "step:04": "tsx src/steps/step-04-max-depth/index.ts",
    "step:05": "tsx src/steps/step-05-delegated-permission/index.ts",
    "step:06": "tsx src/steps/step-06-lifecycle-events/index.ts",
    "step:07": "tsx src/steps/step-07-continuable/index.ts",
    "step:08": "tsx src/steps/step-08-report-and-assembly/index.ts"
  },
  "dependencies": {
    "@langchain/core": "^1.2.1",
    "@langchain/openai": "^1.5.3",
    "dotenv": "^17.4.2"
  }
}
```

根 `package.json` 的 `subagent:step:01` ~ `subagent:step:08` 同步指向新目录入口。

**替换原 `src/steps/` 下的 8 个单文件**（git 历史可恢复，不用留 archive；旧文件删除，新目录结构创建）。

## 代码风格（严格对齐现有样本）

- 入口文件顶部 JSDoc 四段式：── 先懂几个词 / **这一步解决什么问题**（痛苦场景，含"朴素做法会怎样"）/ **为什么 harness 这么设计**（哲学思想）/ **收益** + **对应源码**（文件:行号）+ **跑法**
- 每个机制文件的关键函数旁注释标注"对应源码 xxx:Lyyy"
- **对照组输出必须有"事故感"**：用 ⚠️/💥/🚫/❌ 标记朴素版翻车点，让读者一眼看到"这么写会崩在这里"
- 教学性输出：console.log 清晰分隔（── 分隔 + ✅/❌/🔍/🎯 标记），main() 场景顺序：A 对照组事故 → B harness 方案 → C 🎯 一句话小结
- 真实 LLM 调用统一走 `shared/llm.ts`；`export {}` 结尾（有 import 的模块自然有，无 import 的补上）；TS 严格模式友好，过 ESLint（typescript-eslint + prettier）
- 依赖保持现状：@langchain/openai + @langchain/core + dotenv，读根 .env 的 LLM_*

## 验证（必须逐个跑通）

在 ai-agent-code-lab 根目录跑：`pnpm run subagent:step:01` ~ `subagent:step:08`（或 articles/dsh-subagent 内 `pnpm run step:01` ~ `step:08`）。确认：无类型错误、无运行时崩溃、每步输出包含"对照组事故 + harness 方案 + 🎯 小结"三段、child 干活是真实 LLM 输出（不是"[模拟 child]"假回复）。

## 输出要求

1. 直接创建/修改文件，不要只给方案
2. 跑通验证后报告：每步 1-2 行输出摘要 + 对照组演示了什么事故 + 真实 LLM 输出的关键句
3. 总结每个 step 目录的文件清单（index/types/runtime/naive/...）—— reviewer 要拿它核对分析文档是否需要同步
4. 如有拿不准的源码行为，以真实源码为准并在总结里指出

## 验收标准

- [ ] `src/steps/` 下 8 个 step 目录，每步含独立 `naive.ts`（对照组）+ 薄入口 `index.ts` + 按关注点拆分的机制文件
- [ ] 原 200~372 行的大单文件已消除，每个文件聚焦单一关注点（类型/机制/对照组/演示），阅读负担明显下降；文件数量与拆分粒度合理，无过度拆分
- [ ] 每步 main() 输出三段式：对照组事故现场 → harness 方案 → 🎯 一句话
- [ ] 对照组真实暴露"朴素方案崩在哪"（不是凑数），与 harness 方案形成清晰对照
- [ ] 机制实现忠实源码（命名/机制/行号注释），child 干活走真实 LLM
- [ ] 根 package.json 的 `subagent:step:*` 指向新目录入口，8 步全部跑通
- [ ] 旧的 8 个单文件已删除（git 历史可恢复）
