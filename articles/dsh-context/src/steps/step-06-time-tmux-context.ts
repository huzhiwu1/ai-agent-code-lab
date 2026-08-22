/**
 * Step 06 – 为什么"实时情报"是插件 + 快照，而不是写死在引擎里？（重点是伪 tmux 检测）
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「插件」= 挂在 pre-step 上的可选模块，谁拥有事实谁注册（类比：餐厅的"时令
 *   菜单"由供应商各自供货，后厨不自己种菜——时间归 time-context 管，终端位置
 *   归 tmux-context 管，引擎不写死任何一条）。
 * 「伪 tmux」= 环境变量被继承但实际不在 tmux 里——VS Code 集成终端从 tmux
 *   祖先进程继承了 `$TMUX_PANE`，变量存在 ≠ 你真在 tmux 里。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法 1：在引擎里写死"注入当前时间" → 引擎要为所有场景负责，装载/卸载
 *   一个情报源都要改引擎。
 * 新手做法 2：看到 `$TMUX_PANE` 就以为是 tmux → 在 VS Code 里误报"你在 tmux
 *   pane 0"，模型被误导。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * ① 情报 = 插件：time-context 注入绝对时间 + 相对耗时，refreshIntervalMs 限频
 *   防刷屏；tmux-context 注入 session/window/pane/layout——谁拥有事实谁注册，
 *   引擎保持干净。
 * ② 伪 tmux 检测：`ps -o tty=`（本进程控制终端）必须等于 `#{pane_tty}`（该
 *   pane 的终端）才算真在 tmux——继承环境变量的终端在这里现形。所有失败都是
 *   no-op + warning，绝不阻塞 turn。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 上下文生产者可插拔；伪环境被识别，模型不被误导；上下文缺失不影响主流程。
 *
 * 对应源码：packages/context/time-context/src/index.ts（renderText index.ts:110-125、
 *   refreshIntervalMs 限频 index.ts:170-208）+ packages/context/tmux-context/src/index.ts
 *   （queryTmuxLocation 命令序列 index.ts:107-155 完整复刻、renderState 稳定块 index.ts:162-168）
 * 跑法：pnpm run context:step:06（或 articles/dsh-context 内 pnpm run step:06）
 */

/** 一条注入的 user 消息（简化） */
interface InjectedMessage {
  text: string
  plugin: string
  time: number
}

/** 会话（简化：只记录注入历史与最后一条模型可见消息的时间） */
class Session {
  messages: InjectedMessage[] = []
  lastModelVisibleTime: number | undefined
}

/** 紧凑时长格式（对应源码 formatDuration，time-context/index.ts:41-55） */
function formatDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

/** 时间快照的模型-facing 文本（对应源码 renderText，time-context/index.ts:110-125） */
function renderTimeText(
  now: number,
  turn: number,
  step: number,
  previous: number | undefined,
): string {
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous)
  const baseline = step === 1 ? 'model-visible message' : 'step context'
  return `Time sampled while preparing turn ${turn}, step ${step}: ${new Date(now).toISOString()}\nElapsed since the preceding ${baseline}: ${elapsed}.`
}

/**
 * time-context 插件的注入逻辑（对应源码 apply()，time-context/index.ts:170-208）：
 * refreshIntervalMs 限频——距上次注入不足阈值就跳过，不刷屏。
 */
function injectTimeContext(
  session: Session,
  turn: number,
  step: number,
  refreshIntervalMs: number | undefined,
  now: number,
): InjectedMessage | undefined {
  if (refreshIntervalMs !== undefined && refreshIntervalMs > 0) {
    const lastInjection = session.messages.at(-1)
    if (lastInjection !== undefined && now - lastInjection.time < refreshIntervalMs)
      return undefined
  }
  const previous = step === 1 ? session.lastModelVisibleTime : session.messages.at(-1)?.time
  const message: InjectedMessage = {
    text: renderTimeText(now, turn, step, previous),
    plugin: 'time-context',
    time: now,
  }
  session.messages.push(message)
  return message
}

/** tmux 位置字段（对应源码 TmuxLocation，tmux-context/index.ts:61-70） */
interface TmuxLocation {
  sessionName: string
  windowIndex: string
  windowName: string
  paneIndex: string
  paneId: string
  windowActive: string
  paneActive: string
  windowLayout: string
}

