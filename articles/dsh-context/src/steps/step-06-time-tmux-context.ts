/**
 * Step 06 – 实时情报：为什么是"插件 + 快照"，而不是写死在引擎里？（伪 tmux 检测）
 *
 * ── 先懂三个词 ──────────────────────────────────────────────
 * 「插件」= 挂在 pre-step 上的可选模块，谁拥有事实谁注册（类比：餐厅的"时令
 *   菜单"由供应商各自供货，后厨不自己种菜——时间归 time-context 管，终端位置
 *   归 tmux-context 管，引擎不写死任何一条）。
 * 「环境变量继承」= 子进程自动复制父进程的环境变量（类比：名片会被人转发——
 *   VS Code 集成终端从 tmux 祖先进程继承了 `$TMUX_PANE` 这张"名片"）。
 * 「tty」= 进程真正连着的终端设备（类比：指纹——名片可以转发，指纹不能）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：① 引擎写死"注入当前时间" → 部署方想关掉/想加情报都得改引擎；
 * ② 看到 `$TMUX_PANE` 就以为在 tmux → 在 VS Code 里误报"你在 tmux pane 0"，
 * 模型被环境信息误导。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * ① 情报做成插件 + 快照：谁拥有事实谁注册，引擎保持干净；
 * ② 伪 tmux 检测（本步主点）：环境变量可以被继承，但 tty 不能——`ps -o tty=`
 *   拿本进程控制终端，必须等于该 pane 的 `#{pane_tty}` 才算真在 tmux；
 * ③ 限频 + 变化驱动：时间不足 refreshIntervalMs 不注入；tmux 位置稳定块
 *   变了才重注入——情报不是每轮都发。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 上下文生产者可插拔；伪环境被识别，模型不被误导；所有失败都是 no-op +
 * warning，绝不阻塞 turn。
 *
 * 对应源码：packages/context/time-context/src/index.ts（renderText index.ts:110-125、
 *   refreshIntervalMs 限频 index.ts:170-208）+ packages/context/tmux-context/src/index.ts
 *   （queryTmuxLocation 命令序列 index.ts:107-155、renderState 稳定块 index.ts:162-168）
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

/** 紧凑时长格式（对应源码 formatDuration，time-context/index.ts:41-55，这里只保留 m/s 两级） */
function formatDuration(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes > 0 ? `${minutes}m ` : ''}${seconds % 60}s`
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

/**
 * 探测数据（教学简化：真实源码跑一段 bash 命令拿这三个值，见 queryTmuxLocation
 * 命令序列 tmux-context/index.ts:107-155；这里直接用模拟数据，专注讲检测逻辑）：
 * - tmuxPane：`$TMUX_PANE` 环境变量（"名片"——有没有被转发过来）
 * - selfTty：本进程控制终端（真实命令：`ps -o tty= -p <pid>`，"指纹"）
 * - paneTty：该 pane 声称的终端（真实命令：`tmux display-message -p '#{pane_tty}'`）
 * - fields：真 tmux 时 display-message 返回的 8 个位置字段
 */
interface TmuxProbe {
  tmuxPane: string | undefined
  selfTty: string
  paneTty: string
  fields?: string[]
}

/**
 * 伪 tmux 检测（对应源码 queryTmuxLocation，tmux-context/index.ts:107-155）：
 * 三道关卡，任何一道不过都返回 undefined（no-op）：
 * 1) 名片都没有（$TMUX_PANE 不存在）→ 不在 tmux；
 * 2) 指纹对不上（本进程 tty ≠ pane 声称的 tty）→ 只是继承了环境变量 = 伪 tmux；
 * 3) 字段数不对或 paneId 为空 → 解析失败。
 */
function queryTmuxLocation(probe: TmuxProbe): TmuxLocation | undefined {
  if (probe.tmuxPane === undefined) return undefined // 关卡 1：名片都没有
  if (probe.paneTty !== `/dev/${probe.selfTty}`) return undefined // 关卡 2：指纹对不上（主点）
  if (probe.fields === undefined || probe.fields.length !== 8) return undefined // 关卡 3：解析失败
  const [
    sessionName,
    windowIndex,
    windowName,
    paneIndex,
    paneId,
    windowActive,
    paneActive,
    windowLayout,
  ] = probe.fields
  if (paneId.length === 0) return undefined // 关卡 3 补充：paneId 为空不可信
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

function main(): void {
  console.log('⏱️  Step 06 – 实时情报 = 插件 + 快照；伪 tmux 一眼识破')
  console.log('='.repeat(56))

  // ========== ① 朴素版：引擎写死时间情报 ==========
  console.log('\n① 朴素版：引擎写死"注入当前时间"')
  console.log('   引擎代码：preStep() 里写死一行 injectTime()——时间情报归引擎管')
  console.log('   💥 崩点：部署方想关掉时间情报 → 改引擎；想加天气情报 → 也得改引擎')
  console.log('   → 引擎要为所有场景负责，"谁拥有事实谁注册"无从谈起')

  // ========== ② 朴素版：$TMUX_PANE 存在 = 在 tmux ==========
  console.log('\n② 朴素版：看到 $TMUX_PANE 就注入"你在 tmux pane 0"')
  console.log('   VS Code 集成终端从 tmux 祖先进程继承了 $TMUX/$TMUX_PANE（名片被转发）')
  console.log('   💥 崩点：误报"你在 tmux pane 0"——模型以为自己在终端里，被环境信息误导')

  // ========== ③ harness 版：time-context 插件（绝对时间 + 相对耗时 + 限频） ==========
  console.log('\n③ harness 版：time-context——时间情报做成插件，引擎不写死')
  const session = new Session()
  const baseTime = Date.now()
  session.lastModelVisibleTime = baseTime - 272_000 // 上一条模型可见消息在 4m32s 前
  const first = injectTimeContext(session, 1, 1, undefined, baseTime)
  console.log(`   turn 1 / step 1 注入：${first!.text.replace('\n', ' | ')}`)
  const skipped = injectTimeContext(session, 2, 1, 10_000, baseTime + 2_000)
  console.log(
    `   turn 2 / step 1（距上次仅 2s，refreshIntervalMs=10000）→ ${skipped === undefined ? '✅ 跳过（限频防刷屏）' : '❌ 不该注入'}`,
  )
  const second = injectTimeContext(session, 2, 1, 10_000, baseTime + 15_000)
  console.log(
    `   turn 2 / step 1（15s 后）→ ${second === undefined ? '❌ 应该注入' : `✅ 注入：${second.text.split('\n')[1]}`}`,
  )

  // ========== ④ harness 版：tmux-context 插件（三道关卡识破伪 tmux） ==========
  console.log('\n④ harness 版：tmux-context——tty 匹配才算真在 tmux')
  console.log('   三道关卡：① $TMUX_PANE 存在？ ② 本进程 tty = pane 的 tty？ ③ 位置解析成功？')
  const sceneA: TmuxProbe = { tmuxPane: undefined, selfTty: 'ttys001', paneTty: '/dev/ttys001' }
  console.log(
    `   场景 A：普通终端（无 $TMUX_PANE）→ ${queryTmuxLocation(sceneA) === undefined ? '✅ 关卡 1 拦截，不注入' : '❌'}`,
  )
  const sceneB: TmuxProbe = { tmuxPane: '%1', selfTty: 'ttys002', paneTty: '/dev/ttys001' }
  console.log(
    `   场景 B（主点）：伪 tmux——名片有但指纹对不上（ttys002 ≠ ttys001）→ ${queryTmuxLocation(sceneB) === undefined ? '✅ 判定伪 tmux，什么都不注入' : '❌'}`,
  )
  const sceneC: TmuxProbe = {
    tmuxPane: '%1',
    selfTty: 'ttys001',
    paneTty: '/dev/ttys001',
    fields: ['dev', '0', 'main', '0', '%0', '1', '1', 'b0e8,213x51,0,0[213x25,0,0,0]'],
  }
  const location = queryTmuxLocation(sceneC)
  if (location !== undefined) {
    const state = renderState(location)
    console.log(`   场景 C：真 tmux（指纹匹配）→ 注入位置：\n   ${state.replaceAll('\n', '\n   ')}`)
    // 变化驱动重注入：稳定块没变 → 不注入；pane 换了 → 注入
    const moved = queryTmuxLocation({
      ...sceneC,
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
    console.log(
      `   变化驱动重注入：pane %0→${moved?.paneId}，稳定块变了 → ${moved !== undefined && renderState(moved) !== state ? '✅ 重新注入' : '❌ 漏注入'}`,
    )
  }
  console.log('   注释：所有失败（shell 拒绝/解析失败）都是 no-op + warning，绝不阻塞 turn')

  console.log(
    '\n🎯 一句话：谁拥有事实谁注册插件；伪 tmux 靠 tty 比对现形——引擎保持干净，模型不被误导。',
  )
}

main()

export {}
