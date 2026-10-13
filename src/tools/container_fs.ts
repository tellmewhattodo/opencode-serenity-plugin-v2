/**
 * container_fs — 容器文件系统（specs §4.1，15 子命令）
 *
 * 契约：root / resolve / exists / list / tree / relative / mkdir / rm /
 *       mv / cp / touch / append / reveal / info / find
 *
 * 纪律：
 *   - **所有路径过 CCC 边界守卫**（path-guard）；逃逸一律拒绝并说明
 *   - 破坏性操作（rm/mv/cp 覆盖）支持 dryRun 预览
 *   - 输出结构化（content 供模型读，output 供程序读）
 */

import {
  existsSync,
  statSync,
  mkdirSync,
  rmSync,
  renameSync,
  cpSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  utimesSync,
} from "node:fs"
import { basename, join } from "node:path"

import type { SerenityTool } from "./types.js"
import { resolveInRoot } from "../runtime/path-guard.js"

const NAME = "container_fs"

const SUBCOMMANDS = [
  "root",
  "resolve",
  "exists",
  "list",
  "tree",
  "relative",
  "mkdir",
  "rm",
  "mv",
  "cp",
  "touch",
  "append",
  "reveal",
  "info",
  "find",
] as const

const input = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: SUBCOMMANDS as unknown as string[],
      description: "子命令",
    },
    path: { type: "string", description: "主路径参数（相对 CCC 根或根内绝对路径）" },
    paths: { type: "array", items: { type: "string" }, description: "批量路径（mkdir/rm）" },
    src: { type: "string", description: "mv/cp 源" },
    dst: { type: "string", description: "mv/cp 目标" },
    content: { type: "string", description: "append 内容" },
    pattern: { type: "string", description: "find 匹配（glob *? 或大小写不敏感子串）" },
    depth: { type: "number", description: "tree 最大深度（1-10，缺省 3）" },
    maxDepth: { type: "number", description: "find 最大递归深度" },
    filesOnly: { type: "boolean", description: "tree 仅文件" },
    dirsOnly: { type: "boolean", description: "tree 仅目录" },
    absolute: { type: "boolean", description: "find 返回绝对路径" },
    dryRun: { type: "boolean", description: "rm/mv/cp 预览（不实际执行）" },
    recursive: { type: "boolean", description: "rm 目录 / cp 目录需 true" },
  },
  required: ["action"],
  additionalProperties: false,
} as const

interface Args {
  action: string
  path?: string
  paths?: string[]
  src?: string
  dst?: string
  content?: string
  pattern?: string
  depth?: number
  maxDepth?: number
  filesOnly?: boolean
  dirsOnly?: boolean
  absolute?: boolean
  dryRun?: boolean
  recursive?: boolean
}

/** 把 glob（仅 `*` `?`）转成正则 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const body = escaped.replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${body}$`, "i")
}

/** 递归遍历（受 maxDepth 限制） */
function walk(
  dir: string,
  maxDepth: number,
  visit: (abs: string, rel: string, depth: number, isDir: boolean) => void,
  root: string,
  depth = 0,
): void {
  if (depth > maxDepth) return
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = join(dir, e.name)
    const isDir = e.isDirectory()
    visit(abs, abs.slice(root.length + 1), depth, isDir)
    if (isDir && depth < maxDepth) walk(abs, maxDepth, visit, root, depth + 1)
  }
}

