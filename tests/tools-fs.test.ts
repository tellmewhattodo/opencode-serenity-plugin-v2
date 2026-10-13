import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveInRoot, isInRoot } from "../src/runtime/path-guard.js"
import { createContainerFsTool } from "../src/tools/container_fs.js"

const ROOT = "/home/yh/home/home-serenity"
const TMP = join(ROOT, "_tmp/v2-test-fs")

/** 取工具执行结果（统一签名） */
async function run(tool: ReturnType<typeof createContainerFsTool>, args: unknown) {
  return (await tool.execute(args as never, {} as never)) as { output: unknown; content: string }
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────
// 路径守卫（ACC 核心安全机制，specs §4.1 / RR5）
// ─────────────────────────────────────────────────────────────
describe("path-guard — CCC 边界", () => {
  it("根内相对路径 ⇒ 通过", () => {
    const r = resolveInRoot(ROOT, "AGENT_SESSIONS/x.md")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.abs).toBe(join(ROOT, "AGENT_SESSIONS/x.md"))
  })

  it("根内绝对路径 ⇒ 通过", () => {
    expect(isInRoot(ROOT, join(ROOT, "docs/a.md"))).toBe(true)
  })

  it("根自身 ⇒ 通过（rel = .）", () => {
    const r = resolveInRoot(ROOT, ".")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rel).toBe(".")
  })

  it("`..` 逃逸 ⇒ 拒绝", () => {
    const r = resolveInRoot(ROOT, "../outside.txt")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("escapes_root")
  })

  it("多级 `..` 逃逸 ⇒ 拒绝", () => {
    expect(isInRoot(ROOT, "../../../etc/passwd")).toBe(false)
  })

  it("根外绝对路径 ⇒ 拒绝", () => {
    expect(isInRoot(ROOT, "/etc/passwd")).toBe(false)
  })

  it("🔴 前缀相似的兄弟目录 ⇒ 拒绝（前缀比较的经典陷阱）", () => {
    // `/home/yh/home/home-serenity-evil` 与根共享前缀，但在根外
    expect(isInRoot(ROOT, "/home/yh/home/home-serenity-evil/x")).toBe(false)
  })

  it("空路径 ⇒ 拒绝（reason=empty），不抛", () => {
    const r = resolveInRoot(ROOT, "")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("empty")
  })

  it("内层 `..` 折返仍在根内 ⇒ 通过", () => {
    expect(isInRoot(ROOT, "docs/../AGENT_SESSIONS/x")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// container_fs（specs §4.1，15 子命令）
// ─────────────────────────────────────────────────────────────
describe("container_fs — 只读子命令", () => {
  it("root ⇒ 返回 CCC 根", async () => {
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "root" })
    expect(r.content).toBe(ROOT)
  })

  it("resolve ⇒ abs + rel", async () => {
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "resolve", path: "docs/a.md" })
    expect((r.output as { rel: string }).rel).toBe("docs/a.md")
  })

  it("resolve 逃逸 ⇒ 阻断并说明", async () => {
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "resolve", path: "../x" })
    expect(r.content).toContain("路径逃逸被阻断")
  })

  it("exists ⇒ true/false", async () => {
    const t = createContainerFsTool(ROOT)
    expect((await run(t, { action: "exists", path: "_tmp" })).content).toBe("true")
    expect((await run(t, { action: "exists", path: "_tmp/definitely-absent-xyz" })).content).toBe("false")
  })

  it("list ⇒ 列出条目", async () => {
    writeFileSync(join(TMP, "a.txt"), "x")
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "list", path: "_tmp/v2-test-fs" })
    expect((r.output as { count: number }).count).toBe(1)
    expect(r.content).toContain("a.txt")
  })

  it("info ⇒ 类型与字节", async () => {
    writeFileSync(join(TMP, "a.txt"), "hello")
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "info", path: "_tmp/v2-test-fs/a.txt" })
    expect((r.output as { size: number }).size).toBe(5)
  })

  it("find ⇒ glob 命中", async () => {
    writeFileSync(join(TMP, "match-me.txt"), "x")
    writeFileSync(join(TMP, "other.md"), "x")
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "find", path: "_tmp/v2-test-fs", pattern: "*.txt" })
    expect((r.output as { count: number }).count).toBe(1)
  })

  it("tree ⇒ 层级输出", async () => {
    mkdirSync(join(TMP, "sub"))
    writeFileSync(join(TMP, "sub/f.txt"), "x")
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "tree", path: "_tmp/v2-test-fs", depth: 2 })
    expect(r.content).toContain("sub/")
  })
})

