# Qoder 任务：重构 articles/dsh-memory —— 每步一个哲学点（对齐 dsh-tools 新格式）

## 为什么改（背景）

ai-agent-code-lab 的源码精读系列已确立新格式：**保留 step-1~N 渐进式，但每步只解决一个哲学点**——这一步回答一个问题：为什么这么设计、好处是什么、解决了什么。dsh-tools 已按此重构（7 步 2400 行 → 1064 行，效果很好）。dsh-memory 现有 7 步共 2072 行，主要问题：

- **步内塞了太多机制**：step-04 checkpoint 429 行（可能把八段的每一段都实现了）、step-07 全链路 637 行（可能复刻了前 6 步全部机制）
- **JSDoc 是"学习目标"格式，不是四段式**（痛苦场景 → 为什么这么设计 → 收益 → 对应源码）

好消息是 step 划分本身合理（session-log / surface / pressure / checkpoint / kv-cache / write-behind / full-chain），**保持现有文件名和 step 划分，重构内容**。

## 你的角色（三重身份）

1. **资深 AI Agent 工程师**：代码体现生产级设计取舍，不追求覆盖全部机制，只挑"最能说明设计哲学"的核心
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。每步注释讲清"这一步在解决什么问题、不这么做会怎样、为什么这么设计、收益是什么"
3. **DeepSeek Harness 资深源码研究者**：简化实现忠实于真实源码的机制和命名，注释标注对应源码文件:行号

## 必读材料（动笔前先读）

1. **现有实现**（读懂的机制，不要照抄重）：
   - `articles/dsh-memory/src/steps/step-01-session-log.ts` ~ `step-07-full-chain.ts`（7 个文件）
2. **分析文档的哲学讲解**：`docs/dsh-memory-analysis.md`（重点：四层记忆——事件日志 → surface 投影 → 压缩（KV cache 复用/日志即锁/八段式 checkpoint）→ write-behind 持久化）
3. **真实源码**（对照核实）：`~/workspace/deepseek-harness-study/source/packages/`
   - `core/session/`（事件日志 / surface）
   - `core/compaction/`（压力检测 / checkpoint / KV cache）
   - 相关设计笔记在 `.agents/notes/implemented/`

## 精简原则（重要，避免你写完又反复自我压缩）

- **不写死具体行数**，以"讲透一个哲学点"为准。写完就是终稿，不要回头反复压缩
- **可省略的内容**（一笔带过或不写）：checkpoint 八段的完整实现（写 2-3 段代表即可，其余注释列出）、事件类型的完整词汇表、压缩 replace 事件的完整边界处理——注释里提一句"源码里还有 XXX，这里不展开"
- **必须写的内容**：每步的核心机制（见下方规格）+ 一个能跑的教学演示
- **给你发挥空间**：每个 step 的演示场景、console 输出文案、复用前一步代码的方式（精简复用 or 独立自足）你自行决定，只要满足"每步一个哲学点 + 教学性强"

## 任务：重构 articles/dsh-memory 的 7 个 step（保持文件名）

### 每步规格（哲学点 + 必须演示的核心）

#### Step 01 — `step-01-session-log.ts`

**哲学点：为什么"历史"是派生的，从不单独存储？**

- 问题：如果消息历史单独存一份，日志更新了历史没更新 → 状态和日志分叉
- 实现：append-only 事件日志（不可变 + seq 连续）+ deriveMessages() 纯函数重放
- 收益：唯一事实源，分叉在结构上不可能
- 对应源码：`packages/core/session/src/session.ts`（Session.append）

#### Step 02 — `step-02-surface.ts`

**哲学点：为什么模型看到的是"投影"，不是日志本身？**

- 问题：日志里有工具调用/推理/内部事件，模型不该全看；若为模型单独存一份副本，两处会漂移
- 实现：surface = 从日志投影出模型可见历史（只含 user/assistant/tool-result 三件套）；日志是唯一事实源，投影永远可重算
- 收益：投影坏了重新投影即可，不需要修数据
- 对应源码：`packages/core/session/src/surface.ts`（surface 投影）

#### Step 03 — `step-03-pressure.ts`

**哲学点：为什么"该压缩"由 token 压力决定，而不是定时触发？**

- 问题：固定 N 轮压缩 → 简单对话浪费、复杂对话不够；定时炸弹式压缩没有依据
- 实现：估算当前模型可见历史的 token 数，超过阈值（如预算的 80%）→ 触发压缩；演示"短对话不触发 / 长对话触发"
- 收益：压缩时机由真实需求驱动，而不是拍脑袋
- 对应源码：`packages/core/compaction/`（压力检测）

