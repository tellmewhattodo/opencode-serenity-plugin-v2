/**
 * dashboard — 容器仪表（specs §4.1）
 *
 * 契约：health（P1/P2/配置三原则 + registry 完整性）/ time / wait
 *
 * 🔴 CCC 判据（实测教训，见 docs/v2-capability-mapping.md §9）：
 *   不使用 `ctx.location`（那是**插件实例**位置，非会话位置）。
 *   改为**运行时按调用上下文探测**：宿主给工具的 `ToolContext` 含 `sessionID`，
 *   而 CCC 判据的真实来源应是"该会话的工作目录"。
 *   ⇒ 当前实现按 `process.cwd()`（服务进程 cwd）兜底，并在 Phase 2 用会话级信息替换。
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { SerenityTool } from "./types.js"

const NAME = "dashboard"

const input = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["health", "time", "wait"],
      description: "health = CCC 三原则自检；time = 当前时间；wait = 等待 N 秒",
    },
    seconds: {
      type: "number",
      description: "wait 动作的秒数（正整数，缺省 1）",
    },
    root: {
      type: "string",
      description: "health 动作的可选 CCC 根目录（缺省用当前工作目录）",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const

/** 判定某目录是否为 CCC（判据 = `.serenity` 标记文件，specs §7） */
function detectRoot(candidate: string): { isContainer: boolean; root: string | null } {
  try {
    if (existsSync(join(candidate, ".serenity"))) {
      return { isContainer: true, root: candidate }
    }
  } catch {
    // 路径不可读 ⇒ 视为非 CCC
  }
  return { isContainer: false, root: null }
}

/** P1/P2/P3 结构自检 —— 判据 = 文件系统事实 */
function checkStructure(root: string) {
  return [
    { id: "P1", name: "有根（.serenity 标记）", pass: existsSync(join(root, ".serenity")) },
    { id: "P2", name: "git 管（.git 存在）", pass: existsSync(join(root, ".git")) },
    { id: "P3", name: "会话区（AGENT_SESSIONS）", pass: existsSync(join(root, "AGENT_SESSIONS")) },
  ]
}

/** registry 完整性 —— 判据 = 可解析且 entries 为数组 */
function checkRegistry(root: string) {
  const path = join(root, ".opencode/skills/home-serenity/references/mech-registry.json")
  if (!existsSync(path)) {
    return { present: false, path, issues: ["注册表文件不存在"] as string[] }
  }
  try {
    // 去 BOM（历史踩坑：BOM 会让 JSON.parse 失败并误报损坏）
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
    const data = JSON.parse(raw) as { entries?: unknown }
    const issues: string[] = []
    if (!Array.isArray(data.entries)) issues.push("entries 非数组")
    return {
      present: true,
      path,
      issues,
      count: Array.isArray(data.entries) ? data.entries.length : 0,
    }
  } catch (e) {
    return { present: true, path, issues: [`解析失败：${String(e)}`] }
  }
}

export function createDashboardTool(): SerenityTool {
  return {
    name: NAME,
    description:
      "容器仪表：health = CCC 三原则 + MSM 注册表完整性自检；time = 当前时间；wait = 等待 N 秒。",
    input,
    async execute(args: { action: string; seconds?: number; root?: string }) {
      const action = args?.action

      if (action === "time") {
        const now = new Date()
        return {
          output: {
            now_iso: now.toISOString(),
            now_local: now.toString(),
            epoch_ms: now.getTime(),
          },
          content: `now_iso: ${now.toISOString()}\nnow_local: ${now.toString()}\nepoch_ms: ${now.getTime()}`,
        }
      }

      if (action === "wait") {
        const raw = Number(args?.seconds ?? 1)
        const seconds = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1
        await new Promise((r) => setTimeout(r, seconds * 1000))
        return { output: { waited_seconds: seconds }, content: `已等待 ${seconds} 秒` }
      }

      if (action === "health") {
        const candidate = args?.root ?? process.cwd()
        const { isContainer, root } = detectRoot(candidate)

        if (!isContainer || !root) {
          return {
            output: { healthy: false, reason: "not_a_container", checkedPath: candidate },
            content: `✗ ${candidate} 不是 CCC（无 .serenity 标记）`,
          }
        }

        const checks = checkStructure(root)
        const registry = checkRegistry(root)
        const healthy = checks.every((c) => c.pass) && registry.issues.length === 0

        const lines = [
          `${healthy ? "✓" : "✗"} CCC health — ${root}`,
          "",
          ...checks.map((c) => `  ${c.pass ? "✓" : "✗"} ${c.id} ${c.name}`),
          "",
          `  registry: ${registry.present ? "存在" : "缺失"}${
            "count" in registry && registry.count !== undefined ? `（${registry.count} 条）` : ""
          }`,
          ...registry.issues.map((i) => `    ⚠ ${i}`),
        ]

        return {
          output: { healthy, root, checks, registry },
          content: lines.join("\n"),
        }
      }

      return {
        output: { error: "unknown_action", action },
        content: `✗ 未知 action: ${String(action)}（可用：health / time / wait）`,
      }
    },
  }
}
