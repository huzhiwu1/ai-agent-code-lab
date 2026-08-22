/**
 * Step 06 – write-behind 持久化：为什么 append 不阻塞 I/O？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「write-behind」= 先写内存立即返回，后台批量落盘（类比：餐厅点单——前厅
 *   记下菜单就接待下一位客人，后厨攒几桌一起做；点单员绝不站在后厨等出锅）。
 * 「落盘」= 把事件写进磁盘持久化，进程崩溃后还能从磁盘找回来。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：日志是唯一事实源，那就"每次 append 都写盘"——结果流式输出每秒
 * 几十个事件，每个都等磁盘 fsync，主循环直接卡死；要么反过来干脆不落盘，
 * 进程一崩一条不剩。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * append 先入内存队列立即返回 → 固定窗口（200ms）批量合并写盘（coalescing
 *   ≠ debounce：窗口一旦启动，新事件不重置截止时间）→ 写失败批次回到队头、
 *   暂停自动重试 → flush 是静止屏障（取消剩余等待，等活动写 + 屏障期间事件，
 *   turn 边界 / 模型请求前 / teardown 都走它）→ 崩溃时从磁盘恢复重放。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 不阻塞主循环 + 不丢事件 + 崩溃可恢复。
 *
 * 对应源码：packages/session/persistence/src/session-write-behind.ts
 *   （设计笔记 bounded-session-persistence-write-batching）
 * 跑法：pnpm run memory:step:06
 */

interface StoredEvent {
  seq: number
  type: string
  time: number
  content: string
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 朴素版后端：每次 append 同步写盘（模拟 15ms 磁盘 fsync 延迟） */
class NaiveSyncBackend {
  persisted: StoredEvent[] = []
  async appendSync(ev: StoredEvent): Promise<void> {
    await sleep(15) // 磁盘 I/O 延迟
    this.persisted.push(ev)
  }
}

interface WriteBackend {
  appendBatch(events: readonly StoredEvent[]): Promise<void>
  readonly persisted: readonly StoredEvent[]
}

/** 内存后端：可注入失败模拟磁盘错误 */
class MemoryBackend implements WriteBackend {
  persisted: StoredEvent[] = []
  failNext = 0

  async appendBatch(events: readonly StoredEvent[]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--
      throw new Error('模拟磁盘 I/O 错误')
    }
    this.persisted.push(...events)
  }
}

/**
 * write-behind 核心：200ms 固定窗口 coalescing + 失败保留 + flush 静止屏障。
 * 注意：队列空→非空时启动固定窗口，后续新事件不重置截止（coalescing ≠ debounce）。
 */
class SessionWriteBehind {
  private queue: StoredEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> | null = null
  stats = { appended: 0, writes: 0, failedWrites: 0 }

  constructor(
    private readonly backend: WriteBackend,
    private readonly windowMs = 200,
  ) {}

  enqueue(event: StoredEvent): void {
    this.queue.push(event)
    this.stats.appended++
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.drain()
      }, this.windowMs)
    }
  }

  /** 静止屏障：取消等待，等活动写 + 屏障期间到达的事件 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.writing) await this.writing
    await this.drain()
    if (this.queue.length > 0) throw new Error(`flush 失败：仍有 ${this.queue.length} 个事件未落盘`)
  }

  private drain(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve()
    if (this.writing) return this.writing
    const run = this.doDrain().finally(() => {
      this.writing = null
    })
    this.writing = run
    return run
  }

  private async doDrain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length)
      this.stats.writes++
      try {
        await this.backend.appendBatch(batch)
      } catch {
        this.stats.failedWrites++
        this.queue.unshift(...batch) // 失败保留：恢复队列头部，顺序不乱
        break // 暂停自动重试，等新事件或显式 flush
      }
    }
  }
}

async function main(): Promise<void> {
  console.log('💾 Step 06 – write-behind 持久化：append 永不阻塞 I/O')
  console.log('='.repeat(56))

  // ========== 朴素版 A：每次 append 同步写磁盘 ==========
  console.log('\n① 朴素版 A：每次 append 都同步写磁盘（模拟 15ms fsync）')
  const naiveSync = new NaiveSyncBackend()
  const t0 = Date.now()
  for (let i = 0; i < 6; i++) {
    await naiveSync.appendSync({
      seq: i,
      type: 'assistant/chunk',
      time: Date.now(),
      content: `chunk-${i}`,
    })
  }
  const syncMs = Date.now() - t0
  console.log(`   6 个事件写完耗时 ${syncMs}ms（每个都等磁盘 I/O）`)
  console.log('   💥 崩点：流式输出每秒几十个事件 → 每个都等 fsync → 主循环卡死')

  // ========== 朴素版 B：完全不落盘 ==========
  console.log('\n② 朴素版 B：只存内存、从不写盘')
  const memoryOnly: StoredEvent[] = []
  for (let i = 0; i < 6; i++) {
    memoryOnly.push({ seq: i, type: 'assistant/chunk', time: Date.now(), content: `chunk-${i}` })
  }
  memoryOnly.length = 0 // 模拟进程崩溃：内存瞬间蒸发
  console.log(`   崩溃前内存 6 条 → 崩溃后恢复 ${memoryOnly.length} 条`)
  console.log('   💥 崩点：日志是唯一事实源——内存一没，历史全没了')

  // ========== harness 版：write-behind ==========
  const backend = new MemoryBackend()
  const wb = new SessionWriteBehind(backend, 200)
  console.log('\n③ harness 版：append 立即返回，200ms 窗口合并落盘')
  const t1 = Date.now()
  for (let i = 0; i < 6; i++) {
    wb.enqueue({ seq: i, type: 'assistant/chunk', time: Date.now(), content: `chunk-${i}` })
  }
  const enqueueMs = Date.now() - t1
  console.log(`   enqueue 6 个事件总耗时 ${enqueueMs}ms（同步返回，0 阻塞）`)
  await sleep(250) // 等窗口截止
  console.log(`   窗口截止：${wb.stats.writes} 次写盘，6 个事件合并成 1 次 ✓`)

  // flush 静止屏障：turn 边界不等定时器
  console.log('\n④ flush 静止屏障：turn 结束立即清空队列')
  for (let i = 6; i < 9; i++) {
    wb.enqueue({ seq: i, type: 'assistant/chunk', time: Date.now(), content: `chunk-${i}` })
  }
  await wb.flush()
  console.log(`   flush 后：${wb.stats.writes} 次写盘，落盘 ${backend.persisted.length} 条`)

  // 崩溃恢复
  console.log('\n⑤ 崩溃恢复：进程没了，磁盘还在')
  const recovered = [...backend.persisted] // 从磁盘重放
  console.log(`   崩溃后从磁盘恢复 ${recovered.length} 条（0 丢失 ✓）`)
  console.log('   （注：崩溃发生在 flush 之后；窗口内未 flush 的事件真实场景靠 WAL 兜底，教学略）')

  // ========== 对比 ==========
  console.log('\n对比')
  console.log(`   朴素版 A：${syncMs}ms 阻塞（每个事件等 I/O）→ 流式主循环卡死`)
  console.log(`   朴素版 B：0 次写盘 → 崩溃全丢`)
  console.log(
    `   harness：enqueue ${enqueueMs}ms + ${wb.stats.writes} 次写盘合并 ${wb.stats.appended} 事件 + 崩溃恢复 ${recovered.length} 条 ✓`,
  )

  console.log(
    '\n🎯 一句话：先记内存立即放行（不阻塞），窗口批量落盘（不浪费），flush 做边界（不丢失）。',
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
