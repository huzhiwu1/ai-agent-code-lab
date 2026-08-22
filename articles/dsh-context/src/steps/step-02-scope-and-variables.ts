/**
 * Step 02 – scope 遮蔽 + 严格变量插值：每个 agent 怎么有自己的 prompt？
 *
 * 学习目标：上一步的注册表只有一层，但生产环境有 global（部署人格）和 scope
 * （每个 agent）两层——scope 层注册的同名 section/variable 遮蔽 global 层，
 * 这就是"子代理装不同人格"的机制基础。另外引入 `{{name}}` 变量插值，且是
 * 严格模式：未知变量、provider 返回 undefined、畸形引用都直接 throw——
 * `{{modle}}` 这种 typo 会在渲染时立刻炸掉，而不是静默发给模型等审阅才发现
 * （"这是作者错误，我们希望它响"）。
 *
 * 对应源码：packages/core/system-prompt/src/index.ts:467-482（assemble 变量合并：
 *           先 global 再 scope 链，最近的 scope 同名变量胜出）
 *           index.ts:484（ScopedLayers.merge：scope 层同名 section 遮蔽 global）
 *           index.ts:258-295（interpolate 严格模式四种 throw + 孤立 {{ 字面量 +
 *           替换值不二次扫描）
 *
 * 跑法：pnpm run step:02（articles/dsh-context 目录内）或根目录 pnpm run context:step:02
 */

/** 一个系统提示词分区（同 Step 01；text 可以是静态文本或按装配上下文求值的 provider） */
interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
}

/** 变量 provider：每次装配时求值，返回 undefined 表示"注册了但本轮没有值" */
type VariableProvider = (context: AssembleContext) => string | undefined

/** 装配上下文：scope 键 + 信号（简化；真实还有 AbortSignal，见源码 AssembleContext） */
interface AssembleContext {
  scope?: string
}

/**
 * 两层注册表：global + 若干 scope（对应源码 ScopedLayers，index.ts:347-350）。
 * 简化：scope 链只支持一层（真实是 scope 链，从远到近覆盖，原理相同）。
 */
class SystemPromptRegistry {
  /** global 层：部署人格、内置变量等全 agent 共享的注册 */
  private readonly globalSections = new Map<string, PromptSection>()
  private readonly globalVariables = new Map<string, VariableProvider>()
  /** scope 层：每个 agent 自己的注册，遮蔽 global 同名项 */
  private readonly scopeSections = new Map<string, Map<string, PromptSection>>()
  private readonly scopeVariables = new Map<string, Map<string, VariableProvider>>()

  /** 在 global 层注册 section（对应源码 this.section() 在全局 ctx 上调用） */
  section(section: PromptSection): void {
    assertNew(this.globalSections, section.name, 'prompt section')
    this.globalSections.set(section.name, section)
  }

  /** 在某个 scope 注册 section——同名遮蔽 global（对应源码：agent 的 ctx 上调用 section()） */
  sectionFor(scope: string, section: PromptSection): void {
    const layer = layerFor(this.scopeSections, scope)
    assertNew(layer, section.name, 'prompt section')
    layer.set(section.name, section)
  }

  /** 在 global 层注册变量（对应源码 variable()，index.ts:446-455） */
  variable(name: string, provider: VariableProvider): void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(
        `invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`,
      )
    }
    if (this.globalVariables.has(name))
      throw new Error(`prompt variable "${name}" is already registered`)
    this.globalVariables.set(name, provider)
  }

  /** 在某个 scope 注册变量——同名遮蔽 global（对应源码：agent ctx 上调用 variable()） */
  variableFor(scope: string, name: string, provider: VariableProvider): void {
    const layer = layerFor(this.scopeVariables, scope)
    if (layer.has(name))
      throw new Error(`prompt variable "${name}" is already registered in this scope`)
    layer.set(name, provider)
  }

  /**
   * 一次装配（对应源码 assemble()，index.ts:467-542 的前两步）：
   * 1) 变量合并：先 global 全部求值，再 scope 覆盖——最近的 scope 同名变量胜出；
   * 2) section 合并：scope 层遮蔽 global 同名 section，再按 order 排序。
   */
  assemble(context: AssembleContext = {}): PromptAssembly {
    const scope = context.scope
    // ① 变量合并：global 先，scope 后覆盖（index.ts:473-482）
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.globalVariables) variables[name] = provider(context)
    if (scope !== undefined) {
      const layer = this.scopeVariables.get(scope)
      if (layer !== undefined) {
        for (const [name, provider] of layer) variables[name] = provider(context)
      }
    }
    // ② section 合并：scope 遮蔽 global（index.ts:484 merge）
    const merged = new Map(this.globalSections)
    if (scope !== undefined) {
      const layer = this.scopeSections.get(scope)
      if (layer !== undefined) {
        for (const [name, section] of layer) merged.set(name, section)
      }
    }
    const sections = [...merged.values()]
      .sort((a, b) => a.order - b.order)
      .map(section => ({
        name: section.name,
        text: typeof section.text === 'function' ? section.text(context) : section.text,
      }))
    return { sections, variables }
  }
}

