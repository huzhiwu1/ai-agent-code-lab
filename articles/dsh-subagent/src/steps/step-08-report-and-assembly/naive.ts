/**
 * Step 08 对照组：朴素做法——"最后一条消息自动算结果"（隐式协议）
 *
 * 演示事故：父 agent 不知道 child 什么时候算"说完了"，只能猜——
 * child 中间态消息被当成结论、或 child 干完没说话父永远等不到。
 */

export function naiveDemo(): void {
  console.log('── A. 对照组：隐式协议翻车现场 ──')

  // ── 事故：父在猜哪条是最终结论 ──
  console.log('\n🚫 事故：父 agent 不知道 child 什么时候算"说完了"')
  console.log('   朴素实现：child 的最后一条消息自动算结果')
  console.log('   child 的对话流：')
  console.log('     child: "正在分析数据……"')
  console.log('     child: "发现 3 个潜在问题"')
  console.log('     child: "其中第 2 个问题需要进一步确认……"')
  console.log('   💥 父 agent 看到三条消息——哪条是最终结论？')
  console.log('     如果取最后一条：第 2 个问题还没确认完，结论不完整')
  console.log('     如果取第二条：漏掉了第 3 条——中间态被当成结论')
  console.log('     如果 child 干完没说话（直接结束）：父永远等不到"最后一条消息"')

  console.log('   → harness 的做法：report 是显式协议——child 主动回传自包含结果')
  console.log('     report 的接收者由持久 parentSession 推导，API 上没"发给谁"的参数')
  console.log('     嵌套汇报只跨一条边：grandchild → direct parent，不跳级')
  console.log('     report 是协作控制，不结束 turn、不结算 Activation')
}

export {}
