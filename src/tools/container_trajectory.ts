/**
 * container_trajectory — 轨迹本体（specs §4.1，8 动作）
 *
 * 动作：list / show / create / use / rebuild / send-later / send-now / cro-guide
 *
 * 语义要点（specs §4.1）：
 *   - `list` / `show` / `create`：清单+统计 / 读一条 / 建一条
 *   - `use`：激活（**内联三项完整性检查**：存在性 / 空壳 / 长期无活动——通过则静默）
 *   - `rebuild`：原地清空重建 = **Ship of Theseus**（v2 落点 = `session.hook("compaction")`）
 *   - `send-later`：未来时刻 + 一条 message，**fire-and-forget（无回执、不可回收）**
 *   - `send-now`：**即时投递**，**同步回执**，**不落注册表**
 *   - `cro-guide`：CRO 编写指南，**无参数纯读**
 *
 * 🔴 已淘汰（勿实现）：close / archive（归档走 `container_fs mv`）/
 *   health·qa·summary（并入 use·list）/ wake-list·wake-rm
 *
 * 落点说明：轨迹落 `AGENT_SESSIONS/`（SESSION.md 为持久身体）；
 * 活跃指针 = `AGENT_SESSIONS/.current`（实测）；唤醒注册表 = `AGENT_SESSIONS/wake-registry.json`。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import type { SerenityTool } from "./types.js"
import { setPendingRebuild } from "../runtime/rebuild.js"

const NAME = "container_trajectory"

const input = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "show", "create", "use", "rebuild", "send-later", "send-now", "cro-guide"],
      description: "轨迹动作",
    },
    name: { type: "string", description: "S### 或目录名或关键词（show/use）" },
    desc: { type: "string", description: "create：短描述（≤5 词，与 issue 互斥）" },
    issue: { type: "string", description: "create：工单号（与 desc 互斥）" },
    summary: { type: "string", description: "create/use/rebuild：≤20 字摘要" },
    goal: { type: "string", description: "create：一句话目标" },
    note: { type: "string", description: "rebuild：给重建后自己的任务焦点（≤200 字符）" },
    force: { type: "boolean", description: "use：强制切换绑定" },
    target: { type: "string", description: "send-now/send-later：目标轨迹" },
    at: { type: "string", description: "send-later：未来时刻（RFC3339 或 +30m/+2h）" },
    message: { type: "string", description: "send-now/send-later：要投递的消息" },
  },
  required: ["action"],
  additionalProperties: false,
} as const

interface Args {
  action: string
  name?: string
  desc?: string
  issue?: string
  summary?: string
  goal?: string
  note?: string
  force?: boolean
  target?: string
  at?: string
  message?: string
}

const SESSIONS_DIRNAME = "AGENT_SESSIONS"

interface TrajectoryEntry {
  dirName: string
  id: string
  date: string
  desc: string
  hasSession: boolean
  mtimeMs: number
}

/** 枚举轨迹（目录名形如 YYYY-MM-DD--S###--desc） */
function listTrajectories(cccRoot: string): TrajectoryEntry[] {
  const dir = join(cccRoot, SESSIONS_DIRNAME)
  if (!existsSync(dir)) return []
  const out: TrajectoryEntry[] = []
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue
    const m = /^(\d{4}-\d{2}-\d{2})--(S\d+)--(.+)$/.exec(e.name)
    if (!m) continue
    const full = join(dir, e.name)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(full).mtimeMs
    } catch {
      /* 忽略 */
    }
    out.push({
      dirName: e.name,
      date: m[1]!,
      id: m[2]!,
      desc: m[3]!,
      hasSession: existsSync(join(full, "SESSION.md")),
      mtimeMs,
    })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 找一条轨迹（S### 精确 / 目录名 / 关键词模糊） */
function findTrajectory(entries: TrajectoryEntry[], q: string): TrajectoryEntry | null {
  const exact = entries.find((e) => e.id === q || e.dirName === q)
  if (exact) return exact
  const lower = q.toLowerCase()
  return (
    entries.find(
      (e) => e.dirName.toLowerCase().includes(lower) || e.desc.toLowerCase().includes(lower),
    ) ?? null
  )
}