export function createContainerFsTool(cccRoot: string): SerenityTool {
  return {
    name: NAME,
    description:
      "容器文件系统（路径限定在 CCC 根内，逃逸自动阻断）。15 子命令：root/resolve/exists/list/tree/relative/mkdir/rm/mv/cp/touch/append/reveal/info/find。",
    input,

    async execute(raw: Args) {
      const a = raw ?? ({} as Args)
      const action = a.action

      /** 解析并守卫；失败直接返回统一错误 */
      const guard = (p: string | undefined) => {
        if (p === undefined) {
          return { ok: false as const, text: `✗ ${action} 需要 path 参数` }
        }
        const r = resolveInRoot(cccRoot, p)
        if (!r.ok) {
          return {
            ok: false as const,
            text: `✗ 路径逃逸被阻断：${p}\n  CCC 根 = ${cccRoot}\n  判据 = 目标不在根内（RR5）`,
          }
        }
        return { ok: true as const, abs: r.abs, rel: r.rel }
      }

      switch (action) {
        // ── 只读类 ────────────────────────────────────────────
        case "root":
          return { output: { root: cccRoot }, content: cccRoot }

        case "resolve": {
          const g = guard(a.path)
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          return {
            output: { abs: g.abs, rel: g.rel },
            content: `abs: ${g.abs}\nrel: ${g.rel}`,
          }
        }

        case "exists": {
          const g = guard(a.path)
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          const e = existsSync(g.abs)
          return { output: { exists: e, path: g.rel }, content: e ? "true" : "false" }
        }

        case "list": {
          const g = guard(a.path)
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          if (!existsSync(g.abs)) {
            return { output: { error: "not_found", path: g.rel }, content: `✗ 不存在：${g.rel}` }
          }
          try {
            const entries = readdirSync(g.abs, { withFileTypes: true }).map((e) => {
              const full = join(g.abs, e.name)
              let size = 0
              try {
                if (!e.isDirectory()) size = statSync(full).size
              } catch {
                /* 忽略不可读项 */
              }
              return { name: e.name, type: e.isDirectory() ? "dir" : "file", size }
            })
            const lines = entries.map(
              (e) =>
                `${e.type === "dir" ? "d" : "-"} ${String(e.size).padStart(10)} ${e.name}`,
            )
            return {
              output: { path: g.rel, entries, count: entries.length },
              content: `${g.rel}/ (${entries.length})\n${lines.join("\n")}`,
            }
          } catch (err) {
            return { output: { error: String(err) }, content: `✗ 读取失败：${String(err)}` }
          }
        }

        case "tree": {
          const g = guard(a.path ?? ".")
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          const depth = Math.min(Math.max(Math.trunc(a.depth ?? 3), 1), 10)
          const lines: string[] = [`${g.rel}/`]
          let count = 0
          walk(
            g.abs,
            depth,
            (_abs, rel, d, isDir) => {
              if (a.filesOnly && isDir) return
              if (a.dirsOnly && !isDir) return
              const name = basename(rel)
              lines.push(`${"  ".repeat(d + 1)}${name}${isDir ? "/" : ""}`)
              count++
            },
            g.abs,
          )
          return {
            output: { path: g.rel, depth, count },
            content: lines.join("\n"),
          }
        }

        case "relative": {
          const g = guard(a.path)
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          return { output: { rel: g.rel }, content: g.rel }
        }

        case "info": {
          const g = guard(a.path)
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          if (!existsSync(g.abs)) {
            return { output: { error: "not_found", path: g.rel }, content: `✗ 不存在：${g.rel}` }
          }
          const st = statSync(g.abs)
          const info = {
            rel: g.rel,
            abs: g.abs,
            type: st.isDirectory() ? "dir" : "file",
            size: st.size,
            mtime: st.mtime.toISOString(),
          }
          return {
            output: info,
            content: `path: ${info.rel}\ntype: ${info.type}\nsize: ${info.size}\nmtime: ${info.mtime}`,
          }
        }

        case "find": {
          const g = guard(a.path ?? ".")
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          const pat = a.pattern ?? "*"
          const re = globToRegExp(pat)
          const maxDepth = a.maxDepth ?? 20
          const hits: string[] = []
          walk(
            g.abs,
            maxDepth,
            (abs, rel) => {
              if (re.test(basename(abs))) hits.push(a.absolute ? abs : rel)
            },
            g.abs,
          )
          return {
            output: { pattern: pat, count: hits.length, matches: hits },
            content: hits.length
              ? `${hits.length} 命中（pattern=${pat}）\n${hits.join("\n")}`
              : `无命中（pattern=${pat}）`,
          }
        }

        // ── 写入类 ────────────────────────────────────────────
        case "mkdir": {
          const targets = a.paths ?? (a.path ? [a.path] : [])
          if (targets.length === 0) {
            return { output: { error: "missing_path" }, content: "✗ mkdir 需要 path 或 paths" }
          }
          const resolved: string[] = []
          for (const t of targets) {
            const r = resolveInRoot(cccRoot, t)
            if (!r.ok) {
              return { output: { error: "path_escape" }, content: `✗ 路径逃逸被阻断：${t}` }
            }
            resolved.push(r.abs)
          }
          if (a.dryRun) {
            return {
              output: { dryRun: true, wouldCreate: resolved },
              content: `[dry-run] 将创建 ${resolved.length} 个目录\n${resolved.join("\n")}`,
            }
          }
          for (const p of resolved) mkdirSync(p, { recursive: true })
          return {
            output: { created: resolved },
            content: `✓ 已创建 ${resolved.length} 个目录\n${resolved.join("\n")}`,
          }
        }

        case "rm": {
          const targets = a.paths ?? (a.path ? [a.path] : [])
          if (targets.length === 0) {
            return { output: { error: "missing_path" }, content: "✗ rm 需要 path 或 paths" }
          }
          const resolved: string[] = []
          for (const t of targets) {
            const r = resolveInRoot(cccRoot, t)
            if (!r.ok) {
              return { output: { error: "path_escape" }, content: `✗ 路径逃逸被阻断：${t}` }
            }
            if (r.rel === ".") {
              return { output: { error: "refuse_root" }, content: "✗ 拒绝删除 CCC 根自身" }
            }
            resolved.push(r.abs)
          }
          if (a.dryRun) {
            return {
              output: { dryRun: true, wouldRemove: resolved },
              content: `[dry-run] 将删除 ${resolved.length} 项\n${resolved.join("\n")}`,
            }
          }
          for (const p of resolved) {
            if (!existsSync(p)) continue
            const isDir = statSync(p).isDirectory()
            if (isDir && !a.recursive) {
              return {
                output: { error: "need_recursive", path: p },
                content: `✗ ${p} 是目录 ⇒ 需 recursive=true`,
              }
            }
            rmSync(p, { recursive: a.recursive === true, force: true })
          }
          return {
            output: { removed: resolved },
            content: `✓ 已删除 ${resolved.length} 项\n${resolved.join("\n")}`,
          }
        }

        case "mv": {
          if (!a.src || !a.dst) {
            return { output: { error: "missing_src_dst" }, content: "✗ mv 需要 src 与 dst" }
          }
          const s = resolveInRoot(cccRoot, a.src)
          const d = resolveInRoot(cccRoot, a.dst)
          if (!s.ok || !d.ok) {
            return { output: { error: "path_escape" }, content: "✗ 路径逃逸被阻断" }
          }
          if (a.dryRun) {
            return {
              output: { dryRun: true, from: s.rel, to: d.rel },
              content: `[dry-run] ${s.rel} → ${d.rel}`,
            }
          }
          if (!existsSync(s.abs)) {
            return { output: { error: "not_found", path: s.rel }, content: `✗ 不存在：${s.rel}` }
          }
          renameSync(s.abs, d.abs)
          return { output: { from: s.rel, to: d.rel }, content: `✓ ${s.rel} → ${d.rel}` }
        }

        case "cp": {
          if (!a.src || !a.dst) {
            return { output: { error: "missing_src_dst" }, content: "✗ cp 需要 src 与 dst" }
          }
          const s = resolveInRoot(cccRoot, a.src)
          const d = resolveInRoot(cccRoot, a.dst)
          if (!s.ok || !d.ok) {
            return { output: { error: "path_escape" }, content: "✗ 路径逃逸被阻断" }
          }
          if (a.dryRun) {
            return {
              output: { dryRun: true, from: s.rel, to: d.rel },
              content: `[dry-run] 复制 ${s.rel} → ${d.rel}`,
            }
          }
          if (!existsSync(s.abs)) {
            return { output: { error: "not_found", path: s.rel }, content: `✗ 不存在：${s.rel}` }
          }
          cpSync(s.abs, d.abs, { recursive: a.recursive === true, force: true })
          return { output: { from: s.rel, to: d.rel }, content: `✓ 复制 ${s.rel} → ${d.rel}` }
        }

        case "touch": {
          const g = guard(a.path)
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          if (!existsSync(g.abs)) writeFileSync(g.abs, "")
          else {
            const now = new Date()
            utimesSync(g.abs, now, now)
          }
          return { output: { touched: g.rel }, content: `✓ 已更新 ${g.rel}` }
        }

        case "append": {
          const g = guard(a.path)
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          const text = a.content ?? ""
          appendFileSync(g.abs, text)
          let size = 0
          try {
            size = statSync(g.abs).size
          } catch {
            /* 忽略 */
          }
          return {
            output: { path: g.rel, appended: text.length, size },
            content: `✓ 已追加 ${text.length} 字符到 ${g.rel}（现 ${size} B）`,
          }
        }

        case "reveal": {
          const g = guard(a.path)
          if (!g.ok) return { output: { error: "path_escape" }, content: g.text }
          // 宿主环境无 GUI 时不可用 ⇒ 返回路径供上层处置（不假装成功）
          return {
            output: { path: g.abs, note: "reveal 需宿主 GUI；此处返回绝对路径" },
            content: g.abs,
          }
        }

        default:
          return {
            output: { error: "unknown_action", action },
            content: `✗ 未知子命令：${String(action)}\n可用：${SUBCOMMANDS.join(" / ")}`,
          }
      }
    },
  }
}
