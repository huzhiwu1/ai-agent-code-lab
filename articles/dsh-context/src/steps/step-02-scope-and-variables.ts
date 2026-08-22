/**
 * Step 02 – 为什么每个 agent 可以有自己的人格？为什么变量 typo 必须炸？
 *
 * ── 先懂三个词 ──────────────────────────────────────────────
 * 「scope」= 每个 agent 自己的小抽屉——往抽屉里放的 section/variable 只对那个
 *   agent 生效，还能遮蔽（shadow）全局同名项（类比：办公室每个人有自己带锁的
 *   抽屉，抽屉里贴的便签不会影响别人桌上的便签）。
 * 「变量」= `{{name}}` 这种占位符，装配时替换成真实值（如 `{{model}}` → 实际模型名）。
 * 「插值」= 把占位符替换成值的动作。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 新手做法 1：全局只有一个 prompt。子代理想装"前端专家"人格 → 直接改全局
 *   字符串 → 污染了所有 agent（部署人格被永久替换）。
 * 新手做法 2：宽松插值。`{{modle}}` 这种 typo 原样保留（或替换为空）静默发给
 *   模型——直到审阅 transcript 才发现，错得很贵。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * ① 注册分 global / scope 两层：scope 层同名 section/variable 遮蔽 global 层，
 *   子代理注册同名 `deployment:persona` 就 shadow 掉全局人格——这是 per-agent
 *   prompt 的机制基础，谁也不污染谁。
 * ② 插值必须严格：未知变量、provider 返回 undefined、畸形引用直接 throw——
 *   `{{modle}}` 在渲染时立刻炸掉（"这是作者错误，我们希望它响"）。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * per-agent prompt 成为可能（子代理装人格不再污染全局）；作者错误在渲染时响，
 * 而不是静默污染模型直到审阅才发现。
 *
 * 对应源码：packages/core/system-prompt/src/index.ts（ScopedLayers 遮蔽 index.ts:484、
 *   变量合并 index.ts:473-482、interpolate 严格模式 index.ts:258-295）
 * 跑法：pnpm run context:step:02（或 articles/dsh-context 内 pnpm run step:02）
 */

/** 一个系统提示词分区（text 可以是静态文本或按装配上下文求值的 provider） */
interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
}

/** 变量 provider：每次装配时求值，返回 undefined 表示"注册了但本轮没有值" */
type VariableProvider = (context: AssembleContext) => string | undefined

/** 装配上下文：scope 键（真实还有 AbortSignal，见源码 AssembleContext） */
interface AssembleContext {
  scope?: string
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
 * 两层注册表：global + 若干 scope（对应源码 ScopedLayers，index.ts:347-350）。
 * scope 层注册的同名 section/variable 遮蔽 global 层——"近层胜出"。
 * 简化：scope 链只支持一层（真实是链，从远到近覆盖，原理相同）。
 */
class ScopeRegistry {
  private readonly globalSections = new Map<string, PromptSection>()
  private readonly globalVariables = new Map<string, VariableProvider>()
  private readonly scopeSections = new Map<string, Map<string, PromptSection>>()
  private readonly scopeVariables = new Map<string, Map<string, VariableProvider>>()

  /** global 层注册 section（对应源码 this.section() 在全局 ctx 上调用） */
  section(section: PromptSection): void {
    assertNew(this.globalSections, section.name, 'prompt section')
    this.globalSections.set(section.name, section)
  }

  /** 在某 scope 注册 section——同名遮蔽 global（对应源码：agent 的 ctx 上调用） */
  sectionFor(scope: string, section: PromptSection): void {
    const layer = layerFor(this.scopeSections, scope)
    assertNew(layer, section.name, 'prompt section')
    layer.set(section.name, section)
  }