/** 读活跃指针 */
function readCurrent(cccRoot: string): string | null {
  const p = join(cccRoot, SESSIONS_DIRNAME, ".current")
  if (!existsSync(p)) return null
  try {
    const v = readFileSync(p, "utf8").trim()
    return v.length ? v : null
  } catch {
    return null
  }
}

export function createContainerTrajectoryTool(cccRoot: string): SerenityTool {
  return {
    name: NAME,
    description:
      "轨迹本体：list（清单+统计）/ show（读一条）/ create（建一条）/ use（激活，内联完整性检查）/ rebuild（原地重建，Ship of Theseus）/ send-now（即时投递，有回执）/ send-later（未来一次性投递，fire-and-forget）/ cro-guide（CRO 编写指南）。",
    input,

    async execute(raw: Args) {
      const a = raw ?? ({} as Args)
      const entries = listTrajectories(cccRoot)

      switch (a.action) {
        // ── list：清单 + 统计 ─────────────────────────────────
        case "list": {
          const current = readCurrent(cccRoot)
          const stale = entries.filter((e) => Date.now() - e.mtimeMs > 7 * 24 * 3600 * 1000)
          const lines = entries.map(
            (e) => `  ${e.id === current ? "▶" : " "} ${e.dirName}${e.hasSession ? "" : "  ⚠无SESSION.md"}`,
          )
          return {
            output: {
              total: entries.length,
              current,
              staleCount: stale.length,
              entries: entries.map((e) => ({
                id: e.id,
                dirName: e.dirName,
                date: e.date,
                desc: e.desc,
                hasSession: e.hasSession,
              })),
            },
            content: [
              `${SESSIONS_DIRNAME}/ (${entries.length} 条轨迹)`,
              `活跃指针: ${current ?? "(无)"}`,
              stale.length ? `⚠ 长期无活动（>7d）: ${stale.length} 条` : "",
              "",
              ...lines,
            ]
              .filter((l) => l !== "")
              .join("\n"),
          }
        }

        // ── show：读一条 ──────────────────────────────────────
        case "show": {
          if (!a.name) {
            return { output: { error: "missing_name" }, content: "✗ show 需要 name" }
          }
          const t = findTrajectory(entries, a.name)
          if (!t) {
            return { output: { error: "not_found", query: a.name }, content: `✗ 未找到轨迹「${a.name}」` }
          }
          const p = join(cccRoot, SESSIONS_DIRNAME, t.dirName, "SESSION.md")
          if (!existsSync(p)) {
            return { output: { dirName: t.dirName }, content: `⚠ ${t.dirName} 无 SESSION.md` }
          }
          const body = readFileSync(p, "utf8")
          return {
            output: { dirName: t.dirName, id: t.id, bytes: body.length },
            content: body,
          }
        }

        // ── create：建一条 ────────────────────────────────────
        case "create": {
          const hasDesc = typeof a.desc === "string" && a.desc.trim().length > 0
          const hasIssue = typeof a.issue === "string" && a.issue.trim().length > 0
          if (hasDesc === hasIssue) {
            return {
              output: { error: "exactly_one_of_desc_issue" },
              content: "✗ create 需要且仅需 desc 或 issue 之一",
            }
          }
          const today = new Date().toISOString().slice(0, 10)
          const slug = (a.issue ?? a.desc)!.trim()
          const dirName = `${today}--${slug}`
          const abs = join(cccRoot, SESSIONS_DIRNAME, dirName)
          if (existsSync(abs)) {
            return { output: { error: "exists", dirName }, content: `✗ 已存在：${dirName}` }
          }
          mkdirSync(abs, { recursive: true })
          const sessionMd = [
            `# SESSION: ${slug}`,
            "",
            `## 目标`,
            a.goal ?? "(待补)",
            "",
            `## 状态`,
            `- [ ] 进行中`,
            "",
            `## 日志`,
            `- ${today} — 轨迹创建`,
            "",
          ].join("\n")
          writeFileSync(join(abs, "SESSION.md"), sessionMd)
          return {
            output: { created: dirName, path: join(SESSIONS_DIRNAME, dirName) },
            content: `✓ 已创建轨迹 ${dirName}\n  SESSION.md 已初始化`,
          }
        }

        // ── use：激活 + 内联三项完整性检查 ────────────────────
        case "use": {
          if (!a.name) {
            return { output: { error: "missing_name" }, content: "✗ use 需要 name" }
          }
          const t = findTrajectory(entries, a.name)
          if (!t) {
            return { output: { error: "not_found", query: a.name }, content: `✗ 未找到轨迹「${a.name}」` }
          }

          // 三项完整性检查（specs §4.1）：存在性 / 空壳 / 长期无活动
          const checks: string[] = []
          if (!t.hasSession) checks.push("⚠ SESSION.md 缺失")
          else {
            const body = readFileSync(join(cccRoot, SESSIONS_DIRNAME, t.dirName, "SESSION.md"), "utf8")
            if (body.trim().length < 100) checks.push("⚠ SESSION.md 近乎空壳（<100 字符）")
          }
          const idleDays = Math.floor((Date.now() - t.mtimeMs) / 86_400_000)
          if (idleDays > 7) checks.push(`⚠ 长期无活动（${idleDays} 天）`)

          const prev = readCurrent(cccRoot)
          if (prev && prev !== t.id && !a.force) {
            return {
              output: { error: "binding_guard", previous: prev, target: t.id },
              content: `⚠ 当前绑定为 ${prev}；切换到 ${t.id} 需 force=true`,
            }
          }

          writeFileSync(join(cccRoot, SESSIONS_DIRNAME, ".current"), `${t.id}\n`)

          // 通过则静默（specs）；不通过则提示
          return {
            output: { activated: t.id, dirName: t.dirName, checks },
            content:
              checks.length === 0
                ? `✓ 已激活 ${t.id} — ${t.dirName}`
                : `✓ 已激活 ${t.id} — ${t.dirName}\n${checks.join("\n")}`,
          }
        }

        // ── rebuild：原地重建（Ship of Theseus）───────────────
        case "rebuild": {
          if (!a.summary) {
            return { output: { error: "missing_summary" }, content: "✗ rebuild 需要 summary（≤20 字）" }
          }
          const t = a.name ? findTrajectory(entries, a.name) : null
          const targetId = t?.id ?? readCurrent(cccRoot)

          // 🔴 登记 pending 意图 ⇒ 由 compaction hook 消费（机制面已接入）
          const intentPath = setPendingRebuild(cccRoot, {
            sessionID: undefined, // 未指定 ⇒ 对任意同 CCC 会话生效
            summary: a.summary,
            note: a.note,
            requestedAt: new Date().toISOString(),
          })

          return {
            output: {
              rebuild: "pending",
              target: targetId,
              summary: a.summary,
              note: a.note ?? null,
              intentPath: intentPath.replace(cccRoot + "/", ""),
            },
            content: [
              `✓ rebuild 意图已登记：${targetId ?? "(当前轨迹)"}`,
              `  summary: ${a.summary}`,
              a.note ? `  note: ${a.note}` : "",
              `  落点: ${intentPath.replace(cccRoot + "/", "")}`,
              "",
              "触发方式（v2 落点）：宿主**压缩该会话**时，",
              "  `session.hook(\"compaction\")` 会消费此意图 ⇒ 追加重建锚点 + 设 result（跳过模型请求）。",
              "  ⇒ 即：**原地重建 + 载体重锚定到 SESSION.md**（持久身体不动）。",
            ]
              .filter(Boolean)
              .join("\n"),
          }
        }

        // ── send-now：即时投递（有回执，不落注册表）───────────
        case "send-now": {
          if (!a.target || !a.message) {
            return { output: { error: "missing_target_or_message" }, content: "✗ send-now 需要 target 与 message" }
          }
          const t = findTrajectory(entries, a.target)
          if (!t) {
            return { output: { error: "not_found", target: a.target }, content: `✗ 未找到目标轨迹「${a.target}」` }
          }
          // 落投递箱（宿主侧注入由机制面接入；此处给可核验的落点）
          const inbox = join(cccRoot, SESSIONS_DIRNAME, "_inbox")
          mkdirSync(inbox, { recursive: true })
          const rec = {
            kind: "send-now",
            target: t.id,
            at: new Date().toISOString(),
            message: a.message,
          }
          const file = join(inbox, `${Date.now()}-${t.id}.json`)
          writeFileSync(file, JSON.stringify(rec, null, 2))
          return {
            output: { delivered: true, target: t.id, receipt: file },
            content: `✓ 已投递（同步回执）\n  目标: ${t.id}\n  落点: ${file.replace(cccRoot + "/", "")}`,
          }
        }

        // ── send-later：未来一次性（fire-and-forget）──────────
        case "send-later": {
          if (!a.target || !a.at || !a.message) {
            return {
              output: { error: "missing_target_at_message" },
              content: "✗ send-later 需要 target / at / message",
            }
          }
          const t = findTrajectory(entries, a.target)
          if (!t) {
            return { output: { error: "not_found", target: a.target }, content: `✗ 未找到目标轨迹「${a.target}」` }
          }
          const when = resolveWhen(a.at)
          if (!when) {
            return {
              output: { error: "bad_at", at: a.at },
              content: `✗ 无法解析时刻：${a.at}（用 RFC3339 或 +30m/+2h）`,
            }
          }
          const regPath = join(cccRoot, SESSIONS_DIRNAME, "wake-registry.json")
          let reg: { entries?: unknown[] } = { entries: [] }
          if (existsSync(regPath)) {
            try {
              reg = JSON.parse(readFileSync(regPath, "utf8").replace(/^\uFEFF/, ""))
            } catch {
              reg = { entries: [] }
            }
          }
          if (!Array.isArray(reg.entries)) reg.entries = []
          const entry = {
            target: t.id,
            at: when.toISOString(),
            message: a.message,
            createdAt: new Date().toISOString(),
            state: "armed",
          }
          reg.entries.push(entry)
          writeFileSync(regPath, JSON.stringify(reg, null, 2))
          return {
            output: { scheduled: true, target: t.id, at: entry.at },
            content: `✓ 已排定（fire-and-forget —— **无回执、不可回收**）\n  目标: ${t.id}\n  时刻: ${entry.at}\n  注册表: AGENT_SESSIONS/wake-registry.json`,
          }
        }

        // ── cro-guide：CRO 编写指南（无参纯读）────────────────
        case "cro-guide": {
          return {
            output: { guide: "cro" },
            content: CRO_GUIDE,
          }
        }

        default:
          return {
            output: { error: "unknown_action", action: a.action },
            content: `✗ 未知动作：${String(a.action)}（可用：list/show/create/use/rebuild/send-now/send-later/cro-guide）`,
          }
      }
    },
  }
}