#### Step 04 — `step-04-checkpoint.ts`

**哲学点：为什么压缩是"结构化保留"，而不是"丢进垃圾桶"？**

- 问题：粗暴截断丢信息；直接让 LLM"总结一下"→ 摘要质量不可控、后续模型不知道去哪找细节
- 实现：checkpoint = 折叠旧消息 + 固定结构摘要（演示 2-3 个关键段：Primary Request / Current Work / Next Step，其余注释列出）；摘要作为一条 user 消息进入历史
- 收益：压缩后仍可回溯，模型"知道去哪里找"
- 对应源码：`packages/core/compaction/`（八段式 checkpoint，演示子集即可）

#### Step 05 — `step-05-kv-cache.ts`

**哲学点：为什么压缩指令必须放在"最后一条 user 消息"？**

- 问题：provider 按请求**开头**的 token 序列做 KV cache；总结指令若放中间/开头，前缀变了缓存失效，每轮全量重算
- 实现：演示两种放置（指令在中间 vs 指令在末尾）对"前缀命中"的影响；结论：总结指令作为最后一条 user 消息，历史前缀保持不变 → KV cache 复用
- 收益：压缩后的长对话继续省钱，不是压缩完就白烧
- 对应源码：compaction 相关设计笔记（kv-cache 复用）

#### Step 06 — `step-06-write-behind.ts`

**哲学点：为什么 append 不阻塞 I/O？（write-behind）**

- 问题：流式输出每秒产生几十个事件，每个都同步写盘 → 性能灾难；但也不能丢（日志是唯一事实源）
- 实现：append 先入内存队列立即返回 → 固定窗口（如 200ms）批量合并写盘 → 崩溃时从磁盘恢复；演示"append 不等待 / 批量落盘 / 恢复重放"
- 收益：不阻塞主循环 + 不丢事件
- 对应源码：`packages/core/session/` 持久化层（write-behind）

#### Step 07 — `step-07-full-chain.ts`

**哲学点：整合——一场长对话的"记忆一生"（四层如何协作）？**

- 问题：前六步单独看都能懂，但真实会话里它们接力：日志 append → surface 投影 → 压力超阈值 → checkpoint 压缩（含 KV cache 放置）→ write-behind 持久化
- 实现：模拟一场多轮对话，完整走一遍四层接力，每层用 console 标注"现在轮到谁、为什么"
- 收益：读者从"每层单独看"升级到"看整体协作"——记忆系统的全貌
- 对应源码：记忆四层对应包

### 工程要求

- **保持文件路径不变**：`articles/dsh-memory/src/steps/step-0X-*.ts`（7 个文件名不变）
- **保持 scripts 不变**：`articles/dsh-memory/package.json` 的 step:01~~07 + 根 package.json 的 memory:step:01~~07 都指向同一批文件，**不用改**
- **代码风格**（严格对齐 dsh-tools 新样本，先读 `articles/dsh-tools/src/steps/step-02-arg-freezing.ts`）：
  - 每文件顶部 JSDoc 四段式：**这一步解决什么问题**（痛苦场景）→ **为什么这么设计**（哲学）→ **收益** → **对应源码**（文件:行号）+ 跑法
  - 关键注释标注"对应源码 xxx"；`export {}` 结尾；TS 严格模式友好，能过 ESLint
  - 教学性：main() 演示正常/异常/边界，console.log 清晰、emoji 前缀
  - 纯 Node 无依赖，只用 tsx 跑，不需要 API key

## 验证

写完必须逐个跑通（在 ai-agent-code-lab 根目录）：`pnpm run memory:step:01` ~ `memory:step:07`。确认无类型错误、无运行时崩溃、每步输出聚焦一个哲学点。

## 输出要求

1. 直接修改文件，不要只给方案
2. 跑通验证后报告每步输出摘要（每步 1-2 行）
3. 总结：每步对应源码的哪个机制、比旧版精简了什么——方便 reviewer 核对
4. 如有拿不准的源码行为，以真实源码为准并在总结里指出

## 验收标准

- [ ] 7 个 step 文件名不变，每步**只解决一个哲学点**（无一步塞多机制的"大杂烩"）
- [ ] 每步 JSDoc 四段式：问题 / 为什么这么设计 / 收益 / 对应源码位置
- [ ] 精简优先：没有为凑行数注水，也没有压缩到牺牲可读性；总行数明显小于旧版 2072 行
- [ ] 核心哲学传达：唯一事实源 / 投影不存副本 / 压力驱动 / 结构化 checkpoint / KV cache 放置 / write-behind / 四层协作
- [ ] 根目录 `pnpm run memory:step:01` ~ `memory:step:07` 全部跑通
