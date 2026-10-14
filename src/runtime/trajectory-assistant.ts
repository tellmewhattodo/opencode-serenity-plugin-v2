/**
 * trajectory-assistant（specs §5.11）
 *
 * 目的：督促 LLM 记录 SESSION.md —— session 是 trajectory 的**可重建载体**，
 *   载体可丢但轨迹身体不可断更。
 *
 * 计分（specs §5.11）：write/edit=3 · task=10 · read/grep/glob/msm=1 · **+1 分/分钟**
 * 阈值：CCC 配置 `sessionKeeper.threshold`
 *
 * token 体系（每个 token = `[TRAJECTORY-ASSISTANT · <LABEL>]`）：
 *   | CHECKPOINT          | 计分达阈值 | **有 ACK**（recorded/skipped，3 位码） |
 *   | · LIMIT             | 上下文压力 rebuild 提醒 | 无 ACK |
 *   | · LIMIT · MANDATORY | 连续多轮未 rebuild ⇒ 升级语气 | 无 ACK |
 *   | · LOGBOOK COMPACTION| SESSION.md 体积超限 ⇒ **重写** | 无 ACK（故**不需预声明**） |
 *   | SCRATCH PRUNE       | REBUILD-TODO.md 超限 ⇒ **清理** | 无 ACK |
 *
 * 🔴 三条硬规矩：
 *   ① **LOGBOOK COMPACTION 与 SCRATCH PRUNE 不得合并**（共用一个 token 会让模型误以为要动 SESSION.md）
 *   ② **两条体积提醒必须含 frontmatter 护栏**：提醒文案须含「保留文件顶部的 YAML frontmatter 原样」
 *   ③ 体积提醒**只提醒，不做任何写/删/归档**（自动删 = 数据丢失风险）
 *
 * v2 落点：计分靠 `tool.hook("execute.after")` 观察工具使用；提醒注入靠 `session.hook("context")`。
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { SessionHookRegistrar, ToolHookRegistrar } from "../tools/types.js"
import { detectContainer } from "./ccc.js"
import { resolveActiveSession } from "./blocks/session.js"

/** 工具 → 分值（specs §5.11） */
const TOOL_SCORES: Record<string, number> = {
  write: 3,
  edit: 3,
  task: 10,
  subagent: 10,
  read: 1,
  grep: 1,
  glob: 1,
  msm: 1,
}

/** 缺省阈值（CCC 未配置时） */
const DEFAULT_THRESHOLD = 100

/** 每会话的计分状态（进程内；specs：**不跨会话持久化**） */
interface SessionScore {
  score: number
  lastTickMs: number
  pendingCode: string | null
  limitRounds: number
  logbookRounds: number
  scratchRounds: number
}

const scores = new Map<string, SessionScore>()

/** 仅供测试 */
export function __resetAssistant(): void {
  scores.clear()
}

function state(sessionID: string): SessionScore {
  let s = scores.get(sessionID)
  if (!s) {
    s = { score: 0, lastTickMs: Date.now(), pendingCode: null, limitRounds: 0, logbookRounds: 0, scratchRounds: 0 }
    scores.set(sessionID, s)
  }
  return s
}

/** 生成 3 位随机 ACK 码（字母+数字） */
export function makeAckCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let out = ""
  for (let i = 0; i < 3; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

/** 读 CCC 的 sessionKeeper 配置 */
export function loadKeeperConfig(cccRoot: string): { threshold: number; sessionMdMaxKB: number } {
  const p = join(cccRoot, ".opencode/serenity.json")
  let threshold = DEFAULT_THRESHOLD
  let sessionMdMaxKB = 0
  if (existsSync(p)) {
    try {
      const d = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")) as {
        sessionKeeper?: { threshold?: number; sessionMdMaxKB?: number }
      }
      if (typeof d.sessionKeeper?.threshold === "number") threshold = d.sessionKeeper.threshold
      if (typeof d.sessionKeeper?.sessionMdMaxKB === "number") sessionMdMaxKB = d.sessionKeeper.sessionMdMaxKB
    } catch {
      // 配置损坏 ⇒ 用缺省（不阻断）
    }
  }
  return { threshold, sessionMdMaxKB }
}

/** 累计时间分（+1 分/分钟） */
function accrueTime(s: SessionScore): void {
  const now = Date.now()
  const minutes = Math.floor((now - s.lastTickMs) / 60_000)
  if (minutes > 0) {
    s.score += minutes
    s.lastTickMs += minutes * 60_000
  }
}

/** 记一次工具使用 */
export function recordToolUse(sessionID: string, tool: string): void {
  const s = state(sessionID)
  accrueTime(s)
  const delta = TOOL_SCORES[tool.toLowerCase()]
  if (typeof delta === "number") s.score += delta
}

/**
 * 构建 CHECKPOINT 提醒（含 ACK 协议）。
 * specs：持续注入直至收到正确 code。
 */
export function buildCheckpoint(score: number, threshold: number, code: string): string {
  return `[TRAJECTORY-ASSISTANT · CHECKPOINT] Score threshold reached (${score}/${threshold}). Please acknowledge with [TRAJECTORY-ASSISTANT-recorded-${code}] once progress is synced to the working session. No need to interrupt your work — just acknowledge inline and keep going.`
}