/** 装配结果：排好序的 section + 已解析的变量表（对应源码 PromptAssembly） */
interface PromptAssembly {
  sections: { name: string; text: string }[]
  variables: Record<string, string | undefined>
}

/** 变量名的合法形态：`^[a-z][a-z0-9_]*$`（index.ts:134） */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** 扫描位置上的完整 `{{...}}` 引用组（index.ts:137） */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/**
 * 严格插值（对应源码 interpolate，index.ts:258-295）。逐字符扫描 `{{`：
 * - `{{` 后面有 `}}` 但中间不合法（空名、含空格、大小写不对）→ throw；
 * - 引用了未注册变量（Object.hasOwn 防原型链污染）→ throw；
 * - 变量注册了但 provider 返回 undefined → throw；
 * - `{{` 后面完全没有 `}}` → 当作字面量正文原样保留（可能是用户写的模板代码）；
 * - 替换后的值不再二次扫描（防递归展开）。
 */
function interpolate(
  text: string,
  variables: Record<string, string | undefined>,
  owner: string,
): string {
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      // 后面有 `}}` 但匹配不上 → 畸形（如 `{{a b}}`）；完全没 `}}` → 字面量
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(
          `malformed prompt variable reference at "${text.slice(open, open + 16)}…" in "${owner}" (references are complete simple {{name}} groups)`,
        )
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2) // 去掉 `{{` 和 `}}`
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(
        `malformed prompt variable reference "{{${name}}}" in "${owner}" (variable names match ${String(VARIABLE_NAME)})`,
      )
    }
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(
        `unknown prompt variable "{{${name}}}" in "${owner}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`,
      )
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly ("${owner}")`)
    }
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

/**
 * 渲染：插值 → 滤空段 → 空行拼接（对应源码 renderPrompt，index.ts:212-217，
 * 这一步开始带真实插值）。
 */
function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => interpolate(section.text, assembly.variables, section.name))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/** 取某 scope 的注册层，不存在则创建（对应源码 ScopedLayers 的按需建层） */
function layerFor<T>(map: Map<string, Map<string, T>>, scope: string): Map<string, T> {
  let layer = map.get(scope)
  if (layer === undefined) {
    layer = new Map()
    map.set(scope, layer)
  }
  return layer
}

/** 重复注册防御（对应源码 NamedEntries，index.ts:315-325） */
function assertNew(layer: Map<string, unknown>, name: string, kind: string): void {
  if (layer.has(name)) {
    throw new Error(
      `${kind} "${name}" is already registered (for a per-agent override, register through that agent's scope instead)`,
    )
  }
}

