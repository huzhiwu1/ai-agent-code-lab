/**
 * Step 03 – waterfall 可改写 + complete 整体接管：专家插件怎么改写 prompt？
 *
 * 学习目标：注册表是"协作"机制，但协作总有需要"改写"或"包场"的场景——
 * 于是 SystemPrompt 提供两个逃生口：① `system-prompt/assemble` waterfall
 * （简化成函数数组），每个监听器可以改写整个装配结果，返回值权威；② complete
 * section：waterfall 跑完后强制恢复成"只有这一个 section"，多个 complete 同时
 * 激活直接 throw（防冲突）。同时引入工具 schema 收集：parameters 用
 * structuredClone 从 schema 上分离（参数不进 prompt 正文，走 tools 通道），
 * knownNames 用于区分"配置拼错工具名"和"工具在本 scope 被故意隐藏"。
 *
 * 对应源码：packages/core/system-prompt/src/index.ts:532-541（assemble 第 5 步
 *           waterfall + complete 恢复）
 *           index.ts:505-508（多个 complete section 同时激活 throw）
 *           index.ts:491-503（工具收集 + parameters 分离 + knownNames）
 *           index.ts:164-178（orderTools：重复列名/缺 <unlisted-tools>/未知名 三个防御）
 *
 * 跑法：pnpm run step:03（articles/dsh-context 目录内）或根目录 pnpm run context:step:03
 */

/** 工具 schema：name + description + parameters（参数走 tools 通道，不进正文） */
interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 工具排序配置的保留位：未列入的工具按字典序插在这里（index.ts:140） */
const TOOL_ORDER_REST = '<unlisted-tools>'

/** 装配结果：在 Step 02 基础上增加 tools（对应源码 PromptAssembly，index.ts:115-120） */
interface PromptAssembly {
  sections: { name: string; text: string }[]
  contexts: { name: string; text: string }[]
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
}

/** waterfall 监听器：接收当前 assembly，返回权威的改写结果 */
type AssemblyWaterfall = (assembly: PromptAssembly) => PromptAssembly

/**
 * 完整版注册表：Step 01 的 section + Step 02 的 scope/变量 + 本步的
 * tools/complete/waterfall。scope 链简化为单层（同 Step 02）。
 */
class SystemPromptRegistry {
  private readonly globalSections = new Map<string, PromptSection>()
  private readonly scopeSections = new Map<string, Map<string, PromptSection>>()
  private readonly globalTools: ToolProvider[] = []
  private readonly scopeTools = new Map<string, ToolProvider[]>()
  private readonly variables = new Map<string, VariableProvider>()
  private readonly waterfalls: AssemblyWaterfall[] = []

  section(section: PromptSection): void {
    if (this.globalSections.has(section.name))
      throw new Error(`prompt section "${section.name}" is already registered`)
    this.globalSections.set(section.name, section)
  }

  sectionFor(scope: string, section: PromptSection): void {
    let layer = this.scopeSections.get(scope)
    if (layer === undefined) {
      layer = new Map()
      this.scopeSections.set(scope, layer)
    }
    if (layer.has(section.name))
      throw new Error(`prompt section "${section.name}" is already registered in this scope`)
    layer.set(section.name, section)
  }

  variable(name: string, provider: VariableProvider): void {
    this.variables.set(name, provider)
  }

  /** 注册工具 schema provider（对应源码 tools()，index.ts:430-436） */
  tools(provider: ToolProvider): void {
    this.globalTools.push(provider)
  }

  /** 在某个 scope 注册工具 provider——global + scope 都贡献（index.ts:487-490） */
  toolsFor(scope: string, provider: ToolProvider): void {
    const list = this.scopeTools.get(scope)
    if (list === undefined) this.scopeTools.set(scope, [provider])
    else list.push(provider)
  }

  /** 注册 waterfall 监听器（对应源码 ctx.on('system-prompt/assemble')，index.ts:532-535） */
  onAssemble(listener: AssemblyWaterfall): void {
    this.waterfalls.push(listener)
  }