/** 构建 LOGBOOK COMPACTION 提醒（🔴 必须含 frontmatter 护栏） */
export function buildLogbookCompaction(kb: number, maxKB: number, rounds: number): string {
  const mandatory = rounds >= 3 ? " (MANDATORY — this is the 3rd+ consecutive round)" : ""
  return `[TRAJECTORY-ASSISTANT · LOGBOOK COMPACTION]${mandatory} SESSION.md is ${kb} KB (limit ${maxKB} KB). Please REWRITE it on the EAP skeleton: ① keep the layered skeleton ② move detail out to references files (leave links) ③ integrate or drop stale items ④ you have full discretion — the only hard requirement is that the skeleton plus open questions / decision rationale / next step remain reconstructable.

🔴 **保留文件顶部的 YAML frontmatter 原样**（那是轨迹 skill 声明的唯一真相源）。

(Reminder only — the ACC does not write, delete, or archive anything on your behalf.)`
}

/** 构建 SCRATCH PRUNE 提醒（🔴 与 LOGBOOK COMPACTION 刻意分开） */
export function buildScratchPrune(kb: number, maxKB: number, rounds: number): string {
  const mandatory = rounds >= 3 ? " (MANDATORY — this is the 3rd+ consecutive round)" : ""
  return `[TRAJECTORY-ASSISTANT · SCRATCH PRUNE]${mandatory} REBUILD-TODO.md is ${kb} KB (limit ${maxKB} KB). Please CLEAN IT UP: delete finished items, delete superseded items, delete items already recorded in SESSION.md. Deleting the whole file is explicitly allowed.

🔴 **保留文件顶部的 YAML frontmatter 原样**（若有）。

(Reminder only — this asks for **cleanup**, not a SESSION.md rewrite; the ACC never writes or deletes anything itself.)`
}

/** 检测 ACK 是否出现（recorded / skipped），出现即清零 */
export function checkAck(sessionID: string, systemTexts: string[]): boolean {
  const s = state(sessionID)
  if (!s.pendingCode) return false
  const joined = systemTexts.join("\n")
  const re = new RegExp(`\\[TRAJECTORY-ASSISTANT-(?:recorded|skipped)-${s.pendingCode}\\]`)
  if (re.test(joined)) {
    s.score = 0
    s.pendingCode = null
    return true
  }
  return false
}

/** 计算提醒（不改状态；由调用方决定是否 commit） */
function computeReminders(
  sessionID: string,
  cccRoot: string,
  cfg: { threshold: number; sessionMdMaxKB: number },
): string[] {
  const s = state(sessionID)
  accrueTime(s)
  const out: string[] = []

  // ── CHECKPOINT（有 ACK）──────────────────────────────────
  if (s.score >= cfg.threshold) {
    if (!s.pendingCode) s.pendingCode = makeAckCode()
    out.push(buildCheckpoint(s.score, cfg.threshold, s.pendingCode))
  } else {
    s.pendingCode = null
  }

  // ── LOGBOOK COMPACTION（SESSION.md 体积）─────────────────
  if (cfg.sessionMdMaxKB > 0) {
    const active = resolveActiveSession(cccRoot)
    if (active && existsSync(active.sessionPath)) {
      try {
        const kb = Math.round(statSync(active.sessionPath).size / 1024)
        if (kb > cfg.sessionMdMaxKB) {
          s.logbookRounds += 1
          out.push(buildLogbookCompaction(kb, cfg.sessionMdMaxKB, s.logbookRounds))
        } else {
          s.logbookRounds = 0 // 回到限内 ⇒ 自愈
        }
      } catch {
        /* 读不到 ⇒ 跳过 */
      }
    }
  }

  // ── SCRATCH PRUNE（REBUILD-TODO.md 体积）铜 —— 独立条件 ──
  if (cfg.sessionMdMaxKB > 0) {
    const active = resolveActiveSession(cccRoot)
    if (active) {
      const todoPath = join(cccRoot, "AGENT_SESSIONS", active.dirName, "REBUILD-TODO.md")
      if (existsSync(todoPath)) {
        try {
          const kb = Math.round(statSync(todoPath).size / 1024)
          if (kb > cfg.sessionMdMaxKB) {
            s.scratchRounds += 1
            out.push(buildScratchPrune(kb, cfg.sessionMdMaxKB, s.scratchRounds))
          } else {
            s.scratchRounds = 0
          }
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  return out
}

/**
 * 注册 trajectory-assistant。
 *
 * @returns disposers
 */
export async function registerTrajectoryAssistant(
  ctx: SessionHookRegistrar & ToolHookRegistrar,
): Promise<Array<() => Promise<void>>> {
  const disposers: Array<() => Promise<void>> = []

  // ① 计分：观察工具使用（execute.after）
  const scoreReg = await ctx.tool.hook("execute.after", (event: unknown) => {
    const e = event as { tool?: string; sessionID?: unknown }
    const sessionID = String(e?.sessionID ?? "")
    if (!sessionID) return
    recordToolUse(sessionID, String(e?.tool ?? ""))
  })
  disposers.push(() => scoreReg.dispose())

  // ② 注入提醒（context hook；与注入面共用同一 hook，但独立注册）
  const injectReg = await ctx.session.hook("context", async (input: unknown) => {
    const it = input as { sessionID?: unknown; system?: unknown }
    const sessionID = String(it.sessionID ?? "")
    if (!sessionID || !Array.isArray(it.system)) return

    const cc = await detectContainer(ctx, sessionID)
    if (!cc.isContainer || !cc.root) return

    const texts = (it.system as Array<{ text?: string }>)
      .map((p) => String(p?.text ?? ""))
      .filter(Boolean)

    // 先查 ACK（收到正确码 ⇒ 清零，本轮不再提醒）
    if (checkAck(sessionID, texts)) return

    const cfg = loadKeeperConfig(cc.root)
    const reminders = computeReminders(sessionID, cc.root, cfg)
    for (const r of reminders) {
      ;(it.system as Array<{ type: string; text: string }>).push({ type: "text", text: r })
    }
  })
  disposers.push(() => injectReg.dispose())

  return disposers
}
