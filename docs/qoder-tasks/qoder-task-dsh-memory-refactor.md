# Qoder 任务：重构 articles/dsh-memory —— 每步一个哲学点 + AB 对比 + 术语先行（v2）

## 为什么改（背景）

ai-agent-code-lab 的源码精读系列已确立新格式：**保留 step-1~N 渐进式，但每步只解决一个哲学点**。dsh-tools 已按此重构（7 步 2400 行 → 1064 行，效果好）。dsh-memory 现有代码（v1 重构版）仍有两个大问题：

1. **术语不做解释**：surface（投影）/ view（视图）/ replace / sourceEventSeqs 这些名词直接出现在代码里，初学者完全卡住——"投影是什么？视图是什么？"
2. **一步塞多个机制**：step-02 surface 把"投影概念"和"replace 压缩替换机制"揉在一起（surfaceOp / sourceEventSeqs / validateNext / replaceGeneration 全在里面），读者在学"投影"时被迫同时消化"压缩审计"，直接看不懂
3. **没有 AB 对比**：只看 harness 的做法，不知道"不这么做会怎样"——设计的好处没有参照物

**本版 v2 的核心要求**（对应上述三个问题）：

- **术语先行**：每个 step 开头先用大白话解释本步涉及的关键名词（类比 + 一句话定义），代码里出现的每个专有名词都要在注释里先解释
- **AB 对比**：每步必须同时展示**朴素做法**（不懂设计的程序员会怎么写）和 **harness 做法**（真实设计），用同一场景跑两遍，让读者亲眼看到"朴素版崩在哪、harness 版怎么解决的"
- **每步只讲一个知识点**：surface 那步只讲"投影是什么"，replace 机制挪到 checkpoint 那步讲

## 你的角色（三重身份）

1. **资深 AI Agent 工程师**：代码体现生产级设计取舍，不追求覆盖全部机制，只挑"最能说明设计哲学"的核心
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。你的最高优先级是**让读者不卡住**——专有名词先解释、朴素版先展示、每步只讲一件事
3. **DeepSeek Harness 资深源码研究者**：简化实现忠实于真实源码的机制和命名，注释标注对应源码文件:行号

## 必读材料（动笔前先读）

1. **现有实现**（读懂的机制，不要照抄重）：
   - `articles/dsh-memory/src/steps/step-01-session-log.ts` ~ `step-07-full-chain.ts`（7 个文件，v1 重构版）
2. **分析文档的哲学讲解**：`docs/dsh-memory-analysis.md`（重点：四层记忆——事件日志 → surface 投影 → 压缩（KV cache 复用/日志即锁/八段式 checkpoint）→ write-behind 持久化）
3. **真实源码**（对照核实）：`~/workspace/deepseek-harness-study/source/packages/`
   - `core/session/`（事件日志 / surface）
   - `core/compaction/`（压力检测 / checkpoint / KV cache）
   - 相关设计笔记在 `.agents/notes/implemented/`

## 教学铁律（v2 新增，最高优先级）

1. **术语先行，先讲人话**：
   - 每步 JSDoc 顶部加一节「**先懂三个词**」（或对应数量）：本步涉及的所有专有名词，每个给「大白话类比 + 一句话定义」
   - 示例：surface 投影 = "仓库里的货架（日志）vs 橱窗陈列（表面）——橱窗只摆客人该看的，货架是全部真相"
   - 代码里第一次出现的专有名词，注释必须解释，不许裸奔
2. **AB 对比是标配**：每步 main() 必须演示「朴素版 vs harness 版」同一场景跑两遍：
   - 先跑朴素版 → 输出"崩点/痛点"
   - 再跑 harness 版 → 输出"解决"
   - 让读者**先看到问题，再看到解法**（解法是问题的答案）
3. **一步一个知识点，绝不塞多**：每个 step 只解决一个哲学点；本步用不到的机制**只字不提**（或一行注释"源码里还有 XXX，后面 step 会讲"）

## 精简原则

- **不写死具体行数**，以"讲透一个哲学点 + AB 对比清楚"为准。写完就是终稿，不要回头反复压缩
- **可省略的内容**（一笔带过或不写）：checkpoint 八段的完整实现（写 2-3 段代表即可）、事件类型的完整词汇表、write-behind 的磁盘恢复细节——注释里提一句即可
- **必须写的内容**：每步的核心机制（见下方规格）+ 术语解释 + 朴素版 vs harness 版 AB 对比演示
- **给你发挥空间**：每个 step 的演示场景、console 输出文案、复用前一步代码的方式（精简复用 or 独立自足）你自行决定，只要满足"术语先行 + AB 对比 + 每步一个知识点"

## 任务：重构 articles/dsh-memory 的 7 个 step（保持文件名）

### 每步规格（哲学点 + 术语 + AB 对比要求）

#### Step 01 — `step-01-session-log.ts`

**哲学点：为什么"历史"是派生的，从不单独存储？**

