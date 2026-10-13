/**
 * dashboard — 容器仪表（specs §4.1）
 *
 * 契约：health（P1/P2/配置三原则 + registry 完整性）/ time / wait
 *
 * v2 实现要点：
 *   - input 用 JSON Schema（Tool.ValueSchema 允许 JsonSchema.JsonSchema）
 *   - execute 返回 Promise<Tool.Result>（promise 侧，非 Effect）
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { SerenityTool } from "./types.js"
import type { ContainerInfo } from "../runtime/container.js"

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
  },
  required: ["action"],
  additionalProperties: false,
} as const

/** P1（有根）/ P2（git 管）自检 —— 判据 = 文件系统事实 */
function checkStructure(root: string) {
  const marker = join(root, ".serenity")
  const gitDir = join(root, ".git")
  const sessions = join(root, "AGENT_SESSIONS")

  const checks = [
    { id: "P1", name: "有根（.serenity 标记）", pass: existsSync(marker), path: marker },
    { id: "P2", name: "git 管（.git 存在）", pass: existsSync(gitDir), path: gitDir },
    { id: "P3", name: "会话区（AGENT_SESSIONS）", pass: existsSync(sessions), path: sessions },
  ]
  return checks
}

/** registry 完整性 —— 判据 = 可解析且 entries 为数组 */
function checkRegistry(root: string) {
  const path = join(root, ".opencode/skills/home-serenity/references/mech-registry.json")
  if (!existsSync(path)) {
    return { present: false, path, issues: ["注册表文件不存在"] }
  }
  try {
    // 去 BOM（历史踩坑：BOM 会让 JSON.parse 失败并误报损坏）
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
    const data = JSON.parse(raw) as { entries?: unknown }
    const issues: string[] = []
    if (!Array.isArray(data.entries)) issues.push("entries 非数组")
    return { present: true, path, issues, count: Array.isArray(data.entries) ? data.entries.length : 0 }
  } catch (e) {
    return { present: true, path, issues: [`解析失败：${String(e)}`] }
  }
}

export function createDashboardTool(container: ContainerInfo): SerenityTool {
  return {
    name: NAME,
    description:
      "容器仪表：health = CCC 三原则 + MSM 注册表完整性自检；time = 当前时间；wait = 等待 N 秒。",
    input,
    async execute(args: { action: string; seconds?: number }) {
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
        if (!container.isContainer || !container.root) {
          return {
            output: { healthy: false, reason: "不在 CCC 内" },
            content: "✗ 当前目录不是 CCC（无 .serenity 标记）——ACC 未激活",
          }
        }
        const checks = checkStructure(container.root)
        const registry = checkRegistry(container.root)
        const allPass = checks.every((c) => c.pass)
        const healthy = allPass && registry.issues.length === 0

        const lines = [
          `${healthy ? "✓" : "✗"} CCC health — ${container.root}`,
          "",
          ...checks.map((c) => `  ${c.pass ? "✓" : "✗"} ${c.id} ${c.name}`),
          "",
          `  registry: ${registry.present ? "存在" : "缺失"}${"count" in registry && registry.count !== undefined ? `（${registry.count} 条）` : ""}`,
          ...registry.issues.map((i) => `    ⚠ ${i}`),
        ]

        return {
          output: { healthy, root: container.root, checks, registry },
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
