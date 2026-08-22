# DeepSeek Harness 源码精读（ai-agent-code-lab）

**DeepSeek Harness 源码精读系列**：解析文档（Markdown）+ **渐进式从 0 复现代码**（TypeScript，真实 LLM 可运行），pnpm monorepo + ESLint/Prettier 管理。

DeepSeek Harness（v0.1.0-rc.5，2026-08-13 开源，MIT）是 DeepSeek 官方的 Agent 运行时框架，Cordis 插件元框架，"一切皆插件"。本系列从源码出发拆解其核心机制，并**从 0 开始一步步实现一遍**验证理解——每个简化版代码的注释都标注了对应源码位置。

> 💡 **注意**：AI Agent 通用知识文章（记忆管理、上下文工程等）的代码示例在另一个仓库：[ai-agent-code-examples](https://github.com/huzhiwu1/ai-agent-code-examples)。

## 📖 文章列表

| 篇目                 | 内容                                                                      | 飞书完整版（含渲染图）                                            | 本地 Markdown                                                      |
| -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| 第一篇：Agent 主循环 | turn/step 双层循环、消息注入、max-tokens 粘性、工具并发调度、Phase 状态机 | [飞书文档](https://my.feishu.cn/docx/BmMsdkoDCoId9rxFSaAcOUEhngb) | [docs/dsh-agent-loop-analysis.md](docs/dsh-agent-loop-analysis.md) |
| 第二篇：工具调用管线 | 六段执行管线、参数物化、单调守卫、取消体系、并行/独占调度                 | [飞书文档](https://my.feishu.cn/docx/BCryd1dmDouDjbxHbdLcLAWUnUd) | [docs/dsh-tools-analysis.md](docs/dsh-tools-analysis.md)           |
| 第三篇：记忆管理     | 事件日志、surface 投影、压力检测、checkpoint 压缩、KV cache 复用          | [飞书文档](https://my.feishu.cn/docx/TfeGdEouco5KmMxeT7ocmEctnyd) | [docs/dsh-memory-analysis.md](docs/dsh-memory-analysis.md)         |
| 第四篇：上下文管理   | SystemPrompt 注册表、快照投影（变了才说）、四类上下文插件、装配纪律       | [飞书文档](https://my.feishu.cn/docx/MVeZd2Ttso3qmqxUPq7c9RQDnzc) | [docs/dsh-context-analysis.md](docs/dsh-context-analysis.md)       |

> 飞书版含完整渲染的主循环全景图（mermaid），建议优先阅读。

## 🧪 从 0 实现一遍：渐进式步骤

源码学习最好的方式不是直接读完整实现，而是**从最小骨架开始，一步一步把机制加回去**。本仓库把 Agent 主循环拆成 7 个渐进步骤，每步都是独立可运行的真实代码：

| 步骤    | 文件名                                                                                                     | 学到什么                                                 | 跑法               |
| ------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------ |
| Step 01 | [steps/step-01-minimal.ts](articles/dsh-agent-loop/src/steps/step-01-minimal.ts)                           | **最小骨架**：turn/step 双层循环（无工具）               | `pnpm run step:01` |
| Step 02 | [steps/step-02-tools-declared.ts](articles/dsh-agent-loop/src/steps/step-02-tools-declared.ts)             | **工具声明**：bindTools 让模型声明 tool_calls（不执行）  | `pnpm run step:02` |
| Step 03 | [steps/step-03-execute-and-feedback.ts](articles/dsh-agent-loop/src/steps/step-03-execute-and-feedback.ts) | **工具闭环**：执行工具 + ToolMessage 回填 + 多 step 往返 | `pnpm run step:03` |
| Step 04 | [steps/step-04-state-machine.ts](articles/dsh-agent-loop/src/steps/step-04-state-machine.ts)               | **结束状态机**：max-tokens 粘性 + 错误处理 + 取消        | `pnpm run step:04` |
| Step 05 | [steps/step-05-kick-wake.ts](articles/dsh-agent-loop/src/steps/step-05-kick-wake.ts)                       | **外部驱动 + Phase**：kick/wake + idle↔running + latch   | `pnpm run step:05` |
| Step 06 | [steps/step-06-pre-step.ts](articles/dsh-agent-loop/src/steps/step-06-pre-step.ts)                         | **preStep 决策点**：claim + waterfall + reject           | `pnpm run step:06` |
| Step 07 | [steps/step-07-full.ts](articles/dsh-agent-loop/src/steps/step-07-full.ts)                                 | **完整版**：整合前 6 步 + 三种消息注入 + 诊断            | `pnpm run step:07` |

> 📖 **精读二《工具调用管线》配套复现**（`articles/dsh-tools/`）：每步只解决一个哲学点——为什么这么设计、好处是什么：

| 步骤    | 文件名                                                                                      | 学到什么                                                  | 跑法                     |
| ------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------ |
| Step 01 | [step-01-pipeline-skeleton.ts](articles/dsh-tools/src/steps/step-01-pipeline-skeleton.ts)   | **管线骨架**：工具调用 ≠ 调函数，六道关地图               | `pnpm run tools:step:01` |
| Step 02 | [step-02-arg-freezing.ts](articles/dsh-tools/src/steps/step-02-arg-freezing.ts)             | **参数物化**：参数一进管线就定型，审计自证靠冻结          | `pnpm run tools:step:02` |
| Step 03 | [step-03-approval-waterfall.ts](articles/dsh-tools/src/steps/step-03-approval-waterfall.ts) | **审批瀑布**：危险工具要问人，无通道也拒绝（fail-closed） | `pnpm run tools:step:03` |
| Step 04 | [step-04-monotonic-guard.ts](articles/dsh-tools/src/steps/step-04-monotonic-guard.ts)       | **单调守卫**：只能拒绝不能放行，拒绝永远是终局            | `pnpm run tools:step:04` |
| Step 05 | [step-05-timeout-wrap.ts](articles/dsh-tools/src/steps/step-05-timeout-wrap.ts)             | **超时环绕**：横切关注点包一层，注册即获得                | `pnpm run tools:step:05` |
| Step 06 | [step-06-post-execute.ts](articles/dsh-tools/src/steps/step-06-post-execute.ts)             | **post-execute**：输出同输入一样不可信，结果也要过门      | `pnpm run tools:step:06` |
| Step 07 | [step-07-full-pipeline.ts](articles/dsh-tools/src/steps/step-07-full-pipeline.ts)           | **完整协作**：六道关衔接、短路传播、审批放行 ≠ 守卫放行   | `pnpm run tools:step:07` |

> 📖 **精读三《记忆管理》配套复现**（`articles/dsh-memory/`）：7 步渐进，从事件日志一路拼到完整链路：

| 步骤    | 文件名                                                                           | 学到什么                                             | 跑法                      |
| ------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------- |
| Step 01 | [step-01-session-log.ts](articles/dsh-memory/src/steps/step-01-session-log.ts)   | **事件日志**：append-only 唯一事实源，历史只是派生   | `pnpm run memory:step:01` |
| Step 02 | [step-02-surface.ts](articles/dsh-memory/src/steps/step-02-surface.ts)           | **surface 投影**：模型看到的只是日志的投影，不存副本 | `pnpm run memory:step:02` |
| Step 03 | [step-03-pressure.ts](articles/dsh-memory/src/steps/step-03-pressure.ts)         | **压力检测**：什么时候该压缩，按 token 压力触发      | `pnpm run memory:step:03` |
| Step 04 | [step-04-checkpoint.ts](articles/dsh-memory/src/steps/step-04-checkpoint.ts)     | **checkpoint**：折叠旧历史 + 摘要，压缩后仍可回溯    | `pnpm run memory:step:04` |
| Step 05 | [step-05-kv-cache.ts](articles/dsh-memory/src/steps/step-05-kv-cache.ts)         | **KV cache 复用**：总结指令复用前缀，省 token        | `pnpm run memory:step:05` |
| Step 06 | [step-06-write-behind.ts](articles/dsh-memory/src/steps/step-06-write-behind.ts) | **write-behind**：append 不阻塞 I/O，异步持久化      | `pnpm run memory:step:06` |
| Step 07 | [step-07-full-chain.ts](articles/dsh-memory/src/steps/step-07-full-chain.ts)     | **完整链路**：日志 → 投影 → 压缩 → 持久化全流程      | `pnpm run memory:step:07` |

> 📖 **精读四《上下文管理》配套复现**（`articles/dsh-context/`）：同样 7 步渐进，从 SystemPrompt 注册表一路拼到完整 pre-step 装配链：

| 步骤    | 文件名                                                                                                                  | 学到什么                                                               | 跑法                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| Step 01 | [step-01-system-prompt-registry.ts](articles/dsh-context/src/steps/step-01-system-prompt-registry.ts)                   | **注册表**：section 分区 + order 排序 + 拼接渲染（取代手写大坨字符串） | `pnpm run context:step:01` |
| Step 02 | [step-02-scope-and-variables.ts](articles/dsh-context/src/steps/step-02-scope-and-variables.ts)                         | **scope 遮蔽 + 严格插值**：per-agent prompt、{{变量}} typo 直接炸      | `pnpm run context:step:02` |
| Step 03 | [step-03-waterfall-complete.ts](articles/dsh-context/src/steps/step-03-waterfall-complete.ts)                           | **waterfall + complete**：专家插件改写 prompt、complete 整体接管       | `pnpm run context:step:03` |
| Step 04 | [step-04-runtime-context-snapshot.ts](articles/dsh-context/src/steps/step-04-runtime-context-snapshot.ts)               | **快照投影**：变了才注入、CLEARED 作废标记、压缩后自动补发             | `pnpm run context:step:04` |
| Step 05 | [step-05-agent-instructions.ts](articles/dsh-context/src/steps/step-05-agent-instructions.ts)                           | **AGENTS.md 动态注入**：基线 + set/replace/remove 增量 + 字节预算      | `pnpm run context:step:05` |
| Step 06 | [step-06-time-tmux-context.ts](articles/dsh-context/src/steps/step-06-time-tmux-context.ts)                             | **时间/位置上下文**：请求时钟、伪 tmux 检测、变化驱动重注入            | `pnpm run context:step:06` |
| Step 07 | [step-07-session-reference-full-assembly.ts](articles/dsh-context/src/steps/step-07-session-reference-full-assembly.ts) | **跨会话引用 + 全家桶**：不可信警告、tag-safe、完整 pre-step 装配链    | `pnpm run context:step:07` |

每个步骤文件顶部都有「学习目标」+「对应源码位置」，跑完一步看输出，再进下一步——这就是从 0 理解主循环的路径。

## 快速开始

```bash
git clone git@github.com:huzhiwu1/ai-agent-code-lab.git
cd ai-agent-code-lab
pnpm install

# 复制环境变量模板并填写 LLM key
cp .env.example .env

# 从 step-01 开始，一步步跑
pnpm run step:01
pnpm run step:02
# ... 直到完整版
pnpm run step:07
```

## 🔧 环境要求

- Node.js ≥ 20
- pnpm ≥ 9（pnpm-workspace.yaml 管理 monorepo）
- 任意 OpenAI 兼容的 LLM 端点（默认 DeepSeek：`https://api.deepseek.com`，也支持网关）
- `.env` 配置：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`

## 🛠️ 开发工具链

- **ESLint**（typescript-eslint + eslint-config-prettier）：`pnpm run lint` / `pnpm run lint:fix`
- **Prettier**：`pnpm run format` / `pnpm run format:check`
- **Husky + lint-staged**：pre-commit 自动 format/lint

## 📚 相关链接

- DeepSeek Harness 官方仓库：https://github.com/deepseek-ai/dsh
- 源码精读系列飞书文档目录：「DeepSeek Harness 源码学习」文件夹

## License

MIT
