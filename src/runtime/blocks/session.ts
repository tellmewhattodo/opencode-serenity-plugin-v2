/**
 * 块 9：Session（specs §5.9）
 *
 * 条件注入：有活跃轨迹时产出；无则整块省略（specs §5.9「无活跃会话时整块省略」）。
 *
 * 🔴 活跃轨迹解析（2026-10-14 重写，实测教训见 active-trajectory.ts 头注释）：
 *   **不再**读全局落盘指针 `AGENT_SESSIONS/.current` —— 它既是全局单值（并发串台），
 *   又会进程重启后残留陈旧值（实测 `.current`=S055 而该目录不存在 ⇒ 静默整块省略）。
 *   改为**按会话隔离的内存状态**（对齐 v1 `active-state.ts` / dsp `activeStore`），
 *   由 `container_trajectory use` 写入。
 *
 * 🔴 必附 TRAJECTORY-ASSISTANT 预声明（specs §5.9：「机制先于提醒」）。
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { getActiveTrajectory, getLastActiveTrajectory } from "../active-trajectory.js"

/** 活跃轨迹信息（与宿主会话解耦的纯数据） */
export interface ActiveTrajectory {
  /** S### 编号 */
  readonly id: string
  /** 目录名（如 `2026-09-06--S156--opencode-serenity 长期维护`） */
  readonly dirName: string
  /** SESSION.md 绝对路径 */
  readonly mdPath: string
}

/**
 * 由目录名解析轨迹信息（用于 `container_trajectory use`）。
 *
 * 返回 null ⇒ 目录不存在或缺 SESSION.md（调用方据此拒绝激活，**不制造半截状态**）。
 */
export function resolveTrajectoryDir(cccRoot: string, dirName: string): ActiveTrajectory | null {
  const mdPath = join(cccRoot, "AGENT_SESSIONS", dirName, "SESSION.md")
  if (!existsSync(mdPath)) return null
  const m = /--(S\d+)--/.exec(dirName)
  const id = m?.[1] ?? dirName
  return { id, dirName, mdPath }
}

/**
 * 取本会话的活跃轨迹。
 *
 * @param sessionID 宿主会话 id（scope）。取不到精确匹配时**不回退**到全局最近值——
 *   回退会把别的会话的轨迹注进来（串台）；精确匹配失败 ⇒ 视为无活跃轨迹。
 *   例外：sessionID 为空时（子代理继承等无 scope 场景）用最近活跃值。
 */
export function resolveActiveSession(sessionID: string): ActiveTrajectory | null {
  if (!sessionID) return getLastActiveTrajectory()
  return getActiveTrajectory(sessionID)
}

/** 构建 Session 块（无活跃轨迹 ⇒ null） */
export function buildSessionBlock(sessionID: string): string | null {
  const s = resolveActiveSession(sessionID)
  if (!s) return null

  // 短名 = 目录名去掉日期前缀与 S### 段
  const shortName = s.dirName.replace(/^\d{4}-\d{2}-\d{2}--/, "").replace(/^S\d+--/, "")

  return `=== Serenity Session ===
Active session: ${s.id} — ${s.dirName} (this session is the rebuildable carrier of the trajectory)
SESSION.md path: ${s.mdPath} (the trajectory's persistent body — stays in place through rebuilds)

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
  { content: "SESSION: ${s.id} — ${shortName}",
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

/** 读 SESSION.md 正文（供 rebuild 锚点等使用） */
export function readSessionMd(mdPath: string): string | null {
  if (!existsSync(mdPath)) return null
  try {
    return readFileSync(mdPath, "utf8")
  } catch {
    return null
  }
}
