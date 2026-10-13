/**
 * msm — MSM 单入口执行与发现（specs §4.1）
 *
 * 契约：
 *   - `msm(name, args)` 执行；name 未命中 ⇒ **模糊候选**
 *   - `inspect=true` ⇒ 查用法（不执行）
 *   - 无 name ⇒ **分类目录**
 *   - 单级聚合注册表；**path 逃逸校验**；**600s 超时**
 *
 * 注册表位置（specs §3/§4.3）：`<CCC>/.opencode/skills/home-serenity/references/mech-registry.json`
 * 格式：`{ version: 1, entries: [{ name, skill, path, category, description, flags?, usage? }] }`
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { SerenityTool } from "./types.js"

const NAME = "msm"

/** 执行超时（specs §4.1：600s） */
const EXEC_TIMEOUT_MS = 600_000

const input = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "MSM 名（部分名 ⇒ 返回模糊候选）；省略 ⇒ 分类目录",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "传给 MSM 的参数（缺省 []）",
    },
    inspect: {
      type: "boolean",
      description: "true ⇒ 只看用法（--help），不执行",
    },
  },
  additionalProperties: false,
} as const

interface MsmEntry {
  name: string
  skill?: string
  path: string
  category?: string
  description?: string
  usage?: string
}

interface Registry {
  version?: number
  entries?: MsmEntry[]
}

/** 读注册表（去 BOM —— 历史踩坑） */
function loadRegistry(cccRoot: string): { entries: MsmEntry[]; error?: string } {
  const p = join(cccRoot, ".opencode/skills/home-serenity/references/mech-registry.json")
  if (!existsSync(p)) return { entries: [], error: `注册表不存在：${p}` }
  try {
    const raw = readFileSync(p, "utf8").replace(/^\uFEFF/, "")
    const data = JSON.parse(raw) as Registry
    if (!Array.isArray(data.entries)) return { entries: [], error: "entries 非数组" }
    return { entries: data.entries }
  } catch (e) {
    return { entries: [], error: `解析失败：${String(e)}` }
  }
}

/** 分类目录（按 skill 分组） */
function summarize(entries: MsmEntry[]): string {
  const bySkill = new Map<string, MsmEntry[]>()
  for (const e of entries) {
    const k = e.skill ?? "(未归属)"
    if (!bySkill.has(k)) bySkill.set(k, [])
    bySkill.get(k)!.push(e)
  }
  const lines: string[] = [`${entries.length} MSMs registered (by skill):`]
  for (const [skill, list] of [...bySkill.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${skill}: ${list.length} MSM`)
  }
  lines.push("")
  lines.push('Execute: msm("<name>", ["<arg>"]) — partial name returns candidates')
  lines.push('Inspect: msm("<name>", [], inspect=true)')
  return lines.join("\n")
}

/** 模糊匹配候选 */
function candidates(entries: MsmEntry[], q: string): MsmEntry[] {
  const lower = q.toLowerCase()
  return entries.filter(
    (e) => e.name.toLowerCase().includes(lower) || lower.includes(e.name.toLowerCase()),
  )
}

interface Args {
  name?: string
  args?: string[]
  inspect?: boolean
}

export function createMsmTool(cccRoot: string): SerenityTool {
  return {
    name: NAME,
    description:
      "执行一个已注册的 CCC MSM：msm(name, args)。name 未命中返回模糊候选；inspect=true 查用法；无参返回分类目录。",
    input,

    async execute(raw: Args) {
      const a = raw ?? ({} as Args)
      const { entries, error } = loadRegistry(cccRoot)
      if (error && entries.length === 0) {
        return { output: { error }, content: `✗ ${error}` }
      }

      // ── 无 name ⇒ 分类目录 ──────────────────────────────────
      if (!a.name) {
        return { output: { total: entries.length }, content: summarize(entries) }
      }

      // ── 精确命中 ────────────────────────────────────────────
      let entry = entries.find((e) => e.name === a.name)

      // ── 未命中 ⇒ 模糊候选（不执行）──────────────────────────
      if (!entry) {
        const cands = candidates(entries, a.name)
        if (cands.length === 0) {
          return {
            output: { error: "not_found", query: a.name },
            content: `✗ 未找到 MSM「${a.name}」，也无近似候选。\n用 msm() 无参查看全部 ${entries.length} 个。`,
          }
        }
        return {
          output: { candidates: cands.map((c) => c.name) },
          content: `未精确命中「${a.name}」；候选：\n${cands
            .map((c) => `  ${c.name} — ${c.description ?? ""}`)
            .join("\n")}`,
        }
      }

      // 🔴 注册表 path 逃逸校验（specs §4.1）
      const scriptAbs = join(cccRoot, entry.path)
      const norm = join(cccRoot, entry.path)
      if (!norm.startsWith(cccRoot)) {
        return {
          output: { error: "path_escape", path: entry.path },
          content: `✗ 注册表项 path 逃逸：${entry.path}`,
        }
      }
      if (!existsSync(scriptAbs)) {
        return {
          output: { error: "script_missing", path: entry.path },
          content: `✗ 脚本不存在：${entry.path}`,
        }
      }

      // ── inspect ⇒ 只查用法 ──────────────────────────────────
      if (a.inspect) {
        return {
          output: {
            name: entry.name,
            skill: entry.skill,
            category: entry.category,
            path: entry.path,
            usage: entry.usage,
            description: entry.description,
          },
          content: [
            `${entry.name}${entry.category ? `  [${entry.category}]` : ""}`,
            `skill: ${entry.skill ?? "-"}`,
            `path: ${entry.path}`,
            entry.description ? `desc: ${entry.description}` : "",
            entry.usage ? `usage: ${entry.usage}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        }
      }

      // ── 执行 ────────────────────────────────────────────────
      const argv = Array.isArray(a.args) ? a.args : []
      const r = spawnSync("npx", ["tsx", scriptAbs, ...argv], {
        cwd: cccRoot,
        encoding: "utf8",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      })

      const stdout = r.stdout ?? ""
      const stderr = r.stderr ?? ""
      const timedOut = r.status === null && r.signal !== null

      if (timedOut) {
        return {
          output: { error: "timeout", msm: entry.name, timeoutMs: EXEC_TIMEOUT_MS },
          content: `✗ ${entry.name} 超时（${EXEC_TIMEOUT_MS}ms）\n${stderr.slice(0, 2000)}`,
        }
      }

      const out = {
        msm: entry.name,
        exit: r.status ?? -1,
        stdout,
        stderr,
      }

      // stdout 可能很大 ⇒ 内容里给截断预览，完整在 output
      const preview = stdout.length > 8000 ? `${stdout.slice(0, 8000)}\n…（截断，完整见 output）` : stdout
      const text = stderr && !stdout ? `exit=${out.exit}\n${stderr}` : preview

      return { output: out, content: text || `（无输出，exit=${out.exit}）` }
    },
  }
}