  /** global 层注册变量（对应源码 variable()，index.ts:446-455） */
  variable(name: string, provider: VariableProvider): void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(
        `invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`,
      )
    }
    assertNew(this.globalVariables, name, 'prompt variable')
    this.globalVariables.set(name, provider)
  }

  /** 在某 scope 注册变量——同名遮蔽 global */
  variableFor(scope: string, name: string, provider: VariableProvider): void {
    const layer = layerFor(this.scopeVariables, scope)
    assertNew(layer, name, 'prompt variable')
    layer.set(name, provider)
  }

  /**
   * 一次装配（对应源码 assemble() 前两步，index.ts:467-484）：
   * 1) 变量合并：先 global 全部求值，再 scope 覆盖——最近的 scope 同名变量胜出；
   * 2) section 合并：scope 层同名 section 遮蔽 global，再按 order 排序。
   */
  assemble(context: AssembleContext = {}): PromptAssembly {
    const scope = context.scope
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.globalVariables) variables[name] = provider(context)
    if (scope !== undefined) {
      const layer = this.scopeVariables.get(scope)
      if (layer !== undefined) {
        for (const [name, provider] of layer) variables[name] = provider(context)
      }
    }
    const merged = new Map(this.globalSections)
    if (scope !== undefined) {
      const layer = this.scopeSections.get(scope)
      if (layer !== undefined) {
        for (const [name, section] of layer) merged.set(name, section) // 遮蔽！
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

/**
 * 严格插值（对应源码 interpolate，index.ts:258-295）。逐字符扫描 `{{`：
 * - 畸形引用（`{{a b}}`、`{{}}`）→ throw；
 * - 未知变量（Object.hasOwn 防原型链污染）→ throw；
 * - 注册了但 provider 返回 undefined → throw；
 * - `{{` 后面完全没有 `}}` 的孤立左花括号 → 字面量正文（可能是用户写的模板代码）；
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
      // 后面有 `}}` 但匹配不上 → 畸形；完全没 `}}` → 字面量
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(
          `malformed prompt variable reference at "${text.slice(open, open + 16)}…" in "${owner}" (references are complete simple {{name}} groups)`,
        )
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(
        `malformed prompt variable reference "{{${name}}}" in "${owner}" (variable names match ${String(VARIABLE_NAME)})`,
      )
    }
    if (!Object.hasOwn(variables, name)) {
      throw new Error(
        `unknown prompt variable "{{${name}}}" in "${owner}"; registered variables: ${Object.keys(variables).join(', ') || '(none)'}`,
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

/** 渲染：插值 → 滤空段 → 空行拼接（对应源码 renderPrompt，index.ts:212-217） */
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

/** 重复注册防御（对应源码 NamedEntries） */
function assertNew(layer: Map<string, unknown>, name: string, kind: string): void {
  if (layer.has(name)) {
    throw new Error(
      `${kind} "${name}" is already registered (for a per-agent override, register through that agent's scope instead)`,
    )
  }
}

function main(): void {
  console.log('🔭 Step 02 – scope 遮蔽（每人一个抽屉）+ 严格插值（typo 必须炸）')
  console.log('='.repeat(56))

  // ========== 朴素版 1：改全局 ==========
  console.log('\n① 朴素版：子代理想装"前端专家"人格 → 直接改全局字符串')
  let globalPrompt = 'You are a general-purpose coding agent.'
  const installFrontendPersona = (): void => {
    globalPrompt = globalPrompt.replace('general-purpose', 'senior frontend engineer') // 改全局！
  }
  installFrontendPersona()
  console.log(`   改完后全局 prompt：${JSON.stringify(globalPrompt)}`)
  console.log('   💥 崩点：所有 agent 都变成了前端专家——部署人格被永久污染，别的子代理没得选')

  // ========== harness 版 1：scope 遮蔽 ==========
  console.log('\n② harness 版：scope 层注册同名 deployment:persona 遮蔽 global')
  const registry = new ScopeRegistry()
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
  // 子代理 "frontend-expert" 注册同名 persona section → shadow 掉全局人格
  registry.sectionFor('frontend-expert', {
    name: 'deployment:persona',
    order: 0,
    text: 'You are a senior frontend engineer working in {{cwd}}. Follow the repo conventions strictly.',
  })
  registry.variableFor('frontend-expert', 'model', () => 'deepseek-coder') // scope 变量也遮蔽

  for (const scope of [undefined, 'frontend-expert'] as const) {
    const label = scope === undefined ? 'global（部署默认）' : `scope=frontend-expert`
    const assembly = registry.assemble(scope === undefined ? {} : { scope })
    console.log(`   --- ${label} ---`)
    console.log(`   ${renderPrompt(assembly).replaceAll('\n', '\n   ')}`)
  }
  console.log('   ✅ 子代理的 prompt 只在自己的抽屉里变了，global 层的部署人格原封不动')

  // ========== 朴素版 2：宽松插值 ==========
  console.log('\n③ 朴素版：宽松插值——{{modle}} typo 原样发给模型')
  const naiveInterpolate = (text: string): string => text.replace(/\{\{(\w+)\}\}/g, '???') // 宽松替换
  console.log(`   渲染结果：${JSON.stringify(naiveInterpolate('Running as {{modle}}.'))}`)
  console.log('   💥 崩点：模型收到 "Running as ???"——typo 静默通过，直到审阅 transcript 才发现')

  // ========== harness 版 2：严格插值 ==========
  console.log('\n④ harness 版：严格插值——未知变量 {{modle}} 渲染时立刻 throw')
  const typos = new ScopeRegistry()
  typos.variable('model', () => 'deepseek-chat')
  typos.section({ name: 'persona', order: 0, text: 'Running as {{modle}}.' })
  try {
    renderPrompt(typos.assemble())
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ ${(error as Error).message}`)
    console.log('   注释：严格模式让作者错误立刻响，而不是静默污染模型')
  }

  console.log('\n⑤ 还有三种 throw + 一个例外：')
  // provider 返回 undefined（注册了但本轮没有值）
  const undefinedValue = new ScopeRegistry()
  undefinedValue.variable('token', () => undefined)
  undefinedValue.section({ name: 'persona', order: 0, text: 'Budget: {{token}}' })
  try {
    renderPrompt(undefinedValue.assemble())
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ provider 返回 undefined → ${(error as Error).message}`)
  }
  // 畸形引用：{{a b}}（含空格）
  const malformed = new ScopeRegistry()
  malformed.section({ name: 'persona', order: 0, text: 'Run: {{a b}}' })
  try {
    renderPrompt(malformed.assemble())
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ 畸形引用 {{a b}} → ${(error as Error).message}`)
  }
  // 例外：孤立 {{（后面没有 }}）是字面量正文；替换值不二次扫描
  const edge = new ScopeRegistry()
  edge.variable('nested', () => '{{model}}') // 值里含 {{model}}
  edge.section({
    name: 'persona',
    order: 0,
    text: 'Render {{nested}} verbatim; literal brace: {{ not closed.',
  })
  console.log(
    `   ✅ 孤立 {{ 是字面量、值不二次扫描：${JSON.stringify(renderPrompt(edge.assemble()))}`,
  )

  console.log(
    '\n🎯 一句话：scope 遮蔽让 per-agent 人格互不污染；严格插值把 typo 拦截在渲染时——抽屉是隔离的，错必须响。',
  )
}

main()

export {}
