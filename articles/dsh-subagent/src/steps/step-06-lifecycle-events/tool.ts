/**
 * Step 06 — 工具层镜像 provider 生命周期（added/removed）
 *
 * 对应源码：packages/subagent/subagent/src/index.ts
 *   registerProvider L369-385 的 provider-added 广播 + effect 清理时的 provider-removed
 *   packages/subagent/tool-subagent（消费方监听这两个事件，注册/注销 subagent 工具）
 */

import { type EventBus } from './bus'

/**
 * 工具层：镜像 provider 生命周期——在就注册工具、走就注销。
 * 对应源码 tool-subagent 的 provider-added/removed 监听：消费方不赌加载顺序，
 * provider 在就注册工具、走就注销，缺席时工具不存在。
 */
export class ToolMirror {
  private mounted: string[] = []

  constructor(events: EventBus) {
    // 对应源码 provider-added 监听：provider 出现 → 注册工具
    events.on('subagent/provider-added', name => {
      this.mounted.push(`subagent-${name}`)
      console.log(`   🛠️ 工具层镜像：provider "${name}" 出现 → 注册工具 subagent-${name}`)
    })
    // 对应源码 provider-removed 监听：provider 离开 → 注销工具
    events.on('subagent/provider-removed', name => {
      this.mounted = this.mounted.filter(tool => tool !== `subagent-${name}`)
      console.log(`   🧹 工具层镜像：provider "${name}" 离开 → 注销工具 subagent-${name}`)
    })
  }

  get tools(): string[] {
    return this.mounted
  }
}

export {}
