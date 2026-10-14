/**
 * registry 写保护（specs §4.3 / §5.8 never edit mech-registry.json directly）
 *
 * 语义：**阻止对 mech-registry.json 的直接写入** —— 该文件只能经
 * container_admin msm register/deregister 修改（那是唯一的合规写入路径）。
 *
 * v2 落点：ctx.tool.hook("execute.before", …)
 *
 * 🔴 拦截机制（依据 tool.d.ts 的实际签名）：
 *   execute.before 的 payload 为 { tool, sessionID, agent, messageID, id, input }
 *   —— 其中 tool 与 input **未标 readonly** ⇒ 可变；
 *   但**没有决策字段**（不像 v1 的 permission.ask 有 output.status）
 *   ⇒ 唯一可靠的阻断方式 = **抛异常**（让工具调用失败）。
 *   改 input 只是"绕过"，不是"阻断"，不作为主手段。
 *
 * 覆盖路径（与 v1 的 isRegistryPathBlocked 语义对齐）：
 *   - <CCC>/references/mech-registry.json（容器级）
 *   - <CCC>/.opencode/skills/<skill>/references/mech-registry.json（技能级）
 */

import { sep } from "node:path"

import type { ToolHookRegistrar } from "../tools/types.js"

/** 受保护的文件名 */
const PROTECTED_BASENAMES = new Set(["mech-registry.json"])

/** 会对路径做写入的工具（读不拦） */
const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit"])

/**
 * 判断某工具调用是否在写受保护文件。
 *
 * 说明：不同工具的 input 形状不同（write: {filePath}；edit: {filePath}；patch: {…}）
 * ⇒ 这里**深挖所有字符串字段**里像路径的值，命中 basename 即视为触碰。
 * 这样不依赖具体 schema，对新工具也稳健（宁可误拦，不可漏放）。
 */
export function hitsProtectedRegistry(tool: string, input: unknown): { hit: boolean; path?: string } {
  if (!WRITE_TOOLS.has(tool)) return { hit: false }

  const seen = new Set<unknown>()
  const stack: unknown[] = [input]
  let guard = 0

  while (stack.length > 0 && guard++ < 500) {
    const cur = stack.pop()
    if (cur === null || cur === undefined) continue
    if (typeof cur === "string") {
      // 用 basename 判定（不依赖 cwd）
      const parts = cur.split(/[\\/]/)
      const base = parts[parts.length - 1]
      if (base && PROTECTED_BASENAMES.has(base)) {
        return { hit: true, path: cur }
      }
      continue
    }
    if (typeof cur !== "object") continue
    if (seen.has(cur)) continue
    seen.add(cur)

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v)
      continue
    }
    for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v)
  }

  return { hit: false }
}

/**
 * 注册 registry 写保护。
 *
 * @returns disposers
 */
export async function registerRegistryGuard(
  ctx: ToolHookRegistrar,
): Promise<Array<() => Promise<void>>> {
  const reg = await ctx.tool.hook("execute.before", (event: unknown) => {
    const e = event as { tool?: string; input?: unknown }
    const tool = String(e?.tool ?? "")
    const r = hitsProtectedRegistry(tool, e?.input)
    if (!r.hit) return

    // 🔴 唯一可靠的阻断 = 抛异常
    throw new Error(
      [
        `mech-registry.json 受写保护（ACC-managed）——禁止用 ${tool} 直接编辑。`,
        `尝试写入：${r.path}`,
        ``,
        `合规路径：`,
        `  container_admin msm register    （新增 MSM）`,
        `  container_admin msm deregister  （移除 MSM）`,
        `  container_admin msm check       （完整性检查）`,
      ].join("\n"),
    )
  })

  return [() => reg.dispose()]
}

/** 仅供测试：暴露路径判定的分隔符常量（跨平台一致性检查用） */
export const __pathSep = sep
