# DeepSeek Harness 源码精读（ai-agent-code-lab）

**DeepSeek Harness 源码精读系列**：解析文档（Markdown）+ 简化版复现代码（TypeScript，真实 LLM 可运行），pnpm monorepo 管理。

DeepSeek Harness（v0.1.0-rc.5，2026-08-13 开源，MIT）是 DeepSeek 官方的 Agent 运行时框架，Cordis 插件元框架，"一切皆插件"。本系列从源码出发拆解其核心机制，并用简化版复现验证理解——每个简化版代码的注释都标注了对应源码位置。

> 💡 **注意**：AI Agent 通用知识文章（记忆管理、上下文工程等）的代码示例在另一个仓库：[ai-agent-code-examples](https://github.com/huzhiwu1/ai-agent-code-examples)。

## 📖 文章列表

| 篇目                 | 内容                                                                      | 飞书完整版（含渲染图）                                            | 本地 Markdown                                                      |
| -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| 第一篇：Agent 主循环 | turn/step 双层循环、消息注入、max-tokens 粘性、工具并发调度、Phase 状态机 | [飞书文档](https://my.feishu.cn/docx/BmMsdkoDCoId9rxFSaAcOUEhngb) | [docs/dsh-agent-loop-analysis.md](docs/dsh-agent-loop-analysis.md) |

> 飞书版含完整渲染的主循环全景图（mermaid），建议优先阅读。

## 🧪 代码复现

| 篇目         | 代码                                                 | 跑法                    |
| ------------ | ---------------------------------------------------- | ----------------------- |
| Agent 主循环 | [articles/dsh-agent-loop/](articles/dsh-agent-loop/) | `pnpm run run:dsh-loop` |

## 快速开始

```bash
git clone git@github.com:huzhiwu1/ai-agent-code-lab.git
cd ai-agent-code-lab
pnpm install

# 复制环境变量模板并填写 LLM key
cp .env.example .env

# 跑示例（真实 LLM 调用，需要配置 LLM_API_KEY）
pnpm run run:dsh-loop
```

## 🔧 环境要求

- Node.js ≥ 20
- pnpm ≥ 9
- 任意 OpenAI 兼容的 LLM 端点（默认 DeepSeek：`https://api.deepseek.com`，也支持网关）
- `.env` 配置：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`

## 📚 相关链接

- DeepSeek Harness 官方仓库：https://github.com/deepseek-ai/dsh
- 源码精读系列飞书文档目录：「DeepSeek Harness 源码学习」文件夹

## License

MIT
