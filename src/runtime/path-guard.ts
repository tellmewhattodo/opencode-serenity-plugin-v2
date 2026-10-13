/**
 * 路径守卫 —— CCC 边界（specs §4.1「路径逃逸阻断」/ §5.3「RR5」）
 *
 * 判据：任何路径操作必须**落在 CCC 根内**。
 *   ① 相对路径 ⇒ 以 CCC 根为基准解析
 *   ② 绝对路径 ⇒ 必须在根内
 *   ③ 结果一律规范化（`..` 逃逸、符号链接不解析以避免 TOCTOU）
 *
 * 🔴 与 v1 的差异：v1 用 `resolvePath()` 手写前缀比较；此处改用**
 *    `path.relative()` 判据**——前缀比较有经典陷阱：`/root` 与 `/root-evil`
 *    共享前缀但后者在根外。relative 判据无此问题。
 */

import { isAbsolute, relative, resolve, sep, normalize } from "node:path"

export interface ResolvedPath {
  readonly ok: true
  /** 绝对路径（已规范化） */
  readonly abs: string
  /** 相对 CCC 根的路径（用于展示；根自身为 "."） */
  readonly rel: string
}

export interface PathEscape {
  readonly ok: false
  readonly reason: "escapes_root" | "empty"
  readonly attempted: string
  readonly root: string
}

export type PathResult = ResolvedPath | PathEscape

/**
 * 把用户给的路径解析到 CCC 根内。
 *
 * @param root CCC 根（绝对路径）
 * @param input 用户路径（相对或绝对）
 */
export function resolveInRoot(root: string, input: string): PathResult {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, reason: "empty", attempted: String(input), root }
  }

  const normalizedRoot = normalize(resolve(root))
  const abs = isAbsolute(input) ? normalize(resolve(input)) : normalize(resolve(normalizedRoot, input))

  // 🔴 用 relative 判据（而非前缀比较）：`..` 开头 ⇒ 在根外
  const rel = relative(normalizedRoot, abs)
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)

  if (escapes) {
    return { ok: false, reason: "escapes_root", attempted: input, root: normalizedRoot }
  }

  return { ok: true, abs, rel: rel === "" ? "." : rel }
}

/** 便捷判定 */
export function isInRoot(root: string, input: string): boolean {
  return resolveInRoot(root, input).ok
}