describe("container_fs — 写入子命令", () => {
  it("mkdir ⇒ 创建目录；dryRun ⇒ 不创建", async () => {
    const t = createContainerFsTool(ROOT)
    const dry = await run(t, { action: "mkdir", path: "_tmp/v2-test-fs/d", dryRun: true })
    expect(dry.content).toContain("[dry-run]")
    expect(existsSync(join(TMP, "d"))).toBe(false)

    await run(t, { action: "mkdir", path: "_tmp/v2-test-fs/d" })
    expect(existsSync(join(TMP, "d"))).toBe(true)
  })

  it("append ⇒ 追加内容", async () => {
    const t = createContainerFsTool(ROOT)
    writeFileSync(join(TMP, "log.txt"), "a")
    await run(t, { action: "append", path: "_tmp/v2-test-fs/log.txt", content: "b" })
    expect(readFileSync(join(TMP, "log.txt"), "utf8")).toBe("ab")
  })

  it("touch ⇒ 创建空文件", async () => {
    const t = createContainerFsTool(ROOT)
    await run(t, { action: "touch", path: "_tmp/v2-test-fs/new.txt" })
    expect(existsSync(join(TMP, "new.txt"))).toBe(true)
  })

  it("mv ⇒ 移动", async () => {
    const t = createContainerFsTool(ROOT)
    writeFileSync(join(TMP, "a.txt"), "x")
    await run(t, { action: "mv", src: "_tmp/v2-test-fs/a.txt", dst: "_tmp/v2-test-fs/b.txt" })
    expect(existsSync(join(TMP, "a.txt"))).toBe(false)
    expect(existsSync(join(TMP, "b.txt"))).toBe(true)
  })

  it("cp ⇒ 复制", async () => {
    const t = createContainerFsTool(ROOT)
    writeFileSync(join(TMP, "a.txt"), "x")
    await run(t, { action: "cp", src: "_tmp/v2-test-fs/a.txt", dst: "_tmp/v2-test-fs/c.txt" })
    expect(existsSync(join(TMP, "a.txt"))).toBe(true)
    expect(existsSync(join(TMP, "c.txt"))).toBe(true)
  })

  it("rm 文件 ⇒ 删除", async () => {
    const t = createContainerFsTool(ROOT)
    writeFileSync(join(TMP, "a.txt"), "x")
    await run(t, { action: "rm", path: "_tmp/v2-test-fs/a.txt" })
    expect(existsSync(join(TMP, "a.txt"))).toBe(false)
  })

  it("🔴 rm 目录但无 recursive ⇒ 拒绝（防误删）", async () => {
    const t = createContainerFsTool(ROOT)
    mkdirSync(join(TMP, "d"))
    const r = await run(t, { action: "rm", path: "_tmp/v2-test-fs/d" })
    expect(r.content).toContain("recursive=true")
    expect(existsSync(join(TMP, "d"))).toBe(true)
  })

  it("🔴 rm 目录 + recursive ⇒ 成功", async () => {
    const t = createContainerFsTool(ROOT)
    mkdirSync(join(TMP, "d"))
    await run(t, { action: "rm", path: "_tmp/v2-test-fs/d", recursive: true })
    expect(existsSync(join(TMP, "d"))).toBe(false)
  })

  it("🔴 rm CCC 根自身 ⇒ 拒绝（refuse_root）", async () => {
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "rm", path: ".", recursive: true })
    expect(r.content).toContain("拒绝删除 CCC 根自身")
    expect(existsSync(ROOT)).toBe(true)
  })

  it("🔴 写操作逃逸 ⇒ 一律阻断（不留副作用）", async () => {
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "mkdir", path: "../escape-dir" })
    expect(r.content).toContain("路径逃逸被阻断")
    expect(existsSync("/home/yh/home/escape-dir")).toBe(false)
  })

  it("未知子命令 ⇒ 列出可用项", async () => {
    const t = createContainerFsTool(ROOT)
    const r = await run(t, { action: "nope" })
    expect(r.content).toContain("未知子命令")
    // 判据：必须把**全部 15 个子命令**列出来（便于模型自我纠正）
    for (const sub of ["root", "resolve", "exists", "list", "tree", "relative", "mkdir", "rm", "mv", "cp", "touch", "append", "reveal", "info", "find"]) {
      expect(r.content).toContain(sub)
    }
  })
})
