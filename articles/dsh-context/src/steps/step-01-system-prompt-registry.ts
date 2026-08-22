/**
 * Step 01 – 为什么 prompt 是"注册"出来的，不是手写一大坨字符串？
 *
 * ── 先懂三个词 ──────────────────────────────────────────────
 * 「section」= 系统提示词的一个积木块（身份块 / 人格块 / 工具指引块），
 *   每块有自己的名字和内容（类比：乐高积木，一块一个零件）。
 * 「order」= 积木块的排列顺序号，小的在前（-100 身份 → 0 人格 → 100-199 工具指引）。
 * 「注册」= 插件声明"我要贡献一块"，而不是去改别人的字符串（类比：往公告栏
 *   贴自己的通知，而不是擦掉别人的通知重写）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法：一个巨大的模板字符串，人格 / 工具指引 / 身份全写在一起。
 * 工具插件 A 想在提示词里加一句指引 → 直接改字符串；另一个插件也改 →
 * 覆盖了 A 的改动；顺序靠运气——谁最后写，谁在中间。改一处要翻全文。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 注册表把"拼 prompt"从字符串手写变成"分区声明 + 排序装配"：每个插件
 * 只贡献自己名字下的 section，互不覆盖；顺序由 order 声明，不靠运气。
 * 装载/卸载一个插件，只增删它自己的 section，绝不手改整段字符串。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * prompt 变成可组合、可防御的工程：插件之间零覆盖、顺序确定、
 * 重复注册同一个名字立刻报错（两个插件抢同一个槽位是配置错误）。
 *
 * 对应源码：packages/core/system-prompt/src/index.ts（section() 注册 index.ts:381-390、
 *   assemble() 按 order 排序 index.ts:504、renderPrompt 去空段拼接 index.ts:212-217）
 * 跑法：pnpm run context:step:01（或 articles/dsh-context 内 pnpm run step:01）
 */

/** 一个系统提示词分区（对应源码 PromptSection，index.ts:53-75） */
interface PromptSection {
  /** 唯一名——重复注册直接 throw（index.ts:381-390） */
  readonly name: string
  /** 升序拼接的顺序号：-100 身份 / 0 人格 / 100-199 工具指引 */
  readonly order: number
  /** 静态文本；空字符串段在渲染时被滤掉 */
  readonly text: string
}

/** 装配结果：按 order 排好序的 section 列表（对应源码 AssembledSection） */
interface PromptAssembly {
  sections: { name: string; text: string }[]
}

/**
 * 最小注册表（对应源码 SystemPrompt 类的 section() + assemble()）。
 * 真实实现基于 Cordis ScopedLayers 做 global/scope 两层注册（step-02 讲），
 * 这里先只做单层，聚焦"注册 + 排序 + 拼接"本身。
 */
class SectionRegistry {
  private readonly sections = new Map<string, PromptSection>()

  /** 注册一个 section；重复名直接 throw（防两个插件抢同一个槽位） */
  section(section: PromptSection): void {
    if (this.sections.has(section.name)) {
      throw new Error(
        `prompt section "${section.name}" is already registered (for a per-agent override, register through that agent's scope instead)`,
      )
    }
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    this.sections.set(section.name, section)
  }

  /** 一次装配：按 order 升序输出（对应源码 assemble() 排序，index.ts:504） */
  assemble(): PromptAssembly {
    const sections = [...this.sections.values()]
      .sort((a, b) => a.order - b.order)
      .map(section => ({ name: section.name, text: section.text }))
    return { sections }
  }
}

/** 渲染：逐段取文本 → 滤掉空段 → 空行拼接（对应源码 renderPrompt，index.ts:212-217） */
function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => section.text)
    .filter(text => text.length > 0)
    .join('\n\n')
}

