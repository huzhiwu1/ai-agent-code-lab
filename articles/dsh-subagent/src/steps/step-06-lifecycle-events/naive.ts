/**
 * Step 06 对照组：两个事故——无事件只能轮询 + 赌加载顺序
 *
 * 事故①：没有事件，只能轮询内部状态
 * 事故②：赌加载顺序——provider 没到，工具 description 就错了
 */

export function naiveDemo(): void {
  console.log('── A. 对照组：朴素做法翻车现场 ──')

  // ── 事故①：没有事件，只能轮询内部状态 ──
  console.log('\n🚫 事故①：没有生命周期事件——想知道子代理跑到哪了只能轮询')
  console.log('   朴素实现：子代理内部维护一个 status 字段（running/idle/done）')
  console.log('   观察者想知道"现在有几个子代理在跑？"只能：')
  console.log('     while (true) {')
  console.log('       for (const child of children) {')
  console.log('         if (child.status === "running") activeCount++')
  console.log('       }')
  console.log('       await sleep(100)')
  console.log('     }')
  console.log('   💥 问题：没有边界——监控/日志/UI 各自轮询、各自猜，没有统一词汇')
  console.log('     一个 child 什么时候结束？轮询到 idle 就算结束？还是等 done？')
  console.log('     没有"start/end"事件对，观察者看不到边界，也没有统一词汇。')

  // ── 事故②：赌加载顺序 ──
  console.log('\n🚫 事故②：赌加载顺序——工具层假设 provider 一定先于工具加载好')
  console.log('   朴素实现：工具层直接写死文案 "fork child 继承父对话上下文"')
  console.log('   Cordis Loader 并发启动时：provider 还没注册到 event bus')
  console.log('   → 工具层拿到的 provider 名字是 undefined，description 就错了')
  console.log('     本该说"继承对话"的 fork 工具，文案变成了"独立上下文"')
  console.log('   💥 异步状态不是同步状态：依赖加载顺序 = 赌运气。')
  console.log('   → harness 的做法：provider-added/removed 广播 + 工具层镜像')
  console.log('     provider 在就注册工具、走就注销。不赌加载顺序——provider 在不在')
  console.log('     由事件驱动，不是一个"你先注册我才注册"的排序需求。')
}

export {}
