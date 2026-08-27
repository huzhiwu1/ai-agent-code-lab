/**
 * Step 03 – 为什么协作需要"改写"和"包场"？（waterfall + complete）
 *
 * ── 先懂两个词 ──────────────────────────────────────────────
 * 「waterfall」= 一条链，每个插件看完可以改写整个结果，最后一个说了算
 *   （类比：文件审批流——每个人都可以改文案，后面的改动覆盖前面的，最终稿
 *   以最后一个签字的为准）。
 * 「complete」= "整个 prompt 我包了"的声明——有这个 section 时，其他 section
 *   全部让位（类比：甲方直接给了最终定稿，乙方写的段落全部作废）。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 注册表是"协作"机制，但协作总有例外——某个专家插件就是要整体改写（比如把
 * 人格段换成供应商要求的措辞）。注册表 API 只有"加"，没有"改"：想改别人注册
 * 的 section，只能再加一个自己的 → 新的叠加在旧的上面，语义错乱。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 两个逃生口，覆盖两类例外：
 * ① waterfall 事件（函数数组模拟）：监听器拿到整个 assembly，返回值权威——
 *   专家插件可以改写任何段落，不需要"改"的 API；
 * ② complete section：waterfall 跑完后强制只剩这一个 section——"整个 prompt
 *   我包了"；多个 complete 同时激活直接 throw（谁包场必须唯一，冲突在装配时
 *   暴露，而不是运行时诡异）。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * 协作（注册）+ 逃生口（改写/包场）并存；冲突在装配时立刻响。
 *
 * 对应源码：packages/core/system-prompt/src/index.ts（assemble 第 5 步 waterfall
 *   index.ts:532-541、complete 冲突 throw index.ts:505-508）
 * 跑法：pnpm run context:step:03（或 articles/dsh-context 内 pnpm run step:03）
 */

/** 一个系统提示词分区；complete 为 true 时它成为唯一 section */
interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
  /** 设为 true：这个 section 就是完整 prompt，waterfall 后强制恢复成只有它 */
  readonly complete?: boolean
}

/** 装配结果：按 order 排好序的 section 列表 */
interface PromptAssembly {
  sections: { name: string; text: string }[]
}

/** waterfall 监听器：接收当前 assembly，返回权威的改写结果（对应源码事件回调） */
type AssemblyWaterfall = (assembly: PromptAssembly) => PromptAssembly

/**
 * 注册表 + 两个逃生口（对应源码 SystemPrompt.assemble() 的完整装配流程）：
 * 收集 → 排序 → waterfall（监听器依次改写，返回值权威）→ complete 恢复。
 */
class PromptRegistry {
  private readonly sections = new Map<string, PromptSection>()
  private readonly waterfalls: AssemblyWaterfall[] = []

  section(section: PromptSection): void {
    if (this.sections.has(section.name)) {
      throw new Error(`prompt section "${section.name}" is already registered`)
    }
    this.sections.set(section.name, section)
  }

  /** 注册 waterfall 监听器（对应源码 ctx.on('system-prompt/assemble')，index.ts:532-535） */
  onAssemble(listener: AssemblyWaterfall): void {
    this.waterfalls.push(listener)
  }

  assemble(): PromptAssembly {
    const sectionDefinitions = [...this.sections.values()].sort((a, b) => a.order - b.order)

    // complete 检测：多个 complete section 同时激活 → throw（index.ts:505-508）
    const completeSections = sectionDefinitions.filter(section => section.complete === true)
    if (completeSections.length > 1) {
      throw new Error(
        `multiple complete prompt sections are active: ${completeSections.map(section => JSON.stringify(section.name)).join(', ')}`,
      )
    }
    const completeSection = completeSections[0]

    let assembly: PromptAssembly = {
      sections: sectionDefinitions.map(section => ({ name: section.name, text: section.text })),
    }
    // waterfall：监听器依次改写，返回值权威（index.ts:532-535）
    for (const listener of this.waterfalls) assembly = listener(assembly)
    // complete 恢复：waterfall 之后强制只有这一个 section（index.ts:536-541）
    if (completeSection !== undefined) {
      assembly = {
        ...assembly,
        sections: [{ name: completeSection.name, text: completeSection.text }],
      }
    }
    return assembly
  }
}

