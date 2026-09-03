/**
 * Step 03 对照组：朴素做法——接受后忽略（不校验，persona 静默失效）
 *
 * 演示事故：父请求"给 child 装海盗人设"，provider 根本不支持 persona，
 * 但默默接受——child 收到的是普通 system prompt，开口不是海盗腔。
 * 父 agent 以为人设生效、实际没生效——"信任崩塌现场"。
 */

import { llmTask } from '../../shared/llm'

/**
 * 💥 朴素版：不校验能力，无论请求什么字段都直接接受。
 * 不支持 persona 的 provider 默默忽略 persona 字段——父 agent 毫不知情。
 * 注意：task 里**故意不提**人设——persona 字段被丢弃后，模型只能当普通子代理回答。
 */
async function naiveStart(_persona?: string): Promise<string> {
  // ⚠️ 不管 persona 字段有没有传，都同一套 system prompt；persona 参数直接被丢弃
  const system = '你是一个被派来干活的普通子代理。'
  return llmTask(system, '用一句话介绍你自己。')
}

export async function naiveDemo(): Promise<void> {
  console.log('── A. 对照组：接受后忽略翻车现场 ──')

  // ── 事故：父请求海盗人设 → 被静默忽略 ──
  console.log('\n🚫 事故：父请求"海盗人设"→ provider 不支持，但静默接受')
  console.log('   父 agent 的请求：prompt + persona="说话像海盗"')
  console.log('   provider 的能力：persona=false（不支持人设）')

  const result = await naiveStart('说话像海盗')
  console.log(`   📨 child 回答：${result}`)
  const personaWorked = /海盗|船|哟|pirate/i.test(result)
  console.log(
    `   ${personaWorked ? '❌' : '💥'} 人设${personaWorked ? '意外生效了' : '没生效——child 是普通回答，不是海盗腔'}`,
  )
  console.log('   → 父 agent 以为"我已经给 child 设了海盗人设"，实际 child 没有任何人设')
  console.log('     这是"信任崩塌现场"：限制以为在，其实不在。父后来发现 child 行为完全没人设。')
  console.log(
    '     harness 的做法：assertCapabilities 委托前逐一校验，缺能力就抛 UNSUPPORTED_CAPABILITY',
  )
  console.log(
    '     → child 从未被创建，父 agent 立刻知道"这个 provider 干不了这活"，可以换人或调整请求。',
  )
}

export {}