/** 模拟 bash 执行器：按真实命令序列的语义返回结果（对应源码 ShellExecutor） */
interface BashExecutor {
  run(command: string): { exitCode: number; stdout: string }
}

/**
 * 查询 tmux 位置（对应源码 queryTmuxLocation，tmux-context/index.ts:107-155，
 * 命令序列完整复刻）。三道关卡，任何一道不过都是 undefined（no-op）：
 * 1) `[ -n "$TMUX_PANE" ] || exit 1`——环境变量都不存在，直接放弃；
 * 2) `ps -o tty=` 拿本进程控制终端，与 `#{pane_tty}` 比较——不匹配说明只是
 *    继承了环境变量（伪 tmux），视为不在 tmux；
 * 3) 解析 display-message 的 tab 分隔字段，字段数不对或 paneId 为空 → 放弃。
 */
function queryTmuxLocation(bash: BashExecutor, processId: number): TmuxLocation | undefined {
  const fields = [
    '#{session_name}',
    '#{window_index}',
    '#{window_name}',
    '#{pane_index}',
    '#{pane_id}',
    '#{window_active}',
    '#{pane_active}',
    '#{window_layout}',
  ]
  const command = [
    '[ -n "$TMUX_PANE" ] || exit 1',
    `self_tty=$(ps -o tty= -p ${processId} | tr -d ' ')`,
    '[ -n "$self_tty" ] || exit 1',
    'pane_tty=$(tmux display-message -t "$TMUX_PANE" -p \'#{pane_tty}\') || exit 1',
    '[ "$pane_tty" = "/dev/$self_tty" ] || exit 1',
    `exec tmux display-message -t "$TMUX_PANE" -p '${fields.join('\\t')}'`,
  ].join('\n')
  const result = bash.run(command)
  if (result.exitCode !== 0) return undefined
  const parts = result.stdout.split('\n', 1)[0]!.split('\\t')
  if (parts.length !== fields.length) return undefined
  const [
    sessionName,
    windowIndex,
    windowName,
    paneIndex,
    paneId,
    windowActive,
    paneActive,
    windowLayout,
  ] = parts as [string, string, string, string, string, string, string, string]
  if (paneId.length === 0) return undefined
  return {
    sessionName,
    windowIndex,
    windowName,
    paneIndex,
    paneId,
    windowActive,
    paneActive,
    windowLayout,
  }
}

/** 稳定状态块：重注入只由 tmux 状态驱动，排除易变的 turn 前缀（index.ts:162-168） */
function renderState(location: TmuxLocation): string {
  return `session ${location.sessionName}, window ${location.windowIndex} ${JSON.stringify(location.windowName)}, pane ${location.paneIndex} ${location.paneId}\nwindow active=${location.windowActive}, pane active=${location.paneActive}, layout ${location.windowLayout}`
}

/**
 * 模拟一个"伪 tmux 环境"（VS Code 集成终端场景）：$TMUX_PANE 从祖先进程继承
 * 但本进程的控制终端不是那个 pane 的 tty。模拟 shell 忠实执行命令序列的判断。
 */
function simulatedBash(env: {
  tmuxPane: string | undefined
  selfTty: string
  paneTty: string
  fields?: string[]
}): BashExecutor {
  return {
    run(_command: string): { exitCode: number; stdout: string } {
      // 关卡 1：$TMUX_PANE 未设置 → 第一条命令 exit 1
      if (env.tmuxPane === undefined) return { exitCode: 1, stdout: '' }
      // 关卡 2：tty 不匹配 → exit 1（继承环境变量的伪 tmux 在这里现形）
      if (env.paneTty !== `/dev/${env.selfTty}`) return { exitCode: 1, stdout: '' }
      // 关卡 3：真 tmux → display-message 输出 tab 分隔字段
      return { exitCode: 0, stdout: env.fields === undefined ? '' : `${env.fields.join('\\t')}\n` }
    },
  }
}

