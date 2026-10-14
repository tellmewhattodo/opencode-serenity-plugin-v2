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
import { createHandymanTool } from "./handyman.js"
import { createResidentTool } from "./resident.js"
import { TOOL_OUTPUT_SCHEMA } from "./output-schema.js"

/**
 * 🔴 给工具补上 `output` schema 声明（宿主硬契约）。
 *
 * 实测根因（2026-10-14）：宿主对 `Tool.Result` 的判定是**二元的**——
 *   未声明 `output` **且**返回值含 `output` ⇒ 直接失败：
 *   `Tool result declared output without an output schema`。
 *
 * 我们的工具**全部**返回 `{ output, content }` 却都没声明 ⇒ **每次调用都失败**，
 * 且错误**不落日志**（只进会话消息 metadata）⇒ 极难发现。
 *
 * 这里在**注册的最后一跳**统一补声明（而非逐个工具改）：
 *   - 单点、不可能漏（新增工具自动被覆盖）
 *   - 不动各工具里已有的 `output` 返回逻辑
 */
const withOutputSchema = (tool: SerenityTool): SerenityTool => ({
  ...tool,
  output: TOOL_OUTPUT_SCHEMA,
}) as SerenityTool

/**
 * 构建 9 契约工具（**含** output schema 声明与应用层包装）。
 *
 * 🔴 单独导出（而非内联在 registerTools 里）的理由：
 *   测试要能对**真正会被注册的那批对象**断言，而不是对各工具工厂的裸产物断言
 *   —— 二者不同：`withOutputSchema` 与 `needsRoot` 都是**注册期**才包的。
 *   2026-10-14 的契约缺陷正是因为"测试测的是工厂产物、宿主收的是注册产物"而漏过。
 *
 * @param resolveRoot 由 `ToolContext.sessionID` 解析 CCC 根（注入以保持解耦）
 */
export function buildTools(resolveRoot: RootResolver): SerenityTool[] {
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

  return [
    // ── 常驻最小公共集（specs §4.1，9 契约工具）──────────────
    createDashboardTool(),
    needsRoot(createContainerFsTool),
    needsRoot(createContainerGitTool),
    needsRoot(createContainerTrajectoryTool),
    needsRoot(createContainerAdminTool),
    needsRoot(createMsmTool),
    needsRoot(createPraxisTool),
    needsRoot(createHandymanTool),
    needsRoot(createResidentTool),
    // 说明：specs §4.1 另列 ontology / serenity-skill-creator / localstore；
    //   objective 的 9 名清单已全覆盖，余下三项按 specs 全表后续补
  ].map(withOutputSchema)
}

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
  const tools = buildTools(resolveRoot)

  const registrations = await Promise.all(
    tools.map((tool) =>
      ctx.tool.transform((editor) => {
        editor.add(tool)
      }),
    ),
  )

  return registrations.map((reg) => () => reg.dispose())
}
