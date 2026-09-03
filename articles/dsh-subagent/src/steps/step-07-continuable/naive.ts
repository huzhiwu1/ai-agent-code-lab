/**
 * Step 07 对照组：朴素做法——每个 followup 都新建一个 child（没有持久 Session 概念）
 *
 * 演示事故：追问一轮 → 新 child 完全不记得上一轮（上下文丢失）
 */

export function naiveDemo(): void {
  console.log('── A. 对照组：每次追问都失忆 ──')

  console.log('\n🚫 事故：每个 followup 都新建一个 child——没有持久 Session')
  console.log('   朴素实现：第一轮派 child 回答"什么是泛型"')
  console.log('   child 回答完后 dispose——转录消失')
  console.log('   第二轮追问"刚才说的泛型约束是什么？"——新建一个 child')
  console.log('   → 新 child 完全不知道第一轮聊了什么')

  console.log('   朴素代码：')
  console.log('     // 第一轮：')
  console.log('     const child1 = new ChildAgent()')
  console.log('     await child1.run("什么是泛型")')
  console.log('     child1.dispose() // 💥 转录没了')
  console.log('     // 第二轮：')
  console.log('     const child2 = new ChildAgent()')
  console.log('     await child2.run("刚才说的泛型约束是什么？")')
  console.log('     // child2 会回答："我不记得刚才说了什么"')

  console.log('   💥 每次追问都失忆——父 agent 要重新喂每一轮上下文，成本极高且不现实')
  console.log('   → harness 的做法：Session（持久身份）与 Activation（进程内驻留）分离')
  console.log('     Session 存转录（跨重启不丢），Activation 是 live 句柄（重启可重建）')
  console.log('     followup 在 live 时直接入 inbox，不在时 cold resume 从 Session 重建')
}

export {}
