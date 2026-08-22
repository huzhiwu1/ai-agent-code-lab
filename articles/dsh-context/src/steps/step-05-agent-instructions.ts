/**
 * Step 05 – 工作区指令：AGENTS.md 是怎么进上下文的？
 *
 * 学习目标：项目约定（AGENTS.md）是"每个事实一个 owner"的典型：它属于文件系统，
 * 插件只负责投影。三步机制：① 加载链——user-global（$DSH_HOME/AGENTS.md）→ 项目根
 * → … → cwd，从宽到窄，更具体的指令覆盖更宽泛的；② 基线注入——第一次 pre-step 把
 * 整条链渲染成 baseline user 消息；③ 动态 reconcile——成功的 read/write/edit 之后，
 * 对比"可见状态 vs 文件系统"，渲染 set（新出现）/ replace（内容变）/ remove（删除）
 * 增量，而不是全量重发。还有字节预算：全部放不下 → 从最宽泛开始省略 → 只剩一个最
 * 具体还超 → 二分截断（UTF-8 边界回退）→ 连标题都放不下 → 预算通知（至少告诉模型
 * "有指令没放进来"）。本文件用真实临时目录 + 真实文件演示。
 *
 * 对应源码：packages/context/agent-instructions/src/render.ts:275-332（预算约束渲染）
 *           render.ts:69-79（truncateUtf8 二分 + UTF-8 边界回退）
 *           state.ts:246-433（reconcileInstructionContext：可见状态 vs 文件系统）
 *           index.ts:322-348（pre-step 消费 pending 上下文）
 *
 * 跑法：pnpm run step:05（articles/dsh-context 目录内）或根目录 pnpm run context:step:05
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { tmpdir } from 'node:os'

/** 一个已加载的指令文件（对应源码 LoadedInstructionFile） */
interface LoadedInstructionFile {
  absolutePath: string
  displayPath: string
  content: string
}

/** 可见状态里记录的一条变化（对应源码 AgentInstructionChange，render.ts:47-52） */
interface AgentInstructionChange {
  action: 'set' | 'replace' | 'remove'
  scope: string
  path: string
  /** 内容标识（真实实现是 sha1 digest；这里直接存内容字符串，原理相同） */
  digest?: string
}

/** 渲染结果：正文 + 被省略/截断的清单（对应源码 RenderedWorkspaceContext） */
interface RenderedWorkspaceContext {
  text: string
  omitted: { displayPath: string }[]
  truncated: { displayPath: string; originalBytes: number; includedBytes: number }[]
}

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const WORKSPACE_CONTEXT_INTRO =
  'The following workspace instructions may be relevant to your work. ' +
  'Use them as guidance when applicable. More specific instructions take precedence over broader ones. ' +
  'They do not override system, developer, or direct user instructions.'
const COMPACT_WORKSPACE_CONTEXT_INTRO =
  'Workspace instructions were omitted or truncated to fit the configured byte budget.'

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * UTF-8 安全的截断（对应源码 truncateUtf8，render.ts:69-79）：
 * 预算切到某个码点的 continuation byte 时回退到 lead byte 一并排除，
 * 保证截断处永远不出现半个字符。
 */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) {
    end -= 1
  }
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * 帧体转义（对应源码 escapeInstructionFrameBody，render.ts:81-83）：
 * 指令内容里恰好有 `</system-reminder>` 会逃逸出帧，替换成反斜杠转义保证帧结构
 * 不可被内容破坏。
 */
function escapeInstructionFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

