/**
 * Step 02 – spawn vs fork：都是"派子代理"，差在哪？——委托的两种上下文哲学
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「spawn」= 派一个 fresh child：零父上下文，看不到父对话（类比：外包全新供应商，
 *   把需求完整写在合同里，对方对你公司的历史一无所知）。
 * 「fork」= 派一个 seed child：把父"已完成 turn 前缀"复制给 child 当起点（类比：
 *   把新人拉进群聊，让他先看完聊天记录再接手你聊到一半的话题）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：所有子代理一视同仁"给它一段话就能干活"。但"基于已有对话的追问"
 * 和"独立调研"是两种任务：前者没有父上下文就是答非所问，后者带着父上下文
 * 反而是污染。一种上下文哲学塞不下两类任务。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 哲学点①：`inheritsParentContext` 是描述性标志（spawn=false / fork=true），只供
 * 模型面向的工具文案用（描述说"继承"还是"独立"），不改变任何服务校验。
 * 哲学点②：fork 的 seed 不是"把整个父日志复制过去"，而是 completedTurnPrefix：
 * 截到**最后一个 turn/end**。in-flight turn（正在进行、还没收尾的那轮）被
 * 排除——它里面的 subagent 调用还没结果，事件是不平衡的，不能作为合法的
 * 回放历史（copy 一半的账本会让 child 读到"调用已发出但结果不存在"的鬼状态）。
 *
 * ── 本步在 8 步渐进里的位置 ─────────────────────────────────
 * step-01 的 provider 只有 name + start。本步长出第一个新概念：child 的上下文从
 * 哪来？spawn = 零上下文，fork = 父日志的已完成 turn 前缀。step-03 继续长出能力。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 追问型任务 fork（省 token、答得上上下文），独立任务 spawn（隔离、防污染）；
 * in-flight turn 永远不会被误继承。
 *
 * 对应源码：packages/subagent/subagent-fork-in-process/src/index.ts
 *   （completedTurnPrefix L48-54、inheritsParentContext L64）
 *   packages/subagent/subagent-spawn-in-process/src/index.ts（inheritsParentContext L44）
 * 跑法：pnpm run subagent:step:02（或 articles/dsh-subagent 内 pnpm run step:02）
 */

import { Session } from './session'
import { completedTurnPrefix, visibleText } from './prefix'
import { spawnChild, forkChild, inheritsParentContext } from './children'
import { clip } from '../../shared/clip'
import { naiveDemo } from './naive'

