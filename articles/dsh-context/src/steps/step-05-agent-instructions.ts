/**
 * Step 05 – 为什么工作区指令走"基线 + 增量"，而不是每轮全量塞？
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「基线」= 第一次注入时把整条指令链（AGENTS.md 等）完整渲染成一条消息，
 *   一次付清全款（类比：入职第一天把员工手册整本发给你）。
 * 「增量」= 之后文件变了，只发"哪变了"——set（新增）/ replace（内容变）/
 *   remove（删除），不重发全文（类比：手册改了一页，只发那一页的修订通知）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法 1：每轮全量塞 AGENTS.md → token 贵（项目指令几百行，每轮都付，
 *   30 轮对话一半 token 花在重复指令上）。
 * 新手做法 2：只在启动时读一次 → 文件改了模型不知道，用过期约定干活。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 基线一次注入 + 事件驱动 reconcile：在成功的 read/write/edit 之后，对比
 * "模型可见状态"与文件系统，内容哈希变了才渲染 set/replace/remove 增量。
 * 没有文件 watcher——指令文件变更频率极低，事件驱动足够（源码的刻意选择）。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 只在"文件变了"时付增量 token；模型永远用最新的项目约定。
 * （字节预算：源码里渲染还要受预算约束，超预算从宽泛到具体省略——render.ts
 *   renderInstructionContext，本步只讲"基线 + 增量"这一件事。）
 *
 * 对应源码：packages/context/agent-instructions/src/state.ts（reconcileInstructionContext，
 *   可见状态 vs 文件系统）+ render.ts（基线/增量渲染）
 * 跑法：pnpm run context:step:05（或 articles/dsh-context 内 pnpm run step:05）
 */

/** 一个已加载的指令文件（对应源码 LoadedInstructionFile） */
interface InstructionFile {
  /** 展示路径：`$DSH_HOME/AGENTS.md` 或项目相对路径 */
  displayPath: string
  content: string
}

/** 可见状态里记录的一条变化（对应源码 AgentInstructionChange，render.ts:47-52） */
interface InstructionChange {
  action: 'set' | 'replace' | 'remove'
  /** 逻辑 scope：指令所属目录（user-global / 项目根 / 子目录） */
  scope: string
  path: string
  /** 内容哈希（真实实现是 sha1 digest，这里用简化哈希，原理相同） */
  digest?: string
}

/** 内存文件系统（教学简化：真实实现读磁盘 + metadata 缓存，state.ts） */
class MemoryFS {
  private readonly files = new Map<string, string>()

  write(path: string, content: string): void {
    this.files.set(path, content)
  }

  remove(path: string): void {
    this.files.delete(path)
  }

  read(path: string): string | undefined {
    return this.files.get(path)
  }
}

/** 简化内容哈希（对应源码 digest.ts；真实是 sha1，这里 djb2 足够教学） */
function contentHash(content: string): string {
  let hash = 5381
  for (const ch of content) hash = ((hash << 5) + hash + ch.codePointAt(0)!) >>> 0
  return hash.toString(16)
}

/** 从展示路径推导逻辑 scope（对应源码 scopeForDisplayPath，render.ts:105-108） */
function scopeOf(path: string): string {
  return path === '$DSH_HOME/AGENTS.md'
    ? 'user-global'
    : path.startsWith('./')
      ? '.'
      : path.split('/').slice(0, -1).join('/')
}

/**
 * 基线注入：加载整条指令链（user-global → 项目根 → … → cwd，从宽到窄）
 * 并完整渲染成一条消息（对应源码 loadBaselineInstructionSet + renderWorkspaceContext）。
 */
function loadBaseline(fs: MemoryFS, paths: readonly string[]): InstructionFile[] {
  const files: InstructionFile[] = []
  for (const path of paths) {
    const content = fs.read(path)
    if (content !== undefined) files.push({ displayPath: path, content })
  }
  return files
}

