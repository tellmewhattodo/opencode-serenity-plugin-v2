/**
 * container_admin — 机务舱（specs §4.1）
 *
 * 契约：`role`（guide/validate/apply/list）/ `msm`（register/deregister/check/guide/catalog/ccc-config）/ `config`
 *
 * 🔴 **已退场（勿实现）**：`autopilot` 域（ACC 侧周期自唤醒整段删除）
 * 🔴 **注册表写保护**：`mech-registry.json` **由本工具的 msm 子域管理，不可直接编辑**
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { SerenityTool } from "./types.js"
import { resolveInRoot } from "../runtime/path-guard.js"

const NAME = "container_admin"

const REGISTRY_REL = ".opencode/skills/home-serenity/references/mech-registry.json"

const input = {
  type: "object",
  properties: {
    domain: {
      type: "string",
      enum: ["role", "msm", "config"],
      description: "管理域",
    },
    action: { type: "string", description: "子命令（见各域说明）" },
    name: { type: "string", description: "msm register/deregister：MSM 名" },
    path: { type: "string", description: "msm register：脚本相对路径" },
    category: { type: "string", description: "msm register：mech | semi-mech" },
    description: { type: "string", description: "msm register：一句话描述" },
    skill: { type: "string", description: "msm register：归属 skill" },
    flags: { type: "string", description: "msm register：flags JSON 串" },
    usage: { type: "string", description: "msm register：自定义用法" },
  },
  required: ["domain"],
  additionalProperties: false,
} as const

interface Args {
  domain: string
  action?: string
  name?: string
  path?: string
  category?: string
  description?: string
  skill?: string
  flags?: string
  usage?: string
}

interface MsmEntry {
  name: string
  skill?: string
  path: string
  category?: string
  description?: string
  flags?: unknown
  usage?: string
}

/** 读注册表（去 BOM） */
function loadRegistry(cccRoot: string): { data: { version?: number; entries: MsmEntry[] }; path: string } {
  const abs = join(cccRoot, REGISTRY_REL)
  if (!existsSync(abs)) return { data: { version: 1, entries: [] }, path: abs }
  try {
    const raw = readFileSync(abs, "utf8").replace(/^\uFEFF/, "")
    const d = JSON.parse(raw) as { version?: number; entries?: MsmEntry[] }
    return { data: { version: d.version ?? 1, entries: Array.isArray(d.entries) ? d.entries : [] }, path: abs }
  } catch {
    return { data: { version: 1, entries: [] }, path: abs }
  }
}

/** 注册表完整性检查（specs §4.3：BOM / wrapper / 字段 / name 唯一 / path 根内+存在） */
function checkRegistry(cccRoot: string): { ok: boolean; issues: string[]; count: number } {
  const abs = join(cccRoot, REGISTRY_REL)
  const issues: string[] = []
  if (!existsSync(abs)) return { ok: false, issues: ["注册表不存在"], count: 0 }

  let raw = ""
  try {
    raw = readFileSync(abs, "utf8")
  } catch (e) {
    return { ok: false, issues: [`读取失败：${String(e)}`], count: 0 }
  }
  if (raw.startsWith("\uFEFF")) issues.push("含 BOM（会致 JSON.parse 失败）")

  let d: { entries?: MsmEntry[] }
  try {
    d = JSON.parse(raw.replace(/^\uFEFF/, ""))
  } catch (e) {
    return { ok: false, issues: [`JSON 解析失败：${String(e)}`], count: 0 }
  }
  if (!Array.isArray(d.entries)) return { ok: false, issues: ["entries 非数组"], count: 0 }

  const seen = new Set<string>()
  for (const e of d.entries) {
    if (!e.name) issues.push(`条目缺 name`)
    else if (seen.has(e.name)) issues.push(`name 重复：${e.name}`)
    else seen.add(e.name)

    if (!e.path) {
      issues.push(`条目缺 path（${e.name}）`)
      continue
    }
    const r = resolveInRoot(cccRoot, e.path)
    if (!r.ok) issues.push(`path 逃逸或非法：${e.name} → ${e.path}`)
    else if (!existsSync(r.abs)) issues.push(`path 不存在：${e.name} → ${e.path}`)
  }

  return { ok: issues.length === 0, issues, count: d.entries.length }
}

