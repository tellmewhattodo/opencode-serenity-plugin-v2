/**
 * 工具面注册入口
 *
 * 契约（specs §4.1 最小公共集）：
 *   container_fs / container_git / container_trajectory / msm / container_admin /
 *   dashboard / praxis / ontology / serenity-skill-creator / handyman / localstore
 *
 * v2 注册方式：`ctx.tool.transform(editor => editor.add(tool))`
 *   - transform 是**可重放**的：域重建时从干净状态按注册顺序重跑
 *   - 因此 editor.add 必须是**幂等且廉价**的（不得在其中做 IO）
 *
 * 本文件只做装配：具体工具实现在 ./<name>.ts
 */

import type { ToolRegistrar } from "./types.js"
import type { ContainerInfo } from "../runtime/container.js"

import { createDashboardTool } from "./dashboard.js"

/**
 * 注册全部工具。
 *
 * @returns disposers —— 释放注册（插件卸载时调用）
 */
export async function registerTools(
  ctx: ToolRegistrar,
  container: ContainerInfo,
): Promise<Array<() => Promise<void> | void>> {
  const tools = [
    // ── 常驻最小公共集（specs §4.1）──────────────────
    createDashboardTool(container),
    // 后续：container_fs / container_git / container_trajectory / msm /
    //       container_admin / praxis / ontology / serenity-skill-creator /
    //       handyman / localstore
  ]

  const registrations = await Promise.all(
    tools.map((tool) =>
      ctx.tool.transform((editor) => {
        editor.add(tool)
      }),
    ),
  )

  return registrations.map((reg) => () => reg.dispose())
}