/** 解析时刻：RFC3339 或 +30m / +2h */
function resolveWhen(input: string): Date | null {
  const rel = /^\+(\d+)([mhd])$/.exec(input.trim())
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000
    return new Date(Date.now() + ms)
  }
  const t = Date.parse(input)
  return Number.isFinite(t) ? new Date(t) : null
}

/** CRO 指南（specs §4.5 的编写指南；此处给要点版） */
const CRO_GUIDE = `# CRO（Continuous Re-Occurrence）编写指南

CRO = 给**本轨迹**写一个程序，由它决定「何时该被唤醒」。

## 何时用
- 需要「未来某刻继续做」而不是「等人叫我」时
- 需要条件式唤醒（如「构建完成后回来检查」）时

## 基本形态
1. 决定唤醒条件（时刻 / 事件 / 状态）
2. 用 container_trajectory 的 send-later 落一条唤醒（未来时刻 + 一条 message）
3. message 里写清：**醒来后做什么**（不是「继续」这种空指令）

## 两条投递路径的分界（务必分清）
| 动作 | 语义 | 回执 |
|---|---|---|
| send-later | 预约（未来时刻 + 一条） | ❌ fire-and-forget，**不可回收** |
| send-now  | 递话（立即投递） | ✅ 同步回执 |

## 纪律
- 🔴 唤醒 message 必须**自足**：未来的你会忘记上下文，message 要能独立读懂
- 🔴 **禁轮询**：CRO 是「为完成工作而自排」，不是「定期醒来看看」
- 到点后先判**是否已过期**（目标可能已被别处完成）`

/** 目录清理辅助（供未来裁剪用；当前不使用，保留以标记边界） */
export function __trajectoryTmpDir(cccRoot: string): string {
  const d = join(cccRoot, "_tmp/trajectory")
  mkdirSync(d, { recursive: true })
  return d
}

/** 仅供测试：清空投递箱 */
export function __clearInbox(cccRoot: string): void {
  rmSync(join(cccRoot, SESSIONS_DIRNAME, "_inbox"), { recursive: true, force: true })
}