async function main(): Promise<void> {
  console.log('🍴 Step 02 – spawn vs fork：独立调研派 spawn，追问派 fork')
  console.log('='.repeat(62))

  // ── A. 对照组：朴素 fork 翻车现场 ──
  naiveDemo()

  // ── B. Harness 方案 ──
  console.log('\n── B. Harness 方案：completedTurnPrefix 精确截断 ──')

  // ── ① 描述性标志：inheritsParentContext（本步给 provider 长出的第一个字段）──
  console.log('\n① provider 的 inheritsParentContext 描述性标志')
  console.log(
    `   spawn=${inheritsParentContext.spawn}（独立上下文）fork=${inheritsParentContext.fork}（继承对话）`,
  )
  console.log('   → 它只供模型面向的工具文案用，不改变任何服务校验。')

  // ── ② 造一个父会话日志：1 个已完成 turn + 1 个 in-flight turn ──
  console.log('\n② 父会话日志（1 个已完成 turn + 1 个正在进行的 turn）')
  const parent = new Session()
  // turn 1（已完成）：用户问技术栈，assistant 回答后收尾
  parent.append({ type: 'turn/start' })
  parent.append({ type: 'user/message', content: '我们这个 AI 课程项目用什么技术栈？' })
  parent.append({
    type: 'assistant/message',
    content: '前端用 React + Vite，后端用 NestJS，AI 部分用 LangChain。',
  })
  parent.append({ type: 'turn/end' })
  // turn 2（in-flight）：assistant 刚发起一次子代理调用，还没等到结果
  parent.append({ type: 'turn/start' })
  parent.append({ type: 'user/message', content: '帮我把登录接口的安全性检查一遍。' })
  parent.append({ type: 'assistant/message', content: '好的，我派一个子代理去审计登录接口。' })
  parent.append({
    type: 'tool/call',
    name: 'subagent',
    arguments: '{"description":"审计登录接口","prompt":"检查 /api/login ..."}',
  })
  // ← 注意：turn 2 没有 turn/end，子代理的 tool/result 也还没回来

  console.log('   完整父日志：')
  for (const e of parent.events) {
    const detail =
      'content' in e ? e.content : 'arguments' in e ? `${e.name}(${e.arguments.slice(0, 30)}…)` : ''
    console.log(`     ${e.type.padEnd(20)} ${clip(detail, 44)}`)
  }

  // ── ③ completedTurnPrefix：seed 截到最后一个 turn/end ──
  console.log('\n③ fork 的 seed = completedTurnPrefix（截到最后一个 turn/end）')
  const seed = completedTurnPrefix(parent)
  console.log(`   🔍 seed 含 ${seed.length} 条事件（父日志共 ${parent.events.length} 条）`)
  for (const line of visibleText(seed)) console.log(`     ${clip(line, 60)}`)
  const inFlight = parent.events.slice(seed.length)
  console.log(
    `   🚫 被排除的 in-flight turn：${inFlight
      .filter(e => e.type === 'tool/call')
      .map(e => (e as Extract<(typeof inFlight)[number], { type: 'tool/call' }>).name)
      .join('、')}（调用已发出但结果没回来）`,
  )
  console.log('   → 为什么排除：turn 没收尾 = 事件不平衡，把半本账复制给 child 会制造鬼状态。')

  // ── ④ fork child：继承上下文，能答出父对话内容 ──
  console.log('\n④ fork 一个 child，追问父对话内容（真实 LLM 回答）')
  const forkAnswer = await forkChild(seed, '父 agent 刚才说的 AI 部分用的是什么技术？请直接回答。')
  console.log(`   📨 fork child 回答：${clip(forkAnswer)}`)
  const forkKnows = /langchain|LangChain|langChain/i.test(forkAnswer)
  console.log(
    `   ${forkKnows ? '✅' : '❌'} fork child ${forkKnows ? '答出了继承的上下文' : '没能答出上下文'}（它有 seed，看得见父历史）`,
  )

  // ── ⑤ spawn child：同一追问，答不出继承内容 ──
  console.log('\n⑤ spawn 一个 child，问同一个追问（真实 LLM 回答）')
  const spawnAnswer = await spawnChild('父 agent 刚才说的 AI 部分用的是什么技术？请直接回答。')
  console.log(`   📨 spawn child 回答：${clip(spawnAnswer)}`)
  const spawnKnows = /langchain|LangChain|langChain/i.test(spawnAnswer)
  console.log(
    `   ${spawnKnows ? '❌ 意外：spawn 居然看见了父上下文' : '✅'} spawn child 答不出（它上下文是空的，只会照实说不知道）`,
  )
  console.log('   → 同一个追问，两种哲学两种结果：追问必须 fork，独立任务必须 spawn。')

  // ── ⑥ 父日志的可见范围：只有 tool/call + tool/result ──
  console.log('\n⑥ 父日志只记录子代理的"调用 + 最终输出"，child 内部过程不进父日志')
  const childInternal = new Session()
  childInternal.append({ type: 'turn/start' })
  childInternal.append({ type: 'user/message', content: '审计登录接口' })
  childInternal.append({ type: 'tool/call', name: 'read_file', arguments: '{"path":"auth.ts"}' })
  childInternal.append({ type: 'tool/result', content: '找到 3 处问题' })
  childInternal.append({ type: 'assistant/message', content: '审计完成，3 处中危漏洞。' })
  childInternal.append({ type: 'turn/end' })
  // 父日志只追加两行：调用标记 + 最终输出
  parent.append({ type: 'tool/result', content: '审计完成，3 处中危漏洞。' })
  parent.append({ type: 'turn/end' })
  console.log(
    '   child 内部 6 条事件（read_file 调用等）→ 父日志只追加 2 条：tool/result（最终输出）+ turn/end（收尾）',
  )
  console.log(`   父日志现在 ${parent.events.length} 条；child 内部 step 永远不会出现在父日志里`)

  // ── C. 🎯 一句话小结 ──
  console.log(
    '\n🎯 一句话：spawn 给独立任务一个干净的脑子，fork 给追问任务一本抄好的笔记——边界是最后一个 turn/end。',
  )
}

main().catch(error => {
  console.error('❌', error)
  process.exit(1)
})

export {}
