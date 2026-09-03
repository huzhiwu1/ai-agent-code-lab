/**
 * Step 04 — 委托链演示工具（makeChild / ROOT）
 *
 * 对应源码：packages/subagent/subagent/src/child-agent.ts
 *   resolveChildDepth L49-58（发布前拒绝超限委托）
 *   childSessionMeta L138-156（delegationDepth 写进持久 header）
 */

import { resolveChildDepth, type AgentLike } from './depth'

/** 顶层 agent：depth 0，无持久化烙印（对应源码 delegationDepthOf 的缺省值 0） */
export const ROOT: AgentLike = { options: {}, header: {} }

/**
 * 造一个被派出来的 child：烙下 delegationDepth = childDepth 的持久化 header。
 * 对应源码 resolveChildDepth L49-58（算 child 深度 + 执行 maxDepth 上限）+
 * childSessionMeta L138-156（深度写进持久 header，跨重启不丢，monotone floor）。
 */
export function makeChild(parent: AgentLike, maxDepth: number | undefined): AgentLike {
  const childDepth = resolveChildDepth(parent, maxDepth)
  console.log(`   ✅ 发布 child（delegationDepth 烙进 header = ${childDepth}）`)
  // 关键：深度写进持久化 header（模拟落库），而不是只在内存 options 里
  return { options: {}, header: { delegationDepth: childDepth } }
}

export {}
