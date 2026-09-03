/**
 * Step 01 对照组：朴素做法——主循环里直接 new ChildAgent 写死
 *
 * 演示两个事故：
 * ① if/else 地狱：想加第二种运输方式（本地进程 → 远程 ACP）时，核心代码到处加分支
 * ② 发布边界混为一谈："没派出去"和"干坏了"被同一个 try/catch 吞掉
 */

/**
 * 朴素版：主循环里直接 new 一个子代理类，写死一种实现。
 * 想换运输方式（spawn → acp）？只能到处加 if/else。
 */
function naiveDelegate(mode: 'spawn' | 'acp', task: string): string {
  // ⚠️ 朴素做法：每次想加一种运输方式，就得在这里加分支
  if (mode === 'spawn') {
    return `[spawn] 完成：${task}（同进程 fresh child）`
  }
  // ⚠️ 再加第三种运输方式（比如 remote-worker）？继续加 else if——
  // 核心代码膨胀，每次加新 provider 都要改这个函数
  return `[acp] 完成：${task}（外部进程 child）`
}

/**
 * 朴素版：发布边界混为一谈——"没派出去"和"干坏了"全被一个 try/catch 吞掉
 */
function naiveStart(mode: string): { ok: boolean; output: string } {
  try {
    // ⚠️ 三种不同失败原因被揉成一个 try/catch：
    // 1. mode 不存在 → "委托不存在"（应该报错，让调用方换 provider）
    // 2. 网络断了 → "委托失败"（应该重试或换 provider）
    // 3. child 任务崩了 → "干活失败"（应该结算成 error stopReason）
    // 三种全被吞成同一个 false，调用方分不清到底发生了什么
    if (mode === 'ghost') throw new Error('provider not found')
    if (mode === 'broken') throw new Error('network error')
    return { ok: true, output: `完成了 ${mode} 的任务` }
  } catch {
    // 💥 事故：三种完全不同的失败，被同一个 catch 吞成 false
    return { ok: false, output: '' }
  }
}

export function naiveDemo(): void {
  console.log('── A. 对照组：朴素做法翻车现场 ──')

  // ── 事故①：if/else 地狱 ──
  console.log('\n🚫 事故①：主循环写死 new ChildAgent，想加运输方式只能堆 if/else')
  console.log('   朴素 spawn：' + naiveDelegate('spawn', '解释闭包'))
  console.log('   朴素 acp：' + naiveDelegate('acp', '解释事件循环'))
  console.log('   ⚠️ 想加第三种（remote-worker）？继续加 else if → 核心文件膨胀')
  console.log('   → 加运输方式 = 改核心代码，不是加插件。每加一种就多一个分支。')

  // ── 事故②：发布边界混为一谈 ──
  console.log('\n🚫 事故②：发布边界混为一谈——"没派出去"和"干坏了"被同一个 catch 吞掉')
  const r1 = naiveStart('ghost')
  console.log(
    `   幽灵 provider：ok=${r1.ok}, output='${r1.output}' ← 调用方不知道这是"不存在的 provider"`,
  )
  const r2 = naiveStart('broken')
  console.log(`   网络故障：ok=${r1.ok}, output='${r2.output}' ← 调用方不知道这是"网络断了"`)
  console.log(
    '   💥 三种完全不同的失败，全部被吞成一个 false——调用方无法决策（重试？换人？报错？）',
  )
}

export {}
