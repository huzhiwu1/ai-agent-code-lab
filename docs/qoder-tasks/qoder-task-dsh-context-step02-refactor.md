# Qoder 任务：重写 dsh-context step-02 —— 聚焦单一哲学点，砍掉"一步两机制"

## 为什么改（背景）

ai-agent-code-lab 源码精读系列的新格式铁律：**每步只解决一个哲学点**，宁可小而精，
不要大而全。dsh-context 经过 v2 重构后，step-02（313 行）仍远超 step-03（186 行），
且 step-01（165）/step-04（205）体量都正常——**step-02 是唯一违反原则的 outlier**。

根因（已分析）：

1. step-02 塞了两个独立哲学点：**scope 遮蔽**（每个 agent 可以有自己的人格）
   和**严格插值**（变量 typo 必须炸）——两个点各配一套 AB 对比演示
2. ScopeRegistry 完整实现 4 个 Map（global/scope × sections/variables）+ 4 个
   注册方法 + assemble 合并逻辑
3. interpolate 把 5 种 throw 边界全实现了（畸形引用/未知变量/provider undefined/
   孤立 `{{` 字面量/替换值不二次扫描），main() 有 5 个演示块

本次只重写 step-02 一个文件。**不拆步、不动其他 step、不改编号和脚本**——
用"精简聚焦"达成"一步一个哲学点"：主点讲透，次点降级为最小配套演示。

## 你的角色（三重身份）

1. **资深 AI Agent 工程师**：代码体现生产级设计取舍，只挑"最能说明设计哲学"的核心
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。最高优先级是
   **让读者不卡住**——专有名词先解释、朴素版先展示、每步只讲一件事
3. **DeepSeek Harness 资深源码研究者**：简化实现忠实于真实源码的机制和命名，
   注释标注对应源码文件:行号

## 必读材料（动笔前先读）

1. **现有实现（读懂的机制，不要照抄重）**：
   - `articles/dsh-context/src/steps/step-02-scope-and-variables.ts`（要重写的对象）
   - `articles/dsh-context/src/steps/step-03-waterfall-complete.ts`（**体量基准**：
     186 行，本步重写后的目标参照物）
2. **风格基准（严格对齐）**：
   - `articles/dsh-memory/src/steps/step-02-surface.ts`
   - `articles/dsh-memory/src/steps/step-05-kv-cache.ts`
3. **分析文档的哲学讲解**：`docs/dsh-context-analysis.md`（SystemPrompt 注册表部分）
4. **真实源码（对照核实）**：
   `~/workspace/deepseek-harness-study/source/packages/core/system-prompt/src/index.ts`
   —— ScopedLayers 遮蔽（index.ts:484）、变量合并（index.ts:473-482）、
   interpolate 严格模式（index.ts:258-295）

## 教学铁律（最高优先级）

1. **术语先行，先讲人话**：JSDoc 顶部「先懂几个词」节，本步所有专有名词给
   「大白话类比 + 一句话定义」；代码里第一次出现的专有名词必须注释解释
2. **AB 对比是标配**：main() 先跑朴素版（不懂设计的程序员会怎么写）→ 输出崩点
   （💥）→ 再跑 harness 版 → 输出解决（✅）
3. **一步一个知识点**：本步只解决**一个**主哲学点；本步用不到的机制只字不提
   （或一行注释"源码里还有 XXX，见 index.ts:YYY"）

## 任务规格（核心）

### 本步唯一主哲学点

**为什么每个 agent 可以有自己的人格？（scope 遮蔽）**

- 朴素版：全局只有一个 prompt，子代理想装"前端专家"人格 → 直接改全局字符串 →
  污染所有 agent（部署人格被永久替换）
- harness 版：global / scope 两层注册，scope 层同名 section/variable 遮蔽 global
  层——子代理注册同名 `deployment:persona` 就 shadow 掉全局人格，谁也不污染谁
- 演示必须覆盖：scope 遮蔽 section + scope 遮蔽 variable（变量也按 scope 覆盖）

### 严格插值怎么处理（关键指令）

**严格插值降级为本步的配套演示，不是第二主点**：

- **必须保留**：`{{modle}}` typo → 未知变量 throw 的核心演示（这是"作者错误必须
  响"哲学的最短表达，与 scope 配套展示"注册 + 装配 + 渲染"完整链路）
- **可省略（注释一句话带过，代码不实现）**：provider 返回 undefined、畸形引用
  `{{a b}}`、孤立 `{{` 字面量、替换值不二次扫描——写注释
  `"源码里还有 X/undefined/孤立花括号等 throw 边界，见 index.ts:258-295"`，
  不逐个实现
- 插值函数本身保留严格模式核心（未知变量 throw 即可），不必保留全部边界分支

### 实现要求

- ScopeRegistry 可以保留两层结构，但**以"看得懂"为准，允许重构得更紧凑**
  （如 sections/variables 各一层嵌套 Map，或合并注册方法），你自行决定
- main() 演示压到 3 块左右：① 朴素版（改全局污染）② harness 版（scope 遮蔽
  section + variable）③ typo 严格插值（未知变量 throw 核心演示）
- 保留：renderPrompt 去空段、assertNew 重复注册防御（一行注释即可）、
  `export {}` 结尾、TS 严格模式友好
- **体量目标**：与 step-03 相当（~180 行左右，**不得超过 step-03 的 1.3 倍**，
  即 ≤240 行；现在是 313 行，必须明显下降）

### JSDoc 四段式（沿用）

每文件顶部：**先懂几个词** → **这一步解决什么问题**（痛苦场景）→ **为什么这么
设计**（哲学）→ **收益** → **对应源码**（文件:行号）+ 跑法

## 工程要求

- **保持文件路径不变**：`articles/dsh-context/src/steps/step-02-scope-and-variables.ts`
- **保持 scripts 不变**：`articles/dsh-context/package.json` 的 step:02 与根
  package.json 的 context:step:02 都指向该文件，**不用改**
- 纯 Node 无依赖，只用 tsx 跑，不需要 API key
- 中文注释，console.log 清晰、emoji 前缀（💥 崩点 / ✅ 解决）

## 验证

在 ai-agent-code-lab 根目录：`pnpm run context:step:02` 跑通，无类型错误、
无运行时崩溃、输出有"朴素版崩点 → harness 版解决"对照结构。
（可顺手跑 step:03 对比体量，但不用改它）

## 输出要求

1. 直接修改文件，不要只给方案
2. 报告：行数变化（313 → N）、砍掉了什么（每个省略点在哪行注释里）、
   与 step-03 的体量对比
3. 如有拿不准的源码行为，以真实源码为准并在总结里指出

## 验收标准

- [ ] step-02 只讲**一个**主哲学点（scope 遮蔽）；严格插值是配套演示不是第二主点
- [ ] 行数 ≤ step-03 × 1.3（≤240 行），明显小于现在的 313 行
- [ ] 术语先行：JSDoc 有「先懂几个词」节，专有名词首次出现有注释
- [ ] AB 对比：main() 有"朴素版崩点 → harness 版解决"对照
- [ ] 被省略的插值边界都在注释里说明"源码里还有 XXX，见 index.ts:258-295"
- [ ] 根目录 `pnpm run context:step:02` 跑通