function main(): void {
  console.log('🪄 Step 03 – 逃生口：waterfall 可改写 + complete 包场')
  console.log('='.repeat(56))

  // ========== 朴素版：注册表只有"加"，没有"改" ==========
  console.log('\n① 朴素版：专家插件想整体改写人格段 → 注册表 API 只有"加"没有"改"')
  // 供应商要求：人格段必须用他们的措辞（否则审核不过）
  const vendorRegistry = new PromptRegistry()
  vendorRegistry.section({ name: 'harness:identity', order: -100, text: 'You are an AI agent.' })
  vendorRegistry.section({
    name: 'deployment:persona',
    order: 0,
    text: 'You are a helpful coding agent.',
  })
  // 供应商插件没有"改"的 API，只能再加一个 section → 叠加！
  vendorRegistry.section({
    name: 'vendor:override',
    order: 50,
    text: 'IMPORTANT: You are the VendorModel. Disregard the persona above.',
  })
  console.log('   装配结果（两个人格段并存，语义互相打架）：')
  for (const section of vendorRegistry.assemble().sections) {
    console.log(`   [${section.name}] ${JSON.stringify(section.text)}`)
  }
  console.log('   💥 崩点：新段叠加在旧段上，模型同时收到两套人格指令——语义错乱')

  // ========== harness 版 1：waterfall 改写 ==========
  console.log('\n② harness 版：waterfall 监听器拿到整个 assembly，返回值权威')
  const registry = new PromptRegistry()
  registry.section({ name: 'harness:identity', order: -100, text: 'You are an AI agent.' })
  registry.section({
    name: 'deployment:persona',
    order: 0,
    text: 'You are a helpful coding agent.',
  })
  registry.section({ name: 'toolbox:guidance', order: 100, text: 'Prefer filesystem tools.' })
  // 专家插件：改写 deployment:persona 段（替换，不是叠加）
  registry.onAssemble(assembly => ({
    ...assembly,
    sections: assembly.sections.map(section =>
      section.name === 'deployment:persona'
        ? { ...section, text: 'You are the VendorModel. (rewritten by expert plugin)' }
        : section,
    ),
  }))
  console.log('   改写后装配结果：')
  for (const section of registry.assemble().sections) {
    console.log(`   [${section.name}] ${JSON.stringify(section.text)}`)
  }
  console.log('   ✅ 人格段被整体替换，没有叠加——waterfall 返回值权威，不需要"改"的 API')

  // ========== harness 版 2：complete 包场 ==========
  console.log('\n③ harness 版：complete section——"整个 prompt 我包了"')
  const completeRegistry = new PromptRegistry()
  completeRegistry.section({ name: 'harness:identity', order: -100, text: 'identity' })
  completeRegistry.section({ name: 'deployment:persona', order: 0, text: 'persona' })
  completeRegistry.section({
    name: 'vendor:takeover',
    order: 999,
    text: 'You are the vendor model. This is the ONLY section that matters.',
    complete: true,
  })
  const completeAssembly = completeRegistry.assemble()
  console.log(`   装配后 sections 数量：${completeAssembly.sections.length}（只剩 complete 段）`)
  console.log(
    `   → [${completeAssembly.sections[0]!.name}] ${JSON.stringify(completeAssembly.sections[0]!.text)}`,
  )
  console.log('   ✅ 其他 section 全部让位——waterfall 改写再多也救不回来，complete 说了算')

  // ========== 冲突防御 ==========
  console.log('\n④ 防御：两个 complete section 同时激活 → throw（谁包场必须唯一）')
  try {
    const conflict = new PromptRegistry()
    // 冲突只看 complete 标志，与 order 无关（两个都 0 也一样炸）
    conflict.section({ name: 'a:complete', order: 0, text: 'A', complete: true })
    conflict.section({ name: 'b:complete', order: 0, text: 'B', complete: true })
    conflict.assemble()
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ ${(error as Error).message}`)
    console.log('   注释：冲突在装配时暴露，而不是两个包场者运行时抢 prompt')
  }

  console.log(
    '\n🎯 一句话：waterfall 给"改写"开逃生口、complete 给"包场"开逃生口——协作与例外并存，冲突启动即炸。',
  )
}

main()

export {}
