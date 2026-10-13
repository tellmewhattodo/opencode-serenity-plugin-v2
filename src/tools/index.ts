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
 * 🔴 **注册与 CCC 判定解耦**（实测教训）：
 *   工具注册在**宿主级**，与会话无关；`ctx.location` 是插件实例位置，**不是**会话位置
 *   ⇒ 此处**不做** CCC 判定，激活语义下沉到会话级（注入面）。
 *   理由与证据见 `docs/v2-capability-mapping.md` §9。
 */

import type { ToolRegistrar } from "./types.js"

import { createDashboardTool } from "./dashboard.js"

/**
 * 注册全部工具。
 *
 * @returns disposers —— 释放注册（插件卸载时调用）
 */
export async function registerTools(
  ctx: ToolRegistrar,
): Promise<Array<() => Promise<void> | void>> {
  const tools = [
    // ── 常驻最小公共集（specs §4.1）──────────────────
    createDashboardTool(),
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