- **术语**：「事件日志」= 按时间顺序追加的流水账，每条不可变；「派生」= 模型看到的历史不是存出来的，是从日志算出来的
- **AB 对比**：
  - 朴素版：直接维护一个"消息数组"当历史，聊一句 push 一句
  - 朴素版崩点：如果后来要"回滚/修正/审计"，消息数组里找不到原始记录（比如工具内部调用了什么）
  - harness 版：append-only 事件日志 + seq 连续 + deriveMessages() 纯函数重放
- 实现：append-only 事件日志（不可变 + seq 连续）+ deriveMessages() 纯函数重放；演示"日志里有什么 vs 模型看到什么"
- 收益：唯一事实源，分叉在结构上不可能
- 对应源码：`packages/core/session/src/session.ts`（Session.append）

#### Step 02 — `step-02-surface.ts`

**哲学点：为什么模型看到的是"投影"，不是日志本身？**

- **术语（本步重点，必须讲透）**：
  - 「投影 / surface」= 从日志里挑出"模型该看的事件"组成一份视图——类比：仓库货架（日志，全部）vs 橱窗陈列（surface，精选）。投影 = 只挑不复制，每次现算
  - 「视图 / view」= 模型实际看到的对话历史，是投影的结果
  - 「日志专用事件」= 只进日志、不进视图的事件（如 tool/call 内部细节）
- **AB 对比**：
  - 朴素版：给模型单独存一份"干净历史"副本，日志更新时手动同步副本
  - 朴素版崩点：日志更新了副本忘了更新 → 两处漂移，模型看到的是过期的；投影坏了副本修不回来
  - harness 版：surface 只维护"该展示哪些 seq 的列表"，deriveMessages() 每次从日志现算——日志是唯一事实源，视图永远可重算
- **本步禁止出现**：replace / sourceEventSeqs / validateNext / replaceGeneration——这些是压缩机制，属于 step-04，本步只字不提（最多一行注释"源码里 surface 还支持 replace 压缩替换，step-04 会讲"）
- 实现：surface 增量维护表面节点 seq 列表 + deriveMessages() 投影；演示"tool/call 不进表面"+"日志追加后视图自动包含新消息"
- 收益：投影坏了重新投影即可，不需要修数据
- 对应源码：`packages/core/session/src/surface.ts`（surface 投影）

#### Step 03 — `step-03-pressure.ts`

**哲学点：为什么"该压缩"由 token 压力决定，而不是定时触发？**

- **术语**：「token 压力」= 当前历史折算成 token 数占模型上下文预算的比例；「压缩」= 把旧历史折叠成摘要（本步只讲"什么时候该压缩"，不讲"怎么压缩"——怎么压缩是 step-04）
- **AB 对比**：
  - 朴素版：每 N 轮固定压缩一次
  - 朴素版崩点：简单对话（聊两句就完）白白压缩浪费；复杂对话（代码+工具往返）还没到 N 轮就爆上下文
  - harness 版：估算模型可见历史 token 数，超阈值（如预算 80%）才触发
- 实现：估算当前模型可见历史的 token 数，超过阈值 → 触发压缩；演示"短对话不触发 / 长对话触发"
- 收益：压缩时机由真实需求驱动，而不是拍脑袋
- 对应源码：`packages/core/compaction/`（压力检测）

#### Step 04 — `step-04-checkpoint.ts`

**哲学点：为什么压缩是"结构化保留"，而不是"丢进垃圾桶"？（含 replace 机制）**

- **术语**：「checkpoint」= 压缩产生的"存档点"，把旧历史折叠成结构化摘要；「replace」= 用新事件（摘要）在视图里**替换**一段旧事件的操作（step-02 提到的那个机制，本步正式讲）；「sourceEventSeqs」= replace 必须声明"我替换掉了哪几条事件"——可审计性：每次压缩都有据可查
- **AB 对比**：
  - 朴素版：把旧消息直接截断丢弃（或让 LLM"随便总结一下"）
  - 朴素版崩点：丢信息——后续模型不知道"之前说过什么、做到哪了"；无结构摘要 → 模型不知道去哪找细节；替换无记录 → 审计查无实据
  - harness 版：checkpoint = 折叠旧消息 + 固定结构摘要（演示 2-3 个关键段：Primary Request / Current Work / Next Step）+ replace 必须带 sourceEventSeqs 点名被替换的事件（端点越界/少报都拒绝）
- 实现：checkpoint 折叠 + 固定结构摘要（2-3 段代表）+ replace 替换视图 + sourceEventSeqs 审计
- 收益：压缩后仍可回溯，模型"知道去哪里找"；每次替换有据可查
- 对应源码：`packages/core/compaction/`（八段式 checkpoint）+ `packages/core/session/src/surface.ts`（replace 机制）

#### Step 05 — `step-05-kv-cache.ts`

**哲学点：为什么压缩指令必须放在"最后一条 user 消息"？**

