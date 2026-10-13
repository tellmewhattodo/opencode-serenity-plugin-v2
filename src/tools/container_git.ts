/**
 * container_git — 容器 git 操作（specs §4.1，6 动作）
 *
 * 动作：status / commit / push / log / pull / diff
 *
 * 契约要点（specs §4.1「提交-推送耦合」）：
 *   - 🔴 **commit 默认随后自动 push**（`noPush` 可关）；**push 失败不得吞**
 *   - `paths` 传 ⇒ 只提交这些路径；不传 = `add -A`（回执须**显式告知**）
 *   - push 成功判据 = `git push --porcelain` **stdout 里读到 ref 行**；
 *     读不到 ⇒ **一律不声称成功**（不得用"stderr 为空"当判据）
 *   - pull = fetch + `merge --ff-only`；非快进 ⇒ `[REJECTED]` + 建议，never auto-force
 *   - 超时：本地 / 网络**分别**可配（缺省 30s / 180s），**每次调用现读**
 */

import { spawnSync } from "node:child_process"

import type { SerenityTool } from "./types.js"

const NAME = "container_git"

const input = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["status", "commit", "push", "log", "pull", "diff"],
      description: "git 动作",
    },
    message: { type: "string", description: "commit 信息（commit 必需）" },
    paths: {
      type: "array",
      items: { type: "string" },
      description: "commit 限定路径；不传 = 整仓 add -A（回执会显式告知）",
    },
    noPush: { type: "boolean", description: "commit 后不推送（缺省自动推送）" },
    count: { type: "number", description: "log 条数（缺省 10，上限 100）" },
    ref: { type: "string", description: "diff 比较基准（如 HEAD~1）" },
    path: { type: "string", description: "diff 限定路径" },
    staged: { type: "boolean", description: "diff 显示暂存区" },
  },
  required: ["action"],
  additionalProperties: false,
} as const

/** 本地动作超时（每次现读 —— 不在模块加载时固化） */
function localTimeoutMs(): number {
  const v = Number(process.env.SERENITY_GIT_LOCAL_TIMEOUT_MS ?? 30_000)
  return Number.isFinite(v) && v > 0 ? v : 30_000
}

/** 网络动作超时（每次现读） */
function networkTimeoutMs(): number {
  const v = Number(process.env.SERENITY_GIT_NETWORK_TIMEOUT_MS ?? 180_000)
  return Number.isFinite(v) && v > 0 ? v : 180_000
}

function runGit(
  cwd: string,
  args: string[],
  timeout: number,
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
  }
}

interface Args {
  action: string
  message?: string
  paths?: string[]
  noPush?: boolean
  count?: number
  ref?: string
  path?: string
  staged?: boolean
}

