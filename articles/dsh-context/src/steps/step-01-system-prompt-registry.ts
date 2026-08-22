/**
 * Step 01 – 最小 SystemPrompt 注册表：静态 prompt 是怎么拼出来的？
 *
 * 学习目标：把"手写一大坨 prompt 字符串"替换成"分区注册 + order 排序"。
 * 系统提示词被拆成一个个有名字的 section（身份段 -100 / 人格段 0 / 工具指引段
 * 100-199），注册时乱序无所谓，装配时按 order 升序输出；空段被滤掉、段落之间
 * 用空行连接。生产级 Agent 的 prompt 因此可以增量拼装：装载/卸载一个插件，
 * 只增删它自己的 section，绝不手改整段字符串。
 *
 * 对应源码：packages/core/system-prompt/src/index.ts:190-205（构造器内置两个
 *           内置 section：harness:identity order -100 + deployment:persona order 0）
 *           index.ts:212-217（renderPrompt：插值 → 滤空段 → 空行拼接）
 *           index.ts:381-390（section() 注册：重复名 throw、非有限 order throw）
 *
 * 跑法：pnpm run step:01（articles/dsh-context 目录内）或根目录 pnpm run context:step:01
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
 * 真实实现基于 Cordis ScopedLayers 做 global/scope 两层注册（下一步演示），
 * 这里先只做单层，聚焦"注册 + 排序 + 拼接"本身。
 */
class SystemPromptRegistry {
  private readonly sections = new Map<string, PromptSection>()

  /** 注册一个 section；重复名或非有限 order 直接 throw（对应源码 index.ts:381-390） */
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

  /**
   * 一次装配：按 order 升序输出（对应源码 assemble() 第 4 步排序，
   * index.ts:504：`[...sectionByName.values()].sort((a, b) => a.order - b.order)`）。
   * 这里简化成同步纯函数——真实实现还有变量合并/工具收集/waterfall，后续步骤补。
   */
  assemble(): PromptAssembly {
    const sections = [...this.sections.values()]
      .sort((a, b) => a.order - b.order)
      .map(section => ({ name: section.name, text: section.text }))
    return { sections }
  }
}

/**
 * 渲染：逐段取文本 → 滤掉空段 → 空行拼接（对应源码 renderPrompt，
 * index.ts:212-217。真实的 renderPrompt 还要先做 {{变量}} 插值，下一步演示）。
 */
function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => section.text)
    .filter(text => text.length > 0)
    .join('\n\n')
}

function main(): void {
  const registry = new SystemPromptRegistry()

  console.log('🧩 第 1 层：SystemPrompt 注册表——静态 prompt 是"注册"出来的')
  console.log('------------------------------------------------------')

  // ① 乱序注册三个 section：身份（-100）/ 人格（0）/ 工具指引（100）
  console.log('① 乱序注册三个 section（身份 -100 / 人格 0 / 工具指引 100）：')
  const registered: PromptSection[] = []
  registered.push({
    name: 'deployment:persona',
    order: 0,
    text: 'You are a senior frontend engineer. Follow the repository conventions.',
  })
  registry.section(registered[0]!)
  registered.push({
    name: 'harness:identity',
    order: -100,
    text: 'You are an AI agent powered by DeepSeek Harness.',
  })
  registry.section(registered[1]!)
  registered.push({
    name: 'toolbox:guidance',
    order: 100,
    text: 'Prefer filesystem tools over shell commands. Verify command success by checking the exit marker.',
  })
  registry.section(registered[2]!)
  for (const section of registered) {
    console.log(`   注册: [${section.name.padEnd(22)}] order=${String(section.order).padStart(4)}`)
  }
  // 注意：上面是"乱序注册"——先注册人格、再注册身份，但输出必须按 order 来
  const assembly = registry.assemble()
  console.log('   assemble() 后 sections 顺序（按 order 升序）：')
  for (const section of assembly.sections) {
    console.log(`   [${section.name.padEnd(22)}]`)
  }

  // ② renderPrompt：拼接成一段可发给模型的 system prompt
  console.log('\n② renderPrompt() 拼接结果（空行连接）：')
  console.log('   ' + renderPrompt(assembly).replaceAll('\n', '\n   '))

  // ③ 空段被滤掉：人格段是空字符串时不进正文（对应源码 renderPrompt 的 filter）
  console.log('\n③ 空段滤除：注册一个空人格段，渲染时它消失：')
  const emptyRegistry = new SystemPromptRegistry()
  emptyRegistry.section({ name: 'harness:identity', order: -100, text: 'identity' })
  emptyRegistry.section({ name: 'deployment:persona', order: 0, text: '' }) // 空段！
  emptyRegistry.section({ name: 'toolbox:guidance', order: 100, text: 'guidance' })
  const rendered = renderPrompt(emptyRegistry.assemble())
  console.log(`   渲染文本：${JSON.stringify(rendered)}（persona 空段不在其中）`)

  // ④ 防御：重复注册同名 section → throw
  console.log('\n④ 防御：重复注册同名 section → throw（防两个插件抢同一个槽位）')
  try {
    const dup = new SystemPromptRegistry()
    dup.section({ name: 'deployment:persona', order: 0, text: 'persona A' })
    dup.section({ name: 'deployment:persona', order: 0, text: 'persona B' })
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ ${(error as Error).message}`)
  }

  // ⑤ 防御：非有限 order → throw（排序配置不能静默失效）
  console.log('\n⑤ 防御：非有限 order（NaN）→ throw')
  try {
    const bad = new SystemPromptRegistry()
    bad.section({ name: 'x', order: Number.NaN, text: 'x' })
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ ${(error as Error).message}`)
  }

  console.log(
    '\n小结：prompt = 命名分区注册表 + order 排序 + 拼接渲染；空段过滤、重复名/非法 order 报错，' +
      '都是为了让"拼 prompt"成为可组合、可防御的工程而不是字符串手写。',
  )
}

main()

export {}
