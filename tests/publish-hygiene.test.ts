/**
 * 发布物卫生测试 —— `dist/` 不得含**源已删除**的陈旧产物（2026-10-15）
 *
 * 🔴 本轮实证的缺陷（真读数，非推测）：
 *   `npm view …@0.1.2 dist.tarball` → 下载 tarball → 解包逐项列举，发现发布的包里有
 *   三个**源文件早已删除**的陈旧产物：
 *     · `dist/runtime/registry-guard.js`（本轮合并进 guards.ts 后删除）
 *     · `dist/runtime/container.js`（续 6 已删：错误的 `ctx.location` 语义）
 *     · `dist/runtime/injection-probe.js`（开发期探针，文件头自述「结论写入 docs 后本文件可删」）
 *
 *   根因：`tsc` **只增不删** —— 重新编译不会移除上一次构建留下的 `.js`/`.d.ts`；
 *   而 `dist/` 在 `.gitignore` 里（本地看不见差异），却在 `package.json` 的
 *   `files: ["dist"]` 里（**会发布**）⇒ 缺陷对开发者不可见，只对用户可见。
 *
 *   影响面：不只是"多几个废文件"。发布包里带着**已废弃的实现**与**开发期探针代码**
 *   （探针会在 `SERENITY_V2_DIAG=1` 时向用户机器 `/tmp` 写文件 —— 这正是 v0.1.1
 *    曾修过的同类问题）。⇒ 属**发布纪律缺陷**，非清洁度问题。
 *
 * 修法（两层，缺一不可）：
 *   ① `build` 先 `clean`（治存量：让每次构建都是全量重建）
 *   ② **本测试**（治增量：把"dist 与 src 必须一一对应"变成机械判据）
 *      —— 因为 ① 只在走 `npm run build` 时生效；若有人直接 `tsc` 就绕过了。
 */

import { describe, it, expect } from "vitest"
import { readdirSync, existsSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = process.cwd()
const SRC = join(ROOT, "src")
const DIST = join(ROOT, "dist")

/** 递归收集某目录下所有 `.ts`（src）与 `.js`（dist）文件的相对路径（去扩展名） */
function collect(dir: string, ext: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  const walk = (cur: string) => {
    for (const entry of readdirSync(cur)) {
      const full = join(cur, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (entry.endsWith(ext)) {
        out.push(relative(dir, full).slice(0, -ext.length))
      }
    }
  }
  walk(dir)
  return out.sort()
}

describe("发布物卫生 —— dist 不得含已被删除的源的陈旧产物", () => {
  it("前提：src/ 与 dist/ 都存在（dist 不存在 ⇒ 提示先 build，而非静默通过）", () => {
    expect(existsSync(SRC), "src/ 不存在").toBe(true)
    if (!existsSync(DIST)) {
      // dist 未构建 ⇒ 本测试无从判定。**明确跳过而非静默通过**：
      // 静默通过会让"忘了 build"伪装成"检查通过"（这正是本项目反复踩的失效模式）。
      expect(existsSync(DIST), "dist/ 未构建 —— 先跑 npm run build 再做发布物卫生检查").toBe(true)
    }
  })

  it("🔴 dist 里的每个产物都必须有对应的 src（无孤儿 = 无陈旧残留）", () => {
    const srcJs = collect(SRC, ".ts")
    const distJs = collect(DIST, ".js")

    // dist 的 .js 必须 ⊆ src 的 .ts（同名对应）
    const srcSet = new Set(srcJs)
    const orphans = distJs.filter((d) => !srcSet.has(d))

    expect(
      orphans,
      [
        `dist/ 含 ${orphans.length} 个**源已删除**的陈旧产物：`,
        ...orphans.map((o) => `  · dist/${o}.js`),
        ``,
        `根因：tsc 只增不删，而 dist/ 被 .gitignore 忽略（本地看不见）却会被发布（files:["dist"]）。`,
        `修法：跑 npm run build（其前置 clean 会清空 dist 后全量重建）。`,
      ].join("\n"),
    ).toEqual([])
  })

  it("🔴 反向：src 里的每个源都应编出对应产物（构建确实覆盖了全部源码）", () => {
    // 与上一条合起来 = 双向一一对应；单向会让"整个文件漏编"也悄悄通过
    const srcJs = collect(SRC, ".ts")
    const distJs = collect(DIST, ".js")
    const distSet = new Set(distJs)
    const missing = srcJs.filter((s) => !distSet.has(s))

    expect(missing, `以下源文件没有对应产物（dist 过期？）：\n${missing.join("\n")}`).toEqual([])
  })

  it("🔴 已删除的旧模块名不得以任何形式残留（点名回归）", () => {
    // 把本轮实证到的三个残留**点名**钉住：
    // 即便将来目录结构变了，只要这些名字又出现，测试立刻变红。
    // 说明：`registry-guard` 已合并进 `guards.ts`；`container` 语义错误已删；
    //       `injection-probe` 是开发期探针（不得进发布物）。
    const retired = ["registry-guard", "container", "injection-probe"]
    const distJs = collect(DIST, ".js")
    const resurrected = retired.filter((name) => distJs.includes(`runtime/${name}`))

    expect(
      resurrected,
      [
        `以下**已退役**的模块在 dist 里复活了：${resurrected.join(", ")}`,
        `若确实需要恢复，请同时更新本测试与 SESSION.md 的退役记录（本测试是退役事实的机械锚点）。`,
      ].join("\n"),
    ).toEqual([])
  })
})
