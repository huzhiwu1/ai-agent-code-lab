# Qoder 任务：重构 articles/dsh-tools —— 渐进式理解设计哲学（每步一个哲学点）

## 为什么改（背景）

用户反馈：ai-agent-code-lab 里 dsh-tools 的 7 步渐进式复现（7 个文件共约 2400 行）太重了，学习负担大。问题不在"渐进式"这个形式（step-1~N 是好的），而在**节奏**——旧版每步塞了太多机制：step-02 一个文件里既有六段骨架又有参数物化又有 token 身份，读者一次要消化多个概念。

**保留 step-1~N 渐进式格式，但每步只解决一个问题**：一个小 step 讲透一个设计哲学点——为什么这么设计、好处是什么、哲学思想是什么、解决了什么问题、带来什么收益。宁可每步小而精，不要一步大而全。

## 你的角色（三重身份）

1. **资深 AI Agent 工程师**：代码体现生产级设计取舍，不追求覆盖全部机制，只挑"最能说明设计哲学"的核心机制
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。每步注释讲清"这一步在解决什么问题、不这么做会怎样、为什么 harness 这么设计、收益是什么"
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

## 精简原则（重要，避免你写完又反复自我压缩）

- **不写死具体行数**，以"讲透一个哲学点"为准。每步聚焦一个问题，代码量自然会小；写完就是终稿，不要回头反复压缩
- **可省略的内容**（一笔带过或不写）：取消体系 ABORTED 两种状态的完整实现、并行调度、Scope 可见性、Code Mode、token 身份 brand type——这些不是本次核心，注释里提一句"源码里还有 XXX，这里不展开"即可
- **必须写的内容**：六段管线骨架、参数物化（冻结）、审批瀑布、单调守卫、超时环绕、post-execute 脱敏——这是本次要传达的哲学核心
- **给你发挥空间**：每个 step 的演示场景、console 输出文案、如何复用前一步的代码（精简复用 or 独立自足）你自行决定，只要满足"每步一个哲学点 + 教学性强"

## 任务：重构 articles/dsh-tools

### 新目录结构

```
articles/dsh-tools/
├── package.json          # 更新 scripts（见下）
└── src/
    └── steps/            # 保留 step-1~N 渐进式格式（与 dsh-agent-loop/dsh-memory/dsh-context 一致）
        ├── step-01-pipeline-skeleton.ts    # 六段管线骨架
        ├── step-02-arg-freezing.ts         # 参数物化：为什么参数要"冻"起来
        ├── step-03-approval-waterfall.ts   # 审批瀑布：为什么危险工具要问人
        ├── step-04-monotonic-guard.ts      # 单调守卫：为什么守卫只能拒绝
        ├── step-05-timeout-wrap.ts         # 超时环绕：为什么超时是"包一层"
        ├── step-06-post-execute.ts         # post-execute：为什么结果也要过一道门
        └── step-07-full-pipeline.ts        # 整合：一次工具调用的完整旅程（串联前六步）
```

**替换原 `src/steps/` 下的 7 个旧文件**（git 历史可恢复，不用留 archive）。

### 每步的"哲学点"规格（渐进节奏，逐步深入）

#### Step 01 — `step-01-pipeline-skeleton.ts`

**哲学点：工具调用 ≠ 调个函数——为什么要引入"管线"这个概念？**

- 问题：模型说"调工具"，如果直接 `registry.get(name)(args)`，会有什么问题？（提示：安全、可靠性、审计，先提出问题不解决）
- 实现：最小六段骨架（参数物化 → pre-execute → 守卫 → execute 环绕 → post-execute → 最终化），数组模拟 Cordis 瀑布，每段留注释说明"这一站未来要干什么"
- 好处：先建立"一次工具调用要过六道关"的地图，后面每步填实一道关
- 对应源码：`packages/core/tools/src/index.ts` 的 execute() 主流程

#### Step 02 — `step-02-arg-freezing.ts`

**哲学点：为什么参数要"冻"起来？（物化）**

- 问题：参数已经出现在历史/审计/UI 里，执行时若允许改参数 → 三个读者三个版本，审计无法自证"当时到底执行了什么"
- 实现：JSON 化无损验证 + 快照克隆 + 递归冻结 + 不透明 token 身份；演示"调用方 await 期间改原对象 → 执行用的是冻结快照"
- 哲学：**执行身份隔离**——fail-closed，有损参数（undefined/函数/循环引用）在物化阶段就拒绝
- 对应源码：createExecution() / snapshotJsonValue() / deepFreeze() / createExecutionToken()

#### Step 03 — `step-03-approval-waterfall.ts`

**哲学点：为什么模型不能直接执行危险工具？（审批瀑布）**

- 问题：模型被 prompt injection 诱导时，delete_file 这种危险工具会被直接执行
- 实现：pre-execute 瀑布 allow / deny / ask 三态，任一 hook 短路即终止；演示 delete_file 挂起等确认（简化：确认放行 / 拒绝终止），read_file 直接放行
- 哲学：**人类监督点**——把"要不要执行"从模型手里拿出来，交给政策
- 对应源码：pre-execute 瀑布（allow/deny/ask）+ 审批服务

#### Step 04 — `step-04-monotonic-guard.ts`

**哲学点：为什么守卫只能"拒绝"，不能"放行"？（单调性）**

