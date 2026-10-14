/**
 * 工具面注册入口
 *
 * 契约（specs §4.1 最小公共集）：
 *   container_fs / container_git / container_trajectory / msm / container_admin /
 *   dashboard / praxis / ontology / serenity-skill-creator / handyman / localstore
 *
 * v2 注册方式：`ctx.tool.transform(editor => editor.add(tool))`
 *   - transform 是**可重放**的：域重建时从干净状态按注册顺序重跑
 *   - ⇒ editor.add 必须**幂等且廉价**（不得在其中做 IO）
 *
 * 🔴 **注册与 CCC 判定解耦**（实测教训，见 docs/v2-capability-mapping.md §9）：
 *   注册在宿主级、与会话无关；`ctx.location` 是**插件实例**位置。
 *   解法：工具注册时**不解析根**；执行时用 `ToolContext.sessionID` → 会话位置 → CCC 根。
 *   （`execute(input, context)` 的 context 含 `sessionID`；这是官方给工具的正确信息来源。）
 */

import type { ToolRegistrar, RootResolver, SerenityTool } from "./types.js"

import { createDashboardTool } from "./dashboard.js"
import { createContainerFsTool } from "./container_fs.js"
import { createContainerGitTool } from "./container_git.js"
import { createContainerTrajectoryTool } from "./container_trajectory.js"
import { createContainerAdminTool } from "./container_admin.js"
import { createMsmTool } from "./msm.js"
import { createPraxisTool } from "./praxis.js"

/**
 * 注册全部工具。
 *
 * @param ctx 宿主 tool 域
 * @param resolveRoot 由 `ToolContext.sessionID` 解析 CCC 根（注入以保持解耦）
 * @returns disposers
 */
export async function registerTools(
  ctx: ToolRegistrar,
  resolveRoot: RootResolver,
): Promise<Array<() => Promise<void> | void>> {
  /**
   * 把「需要 CCC 根的工具」包装成运行时解析版本。
   *
   * 保留完整的宿主 ToolInfo 形状（input/description/options 原样），
   * 只替换 `execute` —— 这样类型与宿主一致，且不丢字段。
   */
  const needsRoot = (make: (root: string) => SerenityTool): SerenityTool => {
    const base = make("")
    return {
      ...base,
      async execute(args: unknown, context: unknown) {
        const sessionID = (context as { sessionID?: unknown } | undefined)?.sessionID
        const root = await resolveRoot(String(sessionID ?? ""))
        if (!root) {
          return {
            output: { error: "not_in_ccc" },
            content: "✗ 当前会话不在 CCC 内（无 .serenity 标记）——本工具不可用",
          }
        }
        return make(root).execute(args as never, context as never)
      },
    }
  }

  const tools: SerenityTool[] = [
    // ── 常驻最小公共集（specs §4.1）──────────────────
    createDashboardTool(),
    needsRoot(createContainerFsTool),
    needsRoot(createContainerGitTool),
    needsRoot(createContainerTrajectoryTool),
    needsRoot(createContainerAdminTool),
    needsRoot(createMsmTool),
    needsRoot(createPraxisTool),
    // 后续（objective 剩余）：handyman / resident / logbook
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
