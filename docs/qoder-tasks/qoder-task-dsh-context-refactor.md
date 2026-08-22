# Qoder 任务：重构 articles/dsh-context —— 每步一个哲学点（对齐 dsh-tools 新格式）

## 为什么改（背景）

ai-agent-code-lab 的源码精读系列已确立新格式：**保留 step-1~N 渐进式，但每步只解决一个哲学点**——这一步回答一个问题：为什么这么设计、好处是什么、解决了什么。dsh-tools 已按此重构（7 步 2400 行 → 1064 行，效果很好）。dsh-context 现有 7 步共 2495 行，主要问题：

- **步内塞了太多机制**：step-05 agent-instructions 496 行（基线 + reconcile + 字节预算 + 临时目录全套）、step-07 全家桶 619 行（跨会话引用 + 防御三连 + 预算裁剪 + 完整装配链全塞一个文件）
- **JSDoc 是"学习目标"格式，不是四段式**（痛苦场景 → 为什么这么设计 → 收益 → 对应源码）

好消息是 step 划分本身合理（registry / scope / waterfall / snapshot / instructions / time-tmux / assembly），**保持现有文件名和 step 划分，重构内容**。

## 你的角色（三重身份）

1. **资深 AI Agent 工程师**：代码体现生产级设计取舍，不追求覆盖全部机制，只挑"最能说明设计哲学"的核心
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。每步注释讲清"这一步在解决什么问题、不这么做会怎样、为什么这么设计、收益是什么"
3. **DeepSeek Harness 资深源码研究者**：简化实现忠实于真实源码的机制和命名，注释标注对应源码文件:行号

## 必读材料（动笔前先读）

1. **现有实现**（读懂的机制，不要照抄重）：
   - `articles/dsh-context/src/steps/step-01-system-prompt-registry.ts` ~ `step-07-session-reference-full-assembly.ts`（7 个文件）
2. **分析文档的哲学讲解**：`docs/dsh-context-analysis.md`（重点：三层机制——SystemPrompt 注册表 / 动态上下文快照投影 / 四类上下文生产者插件 + 设计纪律）
3. **真实源码**（对照核实）：`~/workspace/deepseek-harness-study/source/packages/`
   - `core/system-prompt/src/index.ts`（注册表 / assemble / interpolate）
   - `core/agent-loop/src/runtime-context.ts`（快照投影）
   - `context/agent-instructions/`、`context/time-context/`、`context/tmux-context/`、`context/session-reference/`

## 精简原则（重要，避免你写完又反复自我压缩）

- **不写死具体行数**，以"讲透一个哲学点"为准。写完就是终稿，不要回头反复压缩
- **可省略的内容**（一笔带过或不写）：agent-instructions 的真实临时目录文件操作（用内存 mock 即可）、session-reference 的完整预算裁剪算法（演示裁剪思路即可）、tmux 的真实 shell 调用（用模拟数据演示 TTY 检测逻辑即可）、waterfall 的完整事件机制（用函数数组模拟即可）——注释里提一句"源码里还有 XXX，这里不展开"
- **必须写的内容**：每步的核心机制（见下方规格）+ 一个能跑的教学演示
- **给你发挥空间**：每个 step 的演示场景、console 输出文案、复用前一步代码的方式（精简复用 or 独立自足）你自行决定，只要满足"每步一个哲学点 + 教学性强"

## 任务：重构 articles/dsh-context 的 7 个 step（保持文件名）

### 每步规格（哲学点 + 必须演示的核心）

#### Step 01 — `step-01-system-prompt-registry.ts`

**哲学点：为什么 prompt 是"注册"出来的，不是手写一大坨字符串？**

- 问题：手写 system prompt → 改一个工具描述要翻整个字符串；多个插件都要往 prompt 里加东西 → 互相覆盖
- 实现：section({name, order, text}) 注册 + 按 order 升序拼接 + renderPrompt 去空段；演示乱序注册按 order 输出
- 收益：每个插件只贡献自己的一块，互不覆盖；顺序由 order 声明
- 对应源码：`packages/core/system-prompt/src/index.ts`（section 注册 + renderPrompt）

#### Step 02 — `step-02-scope-and-variables.ts`

**哲学点：为什么每个 agent 可以有自己的人格？为什么变量 typo 必须炸？**

- 问题：全局 prompt 是共享的，子代理要装不同人格 → 若只能全局，人格互相污染；`{{modle}}` typo 若静默传给模型，审阅 transcript 才发现
- 实现：global/scope 两层注册（scope 遮蔽 global）+ variable 注册 + 严格插值（未知变量 throw / provider 返回 undefined throw / 畸形引用 throw；孤立 `{{` 是字面量）
- 收益：per-agent prompt 成为可能；typo 在渲染时立刻炸——作者错误就该响
- 对应源码：`index.ts` ScopedLayers + interpolate（严格模式）

#### Step 03 — `step-03-waterfall-complete.ts`

**哲学点：为什么协作需要"改写"和"包场"？（waterfall + complete）**

- 问题：注册表是"协作"机制，但总有人要改写整体（专家插件）或整个接管（供应商人格）→ 没有逃生口，协作就锁死
- 实现：waterfall（函数数组，返回值权威，可改写 assembly）+ complete section（waterfall 后强制只剩这一个 section，多个 complete 冲突 throw）
- 收益：协作 + 逃生口并存；冲突在启动时暴露
- 对应源码：`index.ts` assemble 第 5 步 + complete 边界处理

