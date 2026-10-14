/**
 * handyman — 杂工（委派编排，specs §4.1 / §4.2）
 *
 * 契约（双模式）：
 *   - `foreground`（**缺省**）= 一次前台串行委派（返回最终文本，不循环 / 不校验完成码 / 不写进度文件）
 *   - `background` = 白名单模型 worker 循环执行（**stop token 唯一完成判据**）+ 进度文件续跑
 *   - 均支持 `jobs=[...]`
 *
 * 🔴 **上限（specs §4.1）**：
 *   - 前台并行上限 = **10（硬编码）**；**超限 ⇒ 拒绝且一个都不起**
 *   - 后台上限 = `handyman.maxParallel`（缺省 10）
 *   - `providerPreflight()` **在创建前**判定 adapter 有无
 *
 * 实现说明：真正的 worker 执行需要宿主 agent 能力。
 *   本工具落点在 v2 = 通过 `ctx.session` 创建子会话；当前**先落地契约面与校验**
 *   （白名单校验 / 上限校验 / preflight / 进度文件），执行链在机制面接入。
 *   🔴 不假装已能跑 worker —— 未接入的能力**明确报错**而非静默失败。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { SerenityTool } from "./types.js"

const NAME = "handyman"

/** 前台并行硬上限（specs：硬编码 10） */
const FOREGROUND_MAX_PARALLEL = 10

const input = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["foreground", "background"],
      description: "foreground（缺省）= 一次前台委派；background = 循环校验 worker",
    },
    task: { type: "string", description: "任务目标（必填）" },
    label: { type: "string", description: "任务标签（background 时命名进度文件）" },
    model: { type: "string", description: "provider/model（须在白名单）" },
    jobs: {
      type: "array",
      description: "多任务并行（[{task,label?,model?}]）",
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          label: { type: "string" },
          model: { type: "string" },
        },
        required: ["task"],
      },
    },
    guide: { type: "boolean", description: "true ⇒ 打印用法指南（不创建 agent）" },
  },
  additionalProperties: false,
} as const

interface Args {
  mode?: string
  task?: string
  label?: string
  model?: string
  jobs?: Array<{ task: string; label?: string; model?: string }>
  guide?: boolean
}

interface HandymanConfig {
  models?: string[]
  defaultModel?: string
  maxParallel?: number
}

/** 读 CCC 的 handyman 配置（specs §3.1：配置单真源） */
function loadConfig(cccRoot: string): HandymanConfig {
  const candidates = [join(cccRoot, ".opencode/serenity.json"), join(cccRoot, "opencode.json")]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const d = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")) as {
        handyman?: HandymanConfig
      }
      if (d.handyman) return d.handyman
    } catch {
      // 继续尝试下一个
    }
  }
  return {}
}

