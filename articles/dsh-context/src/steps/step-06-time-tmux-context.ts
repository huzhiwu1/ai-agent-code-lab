/**
 * Step 06 – time-context + tmux-context：请求时钟和终端位置
 *
 * 学习目标：两个"实时情报"插件的典型实现。time-context 在每个 step 1 注入一条
 * 时间快照：绝对时间（含时区）+ 相对耗时（距上一条模型可见消息，step>1 时基准
 * 是上一个 step context），refreshIntervalMs 限频防刷屏。tmux-context 跑一次
 * `tmux display-message` 注入 session/window/pane/layout——重点是伪 tmux 检测：
 * `$TMUX_PANE` 存在 ≠ 真在 tmux（VS Code 集成终端会从祖先进程继承环境变量），
 * 必须比较 `ps -o tty=` 的本进程控制终端与 `#{pane_tty}`，不匹配视为"不在
 * tmux"什么都不注入；且状态变了才重新注入（稳定状态块比较），所有失败都是
 * no-op + warning，绝不阻塞 turn。
 *
 * 对应源码：packages/context/time-context/src/index.ts:41-55（formatDuration）
 *           index.ts:110-125（renderText：三行信息维度）
 *           index.ts:170-208（pre-step 注入 + refreshIntervalMs 限频）
 *           packages/context/tmux-context/src/index.ts:107-155（queryTmuxLocation
 *           命令序列，可以完整复刻）
 *           index.ts:162-168（renderState 稳定块）+ 226-235（变化驱动重注入）
 *
 * 跑法：pnpm run step:06（articles/dsh-context 目录内）或根目录 pnpm run context:step:06
 */

/** 时间快照的模型-facing 文本（对应源码 renderText，time-context/index.ts:110-125） */
function renderTimeText(
  now: number,
  turn: number,
  step: number,
  previous: number | undefined,
): string {
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous)
  const baseline = step === 1 ? 'model-visible message' : 'step context'
  return (
    `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now)}\n` +
    `Elapsed since the preceding ${baseline}: ${elapsed}.`
  )
}

/**
 * 紧凑时长格式（对应源码 formatDuration，time-context/index.ts:41-55）：
 * 只保留非零的最大单位组合，秒兜底。
 */
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

/** 时间戳（简化：真实实现用 Intl.DateTimeFormat 带时区渲染；这里用本地时间组件） */
function formatTimestamp(now: number): string {
  const date = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset() / 60
  const sign = offset >= 0 ? '+' : '-'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `GMT${sign}${String(Math.abs(offset)).padStart(2, '0')}:00`
  )
}

/** 一条注入的 user 消息（带 form: 'snapshot' 双维度追溯） */
interface InjectedMessage {
  text: string
  plugin: string
  time: number
}

/** 会话（简化：只记录消息与注入历史） */
class Session {
  messages: InjectedMessage[] = []
  /** 最后一条模型可见消息的时间（time-context 用它算相对耗时） */
  lastModelVisibleTime: number | undefined
}

/**
 * time-context 插件的注入逻辑（对应源码 apply()，time-context/index.ts:170-208）：
 * - refreshIntervalMs 限频：距上次注入不足阈值 → 跳过；
 * - step 1 的相对耗时基准是"上一条模型可见消息"，step>1 是"上一个 step context"；
 * - now 参数是模拟时钟（真实实现直接 Date.now()），让演示可以精确控制间隔。
 */
