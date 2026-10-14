import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveInRoot, isInRoot } from "../src/runtime/path-guard.js"
import { createContainerFsTool } from "../src/tools/container_fs.js"
import { buildTools } from "../src/tools/index.js"
import { TOOL_OUTPUT_SCHEMA } from "../src/tools/output-schema.js"

const ROOT = "/home/yh/home/home-serenity"
const TMP = join(ROOT, "_tmp/v2-test-fs")

/**
 * 🔴 复刻宿主对工具返回值的**二元判定**（反编译宿主二进制所得原文逻辑）：
 *
 * ```js
 * if (tool.output === undefined) {
 *   if ("output" in result) fail("Tool result declared output without an output schema")
 *   return { output: undefined, content }
 * }
 * if (!("output" in result)) fail("Tool did not return its declared output")
 * ```
 *
 * 这个函数存在的意义：**把这个契约变成可测的**。
 * 2026-10-14 之前没有任何测试覆盖它 ⇒ 9 个工具**全部**每次调用都失败而无人察觉
 * （错误不落 opencode.log，只进会话消息 metadata）。
 */
function hostValidateResult(
  tool: { output?: unknown },
  result: { output?: unknown; content?: unknown },
): { ok: true } | { ok: false; error: string } {
  if (tool.output === undefined) {
    if (result.output !== undefined) {
      return { ok: false, error: "Tool result declared output without an output schema" }
    }
    return { ok: true }
  }
  if (result.output === undefined) {
    return { ok: false, error: "Tool did not return its declared output" }
  }
  return { ok: true }
}

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

// ─────────────────────────────────────────────────────────────
// 🔴 宿主返回值契约（2026-10-14 owner 报「工具调用有报错」的根因护栏）
//
// 背景：宿主判定「未声明 output 却返回 output」⇒ 直接失败。我们的工具全部如此
// ⇒ 9 个工具每次调用都失败，且错误不落日志（只进会话消息 metadata），
// 藏了很久才由 owner 的实测暴露。这些测试把该契约钉死。
// ─────────────────────────────────────────────────────────────
describe("🔴 工具返回值契约（宿主对 output schema 的二元判定）", () => {
  /**
   * 🔴 用 `buildTools`（**注册路径**）而非各工厂裸产物 —— 二者不同：
   *   `withOutputSchema` / `needsRoot` 都是**注册期**才包的。
   *   最初写这组测试时我断言了工厂产物 ⇒ 测试失败 ⇒ 恰好暴露了
   *   「测的不是宿主真收到的那批对象」这个方法论陷阱。
   */
  const makeAll = () => buildTools(async () => ROOT)

  it("🔴 9 个契约工具全部声明了 output schema（否则一调用就失败）", () => {
    const tools = makeAll()
    expect(tools).toHaveLength(9)
    for (const t of tools) {
      expect(t.output, `工具 ${t.name} 缺 output 声明`).toBeDefined()
    }
  })

  it("🔴 9 个工具名与 specs §4.1 契约名一致", () => {
    const names = makeAll().map((t) => t.name).sort()
    expect(names).toEqual(
      [
        "container_admin",
        "container_fs",
        "container_git",
        "container_trajectory",
        "dashboard",
        "handyman",
        "msm",
        "praxis",
        "resident",
      ].sort(),
    )
  })

  it("🔴 output schema 是对象型且不虚构字段（additionalProperties 放开）", () => {
    expect(TOOL_OUTPUT_SCHEMA).toMatchObject({ type: "object", additionalProperties: true })
  })

  it("🔴 反例：未声明 output 却返回 output ⇒ 宿主要判失败（契约本身的自证）", () => {
    const bad = hostValidateResult({}, { output: { x: 1 }, content: "c" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toBe("Tool result declared output without an output schema")
  })

  it("🔴 反例：声明了 output 却不返回 ⇒ 宿主要判失败", () => {
    const bad = hostValidateResult({ output: TOOL_OUTPUT_SCHEMA }, { content: "c" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toBe("Tool did not return its declared output")
  })

  it("🔴 真机路径：container_fs 各子命令的返回值都能过宿主判定", async () => {
    const registered = makeAll().find((t) => t.name === "container_fs")!
    const t = createContainerFsTool(ROOT)
    for (const args of [
      { action: "root" },
      { action: "list", path: "." },
      { action: "exists", path: "localstore.json" },
      { action: "info", path: "localstore.json" },
      { action: "tree", path: "_tmp", depth: 1 },
      { action: "find", path: "_tmp", pattern: "*" },
      { action: "relative", path: "." },
      { action: "resolve", path: "." },
      { action: "reveal", path: "." },
      { action: "nope" },
      { action: "list" }, // 缺 path ⇒ 错误分支
      { action: "exists", path: "../escape" }, // 逃逸 ⇒ 错误分支
    ]) {
      const r = await run(t, args)
      const v = hostValidateResult(registered, r)
      expect(v.ok, `${JSON.stringify(args)} 未过宿主契约：${v.ok ? "" : v.error}`).toBe(true)
    }
  })

  it("🔴 每个工具在「不在 CCC 内」分支的返回值也过契约（needsRoot 包装路径）", async () => {
    // resolveRoot 恒返回 null ⇒ 走 not_in_ccc 分支
    const tools = buildTools(async () => null)
    for (const t of tools) {
      if (t.name === "dashboard") continue // dashboard 不包 needsRoot（不需要根）
      const r = await t.execute({ action: "root" } as never, { sessionID: "ses_x" } as never)
      const v = hostValidateResult(t, r as { output?: unknown; content?: unknown })
      expect(v.ok, `${t.name} 的 not_in_ccc 分支未过契约：${v.ok ? "" : v.error}`).toBe(true)
    }
  })

  it("🔴 所有子命令的返回都含结构化 output 且恒为对象（不是裸值）", async () => {
    const t = createContainerFsTool(ROOT)
    for (const args of [
      { action: "root" },
      { action: "list", path: "." },
      { action: "nope" },
    ]) {
      const r = await run(t, args)
      expect(r.output).toBeTypeOf("object")
      expect(typeof r.content).toBe("string")
    }
  })
})
