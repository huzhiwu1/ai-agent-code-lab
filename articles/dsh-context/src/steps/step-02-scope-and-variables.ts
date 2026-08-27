/**
 * Step 02 – 为什么每个 agent 可以有自己的人格？（scope 遮蔽）
 *
 * ── 先懂三个词 ──────────────────────────────────────────────
 * 「scope」= 每个 agent 自己的小抽屉——往抽屉里放的 section/variable 只对那个
 *   agent 生效，还能遮蔽（shadow）全局同名项（类比：办公室每个人有自己带锁的
 *   抽屉，抽屉里贴的便签不会影响别人桌上的便签）。
 * 「变量」= `{{name}}` 这种占位符，装配时替换成真实值（如 `{{model}}` → 实际模型名）。
 * 「插值」= 把占位符替换成值的动作。
 *
 * ── 这一步解决什么问题 ──────────────────────────────────────
 * 全局只有一个 prompt：子代理想装"前端专家"人格 → 直接改全局字符串 → 污染了
 *   所有 agent（部署人格被永久替换，别的子代理没得选）。
 *
 * ── 为什么这么设计 ──────────────────────────────────────────
 * 注册分 global / scope 两层：scope 层同名 section/variable 遮蔽 global 层——
 *   子代理注册同名 `deployment:persona` 就 shadow 掉全局人格，谁也不污染谁。
 *   配套演示严格插值：`{{modle}}` typo → 未知变量 throw（"作者错误必须响"），
 *   与 scope 一起展示"注册 + 装配 + 渲染"完整链路。
 *
 * ── 收益 ────────────────────────────────────────────────────
 * per-agent prompt 成为可能（子代理装人格不再污染全局）；作者 typo 在渲染时响，
 * 而不是静默发给模型直到审阅才发现。
 *
 * 对应源码：packages/core/system-prompt/src/index.ts（变量合并 index.ts:472-482、
 *   ScopedLayers 遮蔽 index.ts:484、interpolate 严格模式 index.ts:258-295）
 * 跑法：pnpm run context:step:02（或 articles/dsh-context 内 pnpm run step:02）
 */

/** 一个系统提示词分区（对应源码 PromptSection，index.ts:53-75） */
interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** 变量 provider：每次装配时求值（真实接收 AssembleContext，见源码 index.ts:42-50/301） */
type VariableProvider = () => string | undefined

/** 装配结果：排好序的 section + 已解析的变量表（对应源码 PromptAssembly，index.ts:115-120） */
interface PromptAssembly {
  sections: { name: string; text: string }[]
  variables: Record<string, string | undefined>
}

/** 变量名的合法形态：`^[a-z][a-z0-9_]*$`（index.ts:134） */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** 一层注册：global 或某个 scope 各一份（对应源码 PromptLayer，index.ts:304-335） */
interface PromptLayer {
  sections: Map<string, PromptSection>
  variables: Map<string, VariableProvider>
}

const emptyLayer = (): PromptLayer => ({ sections: new Map(), variables: new Map() })

/**
 * 两层注册表：global + 若干 scope（对应源码 ScopedLayers，index.ts:347）。
 * scope 层同名 section/variable 遮蔽 global 层——"近层胜出"。简化：scope 只支持
 * 一层（真实是链，从远到近覆盖，原理相同，index.ts:469-482）。
 */
class ScopeRegistry {
  private readonly global = emptyLayer()
  private readonly scopes = new Map<string, PromptLayer>()

  /** 注册 section；scope 省略 = global 层（对应源码 section()，index.ts:381-390） */
  section(section: PromptSection, scope?: string): void {
    const layer = scope === undefined ? this.global : this.layerFor(scope)
    assertNew(layer.sections, section.name, 'prompt section')
    layer.sections.set(section.name, section)
  }

  /** 注册变量；scope 省略 = global 层（对应源码 variable()，index.ts:446-455） */
  variable(name: string, provider: VariableProvider, scope?: string): void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(
        `invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`,
      )
    }
    const layer = scope === undefined ? this.global : this.layerFor(scope)
    assertNew(layer.variables, name, 'prompt variable')
    layer.variables.set(name, provider)
  }

  /** 取某 scope 的注册层，不存在则按需创建 */
  private layerFor(scope: string): PromptLayer {
    let layer = this.scopes.get(scope)
    if (layer === undefined) {
      layer = emptyLayer()
      this.scopes.set(scope, layer)
    }
    return layer
  }

  /**
   * 一次装配（对应源码 assemble() 前两步，index.ts:472-484）：
   * 1) 变量合并：先 global 全部求值，再 scope 覆盖——scope 同名变量胜出；
   * 2) section 合并：scope 同名 section 遮蔽 global（index.ts:484），再按 order 排序。
   */
  assemble(scope?: string): PromptAssembly {
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.global.variables) variables[name] = provider()
    const scopeLayer = scope === undefined ? undefined : this.scopes.get(scope)
    if (scopeLayer !== undefined) {
      for (const [name, provider] of scopeLayer.variables) variables[name] = provider()
    }
    const sections = new Map(this.global.sections)
    if (scopeLayer !== undefined) {
      for (const [name, section] of scopeLayer.sections) sections.set(name, section) // 遮蔽！
    }
    return {
      sections: [...sections.values()]
        .sort((a, b) => a.order - b.order)
        .map(section => ({ name: section.name, text: section.text })),
      variables,
    }
  }
}