function main(): void {
  console.log('⏱️  Step 06 – 实时情报 = 插件 + 快照；伪 tmux 一眼识破')
  console.log('='.repeat(56))

  // ========== 朴素版 1：引擎写死时间 ==========
  console.log('\n① 朴素版：引擎写死"注入当前时间"')
  console.log('   引擎代码：每轮请求硬编码 `Time: ${Date.now()}`')
  console.log(
    '   💥 崩点：引擎要为所有场景负责——部署方想关掉时间情报得改引擎；想加天气情报也得改引擎',
  )

  // ========== harness 版 1：time-context 插件 ==========
  console.log('\n② harness 版：time-context 插件（绝对时间 + 相对耗时 + 限频）')
  const session = new Session()
  const baseTime = Date.now()
  session.lastModelVisibleTime = baseTime - 272_000 // 上一条模型可见消息在 4m32s 前
  const first = injectTimeContext(session, 1, 1, undefined, baseTime)
  console.log(`   turn 1 / step 1 注入：${first!.text}`)
  const skipped = injectTimeContext(session, 2, 1, 10_000, baseTime + 2_000)
  console.log(
    `   turn 2 / step 1（距上次仅 2s，refreshIntervalMs=10000）→ ${skipped === undefined ? '✅ 跳过（限频防刷屏）' : '❌ 不该注入'}`,
  )
  const second = injectTimeContext(session, 2, 1, 10_000, baseTime + 15_000)
  console.log(
    `   turn 2 / step 1（15s 后）→ ${second === undefined ? '❌ 应该注入' : `✅ 注入：${second.text.split('\n')[1]}`}`,
  )

  // ========== 朴素版 2：$TMUX_PANE 存在 = tmux ==========
  console.log('\n③ 朴素版：看到 $TMUX_PANE 就注入"你在 tmux pane 0"')
  console.log('   VS Code 集成终端从 tmux 祖先进程继承了 $TMUX/$TMUX_PANE')
  console.log('   💥 崩点：误报"你在 tmux pane 0"——模型以为自己在终端里，被环境信息误导')

  // ========== harness 版 2：tmux-context 插件（TTY 校验） ==========
  console.log('\n④ harness 版：tmux-context——tty 匹配才算真在 tmux')
  console.log('   命令序列：$TMUX_PANE 存在 → ps -o tty= 拿本进程控制终端 → 与 #{pane_tty} 比对')
  const noTmux = simulatedBash({ tmuxPane: undefined, selfTty: 'ttys001', paneTty: '/dev/ttys001' })
  console.log(
    `   场景 A：普通终端（无 $TMUX_PANE）→ ${queryTmuxLocation(noTmux, process.pid) === undefined ? '✅ 不注入（no-op）' : '❌'}`,
  )
  const fakeTmux = simulatedBash({ tmuxPane: '%1', selfTty: 'ttys002', paneTty: '/dev/ttys001' })
  console.log(
    `   场景 B（重点）：伪 tmux——变量被继承但 tty 不匹配（ttys002 ≠ ttys001）→ ${queryTmuxLocation(fakeTmux, process.pid) === undefined ? '✅ 判定伪 tmux，什么都不注入' : '❌'}`,
  )
  const realTmux = simulatedBash({
    tmuxPane: '%1',
    selfTty: 'ttys001',
    paneTty: '/dev/ttys001',
    fields: ['dev', '0', 'main', '0', '%0', '1', '1', 'b0e8,213x51,0,0[213x25,0,0,0]'],
  })
  const location = queryTmuxLocation(realTmux, process.pid)
  if (location !== undefined) {
    const state = renderState(location)
    console.log(`   场景 C：真 tmux（tty 匹配）→ 注入位置：\n   ${state.replaceAll('\n', '\n   ')}`)
    // 变化驱动重注入：稳定块没变 → 不注入；pane 换了 → 注入
    const moved = simulatedBash({
      tmuxPane: '%1',
      selfTty: 'ttys001',
      paneTty: '/dev/ttys001',
      fields: [
        'dev',
        '1',
        'main',
        '2',
        '%2',
        '1',
        '1',
        '9a2f,213x51,0,0[106x51,0,0,2,106x51,107,0,3]',
      ],
    })
    const movedLocation = queryTmuxLocation(moved, process.pid)
    const movedState = movedLocation === undefined ? '' : renderState(movedLocation)
    console.log(
      `   变化驱动重注入：位置没变 → 不注入；pane %0→${movedLocation?.paneId} → ${state === movedState ? '❌ 漏注入' : '✅ 重新注入'}`,
    )
  }
  console.log('   注释：所有失败（shell 拒绝/解析失败）都是 no-op + warning，绝不阻塞 turn')

  console.log(
    '\n🎯 一句话：谁拥有事实谁注册插件；伪 tmux 靠 tty 比对现形——引擎保持干净，模型不被误导。',
  )
}

main()

export {}