export function createContainerGitTool(cccRoot: string): SerenityTool {
  return {
    name: NAME,
    description:
      "容器 git 操作（6 动作）：status/commit/push/log/pull/diff。commit 默认随后自动 push（noPush 可关）；paths 传则只提交这些路径。",
    input,

    async execute(raw: Args) {
      const a = raw ?? ({} as Args)

      switch (a.action) {
        case "status": {
          const r = runGit(cccRoot, ["status", "--porcelain=v1", "--branch"], localTimeoutMs())
          if (!r.ok && r.status === null) {
            return { output: { error: "timeout_or_failed" }, content: `✗ git status 失败：${r.stderr}` }
          }
          const lines = r.stdout.split("\n").filter((l) => l.length > 0)
          const branchLine = lines.find((l) => l.startsWith("##")) ?? ""
          const files = lines
            .filter((l) => !l.startsWith("##"))
            .map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3) }))

          // ahead/behind（specs §4.1：status 至少含 clean/files/summary/ahead/behind）
          const m = /\[ahead (\d+)(?:, behind (\d+))?\]/.exec(branchLine)
          const ahead = m ? Number(m[1]) : 0
          const behind = m && m[2] ? Number(m[2]) : 0

          const out = {
            clean: files.length === 0,
            files,
            summary: `${files.length} 项变更`,
            ahead,
            behind,
            branch: branchLine.replace(/^##\s*/, ""),
          }
          const text = files.length
            ? files.map((f) => `${f.status.padEnd(2)} ${f.file}`).join("\n")
            : "工作区干净"
          return { output: out, content: `${branchLine}\n${text}` }
        }

        case "commit": {
          if (!a.message) {
            return { output: { error: "missing_message" }, content: "✗ commit 需要 message" }
          }
          const explicitPaths = Array.isArray(a.paths) && a.paths.length > 0
          if (explicitPaths) {
            const addR = runGit(cccRoot, ["add", "--", ...a.paths!], localTimeoutMs())
            if (!addR.ok) {
              return { output: { error: "add_failed" }, content: `✗ git add 失败：${addR.stderr}` }
            }
          } else {
            const addR = runGit(cccRoot, ["add", "-A"], localTimeoutMs())
            if (!addR.ok) {
              return { output: { error: "add_failed" }, content: `✗ git add -A 失败：${addR.stderr}` }
            }
          }

          const cR = runGit(cccRoot, ["commit", "-m", a.message], localTimeoutMs())
          if (!cR.ok) {
            return {
              output: { error: "commit_failed", stderr: cR.stderr },
              content: `✗ git commit 失败：\n${cR.stderr || cR.stdout}`,
            }
          }
          const hash = runGit(cccRoot, ["rev-parse", "--short", "HEAD"], localTimeoutMs()).stdout.trim()

          const scopeNote = explicitPaths
            ? `限定路径：${a.paths!.join(", ")}`
            : "⚠️ 未传 paths ⇒ 已 `git add -A`（整仓变更一并提交）"

          // 🔴 默认随后自动 push（specs §4.1）
          if (a.noPush) {
            return {
              output: { committed: hash, scope: explicitPaths ? a.paths : "all", pushed: false },
              content: `✓ 已提交 ${hash}\n${scopeNote}\n（noPush=true ⇒ 未推送）`,
            }
          }

          const p = runGit(cccRoot, ["push", "--porcelain"], networkTimeoutMs())
          // 🔴 成功判据 = stdout 里有 ref 行；读不到一律不声称成功
          const hasRefLine = /(^|\n)\s*(refs\/|\*|\+| =|!)\S*\s/i.test(p.stdout) || /\t/.test(p.stdout)
          if (p.ok && hasRefLine) {
            return {
              output: { committed: hash, pushed: true, scope: explicitPaths ? a.paths : "all" },
              content: `✓ 已提交 ${hash} 并推送\n${scopeNote}\n${p.stdout.trim()}`,
            }
          }
          return {
            output: {
              committed: hash,
              pushed: false,
              pushStdout: p.stdout,
              pushStderr: p.stderr,
            },
            content: `⚠️ 已提交 ${hash}，但**推送未确认**（不得视为成功）\n${scopeNote}\n推送输出：\n${p.stdout || p.stderr}\n\n请核验：git ls-remote origin`,
          }
        }

        case "push": {
          const p = runGit(cccRoot, ["push", "--porcelain"], networkTimeoutMs())
          const hasRefLine = /(^|\n)\s*(refs\/|\*|\+| =|!)\S*\s/i.test(p.stdout) || /\t/.test(p.stdout)
          if (p.ok && hasRefLine) {
            return { output: { pushed: true }, content: `✓ 已推送\n${p.stdout.trim()}` }
          }
          return {
            output: { pushed: false, stdout: p.stdout, stderr: p.stderr },
            content: `⚠️ 推送未确认（不得视为成功）\n${p.stdout || p.stderr}\n\n请核验：git ls-remote origin`,
          }
        }

        case "log": {
          const n = Math.min(Math.max(Math.trunc(a.count ?? 10), 1), 100)
          const r = runGit(cccRoot, ["log", `-${n}`, "--oneline", "--decorate"], localTimeoutMs())
          if (!r.ok) {
            return { output: { error: "log_failed" }, content: `✗ git log 失败：${r.stderr}` }
          }
          return { output: { count: n, log: r.stdout.trim() }, content: r.stdout.trim() }
        }

        case "pull": {
          const f = runGit(cccRoot, ["fetch"], networkTimeoutMs())
          if (!f.ok) {
            return { output: { error: "fetch_failed" }, content: `✗ git fetch 失败：${f.stderr}` }
          }
          const m = runGit(cccRoot, ["merge", "--ff-only"], localTimeoutMs())
          if (m.ok) {
            return { output: { pulled: true }, content: `✓ 已快进合并\n${m.stdout.trim()}` }
          }
          // 🔴 非快进 ⇒ [REJECTED] + 建议，never auto-force
          return {
            output: { pulled: false, rejected: true },
            content: `[REJECTED] 非快进合并：${m.stderr.trim() || m.stdout.trim()}\n建议：先 rebase 或手动解决冲突（本工具**不会**自动 force）。`,
          }
        }

        case "diff": {
          const args = ["diff"]
          if (a.staged) args.push("--cached")
          if (a.ref) args.push(a.ref)
          if (a.path) args.push("--", a.path)
          const r = runGit(cccRoot, args, localTimeoutMs())
          if (!r.ok) {
            return { output: { error: "diff_failed" }, content: `✗ git diff 失败：${r.stderr}` }
          }
          return { output: { diff: r.stdout }, content: r.stdout || "（无差异）" }
        }

        default:
          return {
            output: { error: "unknown_action", action: a.action },
            content: `✗ 未知动作：${String(a.action)}（可用：status/commit/push/log/pull/diff）`,
          }
      }
    },
  }
}