/**
 * 严格插值（对应源码 interpolate，index.ts:258-295）：未知变量直接 throw——
 * "这是作者错误，我们希望它响"。本步只实现这一条边界；畸形引用 `{{a b}}`、
 * provider 返回 undefined、孤立 `{{` 字面量等边界源码也 throw，见
 * index.ts:258-295。（String.replace 只扫原文一次，替换值不二次展开）
 */
function interpolate(
  text: string,
  variables: Record<string, string | undefined>,
  owner: string,
): string {
  return text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (match, name: string) => {
    if (!Object.hasOwn(variables, name)) {
      // Object.hasOwn 防原型链污染：不解析原型上的属性（index.ts:282-286）
      throw new Error(
        `unknown prompt variable "${match}" in "${owner}"; registered variables: ${Object.keys(variables).join(', ') || '(none)'}`,
      )
    }
    return variables[name] ?? match // undefined 时源码也 throw（index.ts:287-290），本步简化
  })
}

/** 渲染：插值 → 滤空段 → 空行拼接（对应源码 renderPrompt，index.ts:212-217） */
function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => interpolate(section.text, assembly.variables, section.name))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/**
 * 重复注册防御（对应源码 NamedEntries.insert 的前半段，index.ts:316-324）：
 * 只检查不写入——已存在则 throw；注册动作由调用方的下一行 set 完成。
 */
function assertNew(layer: Map<string, unknown>, name: string, kind: string): void {
  if (layer.has(name)) {
    throw new Error(
      `${kind} "${name}" is already registered (for a per-agent override, register through that agent's scope instead)`,
    )
  }
}

function main(): void {
  console.log('🔭 Step 02 – scope 遮蔽：为什么每个 agent 可以有自己的人格？')
  console.log('='.repeat(56))

  // ========== ① 朴素版：改全局 ==========
  console.log('\n① 朴素版：子代理想装"前端专家"人格 → 直接改全局字符串')
  let globalPrompt = 'You are a general-purpose coding agent.'
  const installFrontendPersona = (): void => {
    globalPrompt = globalPrompt.replace('general-purpose', 'senior frontend engineer') // 改全局！
  }
  installFrontendPersona()
  console.log(`   改完后全局 prompt：${JSON.stringify(globalPrompt)}`)
  console.log('   💥 崩点：所有 agent 都变成前端专家——部署人格被永久替换，别的子代理没得选')

  // ========== ② harness 版：scope 遮蔽 section + variable ==========
  console.log('\n② harness 版：scope 层注册同名 section/variable → shadow 掉全局')
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
  // 子代理 "frontend-expert" 注册同名 persona section + 同名 model 变量 → 双双遮蔽 global
  registry.section(
    {
      name: 'deployment:persona',
      order: 0,
      text: 'You are a senior frontend engineer working in {{cwd}}. Follow the repo conventions strictly.',
    },
    'frontend-expert',
  )
  registry.variable('model', () => 'deepseek-coder', 'frontend-expert')

  for (const scope of [undefined, 'frontend-expert'] as const) {
    const label = scope === undefined ? 'global（部署默认）' : 'scope=frontend-expert'
    const assembly = registry.assemble(scope)
    console.log(`   --- ${label} ---`)
    console.log(`   ${renderPrompt(assembly).replaceAll('\n', '\n   ')}`)
  }
  console.log(
    '   ✅ 子代理的 prompt 只在自己抽屉里变了（section+variable 双双遮蔽），global 层原封不动',
  )

  // ========== ③ 配套演示：严格插值（typo 必须响） ==========
  console.log('\n③ 配套演示：严格插值——{{modle}} typo 宽松 vs 严格')
  const naiveInterpolate = (text: string): string => text.replace(/\{\{(\w+)\}\}/g, '???') // 宽松替换
  console.log(`   宽松版渲染：${JSON.stringify(naiveInterpolate('Running as {{modle}}.'))}`)
  console.log('   💥 崩点：模型收到 "Running as ???."——typo 静默通过，直到审阅 transcript 才发现')
  const typos = new ScopeRegistry()
  typos.variable('model', () => 'deepseek-chat')
  typos.section({ name: 'deployment:persona', order: 0, text: 'Running as {{modle}}.' })
  try {
    renderPrompt(typos.assemble())
    console.log('   未抛出？')
  } catch (error) {
    console.log(`   ✅ 严格版：${(error as Error).message}`)
    console.log('   注释：畸形引用/undefined/孤立花括号等边界源码也 throw，见 index.ts:258-295')
  }

  console.log(
    '\n🎯 一句话：scope 遮蔽让 per-agent 人格互不污染；严格插值让 typo 在渲染时炸——抽屉是隔离的，错必须响。',
  )
}

main()

export {}
