/**
 * Step 05 对照组：朴素做法——child 继承父的 approval 策略（ask）
 *
 * 演示事故：后台 child 继承父的 ask → 申请升级权限 → 进入 pending →
 * 父 agent 不在 UI 前、人类看不到后台 child 的弹窗 → 任务永久卡死。
 * 这是全篇最重要的反例。
 */

import { decide, type ApprovalDecision } from './approval'

export function naiveDemo(): void {
  console.log('── A. 对照组：继承父的 ask → 死锁现场 ──')

  // ── 事故：child 继承 ask → 申请升级 → 永远 pending ──
  console.log('\n🚫 事故：后台 child 继承父的 approval 策略（ask）')
  console.log('   父 agent 的审批策略：ask（人在 UI 前，有事弹窗问人）')
  console.log('   朴素实现：child 直接继承父的 ask')
  console.log('   child 想升级 sandbox 权限 → 触发审批')

  const inherited: ApprovalDecision = decide('ask', '把 sandbox 模式改为 danger-full-access')
  console.log(`   ⏳ ${inherited.reason}`)

  console.log('   💥 这个 pending 会被谁批准？')
  console.log('     父 agent 不在 UI 前——它正在后台跑自己的任务')
  console.log('     人类用户看不到后台 child 的弹窗——UI 上没有任何提示')
  console.log('     结果：任务永久卡死 + 一条无人认领的待审批记录')
  console.log('     比拒绝糟糕得多——拒绝至少让 child 知道边界在哪，ask 让它永远等着。')

  // harness 的做法：captureDelegatedPolicyOverrides 把 approval 钉死 'never'
  console.log('\n   → harness 的做法：approvalPolicy 钉死 "never"')
  const harnessDecision = decide('never', '把 sandbox 模式改为 danger-full-access')
  console.log(`   ✅ ${harnessDecision.kind === 'denied' ? harnessDecision.reason : ''}`)
  console.log('     拒绝是确定性的：不等人、不排队、不悬挂。child 立刻知道边界在哪。')
  console.log('     与其造"后台审批可见性"机制，不如让"挂起"这个状态不可能出现。')
}

export {}