#### Step 04 — `step-04-runtime-context-snapshot.ts`

**哲学点：为什么"变了才说"能省 token？（快照投影）**

- 问题：时间/位置/状态每轮都塞 → token 浪费 + 注意力稀释；完全不塞 → 模型用过期情报
- 实现：RuntimeContextProjection——内容没变不注入；变了注入新快照；从有到无注入 CLEARED 作废标记；快照被压缩掉后 retained=null 自动补发
- 收益：模型永远看到最新快照，且不为不变的内容付费
- 对应源码：`packages/core/agent-loop/src/runtime-context.ts`（全文 76 行，可完整复刻核心逻辑）

#### Step 05 — `step-05-agent-instructions.ts`

**哲学点：为什么工作区指令走"基线 + 增量"，而不是每轮全量塞？**

- 问题：AGENTS.md 每轮全量塞 → token 贵；文件变了模型不知道 → 用过期约定
- 实现：基线注入（首次完整渲染）+ 变化检测（文件内容变了 → replace 增量 / 新增 → set / 删除 → remove）+ 字节预算（超预算从宽泛到具体省略，再超二分截断）
- 收益：只在"文件变了"时付增量 token；预算约束下宁可告诉模型"有指令被截断"
- 对应源码：`packages/context/agent-instructions/src/render.ts` + state.ts（reconcile）

#### Step 06 — `step-06-time-tmux-context.ts`

**哲学点：为什么"实时情报"是插件 + 快照，而不是写死在引擎里？**

- 问题：时间、终端位置是高频变化的动态上下文；若写死在引擎里，引擎要为所有场景负责
- 实现：time-context（绝对时间 + 相对耗时 + refreshIntervalMs 限频）+ tmux-context（伪 tmux 检测：环境变量继承 ≠ 真在 tmux，TTY 不匹配不注入；变化驱动重注入）
- 收益：上下文生产者可插拔，谁拥有事实谁注册；快照语义保证"变了才说"
- 对应源码：`packages/context/time-context/src/index.ts` + `packages/context/tmux-context/src/index.ts`（queryTmuxLocation 可完整复刻）

#### Step 07 — `step-07-session-reference-full-assembly.ts`

**哲学点：为什么引用另一个会话的内容必须"不可信"？完整装配链如何协作？**

- 问题：@引用别的会话 → 内容是别人家的，可能含恶意指令/过期信息；若当指令执行，当前 agent 被劫持
- 实现（前半）：session-reference——入队前读快照（源后变不影响）+ 聚合 JSON 包"untrusted, read-only"警告 + tag-safe 序列化（`<` → `\u003c`）+ 预算保留（head/tail 裁剪 + 记录 omitted）+ 最多 3 个引用 + 拒绝自引用
- 实现（后半）：完整 pre-step 装配链——assemble（注册表+变量+工具）→ 快照投影 → agent/pre-step waterfall（指令/时间/位置/引用往里塞）→ renderPrompt → 输出完整请求
- 收益：跨会话情报可用但不越权；模型看到的每个字都有来源、有预算、有边界
- 对应源码：`packages/context/session-reference/src/index.ts` + agent-loop preStep

### 工程要求

- **保持文件路径不变**：`articles/dsh-context/src/steps/step-0X-*.ts`（7 个文件名不变）
- **保持 scripts 不变**：`articles/dsh-context/package.json` 的 step:01~~07 + 根 package.json 的 context:step:01~~07 都指向同一批文件，**不用改**
- **代码风格**（严格对齐 dsh-tools 新样本，先读 `articles/dsh-tools/src/steps/step-02-arg-freezing.ts`）：
  - 每文件顶部 JSDoc 四段式：**这一步解决什么问题**（痛苦场景）→ **为什么这么设计**（哲学）→ **收益** → **对应源码**（文件:行号）+ 跑法
  - 关键注释标注"对应源码 xxx"；`export {}` 结尾；TS 严格模式友好，能过 ESLint
  - 教学性：main() 演示正常/异常/边界，console.log 清晰、emoji 前缀
  - 纯 Node 无依赖，只用 tsx 跑，不需要 API key

## 验证

写完必须逐个跑通（在 ai-agent-code-lab 根目录）：`pnpm run context:step:01` ~ `context:step:07`。确认无类型错误、无运行时崩溃、每步输出聚焦一个哲学点。

## 输出要求

1. 直接修改文件，不要只给方案
2. 跑通验证后报告每步输出摘要（每步 1-2 行）
3. 总结：每步对应源码的哪个机制、比旧版精简了什么——方便 reviewer 核对
4. 如有拿不准的源码行为，以真实源码为准并在总结里指出

## 验收标准

- [ ] 7 个 step 文件名不变，每步**只解决一个哲学点**（无一步塞多机制的"大杂烩"）
- [ ] 每步 JSDoc 四段式：问题 / 为什么这么设计 / 收益 / 对应源码位置
- [ ] 精简优先：没有为凑行数注水，也没有压缩到牺牲可读性；总行数明显小于旧版 2495 行
- [ ] 核心哲学传达：注册表 / scope 遮蔽 + 严格插值 / waterfall + complete / 快照投影 / 基线+增量 / 可插拔实时情报 / 不可信引用 + 完整装配
- [ ] 根目录 `pnpm run context:step:01` ~ `context:step:07` 全部跑通