  /**
   * 一次完整装配（对应源码 assemble()，index.ts:467-542）：
   * 收集 → 排序 → 工具收集（参数分离 + knownNames）→ waterfall → complete 恢复。
   */
  assemble(context: AssembleContext = {}): PromptAssembly {
    const scope = context.scope
    // section 合并 + 排序
    const merged = new Map(this.globalSections)
    const scopeLayer = scope === undefined ? undefined : this.scopeSections.get(scope)
    if (scopeLayer !== undefined)
      for (const [name, section] of scopeLayer) merged.set(name, section)
    const sectionDefinitions = [...merged.values()].sort((a, b) => a.order - b.order)

    // complete 检测：多个 complete section 同时激活 → throw（index.ts:505-508）
    const completeSections = sectionDefinitions.filter(section => section.complete === true)
    if (completeSections.length > 1) {
      throw new Error(
        `multiple complete prompt sections are active: ${completeSections.map(section => JSON.stringify(section.name)).join(', ')}`,
      )
    }
    let completeSection: { name: string; text: string } | undefined
    const sections = sectionDefinitions.map(section => {
      const assembled = {
        name: section.name,
        text: typeof section.text === 'function' ? section.text(context) : section.text,
      }
      if (section.complete === true) completeSection = assembled
      return assembled
    })

    // 工具收集：每个 schema 的 parameters 做结构化克隆——参数定义从 schema 分离，
    // 走 tools 通道而不是 prompt 正文（index.ts:491-503）
    const providers = [...this.globalTools]
    if (scope !== undefined) providers.push(...(this.scopeTools.get(scope) ?? []))
    const collected: ToolSchema[] = []
    const knownNames = new Set<string>()
    for (const provider of providers) {
      const result = provider(context)
      for (const tool of result.schemas) {
        collected.push({ ...tool, parameters: structuredClone(tool.parameters) })
        knownNames.add(tool.name)
      }
      for (const name of result.knownNames ?? []) knownNames.add(name)
    }

    let assembly: PromptAssembly = {
      sections,
      contexts: [],
      tools: orderTools(collected, undefined, knownNames),
      variables: this.resolveVariables(context),
    }
    // waterfall：监听器依次改写，返回值权威（index.ts:532-535）
    for (const listener of this.waterfalls) assembly = listener(assembly)
    // complete 恢复：waterfall 之后强制只有这一个 section（index.ts:536-541）
    if (completeSection !== undefined) {
      assembly = { ...assembly, sections: [completeSection] }
    }
    return assembly
  }

  private resolveVariables(context: AssembleContext): Record<string, string | undefined> {
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.variables) variables[name] = provider(context)
    return variables
  }
}

/** 工具 provider：返回本 scope 可见的工具集 + 限制前的名字全集 */
interface ToolProviderResult {
  schemas: ToolSchema[]
  knownNames?: string[]
}

type ToolProvider = (context: AssembleContext) => ToolProviderResult

interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  /** 设为 true：这个 section 就是完整 prompt，waterfall 后强制恢复成只有它 */
  readonly complete?: boolean
}

type VariableProvider = (context: AssembleContext) => string | undefined

interface AssembleContext {
  scope?: string
}

/**
 * 工具排序（对应源码 orderTools，index.ts:164-178）。三个防御点：
 * ① toolOrder 重复列工具名 → throw；② 必须含 <unlisted-tools> 保留位 → throw；
 * ③ 配置了未注册的工具名 → 用 knownNames 判断并 throw（拼错名字立刻暴露）。
 * 演示简化：不实现自定义 toolOrder，只保留"纯字典序 + 保留名冲突"防御。
 */
