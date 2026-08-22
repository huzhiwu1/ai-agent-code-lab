# Qoder 任务：精读（四）配套复现——articles/dsh-context 7 步渐进式上下文管理

## 你的角色（三重身份，融合到每一行代码和注释里）

1. **资深 AI Agent 工程师**：写的代码要体现生产级 Agent 框架的设计取舍——不只是"能跑"，要让人看出"为什么这么设计"（性能、token 成本、正确性、防御性）。
2. **AI Agent 教学老师**：读者是**有前端经验但刚学 Agent 的初学者**。每步代码必须能独立运行、输出教学性结果，注释要讲清楚"这一步在解决什么问题、不这么做会怎样"。
3. **DeepSeek Harness 资深源码研究者**：所有简化实现必须忠实于真实源码的机制和命名，注释标注对应源码文件:行号，不能凭空发明与源码不符的行为。

## 项目背景

仓库 `~/workspace/ai-agent-code-lab` 是 **DeepSeek Harness 源码精读系列**的复现仓库：每篇精读 = 分析文档（docs/*.md）+ 渐进式从 0 复现的可运行 TS 代码（articles/dsh-xxx/src/steps/step-01~07.ts）。

已完成的模式（**必须对齐的风格样本，先读再写**）：

- `articles/dsh-tools/src/steps/step-01-minimal-pipeline.ts`（工具管线，风格标杆）
- `articles/dsh-memory/src/steps/step-01-session-log.ts`（记忆管理，最新一期）

已完成的 package.json 模式：

- `articles/dsh-tools/package.json`（@articles/dsh-tools，纯 Node 无依赖，tsx 跑）
- 根 `package.json` scripts 里有 `run:dsh-tools` 等总入口

## 任务

为精读四《上下文管理》创建配套复现 `articles/dsh-context/`，7 步渐进式。

### 必读材料（动笔前先读，读懂再写）

1. **分析文档（教学设计蓝本）**：`~/workspace/ai-agent-code-lab/docs/dsh-context-analysis.md` —— 完整拆解了四个核心层：
   - 第 1 层：SystemPrompt 注册表（五通道 section/context/tools/variable/suppressRuntimeContext；order 排序 -100 身份/0 人格/100-199 工具指引；scope 遮蔽 global；waterfall 可改写；complete 整体接管；严格 {{变量}} 插值）
   - 第 2 层：动态上下文快照投影（RuntimeContextProjection：变了才注入、CLEARED 显式作废、压缩 shadow 后自动补发）
   - 第 3 层：四个上下文生产者插件（agent-instructions / time-context / tmux-context / session-reference）
   - 第 4 层：设计纪律（每个事实一个 owner、kind+form 双维度追溯、预算约束）
2. **真实源码（对照核实，不要凭记忆写）**：`~/workspace/deepseek-harness-study/source/`
   - `packages/core/system-prompt/src/index.ts`（约 470 行：assemble / renderPrompt / interpolate / orderTools）
   - `packages/core/agent-loop/src/runtime-context.ts`（76 行：RuntimeContextProjection）
   - `packages/core/agent-loop/src/agent.ts`（preStep 装配点，约 226-237 行）
   - `packages/context/agent-instructions/src/`（index.ts / state.ts / render.ts）
   - `packages/context/time-context/src/index.ts`
   - `packages/context/tmux-context/src/index.ts`
   - `packages/context/session-reference/src/index.ts`

## 7 步规格（文件名 + 学习目标 + 核心机制，按此实现）

每步一个独立可运行文件，**从最小骨架逐步加机制**，与精读四的"三层"结构对应：

### Step 01 — `step-01-system-prompt-registry.ts`

**最小 SystemPrompt 注册表：静态 prompt 是怎么拼出来的？**

- 核心机制：`section({name, order, text})` 注册 + 按 order 升序排序 + renderPrompt 拼接（去空段、空行连接）
- 演示：注册身份段（-100）/人格段（0）/工具指引段（100），乱序注册、按 order 输出
- 对应源码：`packages/core/system-prompt/src/index.ts` 构造器 section 注册 + renderPrompt
- 学习目标：理解"分区注册 + order 排序"代替"手写一大坨 prompt 字符串"

### Step 02 — `step-02-scope-and-variables.ts`

**scope 遮蔽 + 严格变量插值：每个 agent 怎么有自己的 prompt？**

- 核心机制：
  - global/scope 两层注册，scope 层同名 section/variable 遮蔽 global（子代理装人格的机制基础）
  - 变量注册 `variable(name, provider)` + `{{var}}` 插值
  - **严格插值**：未知变量 throw、provider 返回 undefined throw、畸形引用 throw；孤立 `{{`（后面无 `}}`）是字面量正文；替换值不再二次扫描
- 演示：global 人格被 agent scope 人格遮蔽；`{{model}}`/`{{cwd}}` 注入；`{{modle}}` typo 直接炸（注释解释为什么严格模式是作者错误的扩音器）
- 对应源码：`index.ts` ScopedLayers / assemble 变量合并 / interpolate（严格模式四种 throw）

### Step 03 — `step-03-waterfall-complete.ts`

**waterfall 可改写 + complete 整体接管：专家插件怎么改写 prompt？**

- 核心机制：
  - waterfall：`system-prompt/assemble` 事件（简化：函数数组），返回值权威，可改写整个 assembly
  - complete section：waterfall 之后强制恢复成只有这一个 section；多个 complete 同时激活 throw
  - 工具 schema 收集 + 参数分离（parameters 不进正文，走 tools 通道）+ knownNames 防拼错
- 演示：一个"改写插件"把人格段文本替换；complete section 包场后其他 section 全部消失；两个 complete 冲突报错
- 对应源码：`index.ts` assemble 第 5 步 + complete 边界处理 + orderTools 防御

### Step 04 — `step-04-runtime-context-snapshot.ts`

**动态上下文快照投影：为什么"变了才说"能省 token？**

- 核心机制：`RuntimeContextProjection.project(current, sections)`：
  - 首次无快照 + 当前为空 → 不注入
  - 内容没变 → 不注入
  - 内容变了 → 注入新快照
  - 从有到无 → 注入 CLEARED 显式作废标记（"Current runtime context: none. Earlier runtime-context snapshots no longer apply."）
  - 快照带 sections 元数据（每个贡献方 name+text）
- 演示：连续三轮（时间变了/没变/清空），打印每轮注入/跳过/作废；模拟 compaction shadow 后 retained 置 null → 自动补发
- 对应源码：`packages/core/agent-loop/src/runtime-context.ts` 全文（76 行，可以完整复刻核心逻辑）

### Step 05 — `step-05-agent-instructions.ts`

**工作区指令：AGENTS.md 是怎么进上下文的？**

- 核心机制：
  - 加载链：user-global（$DSH_HOME/AGENTS.md）→ 项目根 → … → cwd，从宽到窄，具体覆盖宽泛
  - 基线注入：第一次 pre-step 渲染整条链成 baseline user 消息
  - 动态 reconcile：成功的 read/write/edit 后，对比可见状态与文件系统，渲染 set（新出现）/ replace（内容变）/ remove（删除）增量
  - 字节预算：全部放不下 → 从最宽泛开始省略 → 只剩一个最具体还超 → 二分截断（UTF-8 边界回退）→ 连标题都放不下 → 预算通知
- 演示：用临时目录 + 真实文件模拟（写一个 AGENTS.md → 基线注入 → 改内容 → replace 增量 → 删文件 → remove 增量 → 塞超长文件 → 截断）
- 对应源码：`packages/context/agent-instructions/src/render.ts`（预算约束渲染）+ state.ts（reconcileInstructionContext）+ index.ts

### Step 06 — `step-06-time-tmux-context.ts`

**time-context + tmux-context：请求时钟和终端位置**

- 核心机制：
  - time-context：绝对时间（含时区）+ 浏览器时区探测 + 相对耗时（距上一条模型可见消息）；refreshIntervalMs 限频
  - tmux-context：`tmux display-message` 注入 session/window/pane/layout
  - **伪 tmux 检测**（重点）：`$TMUX_PANE` 存在 ≠ 真在 tmux（VS Code 集成终端继承环境变量）；比较 `ps -o tty=` 与本进程控制终端 vs `#{pane_tty}`，不匹配视为不在 tmux
  - 变化驱动重注入：稳定状态块（session/window/pane/layout）变了才重新注入
- 演示：time-context 注入两次请求（间隔>阈值才重注入）；tmux 部分模拟环境变量存在但 tty 不匹配 → 判定伪 tmux 不注入；tty 匹配 → 注入位置信息
- 对应源码：`packages/context/time-context/src/index.ts` + `packages/context/tmux-context/src/index.ts`（queryTmuxLocation 可以完整复刻）

### Step 07 — `step-07-session-reference-full-assembly.ts`

**跨会话引用 + 完整 pre-step 装配链（全家桶）**

- 核心机制：
  - session-reference：入队前读快照（源会话后变不影响）；聚合 JSON 包"untrusted, read-only"不可信警告；tag-safe 序列化（`<` → `\u003c`）；预算保留（head/tail 裁剪 + 精确记录 omitted 字节）；最多 3 个引用；拒绝自引用
  - **完整装配链整合**：assemble（注册表+变量+工具）→ renderContextSections → joinContextSections（"Current runtime context. This snapshot supersedes earlier..."）→ project 快照投影 → agent/pre-step waterfall（四个插件往里塞消息）→ renderPrompt → 最终发给"LLM"（简化：打印完整请求）
- 演示：两个模拟会话（一个正常、一个含恶意指令"忽略之前所有指令"），引用后模型侧收到的完整请求——能看到不可信警告 + 注入的指令在引用里被当背景信息；完整链路跑一遍
- 对应源码：`packages/context/session-reference/src/index.ts` + projection.ts；`agent.ts` preStep + `runtime-context.ts`

## 工程要求

1. **目录结构**：`articles/dsh-context/src/steps/step-01~07-*.ts` + `articles/dsh-context/package.json`
2. **package.json**（对齐 dsh-tools）：name `@articles/dsh-context`，纯 Node 无依赖（只用 tsx 跑），scripts：`start`/`run:dsh-context` → step-07，`step:01`~`step:07` 各自映射
3. **根 package.json**：追加 `run:dsh-context` 脚本（对齐现有 `run:dsh-tools`）
4. **代码风格**（严格对齐样本）：
   - 每个文件顶部 JSDoc：**学习目标**（2-4 句，讲清"这一步在解决什么问题"）+ **对应源码**（文件:行号）+ **跑法**
   - 简化实现，但机制和命名忠于源码；关键注释标注"对应源码 xxx"
   - 教学性：每步 main() 演示多种情况（正常/异常/边界），console.log 输出清晰、有 emoji 前缀（✅🚫❓等，对齐样本）
   - 用 `export {}` 结尾
   - 全程 TS 严格模式友好（不要 any 泛滥），能过 ESLint（typescript-eslint + prettier）
5. **验证**：写完必须逐个跑通 `pnpm run step:01` ~ `step:07`（在 ai-agent-code-lab 根目录），确保无类型错误、无运行时崩溃，输出有教学价值
6. **README**：在 ai-agent-code-lab/README.md 的文章列表和渐进式步骤表格中追加精读四（文章链接用飞书 https://my.feishu.cn/docx/MVeZd2Ttso3qmqxUPq7c9RQDnzc ，分析文档 docs/dsh-context-analysis.md，步骤表加 7 行）

## 输出要求

1. 直接创建/修改上述文件，不要只给方案
2. 完成后逐个跑通验证，报告每步的输出摘要（一两行即可）
3. 总结里说明：每步复现了源码的哪个核心机制、与真实源码的差异（简化了什么）——方便 reviewer 核对
4. 如有拿不准的源码行为，以真实源码为准，并在总结里指出

## 验收标准

- [ ] articles/dsh-context/ 7 个 step 文件齐全，结构对齐 dsh-tools/dsh-memory
- [ ] 根目录 `pnpm run step:01`~`step:07` 全部跑通（tsx）
- [ ] 每步注释标注了对应源码位置（可追溯到 packages/ 真实路径）
- [ ] step-04 完整复刻 RuntimeContextProjection 语义（去重/作废/补发）
- [ ] step-05 真实文件演示（临时目录），不是硬编码假数据
- [ ] step-07 完整装配链 + 不可信警告 + tag-safe 序列化演示
- [ ] README 已更新