- 问题：如果守卫能放行，注册顺序决定"谁说了算"——A 拒绝、B 放行 → 结果变放行，守卫互相踩
- 实现：ToolGuard 返回类型只有 `string | undefined`（拒绝理由 or 无），**没有 allow 分支**；演示多个守卫注册顺序无关，任何一道拒绝都是终局
- 哲学：**单调性**——"listener ordering cannot turn a denial back into permission"，拒绝是幂等安全的，放行不是
- 对应源码：ToolGuard 类型注释（index.ts:708）+ guardReason() 的 scope 链查询（index.ts:1132）

#### Step 05 — `step-05-timeout-wrap.ts`

**哲学点：为什么超时是"包一层"，而不是工具自己实现？（关注点分离）**

- 问题：慢工具无限等待会拖垮整个 agent；如果让每个工具自己写超时，20 个工具 20 份重复代码，且容易漏
- 实现：execute 环绕（wrapper）用 Promise.race 包超时，任何工具注册后自动获得超时能力；演示慢工具 500ms 超时返回 isError
- 哲学：**横切关注点**——超时/日志/重试是"包在工具外面"的能力，不该是工具自己的责任
- 对应源码：tools/execute 环绕（wrapper 机制）

#### Step 06 — `step-06-post-execute.ts`

**哲学点：为什么执行结果也要过一道门？（post-execute）**

- 问题：工具返回的值不一定适合直接给模型看——可能含密钥、可能格式脏、可能违反策略
- 实现：post-execute 接受/替换/阻止三态；演示 read_file 结果经 post-execute 脱敏（`sk-xxx` → `***`）
- 哲学：**输出同输入一样不可信**——进出的数据都要过门，结果处理（脱敏/校验/重渲染）和工具逻辑解耦
- 对应源码：post-execute（接受/替换/阻止）

#### Step 07 — `step-07-full-pipeline.ts`

**哲学点：整合——一次工具调用的完整旅程，六道关如何协作？**

- 实现：把 Step 02~06 的机制串进 Step 01 的骨架，跑一次完整调用（含审批、守卫拒绝、超时、脱敏各演示一次）
- 好处：读者从"每道关单独看"升级到"看整体协作"——关与关之间如何衔接、短路如何传播
- 对应源码：execute() 完整主流程

### package.json scripts

```json
{
  "name": "@articles/dsh-tools",
  "version": "1.0.0",
  "private": true,
  "description": "工具调用管线设计哲学渐进式复现：六道关逐关理解（参数冻结/审批瀑布/单调守卫/超时环绕/post-execute），纯 Node 无依赖",
  "scripts": {
    "start": "tsx src/steps/step-07-full-pipeline.ts",
    "run:dsh-tools": "tsx src/steps/step-07-full-pipeline.ts",
    "step:01": "tsx src/steps/step-01-pipeline-skeleton.ts",
    "step:02": "tsx src/steps/step-02-arg-freezing.ts",
    "step:03": "tsx src/steps/step-03-approval-waterfall.ts",
    "step:04": "tsx src/steps/step-04-monotonic-guard.ts",
    "step:05": "tsx src/steps/step-05-timeout-wrap.ts",
    "step:06": "tsx src/steps/step-06-post-execute.ts",
    "step:07": "tsx src/steps/step-07-full-pipeline.ts"
  }
}
```

### 根 package.json 清理

- `tools:step:01` ~ `tools:step:07` 保留（脚本名不变），指向新的 step 文件名
- `run:dsh-tools` 指向 `step-07-full-pipeline.ts`

## 代码风格（严格对齐现有样本）

- 每个文件顶部 JSDoc：**这一步解决什么问题**（痛苦场景，2-3 句）+ **为什么 harness 这么设计**（哲学思想，2-3 句）+ **好处/收益**（1-2 句）+ **对应源码**（文件:行号）+ **跑法**
- 关键注释标注"对应源码 xxx"；简化实现但机制命名忠于源码
- 教学性：main() 演示多种情况（正常/异常/边界），console.log 清晰、emoji 前缀（💥✅🚫⏱️ 等）
- `export {}` 结尾；TS 严格模式友好，能过 ESLint（typescript-eslint + prettier）
- 纯 Node 无依赖，只用 tsx 跑，不需要 API key

## 验证

写完必须逐个跑通（在 ai-agent-code-lab 根目录）：`pnpm run tools:step:01` ~ `tools:step:07`（或 articles/dsh-tools 内 `pnpm run step:01` ~ `step:07`）。确认无类型错误、无运行时崩溃、每步输出聚焦一个哲学点。

## 输出要求

1. 直接创建/修改文件，不要只给方案
2. 跑通验证后报告每步输出摘要（每步 1-2 行）
3. 总结：每步对应源码的哪个机制、简化了什么——方便 reviewer 核对
4. 如有拿不准的源码行为，以真实源码为准并在总结里指出

## 验收标准

- [ ] `src/steps/` 下 7 个新文件，每步**只解决一个哲学点**（无一步塞多个机制的"大杂烩"）
- [ ] 文件行数合理精简（每步聚焦一个问题，没有为凑数注水、也没有压缩到牺牲可读性）
- [ ] 每步 JSDoc 包含：问题 / 为什么这么设计 / 好处收益 / 对应源码位置
- [ ] 核心哲学传达：管线骨架 / 参数冻结 / 审批瀑布 / 单调守卫（无 allow）/ 超时环绕 / post-execute 脱敏 / 整合协作
- [ ] 根 package.json 的 tools:step:* 指向新文件名，全部跑通
