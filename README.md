# AI Agent Code Lab

AI Agent 知识文章的**代码示例库**（monorepo，每篇文章一个独立包）+ **DeepSeek Harness 源码精读系列解析**。

本仓库是学习 AI Agent 开发（vibecoding）的实战代码库：每篇文章都配一份可运行的 TypeScript 代码，用真实 LLM 跑通核心机制，而不是纸面概念。

## 📖 DeepSeek Harness 源码精读系列

DeepSeek Harness（v0.1.0-rc.5，2026-08-13 开源，MIT）是 DeepSeek 官方的 Agent 运行时框架，Cordis 插件元框架，"一切皆插件"。本系列从源码出发拆解其核心机制，并配简化版复现验证理解。

| 篇目 | 内容 | 飞书完整版（含渲染图） | 本地 Markdown |
|------|------|----------------------|--------------|
| 第一篇：Agent 主循环 | turn/step 双层循环、消息注入、max-tokens 粘性、工具并发调度、Phase 状态机 | [飞书文档](https://my.feishu.cn/docx/BmMsdkoDCoId9rxFSaAcOUEhngb) | [docs/dsh-agent-loop-analysis.md](docs/dsh-agent-loop-analysis.md) |

> 飞书版含完整渲染的主循环全景图（mermaid），建议优先阅读。

## 🧪 代码示例

| 文章 | 代码 | 跑法 |
|------|------|------|
| Agent 主循环源码精读 | [articles/dsh-agent-loop/](articles/dsh-agent-loop/) | `npm run run:dsh-loop` |
| 上下文工程：语义裁剪 | [articles/context-eng/](articles/context-eng/) | `npm run run:context-eng` |
| 记忆管理：怎么让 Agent 记住上次对话 | [articles/agent-memory/](articles/agent-memory/) | `npm run run:memory` |

### 快速开始

```bash
git clone git@github.com:huzhiwu1/ai-agent-code-lab.git
cd ai-agent-code-lab
npm install

# 复制环境变量模板并填写 LLM key
cp .env.example .env

# 跑某个示例（真实 LLM 调用，需要配置 LLM_API_KEY）
npm run run:dsh-loop
```

## 🔧 环境要求

- Node.js ≥ 20
- 任意 OpenAI 兼容的 LLM 端点（默认 DeepSeek：`https://api.deepseek.com`，也支持网关）
- `.env` 配置：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`

## 📚 相关链接

- DeepSeek Harness 官方仓库：https://github.com/deepseek-ai/dsh
- 源码精读系列飞书文档目录：「DeepSeek Harness 源码学习」文件夹

## License

MIT
