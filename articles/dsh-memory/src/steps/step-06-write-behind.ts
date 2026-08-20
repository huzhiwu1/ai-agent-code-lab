/**
 * Step 06 – write-behind 持久化：200ms 固定窗口，合并写但绝不丢
 *
 * 学习目标：流式输出每秒产生几十个 chunk 事件，不能每个都写盘（JSONL
 * 每次 append 要创建并 fsync 一个 zstd frame，SQLite 每次开一个事务）。
 * 方案是"固定窗口的批量合并（bounded coalescing），不是 debounce"
 * （文章 4.2 节）：
 *
 *   - 队列从空变非空 → 启动一个固定窗口（maxDelayMs，默认 200ms），
 *     后续事件加入该批，**不重置截止时间**（coalescing ≠ debounce）；
 *   - 截止 → 把完整 pending 前缀交给后端 appendBatch；
 *   - 同一时刻最多一个 active write，写期间新到的事件 → 新 pending 前缀；
 *   - 失败保留：写失败 → 完整批次恢复到队列头部（保持顺序），报告一次
 *     失败，**暂停自动重试**（避免定时器驱动的失败循环）；下一个新事件
 *     重新开窗口；显式 flush 立即重试并向上报错；
 *   - flush 是共享静止屏障：取消剩余等待，drain 活动写 + 屏障期间到达
 *     的所有事件（turn 边界、模型请求前、生命周期 teardown 都走它）。
 *
 * 对应源码：packages/session/persistence/src/session-write-behind.ts
 *   （设计笔记 bounded-session-persistence-write-batching）
 *
 * 跑法：pnpm run step:06
 */

/** 简化事件（落盘粒度，教学用平铺结构） */
interface StoredEvent {
  seq: number
  type: string
  time: number
  content: string
}

/** 后端抽象（真实实现：JSONL(zstd) / SQLite 双后端，这里用内存模拟） */
interface WriteBackend {
  appendBatch(events: readonly StoredEvent[]): Promise<void>
  readonly persisted: readonly StoredEvent[]
}

/** 内存后端：可注入失败，模拟磁盘 I/O 错误 */
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
 * 写后缓冲（文章 4.2 节 SessionWriteBehind）：
 * 200ms 固定窗口 coalescing + 失败保留 + flush 静止屏障。
 */
class SessionWriteBehind {
  private queue: StoredEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> | null = null

  /** 统计：事件数 vs 写次数（合并效果看得见） */
  stats = { appended: 0, writes: 0, failedWrites: 0 }

  constructor(
    private readonly backend: WriteBackend,
    private readonly windowMs = 200,
  ) {}

  /** 事件入队：队列空→非空时启动固定窗口；窗口内不重置截止（coalescing） */
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

  /** 静止屏障：取消剩余等待，等活动写，再排空期间到达的事件 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.writing) await this.writing
    await this.drain()
    if (this.queue.length > 0) {
      throw new Error(`flush 失败：仍有 ${this.queue.length} 个事件未落盘`)
    }
  }

  /** 排空 pending 前缀：一次写失败则保留队列并暂停（等新事件或显式 flush） */
  private drain(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve()
    if (this.writing) return this.writing // 同一时刻最多一个 active write
    const run = this.doDrain().finally(() => {
      this.writing = null
    })
    this.writing = run
    return run
  }

  private async doDrain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length) // 完整 pending 前缀
      this.stats.writes++
      try {
        await this.backend.appendBatch(batch)
      } catch {
        this.stats.failedWrites++
        this.queue.unshift(...batch) // 失败保留：批次恢复队列头部，顺序不乱
        break // 暂停自动重试：下一个新事件重新开窗口 / 显式 flush 立即重试
      }
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const backend = new MemoryBackend()
  const wb = new SessionWriteBehind(backend, 200)

  console.log('💾 第 4 层：write-behind 持久化（200ms 固定窗口 coalescing）')
  console.log('----------------------------------------')

  // ① 快速追加 8 个流式 chunk（每 20ms 一个，总耗时 160ms < 200ms 窗口）
  console.log('① 快速追加 8 个流式事件（每 20ms 一个，都落在同一 200ms 窗口）：')
  for (let i = 0; i < 8; i++) {
    wb.enqueue({
      seq: i,
      type: i % 3 === 0 ? 'assistant/message' : 'assistant/chunk',
      time: Date.now(),
      content: `chunk-${i}`,
    })
    await sleep(20)
  }
  await sleep(250) // 等窗口截止
  console.log(`   写次数 = ${wb.stats.writes}（8 个事件合并成 1 次写 ✓）`)

  // ② 追加 3 个 → flush 静止屏障（不等定时器）
  console.log('\n② 追加 3 个事件后显式 flush（静止屏障，不等待定时器）：')
  for (let i = 8; i < 11; i++) {
    wb.enqueue({ seq: i, type: 'assistant/chunk', time: Date.now(), content: `chunk-${i}` })
  }
  await wb.flush()
  console.log(`   写次数 = ${wb.stats.writes}，已落盘 = ${backend.persisted.length} 条`)

  // ③ 失败保留 + 暂停自动重试
  console.log('\n③ 注入一次磁盘错误，验证"失败保留 + 暂停自动重试"：')
  backend.failNext = 1
  for (let i = 11; i < 13; i++) {
    wb.enqueue({ seq: i, type: 'assistant/chunk', time: Date.now(), content: `chunk-${i}` })
  }
  await sleep(250) // 窗口截止 → 后台写失败
  console.log(
    `   写失败 ${wb.stats.failedWrites} 次；事件不丢：${wb.stats.appended} 追加 - ${backend.persisted.length} 落盘 = ${wb.stats.appended - backend.persisted.length} 个仍在内存`,
  )
  await sleep(250) // 再等一个窗口：不应有自动重试
  console.log(
    `   暂停自动重试：再等 250ms，写次数仍 = ${wb.stats.writes}（没有定时器驱动的失败循环）`,
  )

  // ④ 显式 flush：立即重试并成功
  console.log('\n④ 显式 flush 立即重试：')
  await wb.flush()
  console.log(`   写次数 = ${wb.stats.writes}，已落盘 = ${backend.persisted.length} 条，0 丢失 ✓`)

  // ⑤ 合并统计
  console.log('\n合并统计：')
  console.log(
    `   追加 ${wb.stats.appended} 个事件 → ${wb.stats.writes} 次写（写次数 / 事件数 = ${((wb.stats.writes / wb.stats.appended) * 100).toFixed(1)}%）`,
  )
  console.log(`   失败 ${wb.stats.failedWrites} 次，全部恢复，无事件丢失`)

  console.log(
    '\n小结：固定窗口合并（不重置截止）+ 失败保留 + 暂停自动重试 + flush 静止屏障——批量但不丢序。',
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