export function createContainerAdminTool(cccRoot: string): SerenityTool {
  return {
    name: NAME,
    description:
      "容器机务舱：domain=role（Skiff 角色 guide/validate/apply/list）/ domain=msm（register/deregister/check/guide/catalog/ccc-config）/ domain=config（CCC 配置）。注册表写保护：不可直接编辑 mech-registry.json。",
    input,

    async execute(raw: Args) {
      const a = raw ?? ({} as Args)

      switch (a.domain) {
        // ── role ───────────────────────────────────────────────
        case "role": {
          const action = a.action ?? "list"
          if (action === "guide") {
            return {
              output: { domain: "role", action: "guide" },
              content: `Skiff 角色 —— 认知子集角色（不注入默认 9 块装配，改用 CCC 定义段全替换）

用法：
  container_admin role list            — 列出已定义角色
  container_admin role guide           — 本指南
  container_admin role validate        — 校验角色定义
  container_admin role apply <name>    — 应用角色`,
            }
          }
          if (action === "list") {
            const dir = join(cccRoot, ".opencode/skiff")
            if (!existsSync(dir)) {
              return { output: { roles: [] }, content: "(未配置 skiff 角色目录 .opencode/skiff/)" }
            }
            return { output: { dir }, content: `角色定义目录：.opencode/skiff/\n（角色清单由 CCC 侧维护）` }
          }
          return {
            output: { domain: "role", action },
            content: `⚠ role ${action}：需 CCC 侧角色定义（Phase 后续接入）`,
          }
        }

        // ── msm（注册表管理）────────────────────────────────────
        case "msm": {
          const action = a.action
          const { data, path } = loadRegistry(cccRoot)

          if (action === "check" || action === undefined) {
            const r = checkRegistry(cccRoot)
            return {
              output: { ok: r.ok, count: r.count, issues: r.issues },
              content: [
                `${r.ok ? "✓" : "✗"} 注册表完整性检查（${r.count} 条）`,
                ...r.issues.map((i) => `  ⚠ ${i}`),
                r.ok ? "  无问题" : "",
              ]
                .filter(Boolean)
                .join("\n"),
            }
          }

          if (action === "catalog") {
            const bySkill = new Map<string, number>()
            for (const e of data.entries) {
              const k = e.skill ?? "(未归属)"
              bySkill.set(k, (bySkill.get(k) ?? 0) + 1)
            }
            const lines = [...bySkill.entries()]
              .sort((x, y) => y[1] - x[1])
              .map(([s, n]) => `  ${s}: ${n} MSM`)
            return {
              output: { total: data.entries.length, bySkill: Object.fromEntries(bySkill) },
              content: `${data.entries.length} MSMs registered (by skill):\n${lines.join("\n")}`,
            }
          }

          if (action === "guide") {
            return {
              output: { domain: "msm", action: "guide" },
              content: `MSM 注册表管理指南

🔴 **写保护**：mech-registry.json 不可直接编辑，只能经本工具。

子命令：
  register   注册一个 MSM（需 name/path/category/description/skill）
  deregister 注销
  check      完整性检查（BOM/wrapper/字段/唯一/path 根内+存在）
  guide      本指南
  catalog    按 skill 统计
  ccc-config CCC 配置总览（9 段）

注册表位置：${REGISTRY_REL}`,
            }
          }

          if (action === "ccc-config") {
            const cfgPaths = ["opencode.json", ".opencode/serenity.json", "localstore.json"]
            const found = cfgPaths.filter((p) => existsSync(join(cccRoot, p)))
            return {
              output: { configs: found },
              content: [
                "CCC 配置（存在于本容器的）：",
                ...found.map((f) => `  ${f}`),
                "",
                "（9 段配置的权威读取由 ACC 运行时提供）",
              ].join("\n"),
            }
          }

          if (action === "register") {
            if (!a.name || !a.path) {
              return {
                output: { error: "missing_name_or_path" },
                content: "✗ register 需要 name 与 path",
              }
            }
            // path 逃逸校验
            const r = resolveInRoot(cccRoot, a.path)
            if (!r.ok) {
              return { output: { error: "path_escape" }, content: `✗ path 逃逸：${a.path}` }
            }
            if (data.entries.some((e) => e.name === a.name)) {
              return { output: { error: "duplicate" }, content: `✗ 已存在同名 MSM：${a.name}` }
            }
            let flags: unknown = undefined
            if (a.flags) {
              try {
                flags = JSON.parse(a.flags)
              } catch {
                return { output: { error: "bad_flags_json" }, content: "✗ flags 不是合法 JSON" }
              }
            }
            data.entries.push({
              name: a.name,
              skill: a.skill,
              path: a.path,
              category: a.category,
              description: a.description,
              flags,
              usage: a.usage,
            })
            writeFileSync(path, JSON.stringify(data, null, 2))
            return {
              output: { registered: a.name, total: data.entries.length },
              content: `✓ 已注册 ${a.name}（共 ${data.entries.length} 条）`,
            }
          }

          if (action === "deregister") {
            if (!a.name) {
              return { output: { error: "missing_name" }, content: "✗ deregister 需要 name" }
            }
            const before = data.entries.length
            data.entries = data.entries.filter((e) => e.name !== a.name)
            if (data.entries.length === before) {
              return { output: { error: "not_found", name: a.name }, content: `✗ 未找到：${a.name}` }
            }
            writeFileSync(path, JSON.stringify(data, null, 2))
            return {
              output: { deregistered: a.name, total: data.entries.length },
              content: `✓ 已注销 ${a.name}（剩 ${data.entries.length} 条）`,
            }
          }

          return {
            output: { error: "unknown_action", action },
            content: `✗ 未知 msm 子命令：${String(action)}（可用：register/deregister/check/guide/catalog/ccc-config）`,
          }
        }

        // ── config ─────────────────────────────────────────────
        case "config": {
          const files = ["opencode.json", ".opencode/serenity.json", ".serenity", ".serenity-safe-on", "localstore.json"]
          const present = files.filter((f) => existsSync(join(cccRoot, f)))
          const details: string[] = [`CCC 根: ${cccRoot}`, "", "配置文件："]
          for (const f of files) {
            details.push(`  ${present.includes(f) ? "✓" : "-"} ${f}`)
          }
          return {
            output: { root: cccRoot, present },
            content: details.join("\n"),
          }
        }

        default:
          return {
            output: { error: "unknown_domain", domain: a.domain },
            content: `✗ 未知域：${String(a.domain)}（可用：role / msm / config）`,
          }
      }
    },
  }
}
