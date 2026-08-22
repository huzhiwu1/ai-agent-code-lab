# Qoder 任务：重构 articles/dsh-tools —— 从"7 步渐进式复现"改为"设计哲学 + AB 对比 demo"

## 为什么改（背景）

用户反馈：ai-agent-code-lab 里 dsh-tools 的 7 步渐进式复现（7 个文件共约 2400 行）太重了，学习负担大。用户的核心诉求不是"从 0 实现 DeepSeek Harness 的全部能力"，而是**理解它的设计哲学**——为什么这么设计、有什么好处。dsh-agent-loop 能看懂是因为顺序逻辑符合直觉；工具管线的机制都是反直觉的（参数要冻结、守卫只能拒绝不能放行），必须先讲"不这么做会崩在哪"，再给最小代码。

**新形态：每个知识域 = 一页哲学讲解 + 1~2 个最小 AB 对比 demo**（追求精简，不写死行数，能讲清设计哲学即可）。同一场景跑两遍——朴素版（直接调函数）vs 管线版（harness 六段管线），输出对比，一眼看出设计好处。

## 精简原则（重要，避免你写完又反复自我压缩）

- **不写死具体行数**，以"讲透设计哲学"为准，尽量精简，但不是牺牲可读性去压行数——写完就是终稿，不要回头反复压缩
- **明确可省略的内容**（这些可一笔带过或不写）：取消体系 ABORTED 两种状态、并行调度、Scope 可见性、Code Mode、token 身份 brand type 的完整实现——这些不是本次核心，注释里提一句即可
- **必须写的内容**：参数物化（冻结）、审批瀑布、单调守卫、超时环绕、post-execute 脱敏——这是本次要传达的哲学核心
- **给你发挥空间**：演示场景、console 输出文案、代码组织方式（一个文件还是拆两个）你自行决定，只要满足"AB 对比清晰 + 教学性强"

## 你的角色（三重身份）

1. **资深 AI Agent 工程师**：代码体现生产级设计取舍，不追求覆盖全部机制，只挑"最能说明设计哲学"的核心机制
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。注释讲清楚"这一步在解决什么问题、不这么做会怎样"，输出教学性结果
3. **DeepSeek Harness 资深源码研究者**：简化实现忠实于真实源码的机制和命名，注释标注对应源码文件:行号

## 必读材料（动笔前先读）

1. **现有实现**（读懂的机制，不要照抄重）：
   - `articles/dsh-tools/src/steps/step-01-minimal-pipeline.ts`（六段管线骨架）
   - `articles/dsh-tools/src/steps/step-02-arg-materialization.ts`（参数物化：lossless 快照 + 冻结 + token）
   - `articles/dsh-tools/src/steps/step-03-approval-pipeline.ts`（pre-execute 瀑布 allow/deny/ask）
   - `articles/dsh-tools/src/steps/step-04-monotonic-guards.ts`（单调守卫：只能拒绝）
   - `articles/dsh-tools/src/steps/step-06-timeout-policy.ts`（超时环绕）
   - `articles/dsh-tools/src/steps/step-05-cooperative-cancel.ts`（取消）、`step-07-parallel-scheduler.ts`（并行调度，了解即可）
2. **分析文档的哲学讲解**：`docs/dsh-tools-analysis.md`（重点看六段管线每站的"为什么"、取消体系、并行调度、回头看六原则）
3. **真实源码**（对照核实）：`~/workspace/deepseek-harness-study/source/packages/core/tools/src/index.ts`（createExecution / pre-execute / ToolGuard / tools/execute 环绕 / post-execute / finalizeContent）

## 核心设计哲学（demo 必须传达的，按优先级）

1. **参数物化**：参数先在历史/审计/UI 出现过，执行时改参数 → 三个读者三个版本。所以快照 + 递归冻结 + 不透明 token，有损参数（undefined/函数/循环引用）fail-closed 拒绝
2. **pre-execute 审批瀑布**：allow / deny / ask 三态，任一 hook 短路即终止——模型不能直接执行危险工具
3. **单调守卫**：守卫只能返回拒绝理由（string | undefined），**没有 allow 分支**——"listener ordering cannot turn a denial back into permission"，注册顺序永远不会把拒绝翻回许可
4. **execute 环绕 + 超时**：超时是"包一层"，不是工具自己实现的——任何工具自动获得超时能力
5. **post-execute 接受/替换/阻止**：执行结果也要过一道门（值校验、脱敏、重渲染）
6. **取消体系**：ABORTED（执行中被取消）vs ABORTED_BEFORE_DISPATCH（还没开始就被取消）——区分"做到一半"和"压根没做"

## 任务：重写 articles/dsh-tools

### 新目录结构

```
articles/dsh-tools/
├── package.json          # 更新 scripts（见下）
├── README.md             # 可选：一句话说明本包是什么
└── src/
    ├── demo-01-naive.ts      # 朴素版：直接调函数，展示四个崩点
    └── demo-02-pipeline.ts   # 管线版：六段管线最小实现，同一场景，展示 harness 怎么救
```

**删除原 `src/steps/` 目录**（git 历史可恢复，不用留 archive）。

### demo-01-naive.ts（朴素版）

**学习目标**：先看到"没有管线"的世界有多危险——为 demo-02 的每一道关做铺垫。

演示场景：一个 agent 要调用两个工具 `read_file`（读文件）和 `delete_file`（删文件）。

朴素实现就是 `registry.get(name)(args)` 直接调。**四个崩点逐个演示**（每个崩点 console.log 输出"发生了什么 + 为什么危险"）：

