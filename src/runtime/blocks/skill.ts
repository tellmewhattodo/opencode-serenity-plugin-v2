/**
 * 块 7：SKILL 全文（入口技能，specs §5.7）
 *
 * 纪律（specs §5.7）：
 *   - 内容 = 入口技能全文，**不截断**
 *   - **原文直推、无包裹头**（不另加抬头——来源信息由 §3.2 承载）
 *   - 多入口技能以**空行**分隔（**不得用 `---`**：那是 frontmatter 定界符）
 *   - 第二层披露树：每个入口 skill 之后附 `references/` 一级条目 + `skill.ttl`（**只有文件名、首标题与字节，不含正文**）；索引为空 ⇒ 不产出
 *
 * 入口技能发现（specs §3.2）：本实现读 `<CCC>/.serenity`（标记文件内含技能名，
 * 实测 CCC 的实际形态 —— 如 `home-serenity`），再到 `.opencode/skills/<name>/SKILL.md` 取全文。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** 读入口技能名（specs §3.2）。`.serenity` 内容 = 技能名 */
export function resolveEntrySkills(cccRoot: string): string[] {
  const marker = join(cccRoot, ".serenity")
  if (!existsSync(marker)) return []
  try {
    const names = readFileSync(marker, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
    return names
  } catch {
    return []
  }
}

/** 读某个技能的 SKILL.md 全文 */
function readSkillBody(cccRoot: string, skillName: string): string | null {
  const p = join(cccRoot, ".opencode/skills", skillName, "SKILL.md")
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}

/**
 * 第二层披露树（specs §5.7）：`references/` 一级条目 + `skill.ttl`
 * 只输出「文件名 + 首标题 + 字节」，不含正文。索引为空 ⇒ 返回 null。
 */
function buildDisclosure(cccRoot: string, skillName: string): string | null {
  const skillDir = join(cccRoot, ".opencode/skills", skillName)
  const lines: string[] = []

  const refsDir = join(skillDir, "references")
  if (existsSync(refsDir)) {
    try {
      const entries = readdirSync(refsDir, { withFileTypes: true })
        .filter((e) => e.name.endsWith(".md") || e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))

      for (const e of entries) {
        const full = join(refsDir, e.name)
        if (e.isDirectory()) {
          // 子目录：只报名字与文件数（不下潜，避免把整棵树拉进提示词）
          const n = readdirSync(full).length
          lines.push(`  references/${e.name}/ — 子目录 · ${n} 个文件`)
          continue
        }
        const bytes = statSync(full).size
        const title = firstHeading(full) ?? ""
        lines.push(`  references/${e.name} — ${title} · ${bytes} B`)
      }
    } catch {
      // 读不到就不产出该段
    }
  }

  const ttl = join(skillDir, "skill.ttl")
  if (existsSync(ttl)) {
    const bytes = statSync(ttl).size
    lines.push(`  skill.ttl — 领域本体 · ${bytes} B`)
  }

  if (lines.length === 0) return null
  return lines.join("\n")
}

/** 取 markdown 首个标题行（H1/H2）作摘要；无则 null */
function firstHeading(path: string): string | null {
  try {
    const head = readFileSync(path, "utf8").split("\n").slice(0, 40)
    for (const line of head) {
      const m = /^#{1,2}\s+(.+)$/.exec(line.trim())
      if (m) return m[1]!.trim()
    }
    return null
  } catch {
    return null
  }
}

/**
 * 构建 SKILL 块（无入口技能或读不到全文 ⇒ null，整块省略）。
 *
 * 形态：各技能 `SKILL.md` 全文（原文直推），其后附披露树；多技能以**空行**分隔。
 */
export function buildSkillBlock(cccRoot: string): string | null {
  const names = resolveEntrySkills(cccRoot)
  if (names.length === 0) return null

  const parts: string[] = []
  for (const name of names) {
    const body = readSkillBody(cccRoot, name)
    if (!body) continue
    const disclosure = buildDisclosure(cccRoot, name)
    parts.push(disclosure ? `${body}\n\n${disclosure}` : body)
  }

  if (parts.length === 0) return null
  return parts.join("\n\n") // 空行分隔 —— 不得用 `---`
}
