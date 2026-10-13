/**
 * 块 9：Session（specs §5.9）
 *
 * 条件注入：有活跃会话时产出；无则整块省略。
 *
 * 活跃会话判据（本实现）：读 `<CCC>/.opencode/sessions/.current`（ACC 约定）
 *   —— 该文件存在且非空 ⇒ 视为活跃会话。
 *
 * 🔴 必附 TRAJECTORY-ASSISTANT 预声明（specs §5.9：「机制先于提醒」）。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** ACC 约定的活跃会话说指针 */
const CURRENT_POINTER = ".opencode/sessions/.current"

/**
 * 解析活跃会话。
 *
 * 返回 null ⇒ 无活跃会话（整块省略）。
 */
export function resolveActiveSession(cccRoot: string): {
  id: string
  dirName: string
  sessionPath: string
  shortName: string
} | null {
  const pointerPath = join(cccRoot, CURRENT_POINTER)
  if (!existsSync(pointerPath)) return null

  let sessionId = ""
  try {
    sessionId = readFileSync(pointerPath, "utf8").trim()
  } catch {
    return null
  }
  if (!sessionId) return null

  // 在 AGENT_SESSIONS/ 下找以该 id 结尾的目录
  const sessionsDir = join(cccRoot, "AGENT_SESSIONS")
  if (!existsSync(sessionsDir)) return null

  let dirName: string | null = null
  try {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.endsWith(`--${sessionId}`) || entry.name.includes(`--${sessionId}--`)) {
        dirName = entry.name
        break
      }
    }
  } catch {
    return null
  }
  if (!dirName) return null

  const sessionPath = join(sessionsDir, dirName, "SESSION.md")
  if (!existsSync(sessionPath)) return null

  // 短名 = 目录名去掉日期前缀与 ID 段
  const shortName = dirName.replace(/^\d{4}-\d{2}-\d{2}--/, "").replace(/^S\d+--/, "")

  return { id: sessionId, dirName, sessionPath, shortName }
}

/** 构建 Session 块（无活跃会话 ⇒ null） */
export function buildSessionBlock(cccRoot: string): string | null {
  const s = resolveActiveSession(cccRoot)
  if (!s) return null

  return `=== Serenity Session ===
Active session: ${s.id} — ${s.dirName} (this session is the rebuildable carrier of the trajectory)
SESSION.md path: ${s.sessionPath} (the trajectory's persistent body — stays in place through rebuilds)

Rules (SESSION.md is the trajectory log — keep its format & granularity fixed):
  • Write only when a MILESTONE landed or a DECISION was made — not every round
  • One entry = one abstraction level, at the highest one that can express it:
    identity/anchors (rare) › decision (one line + rationale/rejected) › milestone
    (one line + an evidence pointer, e.g. a commit id). Execution detail — test
    counts, coverage decimals, per-file readings, step narration — belongs in the
    COMMIT MESSAGE, not here
  • Never write a value that changes by the act of writing it (file size; the hash
    of the commit containing this edit)
  • Fixed sections, in this order: 身份与边界 / 权威锚点 / 工作纪律 / 决策 / 日志 /
    当前状态 / 待 owner 裁决.  The 日志 section appends only; 当前状态 and
    待 owner 裁决 are OVERWRITTEN each round
  • Reference this session in all subsequent messages

IMPORTANT: Read SESSION.md now to RESUME — not to audit. Sync the todo list from
the 当前状态 and 待 owner 裁决 sections only.

CRITICAL: When calling todowrite, the first item in the todos array MUST
always be:
  { content: "SESSION: ${s.id} — ${s.shortName}",
    status: "completed" }
This preserves the session context across todo updates.
Do NOT remove or reorder this item — keep it at position 0.

TRAJECTORY-ASSISTANT: a background tracker scores your tool use (write/edit=3,
task=10, read/grep/glob/msm=1, +1 per minute) and reminds you with a
[TRAJECTORY-ASSISTANT · CHECKPOINT] message when the threshold is reached. On every such
reminder you MUST reply with the exact ACK code:
  [TRAJECTORY-ASSISTANT-recorded-{code}]  — if you recorded progress to SESSION.md
  [TRAJECTORY-ASSISTANT-skipped-{code}]  — if nothing to record this round
Do not ignore the reminder; do not stop ongoing work. Codes are single-use;
never reuse a prior code.`
}