1. **参数被改**：调用方传入 args 对象，工具执行是异步的，在 await 期间外部把 `args.path` 改了 → 工具执行用的不是"被展示给用户/记入日志"的那份参数（演示：先打印"模型说要删 A"，await 中改成 B，实际删了 B）——**审计无法自证**
2. **无审批**：`delete_file` 直接执行，没有任何人确认——模型被 prompt injection 诱导时直接删库跑路
3. **超时挂死**：一个慢工具（模拟 5s），没有超时，调用方无限等待——单次卡死拖垮整个 agent
4. **无取消**：无法在工具执行中取消——用户说"停"也没用

输出格式：每个崩点一段 `💥 崩点 N：标题` + 现象 + 一句"这就是为什么需要 XXX"。

### demo-02-pipeline.ts（管线版）

**学习目标**：用最小六段管线把 demo-01 的四个崩点逐个救回来——看到每道关存在的理由。

实现要点（忠实源码语义，简化 Cordis 为数组）：

- 六段结构：① 参数物化（JSON 化验证 + 快照 + deepFreeze + 不透明 token）→ ② pre-execute 瀑布（allow/deny/ask）→ ③ 单调守卫（只能拒绝）→ ④ execute 环绕（超时包装）→ ⑤ post-execute → ⑥ 最终化返回
- 注册表强制 `output` 声明（schema + render），未知工具返回 isError 而不是崩溃
- 演示流程（与 demo-01 同一场景、同一批调用，形成对照）：
  1. **参数物化**：调用方在 await 期间改原对象 → 执行用的是冻结快照，不受影响；打印"参数已冻结，外部修改无效"
  2. **审批**：`delete_file` 注册时声明需要审批 → pre-execute 返回 ask → 演示"挂起等待用户确认"（简化：确认后放行，拒绝则终止）；`read_file` 不需要审批直接放行
  3. **守卫**：注册一个守卫"禁止删除 `AGENTS.md`"→ 尝试删 `AGENTS.md` 被拒；再演示守卫无 allow 分支（类型上只有 string | undefined），注释解释为什么
  4. **超时**：慢工具包上 500ms 超时 → 超时返回 isError，调用方不挂死
  5. **post-execute**：`read_file` 结果经 post-execute 脱敏（把内容里的密钥 `sk-xxx` 替换成 `***`）→ 演示结果被改写
- 输出格式：每个救场一段 `✅ 救场 N：标题` + 现象 + 一句"这就是 XXX 的设计"。

### package.json scripts

```json
{
  "name": "@articles/dsh-tools",
  "version": "1.0.0",
  "private": true,
  "description": "工具调用管线设计哲学：朴素版 vs 六段管线版 AB 对比 demo（复现 DeepSeek Harness 工具执行管线核心机制）",
  "scripts": {
    "start": "tsx src/demo-02-pipeline.ts",
    "run:dsh-tools": "tsx src/demo-02-pipeline.ts",
    "demo:naive": "tsx src/demo-01-naive.ts",
    "demo:pipeline": "tsx src/demo-02-pipeline.ts"
  }
}
```

### 根 package.json 清理

- 删除 `tools:step:01` ~ `tools:step:07` 共 7 个脚本
- 加 `run:dsh-tools`（如已有则保持指向 demo-02-pipeline）
- 加 `tools:demo:naive` → `tsx articles/dsh-tools/src/demo-01-naive.ts`、`tools:demo:pipeline` → `tsx articles/dsh-tools/src/demo-02-pipeline.ts`

## 代码风格（严格对齐现有样本）

- 每个文件顶部 JSDoc：**学习目标**（2-4 句，讲清"这一步在解决什么问题"）+ **对应源码**（文件:行号）+ **跑法**
- 关键注释标注"对应源码 xxx"；简化实现但机制命名忠于源码
- 教学性：main() 演示多种情况（正常/异常/边界），console.log 清晰、emoji 前缀（💥✅🚫⏱️ 等）
- `export {}` 结尾；TS 严格模式友好，能过 ESLint（typescript-eslint + prettier）
- 纯 Node 无依赖，只用 tsx 跑，不需要 API key

## 验证

写完必须逐个跑通（在 ai-agent-code-lab 根目录）：

- `pnpm run tools:demo:naive`（或 `pnpm run demo:naive`）
- `pnpm run tools:demo:pipeline`（或 `pnpm run demo:pipeline`）
- 确认无类型错误、无运行时崩溃、输出有教学价值、两个 demo 形成清晰对照

## 输出要求

1. 直接创建/修改文件，不要只给方案
2. 跑通验证后报告两个 demo 的输出摘要（各 2-3 行）
3. 总结：每个救场对应源码的哪个机制、简化了什么——方便 reviewer 核对
4. 如有拿不准的源码行为，以真实源码为准并在总结里指出

## 验收标准

- [ ] `articles/dsh-tools/src/steps/` 已删除，替换为 demo-01-naive.ts + demo-02-pipeline.ts
- [ ] 精简优先：没有为凑行数注水，也没有压缩到牺牲可读性；注释标注对应源码位置
- [ ] demo-01 演示 4 个崩点，demo-02 用同一场景逐个救场，输出对照清晰
- [ ] 核心哲学传达：参数冻结 / 审批瀑布 / 单调守卫（无 allow）/ 超时环绕 / post-execute 脱敏
- [ ] 根 package.json 的 tools:step:* 已清理，demo 脚本可用
- [ ] 根目录 `pnpm run tools:demo:naive` 和 `pnpm run tools:demo:pipeline` 都跑通
