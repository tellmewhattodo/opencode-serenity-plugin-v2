/**
 * resident — 常驻 agent（specs §4.2「宿主超集优先」）
 *
 * 语义：把一个 agent 作为**常驻进程**跑起来（与 loop 的区别：resident 常驻、loop 一次性）。
 *
 * v1 的实现要点（历史，供语义对齐）：
 *   - `start` **阻塞挂住**（像 loop 一样 hang 住，不立即返回）
 *   - 中断时**必须清理进程**（v0.8.5 加固：killGroup 同时杀进程组与单 pid；
 *     finally 兜底 SIGKILL 防残留）
 *
 * v2 落点：需要宿主进程管理能力。当前**落地契约面 + 进程安全纪律**，
 * 执行链在机制面接入（🔴 不假装已能跑）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import type { SerenityTool } from "./types.js"

const NAME = "resident"

const input = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["start", "stop", "status", "list"],
      description: "start（阻塞挂住）/ stop / status / list",
    },
    name: { type: "string", description: "resident 名称（start/stop/status 用）" },
    command: { type: "string", description: "start：要常驻的命令" },
  },
  required: ["action"],
  additionalProperties: false,
} as const

interface Args {
  action: string
  name?: string
  command?: string
}

const RESIDENT_DIR = "_tmp/resident"

interface ResidentRecord {
  name: string
  command?: string
  startedAt: string
  state: "declared" | "running" | "stopped"
  pid?: number
}

function dir(cccRoot: string): string {
  return join(cccRoot, RESIDENT_DIR)
}

function loadRecords(cccRoot: string): ResidentRecord[] {
  const d = dir(cccRoot)
  if (!existsSync(d)) return []
  const out: ResidentRecord[] = []
  try {
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue
      try {
        out.push(JSON.parse(readFileSync(join(d, f), "utf8")))
      } catch {
        /* 跳过坏记录 */
      }
    }
  } catch {
    return []
  }
  return out
}

export function createResidentTool(cccRoot: string): SerenityTool {
  return {
    name: NAME,
    description:
      "常驻 agent：start（阻塞挂住，像 loop）/ stop / status / list。中断时必须清理进程（不留残留）。",
    input,

    async execute(raw: Args) {
      const a = raw ?? ({} as Args)

      switch (a.action) {
        case "list": {
          const records = loadRecords(cccRoot)
          return {
            output: { count: records.length, records },
            content: records.length
              ? records.map((r) => `  ${r.name}  [${r.state}]  ${r.startedAt}`).join("\n")
              : "(无常驻记录)",
          }
        }

        case "status": {
          if (!a.name) {
            return { output: { error: "missing_name" }, content: "✗ status 需要 name" }
          }
          const rec = loadRecords(cccRoot).find((r) => r.name === a.name)
          if (!rec) {
            return { output: { found: false, name: a.name }, content: `(未找到常驻「${a.name}」)` }
          }
          return {
            output: rec,
            content: `${rec.name}\n  状态: ${rec.state}\n  启动: ${rec.startedAt}${rec.pid ? `\n  pid: ${rec.pid}` : ""}`,
          }
        }

        case "start": {
          if (!a.name || !a.command) {
            return { output: { error: "missing_name_or_command" }, content: "✗ start 需要 name 与 command" }
          }
          const d = dir(cccRoot)
          mkdirSync(d, { recursive: true })
          const rec: ResidentRecord = {
            name: a.name,
            command: a.command,
            startedAt: new Date().toISOString(),
            state: "declared",
          }
          writeFileSync(join(d, `${a.name}.json`), JSON.stringify(rec, null, 2))
          return {
            output: { declared: rec },
            content: [
              `✓ 已登记常驻声明：${a.name}`,
              `  command: ${a.command}`,
              "",
              "⚠ **执行链未接入**：v2 的进程常驻需宿主进程管理能力（机制面 Phase 3）。",
              "  当前仅登记声明，未启动任何进程（不静默假装已跑）。",
              "",
              "🔴 接入时必须遵守（v1 教训 v0.8.5）：",
              "  · start **阻塞挂住**（不立即返回）",
              "  · 中断时 killGroup 同时杀**进程组**与**单个 pid**",
              "  · finally 兜底 SIGKILL，杜绝残留进程",
            ].join("\n"),
          }
        }

        case "stop": {
          if (!a.name) {
            return { output: { error: "missing_name" }, content: "✗ stop 需要 name" }
          }
          const p = join(dir(cccRoot), `${a.name}.json`)
          if (!existsSync(p)) {
            return { output: { found: false, name: a.name }, content: `(未找到常驻「${a.name}」)` }
          }
          rmSync(p, { force: true })
          return {
            output: { stopped: a.name },
            content: `✓ 已移除常驻声明：${a.name}\n  （若已启动进程，接入后需一并清理进程组）`,
          }
        }

        default:
          return {
            output: { error: "unknown_action", action: a.action },
            content: `✗ 未知动作：${String(a.action)}（可用：start/stop/status/list）`,
          }
      }
    },
  }
}