function sectionText(file: LoadedInstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

/** 预算诊断标记：omitted/truncated 清单进正文，模型知道自己漏看了什么（render.ts:215-225） */
function markerText(
  maxBytes: number,
  omitted: { displayPath: string }[],
  truncated: { displayPath: string; originalBytes: number; includedBytes: number }[],
): string {
  if (omitted.length === 0 && truncated.length === 0) return ''
  const parts: string[] = []
  if (omitted.length > 0) parts.push(`omitted ${omitted.map(file => file.displayPath).join(', ')}`)
  if (truncated.length > 0) {
    parts.push(
      `truncated ${truncated.map(item => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(', ')}`,
    )
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

function buildInstructionText(
  files: LoadedInstructionFile[],
  maxBytes: number,
  omitted: { displayPath: string }[],
  truncated: { displayPath: string; originalBytes: number; includedBytes: number }[],
  intro: string,
): string {
  const marker = markerText(maxBytes, omitted, truncated)
  const body = [marker, intro, ...files.map(file => sectionText(file))].filter(
    block => block.length > 0,
  )
  return [
    SYSTEM_REMINDER_OPEN,
    escapeInstructionFrameBody(body.join('\n\n')),
    SYSTEM_REMINDER_CLOSE,
  ].join('\n')
}

/**
 * 预算约束渲染（对应源码 renderInstructionContext，render.ts:275-332）。
 * 优先级：全部放得下 → 直接输出；放不下 → 从最宽泛的文件开始省略（保留最具体）；
 * 只剩一个最具体还超 → 对它二分截断（truncateToFit 用二分找最大可包含字节数）；
 * 连标题都放不下 → 退化为预算通知。
 */
function renderInstructionContext(
  files: LoadedInstructionFile[],
  maxBytes: number,
): RenderedWorkspaceContext {
  const fullText = buildInstructionText(files, maxBytes, [], [], WORKSPACE_CONTEXT_INTRO)
  if (byteLength(fullText) <= maxBytes) {
    return { text: fullText, omitted: [], truncated: [] }
  }
  // 从最宽泛开始省略：files 已是"宽泛 → 具体"排序，逐个砍头
  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start)
    const omitted = files.slice(0, start).map(file => ({ displayPath: file.displayPath }))
    const suffixText = buildInstructionText(
      included,
      maxBytes,
      omitted,
      [],
      WORKSPACE_CONTEXT_INTRO,
    )
    if (byteLength(suffixText) <= maxBytes) return { text: suffixText, omitted, truncated: [] }
  }
  // 只剩最具体的一个还超：二分截断
  const mostSpecific = files.at(-1)
  if (mostSpecific === undefined) return { text: '', omitted: [], truncated: [] }
  const omitted = files.slice(0, -1).map(file => ({ displayPath: file.displayPath }))
  const originalBytes = byteLength(mostSpecific.content)
  let low = 0
  let high = originalBytes
  let best = { content: '', bytes: 0 }
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = truncateUtf8(mostSpecific.content, mid)
    const truncated = [
      {
        displayPath: mostSpecific.displayPath,
        originalBytes,
        includedBytes: byteLength(candidate),
      },
    ]
    const text = buildInstructionText(
      [{ ...mostSpecific, content: candidate }],
      maxBytes,
      omitted,
      truncated,
      COMPACT_WORKSPACE_CONTEXT_INTRO,
    )
    if (byteLength(text) <= maxBytes) {
      best = { content: candidate, bytes: byteLength(candidate) }
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (best.bytes > 0) {
    const truncated = [
      { displayPath: mostSpecific.displayPath, originalBytes, includedBytes: best.bytes },
    ]
    return {
      text: buildInstructionText(
        [{ ...mostSpecific, content: best.content }],
        maxBytes,
        omitted,
        truncated,
        COMPACT_WORKSPACE_CONTEXT_INTRO,
      ),
      omitted,
      truncated,
    }
  }
  // 连标题都放不下：至少告诉模型"有指令被省略了"（诚实优先，render.ts:317-331）
  const notice = markerText(maxBytes, omitted, [
    { displayPath: mostSpecific.displayPath, originalBytes, includedBytes: 0 },
  ])
  // 通知本身也要塞进预算（render.ts:330：放不下就 truncateUtf8 兜底）
  const boundedNotice = truncateUtf8(notice, maxBytes)
  return { text: escapeInstructionFrameBody(boundedNotice), omitted, truncated: [] }
}

/** 从 cwd 向上找项目根（.git 标记；对应源码 files.ts findProjectRoot） */
async function findProjectRoot(cwd: string): Promise<string> {
  let dir = cwd
  for (;;) {
    try {
      await readFile(join(dir, '.git'), 'utf8')
      return dir
    } catch {
      /* 继续向上 */
    }
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

/** 项目根 → cwd 的目录链（对应源码 files.ts ancestorChain） */
function ancestorChain(projectRoot: string, cwd: string): string[] {
  const chain: string[] = []
  let dir = cwd
  for (;;) {
    chain.push(dir)
    if (dir === projectRoot) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return chain
}

/**
 * 加载整条指令链：user-global → 项目根 → … → cwd（对应源码 loadBaselineInstructionSet）。
 * 返回的 files 已按"宽泛 → 具体"排序，同目录取第一个存在的候选（简化：只 AGENTS.md）。
 */
async function loadBaselineInstructionSet(
  dshHome: string,
  projectRoot: string,
  cwd: string,
): Promise<LoadedInstructionFile[]> {
  const files: LoadedInstructionFile[] = []
  // user-global：$DSH_HOME/AGENTS.md（最宽泛，第一优先级省略）
  const userGlobalPath = join(dshHome, 'AGENTS.md')
  try {
    const content = await readFile(userGlobalPath, 'utf8')
    files.push({ absolutePath: userGlobalPath, displayPath: '$DSH_HOME/AGENTS.md', content })
  } catch {
    /* 不存在就跳过 */
  }
  // 项目根 → … → cwd：从宽到窄（ancestorChain 从 cwd 向上，需反转成项目根在前）
  for (const dir of ancestorChain(projectRoot, cwd).reverse()) {
    const candidate = join(dir, 'AGENTS.md')
    try {
      const content = await readFile(candidate, 'utf8')
      files.push({
        absolutePath: candidate,
        displayPath: relative(projectRoot, candidate),
        content,
      })
    } catch {
      /* 目录没有 AGENTS.md 就跳过 */
    }
  }
  return files
}

/** 逻辑 scope：从展示路径推导（对应源码 scopeForDisplayPath，render.ts:105-108，简化） */
function scopeForDisplayPath(displayPath: string): string {
  if (displayPath === '$DSH_HOME/AGENTS.md') return 'user-global'
  return dirname(displayPath)
}

/**
 * 动态 reconcile（对应源码 reconcileInstructionContext，state.ts:246-433 的核心思路）：
 * 对比"可见状态"与文件系统，对每个 scope 渲染 set / replace / remove 增量。
 * 简化：不实现 version+digest 元数据缓存和同目录去重，直接比内容。
 */
async function reconcileInstructionContext(
  visible: Map<string, AgentInstructionChange>,
  touchedPaths: string[],
  dshHome: string,
  projectRoot: string,
): Promise<{ text: string; changes: AgentInstructionChange[] } | undefined> {
  // 关注范围：可见的 scope + touched 路径涉及的目录 scope（state.ts:269-299）
  const scopes = new Set(visible.keys())
  for (const touchedPath of touchedPaths) {
    scopes.add(scopeForDisplayPath(relative(projectRoot, touchedPath)))
  }
  const items: { change: AgentInstructionChange; content: string }[] = []
  for (const scope of scopes) {
    const previous = visible.get(scope)
    // 从 scope 还原候选路径（简化：AGENTS.md 单候选；user-global 特殊）
    const candidatePath =
      scope === 'user-global'
        ? join(dshHome, 'AGENTS.md')
        : scope === '.'
          ? join(projectRoot, 'AGENTS.md')
          : join(projectRoot, scope, 'AGENTS.md')
    const displayPath =
      scope === 'user-global' ? '$DSH_HOME/AGENTS.md' : relative(projectRoot, candidatePath)
    let content: string | undefined
    try {
      content = await readFile(candidatePath, 'utf8')
    } catch {
      /* 文件不存在 */
    }
    if (content === undefined) {
      // 文件没了：之前可见 → remove 增量（state.ts:366-370）
      if (previous !== undefined && previous.action !== 'remove') {
        items.push({ change: { action: 'remove', scope, path: previous.path }, content: '' })
      }
      continue
    }
    // 文件在：新出现 → set；内容变了 → replace；没变 → 跳过（state.ts:408-420）
    if (previous === undefined || previous.action === 'remove') {
      items.push({ change: { action: 'set', scope, path: displayPath, digest: content }, content })
    } else if (previous.path !== displayPath || previous.digest !== content) {
      items.push({
        change: { action: 'replace', scope, path: displayPath, digest: content },
        content,
      })
    }
  }
  if (items.length === 0) return undefined
  // 渲染变化（对应源码 renderInstructionChanges，render.ts:192-213）
  const text = items
    .map(item => {
      const { change } = item
      if (change.action === 'set') {
        return `Additional instructions from: ${change.path}\n\nThese instructions apply to work under \`${change.scope}\`. Use them as guidance when relevant; more specific instructions take precedence.\n\n${item.content}`
      }
      if (change.action === 'remove') {
        return `Instructions removed: ${change.path}\n\nThe previously loaded instructions from this file no longer apply.`
      }
      return `Updated instructions from: ${change.path}\n\nThis file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.\n\n${item.content}`
    })
    .join('\n\n')
  const framed = [
    SYSTEM_REMINDER_OPEN,
    escapeInstructionFrameBody(text),
    SYSTEM_REMINDER_CLOSE,
  ].join('\n')
  return { text: framed, changes: items.map(item => item.change) }
}

async function main(): Promise<void> {
  // 真实临时目录：$DSH_HOME + 项目仓库 + cwd
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-context-05-'))
  const dshHome = join(sandbox, 'dsh-home')
  const cwd = join(sandbox, 'repo', 'packages', 'web')
  await mkdir(dshHome, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(join(sandbox, 'repo', '.git'), '', 'utf8') // 项目根标记
  // 项目根发现：从 cwd 向上找 .git 标记（对应源码 files.ts findProjectRoot）
  const projectRoot = await findProjectRoot(cwd)

  try {
    console.log('📁 Step 05：工作区指令——AGENTS.md 是怎么进上下文的？')
    console.log('---------------------------------------------------')
    console.log(`   临时沙箱：${sandbox}`)
    console.log(
      `   项目根发现：findProjectRoot(${cwd}) → ${projectRoot}（从 cwd 向上找到 .git 标记）`,
    )

    // ① 建三份真实 AGENTS.md：user-global / 项目根 / cwd（从宽到窄）
    await writeFile(
      join(dshHome, 'AGENTS.md'),
      '# Team rules\n- Always run tests before committing.\n- Use conventional commits.\n',
      'utf8',
    )
    await writeFile(
      join(projectRoot, 'AGENTS.md'),
      '# Repo conventions\n- TypeScript strict mode.\n- pnpm monorepo.\n',
      'utf8',
    )
    await writeFile(
      join(cwd, 'AGENTS.md'),
      '# Web package\n- Use the repo UI kit, never raw CSS.\n',
      'utf8',
    )

    // ② 基线注入：第一次 pre-step 渲染整条链
    console.log('\n① 基线注入（第一次 pre-step）：加载链 user-global → 项目根 → cwd：')
    const files = await loadBaselineInstructionSet(dshHome, projectRoot, cwd)
    for (const file of files) console.log(`   加载: ${file.displayPath}`)
    const baseline = renderInstructionContext(files, 2048)
    console.log(`   渲染字节数：${byteLength(baseline.text)}（预算 2048）`)
    console.log('   模型看到的正文（帧内分节）：')
    const body = baseline.text
      .replace(`<system-reminder>`, '')
      .replace('</system-reminder>', '')
      .trim()
    for (const line of body.split('\n')) console.log(`     ${line}`)
    // 记录基线可见状态（真实实现从会话 surface 恢复；这里直接存）
    const visible = new Map<string, AgentInstructionChange>()
    for (const file of files) {
      visible.set(scopeForDisplayPath(file.displayPath), {
        action: 'set',
        scope: scopeForDisplayPath(file.displayPath),
        path: file.displayPath,
        digest: file.content,
      })
    }

    // ③ 改内容 → replace 增量（对应 tools/result 里 read/write/edit 成功 → reconcile）
    console.log('\n② 动态 reconcile：修改 cwd 的 AGENTS.md → replace 增量：')
    await writeFile(
      join(cwd, 'AGENTS.md'),
      '# Web package\n- Use the repo UI kit, never raw CSS.\n- New rule: export types with `type` keyword.\n',
      'utf8',
    )
    const replaceUpdate = await reconcileInstructionContext(
      visible,
      [join(cwd, 'AGENTS.md')],
      dshHome,
      projectRoot,
    )
    if (replaceUpdate !== undefined) {
      console.log(
        `   增量 ${JSON.stringify(replaceUpdate.changes.map(c => c.action))} → ${JSON.stringify(replaceUpdate.changes[0]!.path)}`,
      )
      console.log('   增量消息正文：')
      for (const line of replaceUpdate.text.split('\n')) console.log(`     ${line}`)
      for (const change of replaceUpdate.changes) visible.set(change.scope, change)
    }

    // ④ 删文件 → remove 增量
    console.log('\n③ 动态 reconcile：删除项目根的 AGENTS.md → remove 增量：')
    await rm(join(projectRoot, 'AGENTS.md'))
    const removeUpdate = await reconcileInstructionContext(
      visible,
      [join(projectRoot, 'AGENTS.md')],
      dshHome,
      projectRoot,
    )
    if (removeUpdate !== undefined) {
      console.log(`   增量 ${JSON.stringify(removeUpdate.changes.map(c => c.action))}`)
      for (const line of removeUpdate.text.split('\n')) console.log(`     ${line}`)
      for (const change of removeUpdate.changes) visible.set(change.scope, change)
    }

    // ⑤ 字节预算：塞超长文件 → 从宽泛开始省略 + 截断最具体
    console.log('\n④ 字节预算：全部放不下时，从最宽泛开始省略，只剩最具体的就截断：')
    await writeFile(join(cwd, 'AGENTS.md'), '# Web package\n' + 'rule-'.repeat(400) + '\n', 'utf8')
    await writeFile(
      join(dshHome, 'AGENTS.md'),
      '# Team rules\n' + 'always test\n'.repeat(200),
      'utf8',
    )
    const reloaded = await loadBaselineInstructionSet(dshHome, projectRoot, cwd)
    const tight = renderInstructionContext(reloaded, 800)
    console.log(`   预算 800 字节；渲染 ${byteLength(tight.text)} 字节`)
    console.log(`   omitted: ${tight.omitted.map(f => f.displayPath).join(', ') || '(无)'}`)
    console.log(
      `   truncated: ${tight.truncated.map(t => `${t.displayPath} ${t.originalBytes}→${t.includedBytes} bytes`).join(', ') || '(无)'}`,
    )

    // ⑥ 超极端预算 → 预算通知（连标题都放不下时至少说一声）
    console.log('\n⑤ 极端预算：连标题都放不下 → 退化为预算通知（诚实优先）：')
    const tiny = renderInstructionContext(reloaded, 60)
    console.log(`   预算 60 字节 → 渲染 ${byteLength(tiny.text)} 字节：`)
    console.log(`   ${tiny.text}`)

    // ⑦ 转义：内容里的 </system-reminder> 不能破坏帧结构
    console.log('\n⑥ 帧体转义：指令内容含 </system-reminder> → 反斜杠转义：')
    await writeFile(join(cwd, 'AGENTS.md'), 'Never emit </system-reminder> in replies.\n', 'utf8')
    const escapedFiles = await loadBaselineInstructionSet(dshHome, projectRoot, cwd)
    const escaped = renderInstructionContext(escapedFiles, 2048)
    console.log(
      `   内容中的帧闭合被转义：${escaped.text.includes('<\\/system-reminder>') ? '✅ 是' : '❌ 否'}`,
    )
    console.log(
      `   帧闭合出现次数：${(escaped.text.match(/<\/system-reminder>/g) ?? []).length}（只能来自帧本身）`,
    )
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }

  console.log(
    '\n小结：AGENTS.md = 文件系统拥有的事实，插件只做投影：基线一次注入、文件 touch 后 set/replace/remove' +
      '增量 reconcile、字节预算下"省略宽泛 → 截断具体 → 预算通知"三级兜底。',
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

export {}