function main(): void {
  const registry = new SystemPromptRegistry()

  console.log('🔭 Step 02：scope 遮蔽 + 严格变量插值')
  console.log('-------------------------------------')

  // ① global 层：部署人格（含 {{model}} / {{cwd}} 变量引用）+ 内置变量
  console.log('① global 层注册：部署人格 section + {{model}}/{{cwd}} 变量')
  registry.section({
    name: 'harness:identity',
    order: -100,
    text: 'You are an AI agent powered by DeepSeek Harness.',
  })
  registry.section({
    name: 'deployment:persona',
    order: 0,
    text: 'You are a general-purpose coding agent running as {{model}}. Working directory: {{cwd}}.',
  })
  registry.variable('model', () => 'deepseek-chat')
  registry.variable('cwd', () => '/home/user/project')

  // ② scope 层：agent "frontend-expert" 注册同名 persona section——遮蔽 global
  console.log('\n② scope 层注册：agent "frontend-expert" 用同名 deployment:persona 遮蔽 global')
  registry.sectionFor('frontend-expert', {
    name: 'deployment:persona',
    order: 0,
    text: 'You are a senior frontend engineer working in {{cwd}}. Follow the repo conventions strictly.',
  })
  registry.variableFor('frontend-expert', 'model', () => 'deepseek-coder')

  // ③ 装配对比：global 视角 vs scope 视角
  console.log('\n③ assemble() 对比——同一注册表，两种 scope，两个不同的 prompt：')
  for (const scope of [undefined, 'frontend-expert'] as const) {
    const label = scope === undefined ? 'global（部署默认）' : `scope=${scope}`
    const assembly = registry.assemble(scope === undefined ? {} : { scope })
    console.log(`   --- ${label} ---`)
    for (const section of assembly.sections) {
      console.log(`   [${section.name}]`)
      console.log(`     ${section.text}`)
    }
    console.log(`   → 渲染（{{model}}/{{cwd}} 已插值）：`)
    console.log(`     ${renderPrompt(assembly).replaceAll('\n', '\n     ')}`)
  }

  // ④ 严格插值：{{modle}} typo → 立即 throw
  console.log('\n④ 严格插值：未知变量 {{modle}}（typo）→ 渲染时立即 throw：')
  const typos = new SystemPromptRegistry()
  typos.variable('model', () => 'deepseek-chat')
  typos.section({ name: 'persona', order: 0, text: 'Running as {{modle}}.' })
  try {
    renderPrompt(typos.assemble())
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ ${(error as Error).message}`)
    console.log(
      '   注释：宽松模式会把 {{modle}} 原样发给模型，直到审阅 transcript 才发现；严格模式让作者错误立刻响。',
    )
  }

  // ⑤ provider 返回 undefined → throw（变量注册了，但本轮没有值）
  console.log('\n⑤ provider 返回 undefined（注册了但本轮无值）→ throw：')
  const undefinedValue = new SystemPromptRegistry()
  undefinedValue.variable('token', () => undefined)
  undefinedValue.section({ name: 'persona', order: 0, text: 'Budget: {{token}}' })
  try {
    renderPrompt(undefinedValue.assemble())
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ ${(error as Error).message}`)
  }

  // ⑥ 畸形引用三连：{{}} / {{a b}} / 大写开头的 {{Model}}
  console.log('\n⑥ 畸形引用：{{}}、{{a b}}、{{Model}} 全部 throw：')
  for (const bad of ['{{}}', '{{a b}}', '{{Model}}']) {
    const malformed = new SystemPromptRegistry()
    malformed.variable('model', () => 'deepseek-chat')
    malformed.section({ name: 'persona', order: 0, text: `Run: ${bad}` })
    try {
      renderPrompt(malformed.assemble())
      console.log(`   ${bad} → 未抛出？`)
    } catch (error) {
      console.log(`   ${bad} → ✅ ${(error as Error).message}`)
    }
  }

  // ⑦ 边界：孤立 {{（后面没有 }}）是字面量正文；替换值不二次扫描
  console.log('\n⑦ 边界：孤立 {{ 是字面量；替换值不二次扫描：')
  const edge = new SystemPromptRegistry()
  edge.variable('model', () => 'deepseek-chat')
  edge.variable('nested', () => '{{model}}') // 值里含 {{model}}
  edge.section({
    name: 'persona',
    order: 0,
    text: 'Render {{nested}} verbatim; literal brace: {{ not closed.',
  })
  console.log(`   → 渲染：${JSON.stringify(renderPrompt(edge.assemble()))}`)
  console.log('   （{{model}} 没有再次展开——替换值只拼进去，不再扫描，防递归）')

  console.log(
    '\n小结：两层注册（scope 遮蔽 global）= per-agent prompt 的机制基础；严格插值把 typo/未定义/畸形引用' +
      '全部拦截在渲染时，唯一豁免是孤立 {{ 字面量与不二次扫描。',
  )
}

main()

export {}