function renderBaseline(files: readonly InstructionFile[]): string {
  const sections = files.map(file => `Instructions from: ${file.displayPath}\n\n${file.content}`)
  return `<system-reminder>\nThe following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones.\n\n${sections.join('\n\n')}\n</system-reminder>`
}

/**
 * 动态 reconcile（对应源码 reconcileInstructionContext 的核心思路）：
 * 对比"可见状态"与文件系统，对每个候选路径渲染 set / replace / remove 增量。
 * 只发变化，不重发全文。
 */
function reconcile(
  fs: MemoryFS,
  visible: Map<string, InstructionChange>,
  paths: readonly string[],
): { text: string; changes: InstructionChange[] } | undefined {
  const items: { change: InstructionChange; content?: string }[] = []
  for (const path of paths) {
    const previous = visible.get(path)
    const content = fs.read(path)
    if (content === undefined) {
      // 文件没了：之前可见 → remove 增量（state.ts 的 remove 分支）
      if (previous !== undefined && previous.action !== 'remove') {
        items.push({ change: { action: 'remove', scope: scopeOf(path), path } })
      }
      continue
    }
    const digest = contentHash(content)
    if (previous === undefined || previous.action === 'remove') {
      // 新出现 → set
      items.push({ change: { action: 'set', scope: scopeOf(path), path, digest }, content })
    } else if (previous.digest !== digest) {
      // 内容变了 → replace（哈希相同 = 没变，跳过）
      items.push({ change: { action: 'replace', scope: scopeOf(path), path, digest }, content })
    }
  }
  if (items.length === 0) return undefined
  const text = items
    .map(item => {
      const { change } = item
      if (change.action === 'set') {
        return `Additional instructions from: ${change.path}\n\nThese instructions apply to work under \`${change.scope}\`. Use them as guidance when relevant.\n\n${item.content}`
      }
      if (change.action === 'remove') {
        return `Instructions removed: ${change.path}\n\nThe previously loaded instructions from this file no longer apply.`
      }
      return `Updated instructions from: ${change.path}\n\nThis file changed after it was loaded. Use the following content instead of the previously loaded instructions.\n\n${item.content}`
    })
    .join('\n\n')
  return {
    text: `<system-reminder>\n${text}\n</system-reminder>`,
    changes: items.map(item => item.change),
  }
}

/** 估算 token 数（教学简化）：CJK 一字一 token，其他约 4 字符一 token */
function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