function main(): void {
  console.log('🧩 Step 01 – 注册表：prompt 是"注册"出来的，不是手写一大坨字符串')
  console.log('='.repeat(56))

  // ========== 朴素版：一个巨大的模板字符串 ==========
  console.log('\n① 朴素版：一个巨型模板字符串，什么都写在一起')
  let naivePrompt = `You are an AI agent powered by DeepSeek Harness.
You are a senior frontend engineer. Follow the repository conventions.
Prefer filesystem tools over shell commands.`
  console.log(
    `   初始模板（3 行，身份/人格/工具指引混在一起）：\n   ${naivePrompt.replaceAll('\n', '\n   ')}`,
  )

  // 工具插件 A：想加一句"查命令成功要看 exit marker" → 直接改字符串
  naivePrompt += `\nVerify command success by checking the exit marker.`
  // 插件 B：也想加一句自己的指引 → 字符串拼接，覆盖不了 A 就插错位置
  naivePrompt = naivePrompt.replace(
    'You are a senior frontend engineer.',
    'You are a backend engineer. (B overwrote the persona!) You are a senior frontend engineer.',
  )
  console.log('   插件 A 加一句指引 → 插件 B 改人格段 → 输出：')
  console.log(`   ${naivePrompt.replaceAll('\n', '\n   ')}`)
  console.log('   💥 崩点 1：B 的改动让 A 的指引位置完全取决于"谁先改"——顺序靠运气')
  console.log('   💥 崩点 2：三块内容纠缠在一个字符串里，想删掉 B 的改动得全文搜索')

  // ========== harness 版：section 注册 + order 排序 ==========
  console.log('\n② harness 版：每个插件只注册自己名字下的 section')
  const registry = new SectionRegistry()
  // 乱序注册：工具指引先注册、身份最后注册——输出顺序不看注册顺序
  registry.section({
    name: 'toolbox:guidance',
    order: 100,
    text: 'Prefer filesystem tools over shell commands. Verify command success by checking the exit marker.',
  })
  registry.section({
    name: 'deployment:persona',
    order: 0,
    text: 'You are a senior frontend engineer. Follow the repository conventions.',
  })
  registry.section({
    name: 'harness:identity',
    order: -100,
    text: 'You are an AI agent powered by DeepSeek Harness.',
  })
  const assembly = registry.assemble()
  console.log(`   乱序注册 3 个 section，assemble() 后按 order 升序：`)
  for (const section of assembly.sections) {
    console.log(`   [${section.name.padEnd(22)}] order 决定位置，与注册顺序无关`)
  }
  console.log('   渲染结果（renderPrompt，空行连接）：')
  console.log(`   ${renderPrompt(assembly).replaceAll('\n', '\n   ')}`)
  console.log(
    '   ✅ 插件 A 加指引只动 toolbox:guidance，插件 B 改人格只动 deployment:persona——互不覆盖',
  )

  // ========== 防御 + 空段 ==========
  console.log('\n③ 防御：重复注册同名 section → throw（两个插件抢同一个槽位是错误）')
  try {
    const dup = new SectionRegistry()
    dup.section({ name: 'deployment:persona', order: 0, text: 'persona A' })
    dup.section({ name: 'deployment:persona', order: 0, text: 'persona B' })
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ ${(error as Error).message}`)
  }

  console.log('\n④ 空段滤除：注册一个空人格段，渲染时它消失（对应源码 renderPrompt 的 filter）')
  const emptyRegistry = new SectionRegistry()
  emptyRegistry.section({ name: 'harness:identity', order: -100, text: 'identity' })
  emptyRegistry.section({ name: 'deployment:persona', order: 0, text: '' }) // 空段！
  emptyRegistry.section({ name: 'toolbox:guidance', order: 100, text: 'guidance' })
  console.log(
    `   渲染文本：${JSON.stringify(renderPrompt(emptyRegistry.assemble()))}（persona 空段不在其中）`,
  )

  console.log(
    '\n🎯 一句话：注册表让每个插件只贡献自己的一块，顺序由 order 声明——prompt 从字符串手写变成积木拼装。',
  )
}

main()

export {}