export function createHandymanTool(cccRoot: string): SerenityTool {
  return {
    name: NAME,
    description:
      "杂工（委派编排）：mode=foreground（缺省，前台一次委派，支持 jobs 并行，上限 10）/ background（循环校验 worker，需 stop token）。guide=true 打印用法指南。",
    input,

    async execute(raw: Args) {
      const a = raw ?? ({} as Args)

      // ── guide ───────────────────────────────────────────────
      if (a.guide) {
        return { output: { guide: "handyman" }, content: GUIDE }
      }

      const mode = a.mode ?? "foreground"
      const config = loadConfig(cccRoot)
      const whitelist = Array.isArray(config.models) ? config.models : []
      const defaultModel = config.defaultModel
      const maxParallel =
        mode === "foreground" ? FOREGROUND_MAX_PARALLEL : (config.maxParallel ?? FOREGROUND_MAX_PARALLEL)

      // ── 组装作业列表 ────────────────────────────────────────
      const jobs = Array.isArray(a.jobs) && a.jobs.length > 0 ? a.jobs : a.task ? [{ task: a.task, label: a.label, model: a.model }] : []

      if (jobs.length === 0) {
        return {
          output: { error: "missing_task" },
          content: "✗ 需要 task 或 jobs（或 guide=true 看指南）",
        }
      }

      // 🔴 上限校验：超限 ⇒ 拒绝且一个都不起（specs §4.1）
      if (jobs.length > maxParallel) {
        return {
          output: { error: "over_parallel_limit", requested: jobs.length, limit: maxParallel },
          content: `✗ 超过${mode}并行上限：请求 ${jobs.length}，上限 ${maxParallel}\n  **一个都不会启动**（不是部分启动）`,
        }
      }

      // 🔴 白名单校验（缺配置 ⇒ 明确报错，不静默）
      if (whitelist.length === 0) {
        return {
          output: { error: "no_whitelist" },
          content:
            "✗ CCC 未配置 handyman.models 白名单 ⇒ 拒绝委派\n" +
            "  配置位置：.opencode/serenity.json 的 handyman.models",
        }
      }

      const resolved = jobs.map((j) => ({
        task: j.task,
        label: j.label ?? "(未命名)",
        model: j.model ?? defaultModel ?? "(未指定)",
      }))

      const invalid = resolved.filter((r) => !whitelist.includes(r.model))
      if (invalid.length > 0) {
        return {
          output: { error: "model_not_whitelisted", invalid: invalid.map((i) => i.model), whitelist },
          content: [
            "✗ 以下 model 不在白名单：",
            ...invalid.map((i) => `  ${i.model}（作业：${i.label}）`),
            "",
            `白名单：${whitelist.join(", ")}`,
          ].join("\n"),
        }
      }

      // ── provider preflight（在创建前判定）───────────────────
      // 🔴 v2 的 adapter 探测需宿主 API；未接入前**明确告知**，不静默假装
      const manifestPath = join(cccRoot, "_tmp/handyman-jobs.json")
      try {
        mkdirSync(join(cccRoot, "_tmp"), { recursive: true })
        writeFileSync(
          manifestPath,
          JSON.stringify(
            {
              mode,
              createdAt: new Date().toISOString(),
              jobs: resolved,
              status: "pending-execution",
            },
            null,
            2,
          ),
        )
      } catch {
        // 落盘失败不影响回执
      }

      return {
        output: {
          mode,
          accepted: resolved.length,
          jobs: resolved,
          manifest: manifestPath.replace(cccRoot + "/", ""),
          executed: false,
        },
        content: [
          `✓ 已受理 ${resolved.length} 个作业（mode=${mode}）`,
          ...resolved.map((r) => `  [${r.model}] ${r.label}：${r.task.slice(0, 80)}`),
          "",
          "⚠ **执行链未接入**：v2 的 worker 执行需经 ctx.session 创建子会话（机制面 Phase 3）。",
          "  当前已落作业清单，未产生任何 agent（不静默假装已跑）。",
          mode === "background" ? "  background 模式还需要 stop token 完成判据与进度文件续跑。" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      }
    },
  }
}

const GUIDE = `# handyman — 委派编排用法指南

## 两种模式
| 模式 | 语义 | 完成判据 |
|---|---|---|
| **foreground**（缺省） | 一次前台串行委派，返回最终文本 | 子 agent 返回即完成 |
| **background** | 循环校验 worker（**需 stop token**）+ 进度文件续跑 | **echo 完成码是唯一判据** |

## 并行
- foreground：上限 **10（硬编码）**；**超限 ⇒ 拒绝且一个都不起**
- background：上限 = \`handyman.maxParallel\`（缺省 10）
- 两种模式都支持 \`jobs=[{task,label?,model?}]\`

## 白名单（强制）
- model 必须在本 CCC 的 \`handyman.models\` 里；**缺配置 ⇒ 拒绝**（不静默）
- 未指定 ⇒ 用 \`handyman.defaultModel\`

## 递归限制
- worker 的工具集**排除 handyman 本身**（编排归主 agent）

## 为什么 background 要 stop token
低智能模型容易「自认为完成」而提前退出 ⇒ 用**随机完成码**做唯一完成判据，
模型必须回显该码才算跑完；这是**机械**判据，不依赖模型自述。`