function injectTimeContext(
  session: Session,
  turn: number,
  step: number,
  refreshIntervalMs: number | undefined,
  now = Date.now(),
): InjectedMessage | undefined {
  if (refreshIntervalMs !== undefined && refreshIntervalMs > 0) {
    const lastInjection = session.messages.at(-1)
    if (lastInjection !== undefined && now - lastInjection.time < refreshIntervalMs)
      return undefined
  }
  const previous = step === 1 ? session.lastModelVisibleTime : session.messages.at(-1)?.time
  const text = renderTimeText(now, turn, step, previous)
  const message: InjectedMessage = { text, plugin: 'time-context', time: now }
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

/** 稳定状态块：重注入只由 tmux 状态驱动，排除易变的 turn 前缀（index.ts:162-168） */
function renderState(location: TmuxLocation): string {
  return (
    `session ${location.sessionName}, ` +
    `window ${location.windowIndex} ${JSON.stringify(location.windowName)}, ` +
    `pane ${location.paneIndex} ${location.paneId}\n` +
    `window active=${location.windowActive}, pane active=${location.paneActive}, ` +
    `layout ${location.windowLayout}`
  )
}

/** 完整可注入文本：turn 前缀 + 稳定块（index.ts:171-173） */
function renderReading(location: TmuxLocation, turn: number): string {
  return `tmux location (turn ${turn}):\n${renderState(location)}`
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
 * 3) 解析 `display-message` 的 tab 分隔字段，字段数不对或 paneId 为空 → 放弃。
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
  const format = fields.join('\\t')
  const command = [
    '[ -n "$TMUX_PANE" ] || exit 1',
    `self_tty=$(ps -o tty= -p ${processId} | tr -d ' ')`,
    '[ -n "$self_tty" ] || exit 1',
    'pane_tty=$(tmux display-message -t "$TMUX_PANE" -p \'#{pane_tty}\') || exit 1',
    '[ "$pane_tty" = "/dev/$self_tty" ] || exit 1',
    `exec tmux display-message -t "$TMUX_PANE" -p '${format}'`,
  ].join('\n')
  const result = bash.run(command)
  if (result.exitCode !== 0) return undefined
  const line = result.stdout.split('\n', 1)[0]!
  const parts = line.split('\\t')
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
    // 模拟 shell 的判定与命令内容无关（env 已含每道关卡的结果），命令本身只是忠实复刻的展示
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
  const session = new Session()

  console.log('⏱️  Step 06：time-context（请求时钟）+ tmux-context（终端位置）')
  console.log('-----------------------------------------------------------------')

  // ============ time-context ============
  console.log('【time-context】')
  const baseTime = Date.now()
  session.lastModelVisibleTime = baseTime - 272_000 // 上一条模型可见消息在 4m32s 前

  console.log('① turn 1 / step 1：注入时间快照（相对耗时基准 = 上一条模型可见消息）：')
  const first = injectTimeContext(session, 1, 1, undefined, baseTime)
  console.log(`   ${first!.text}`)

  console.log('\n② turn 2 / step 1：refreshIntervalMs=10000 限频——距上次注入仅 2s → 跳过：')
  const skipped = injectTimeContext(session, 2, 1, 10_000, baseTime + 2_000)
  console.log(
    `   注入结果：${skipped === undefined ? '✅ 跳过（距上次注入不足阈值，不刷屏）' : '❌ 不该注入'}`,
  )

  console.log('\n③ 模拟 15s 后再装配：间隔超过阈值 → 注入新快照：')
  session.lastModelVisibleTime = baseTime + 15_000 - 12_000 // 上一条模型可见消息在 12s 前
  const second = injectTimeContext(session, 2, 1, 10_000, baseTime + 15_000)
  console.log(`   注入结果：${second === undefined ? '❌ 应该注入' : `✅ 注入\n   ${second.text}`}`)

  console.log('\n④ step 2：基准切换为"上一个 step context"（同一 turn 内的连续请求）：')
  const third = injectTimeContext(session, 2, 2, undefined, baseTime + 16_000)
  console.log(`   ${third!.text}`)

  // ============ tmux-context ============
  console.log('\n【tmux-context】')
  console.log('⑤ 场景 A：$TMUX_PANE 未设置（普通终端）→ 不注入：')
  const noTmux = simulatedBash({ tmuxPane: undefined, selfTty: 'ttys001', paneTty: '/dev/ttys001' })
  console.log(
    `   queryTmuxLocation → ${queryTmuxLocation(noTmux, process.pid) === undefined ? 'undefined ✅（no-op）' : '❌'}`,
  )

  console.log('\n⑥ 场景 B（重点）：伪 tmux——环境变量被继承但 tty 不匹配 → 不注入：')
  const fakeTmux = simulatedBash({ tmuxPane: '%1', selfTty: 'ttys002', paneTty: '/dev/ttys001' })
  console.log('   背景：VS Code 集成终端从 tmux 祖先进程继承了 $TMUX/$TMUX_PANE，')
  console.log('   但本进程控制终端 ttys002 ≠ pane 的 ttys001——变量存在≠真在 tmux。')
  console.log(
    `   queryTmuxLocation → ${queryTmuxLocation(fakeTmux, process.pid) === undefined ? 'undefined ✅（判定伪 tmux，什么都不注入）' : '❌'}`,
  )

  console.log('\n⑦ 场景 C：真 tmux——tty 匹配 → 注入位置信息（含稳定块 + 易变 turn 前缀）：')
  const realTmux = simulatedBash({
    tmuxPane: '%1',
    selfTty: 'ttys001',
    paneTty: '/dev/ttys001',
    fields: ['dev', '0', 'main', '0', '%0', '1', '1', 'b0e8,213x51,0,0[213x25,0,0,0]'],
  })
  const location = queryTmuxLocation(realTmux, process.pid)
  if (location !== undefined) {
    const state = renderState(location)
    console.log(`   稳定状态块（用于去重比较）：\n   ${state.replaceAll('\n', '\n   ')}`)
    const reading = renderReading(location, 3)
    console.log(`   完整注入文本（含 turn 前缀）：\n   ${reading.replaceAll('\n', '\n   ')}`)
  }

  console.log('\n⑧ 变化驱动重注入：同一位置再查询 → 状态块没变 → 不注入；pane 换了 → 注入：')
  const previousState = location === undefined ? '' : renderState(location)
  const sameQuery = queryTmuxLocation(realTmux, process.pid)
  const sameState = sameQuery === undefined ? '' : renderState(sameQuery)
  console.log(
    `   位置没变：${previousState === sameState ? '✅ 不注入（稳定块相同）' : '❌ 不该注入'}`,
  )
  const movedTmux = simulatedBash({
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
  const moved = queryTmuxLocation(movedTmux, process.pid)
  if (moved !== undefined) {
    console.log(
      `   位置变了（pane %0 → ${moved.paneId}，window 0 → ${moved.windowIndex}）：${previousState !== renderState(moved) ? '✅ 重新注入' : '❌ 漏注入'}`,
    )
  }

  console.log(
    '\n小结：time-context 提供"现在几点 + 距离上次多久"，refreshIntervalMs 防刷屏；tmux-context 用 tty 匹配戳穿' +
      '伪 tmux 环境，用稳定状态块做变化驱动重注入——失败一律 no-op，上下文缺失绝不阻塞 turn。',
  )
}

main()

export {}