function main(): void {
  console.log('📁 Step 05 – 工作区指令：基线一次注入，之后只发增量')
  console.log('='.repeat(56))

  // 内存文件系统：三份指令（user-global → 项目根 → cwd 子目录，从宽到窄）
  const fs = new MemoryFS()
  const paths = ['$DSH_HOME/AGENTS.md', './AGENTS.md', 'packages/web/AGENTS.md']
  fs.write('$DSH_HOME/AGENTS.md', '# Team rules\n- Always run tests before committing.\n')
  fs.write('./AGENTS.md', '# Repo conventions\n- TypeScript strict mode.\n- pnpm monorepo.\n')
  fs.write('packages/web/AGENTS.md', '# Web package\n- Use the repo UI kit, never raw CSS.\n')

  // ========== 朴素版 1：每轮全量塞 ==========
  console.log('\n① 朴素版：每轮全量塞 AGENTS.md')
  const baselineFiles = loadBaseline(fs, paths)
  const baselineText = renderBaseline(baselineFiles)
  const turns = 30
  console.log(
    `   基线全文 ${estimateTokens(baselineText)} tokens × ${turns} 轮 = ${estimateTokens(baselineText) * turns} tokens`,
  )
  console.log(`   💥 崩点：长对话一半 token 花在重复指令上（30 轮里 29 轮一字不差）`)

  // ========== 朴素版 2：只在启动时读一次 ==========
  console.log('\n② 朴素版反面：只在启动时读一次')
  const startupCopy = baselineText // 启动时快照
  fs.write(
    'packages/web/AGENTS.md',
    '# Web package\n- Use the repo UI kit, never raw CSS.\n- New rule: export types with `type` keyword.\n',
  )
  console.log('   之后 cwd 的 AGENTS.md 加了一条新规则')
  console.log(
    `   模型看到的还是启动时的约定：${JSON.stringify(startupCopy.includes('New rule') ? '有' : '没有')} New rule`,
  )
  console.log('   💥 崩点：文件改了模型不知道，按旧规则干活')

  // ========== harness 版：基线 + 增量 ==========
  console.log('\n③ harness 版：基线一次注入，之后只发增量')
  const visible = new Map<string, InstructionChange>()
  for (const file of baselineFiles) {
    visible.set(file.displayPath, {
      action: 'set',
      scope: scopeOf(file.displayPath),
      path: file.displayPath,
      digest: contentHash(file.content),
    })
  }
  console.log(`   基线注入一次（${estimateTokens(baselineText)} tokens，之后不再重发全文）`)
  console.log(`   模型看到的基线（${baselineFiles.length} 份文件，从宽到窄）：`)
  for (const file of baselineFiles) console.log(`     ${file.displayPath}`)

  // 文件变了 → replace 增量
  console.log('\n④ 文件内容变了 → replace 增量（只发"哪变了"）')
  fs.write(
    'packages/web/AGENTS.md',
    '# Web package\n- Use the repo UI kit, never raw CSS.\n- New rule: export types with `type` keyword.\n',
  )
  const replaceUpdate = reconcile(fs, visible, paths)
  if (replaceUpdate !== undefined) {
    for (const change of replaceUpdate.changes) {
      visible.set(change.path, change)
      console.log(`   → [${change.action}] ${change.path}`)
    }
    console.log(
      `   增量消息（${estimateTokens(replaceUpdate.text)} tokens，不是全量 ${estimateTokens(baselineText)} tokens）：`,
    )
    console.log(`   ${replaceUpdate.text.replaceAll('\n', '\n   ')}`)
    console.log('   ✅ 只付增量 token——"文件变了"才付费')
  }

  // 新增文件 → set 增量
  console.log('\n⑤ 新增指令文件 → set 增量')
  fs.write('packages/web/AGENTS.local.md', '# Local overlay\n- Use prettier before commit.\n')
  // 简化：新增文件当作新候选参与 reconcile（真实实现有候选发现，这里直接列出）
  const withLocal = [...paths, 'packages/web/AGENTS.local.md']
  const setUpdate = reconcile(fs, visible, withLocal)
  if (setUpdate !== undefined) {
    for (const change of setUpdate.changes) visible.set(change.path, change)
    console.log(
      `   → [${setUpdate.changes.map(c => c.action).join(', ')}] ${setUpdate.changes.map(c => c.path).join(', ')}`,
    )
    console.log('   ✅ 新文件 → set，模型知道有新的约定文件')
  }

  // 删除文件 → remove 增量
  console.log('\n⑥ 删除指令文件 → remove 增量')
  fs.remove('./AGENTS.md')
  const removeUpdate = reconcile(fs, visible, paths)
  if (removeUpdate !== undefined) {
    for (const change of removeUpdate.changes) visible.set(change.path, change)
    console.log(
      `   → [${removeUpdate.changes.map(c => c.action).join(', ')}] ${removeUpdate.changes.map(c => c.path).join(', ')}`,
    )
    console.log(
      `   增量消息：${JSON.stringify(removeUpdate.text.slice(removeUpdate.text.indexOf('Instructions removed'), -14))}…`,
    )
    console.log('   ✅ 删除也有显式增量——模型知道旧约定不再适用')
  }

  // 没变 → 不产生任何增量
  console.log('\n⑦ 文件没变 → reconcile 返回 undefined（什么都不发）')
  const noChange = reconcile(fs, visible, paths)
  console.log(`   ${noChange === undefined ? '✅ 无变化，零 token 开销' : '❌ 不该有增量'}`)

  console.log(
    '\n🎯 一句话：基线付一次全款，之后 set/replace/remove 只付差价——模型永远用最新约定，token 只花在变化上。',
  )
}

main()

export {}