function orderTools(
  tools: ToolSchema[],
  toolOrder: string[] | undefined,
  knownNames: ReadonlySet<string>,
): ToolSchema[] {
  const reserved = tools.find(tool => tool.name === TOOL_ORDER_REST)
  if (reserved !== undefined) {
    throw new Error(
      `tool provider returned reserved tool name "${TOOL_ORDER_REST}" (reserved for toolOrder's rest entry)`,
    )
  }
  if (toolOrder === undefined)
    return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const unknown = toolOrder.filter(name => name !== TOOL_ORDER_REST && !knownNames.has(name))
  if (unknown.length > 0) {
    throw new Error(
      `toolOrder lists unregistered tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}; known tools: ${[...knownNames].sort().join(', ') || '(none)'}`,
    )
  }
  const listed = new Set(toolOrder)
  const rest = tools
    .filter(tool => !listed.has(tool.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return toolOrder.flatMap(name =>
    name === TOOL_ORDER_REST ? rest : tools.filter(tool => tool.name === name),
  )
}

function main(): void {
  const registry = new SystemPromptRegistry()
  const personality = {
    name: 'deployment:persona',
    order: 0,
    text: 'You are a careful agent. Always explain your reasoning step by step.',
  }
  registry.section({
    name: 'harness:identity',
    order: -100,
    text: 'You are an AI agent powered by DeepSeek Harness.',
  })
  registry.section(personality)
  registry.section({ name: 'toolbox:guidance', order: 100, text: 'Prefer built-in tools.' })

  console.log('🪄 Step 03：waterfall 可改写 + complete 整体接管 + 工具收集')
  console.log('-------------------------------------------------------')

  // ① waterfall：专家插件把人格段替换成自己的版本
  console.log('① waterfall：一个"前端专家插件"改写 deployment:persona 段：')
  registry.onAssemble(assembly => ({
    ...assembly,
    sections: assembly.sections.map(section =>
      section.name === 'deployment:persona'
        ? { ...section, text: 'You are a senior frontend engineer. (rewritten by expert plugin)' }
        : section,
    ),
  }))
  console.log('   改写后 persona 段：')
  const rewritten = registry
    .assemble()
    .sections.find(section => section.name === 'deployment:persona')!
  console.log(`   → ${rewritten.text}`)

  // ② complete：包场后其他 section 全部消失（工具和上下文仍然装配，只是 sections 被替换）
  console.log('\n② complete section 包场：注册 complete 段后，其他 section 全部消失：')
  const completeRegistry = new SystemPromptRegistry()
  completeRegistry.section({ name: 'harness:identity', order: -100, text: 'identity' })
  completeRegistry.section({ name: 'deployment:persona', order: 0, text: 'persona' })
  completeRegistry.section({ name: 'toolbox:guidance', order: 100, text: 'guidance' })
  completeRegistry.section({
    name: 'vendor:takeover',
    order: 999,
    text: 'You are the vendor model. This is the ONLY section that matters.',
    complete: true,
  })
  const completeAssembly = completeRegistry.assemble()
  console.log(`   装配后 sections 数量：${completeAssembly.sections.length}（只剩 complete 段）`)
  console.log(`   → ${completeAssembly.sections[0]!.name}: ${completeAssembly.sections[0]!.text}`)

  // ③ 两个 complete 同时激活 → throw（防冲突：谁包场必须唯一）
  console.log('\n③ 防御：两个 complete section 同时激活 → throw：')
  try {
    const conflict = new SystemPromptRegistry()
    conflict.section({ name: 'a:complete', order: 1, text: 'A', complete: true })
    conflict.section({ name: 'b:complete', order: 2, text: 'B', complete: true })
    conflict.assemble()
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ ${(error as Error).message}`)
  }

  // ④ 工具收集：parameters 分离（不进正文，走 tools 通道）+ 字典序
  console.log('\n④ 工具收集：parameters 用 structuredClone 分离，tools 按字典序：')
  const toolsRegistry = new SystemPromptRegistry()
  toolsRegistry.tools(() => ({
    schemas: [
      {
        name: 'read_file',
        description: 'Read a file from disk',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
      {
        name: 'edit_file',
        description: 'Edit a file on disk',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
    ],
  }))
  const toolsAssembly = toolsRegistry.assemble()
  console.log(
    `   工具顺序：${toolsAssembly.tools.map(tool => tool.name).join(' → ')}（字典序，无 toolOrder 配置）`,
  )
  console.log(
    `   参数与正文分离：sections 里没有任何 parameters JSON（正文 = ${JSON.stringify(toolsAssembly.sections.map(s => s.name))}）`,
  )
  const secondAssembly = toolsRegistry.assemble()
  const cloneCheck = toolsAssembly.tools[0]!.parameters !== secondAssembly.tools[0]!.parameters
  console.log(`   每次装配都是新克隆（结构共享被切断）：${cloneCheck ? '✅ 是' : '❌ 否'}`)

  // ⑤ 防御：toolOrder 配置拼错工具名 → knownNames 判断并 throw
  console.log('\n⑤ 防御：toolOrder 配置了未注册的工具名 → knownNames 拦截：')
  try {
    orderTools(
      [{ name: 'read_file', description: 'r', parameters: {} }],
      ['read_file', 'read_flie', TOOL_ORDER_REST], // 拼错的 read_flie！
      new Set(['read_file']),
    )
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ ${(error as Error).message}`)
    console.log('   注释：knownNames 是"限制前的名字全集"——区分拼错配置 vs 本 scope 故意隐藏工具。')
  }

  console.log(
    '\n小结：waterfall 让专家插件有权改写整个装配（返回值权威）；complete 提供"整个 prompt 我包了"' +
      '的唯一性逃生口；工具 parameters 走独立通道 + knownNames 让排序配置错误立刻暴露。',
  )
}

main()

export {}