- **术语**：「KV cache」= LLM 服务商按请求**开头**的 token 序列缓存计算结果，前缀相同就复用；「前缀命中」= 两次请求开头一样，第二次不用重新算
- **AB 对比**：
  - 朴素版：把总结指令拼在历史中间（或开头）
  - 朴素版崩点：前缀变了 → 每次请求全量重算，压缩省下的 token 又烧回去
  - harness 版：总结指令作为**最后一条 user 消息**——历史前缀保持不变 → KV cache 复用
- 实现：演示两种放置（指令在中间 vs 指令在末尾）对"前缀命中"的影响
- 收益：压缩后的长对话继续省钱，不是压缩完就白烧
- 对应源码：compaction 相关设计笔记（kv-cache 复用）

#### Step 06 — `step-06-write-behind.ts`

**哲学点：为什么 append 不阻塞 I/O？（write-behind）**

- **术语**：「write-behind」= 先写内存立即返回，后台批量落盘；「落盘」= 写进磁盘持久化
- **AB 对比**：
  - 朴素版：每次 append 都同步写磁盘
  - 朴素版崩点：流式输出每秒几十个事件 → 每个都等磁盘 I/O → 主循环卡死；或者反过来——完全不落盘 → 崩溃全丢
  - harness 版：append 先入内存队列立即返回 → 固定窗口（如 200ms）批量合并写盘 → 崩溃时从磁盘恢复
- 实现：演示"append 不等待 / 批量落盘 / 恢复重放"
- 收益：不阻塞主循环 + 不丢事件
- 对应源码：`packages/core/session/` 持久化层（write-behind）

#### Step 07 — `step-07-full-chain.ts`

**哲学点：整合——一场长对话的"记忆一生"（四层如何协作）？**

- **术语**：回顾前六步术语（事件日志 / surface 投影 / token 压力 / checkpoint / KV cache / write-behind），一句话各带过
- **AB 对比**：朴素版"记忆"（一个消息数组，长了就截断）从头到尾走一遍 vs harness 四层接力——对比"对话结尾时朴素版还剩什么 / harness 版还剩什么"
- 实现：模拟一场多轮对话，完整走一遍四层接力：日志 append → surface 投影 → 压力超阈值 → checkpoint 压缩（含 KV cache 放置 + replace 审计）→ write-behind 持久化，每层用 console 标注"现在轮到谁、为什么"
- 收益：读者从"每层单独看"升级到"看整体协作"
- 对应源码：记忆四层对应包

### 工程要求

- **保持文件路径不变**：`articles/dsh-memory/src/steps/step-0X-*.ts`（7 个文件名不变）
- **保持 scripts 不变**：`articles/dsh-memory/package.json` 的 step:01~~07 + 根 package.json 的 memory:step:01~~07 都指向同一批文件，**不用改**
- **代码风格**（严格对齐 dsh-tools 新样本，先读 `articles/dsh-tools/src/steps/step-02-arg-freezing.ts`）：
  - 每文件顶部 JSDoc：**先懂几个词**（术语解释）→ **这一步解决什么问题**（痛苦场景）→ **为什么这么设计**（哲学）→ **收益** → **对应源码**（文件:行号）+ 跑法
  - 关键注释标注"对应源码 xxx"；`export {}` 结尾；TS 严格模式友好，能过 ESLint
  - 教学性：main() 先跑朴素版（展示崩点）再跑 harness 版（展示解决），console.log 清晰、emoji 前缀（💥 崩点 / ✅ 解决）
  - 纯 Node 无依赖，只用 tsx 跑，不需要 API key

## 验证

写完必须逐个跑通（在 ai-agent-code-lab 根目录）：`pnpm run memory:step:01` ~ `memory:step:07`。确认无类型错误、无运行时崩溃、每步输出有"朴素版崩点 → harness 版解决"的对照结构。

## 输出要求

1. 直接修改文件，不要只给方案
2. 跑通验证后报告每步输出摘要（每步 1-2 行）
3. 总结：每步对应源码的哪个机制、比旧版精简了什么——方便 reviewer 核对
4. 如有拿不准的源码行为，以真实源码为准并在总结里指出

## 验收标准

- [ ] 7 个 step 文件名不变，每步**只解决一个哲学点**（无一步塞多机制的"大杂烩"）
- [ ] **术语先行**：每步 JSDoc 有「先懂几个词」节，代码里专有名词首次出现有注释解释
- [ ] **AB 对比**：每步 main() 有"朴素版崩点 → harness 版解决"对照，读者能亲眼看到设计的好处
- [ ] **step-02 纯净**：surface 步不含 replace / sourceEventSeqs / validateNext / replaceGeneration（最多一行注释预告 step-04）
- [ ] **step-04 承接**：replace + sourceEventSeqs 审计在 checkpoint 步正式讲
- [ ] 精简优先：没有为凑行数注水，也没有压缩到牺牲可读性；总行数明显小于旧版 2072 行
- [ ] 根目录 `pnpm run memory:step:01` ~ `memory:step:07` 全部跑通
