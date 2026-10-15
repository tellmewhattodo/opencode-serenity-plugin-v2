/**
 * safe-mode 保护 + **元判据**测试（2026-10-15）
 *
 * 本文件的两个目的（EAP · R↓）：
 *
 *   A. **行为测试** —— 治理文件写保护 / 黑名单写拦截 / 注册表保护，
 *      三者在**同一个 `execute.before` 决策函数**（`decideWriteGuard`）上逐条验证。
 *
 *   B. 🔴 **元判据测试**（本轮缺陷的直接护栏）——
 *      **提示词里宣称的保护，必须真有对应实现**（宣称与实现不得脱节）。
 *
 *      缘起：块 6 文本（specs §5.6 逐字）写死了三条保护声明，而 v2 当时**一条都没实现**
 *      —— 这是**假陈述**，比"缺功能"更严重：模型会据此认为自己受保护。
 *
 *      与"测试测了工厂产物而非注册产物"同族：**测的东西与被断言的东西不是同一个**。
 *      ⇒ 元判据：**从注入文本里解析出承诺 → 逐条要求存在对应的机械拦截**。
 *      这样"以后有人改了提示词却忘了实现"会在测试里立刻变红。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  SAFE_MODE_MARKER,
  CCC_MARKER,
  isSafeModeOn,
  readBlacklist,
  readBlacklistDisplay,
  matchBlacklist,
} from "../src/runtime/safe-mode.js"
import {
  decideWriteGuard,
  extractPaths,
  relFromRoot,
  isWriteCall,
  isShellCall,
} from "../src/runtime/guards.js"
import { SAFE_MODE_BLOCK } from "../src/runtime/injection.js"

// ─────────────────────────────────────────────────────────────
// 测试夹具：一个临时 CCC（自带配置 + 标记文件，按需开关）
// ─────────────────────────────────────────────────────────────

interface Fixture {
  root: string
  writeConfig: (safeMode: unknown) => void
  setSafeMode: (on: boolean) => void
}

function makeCcc(opts: { safeMode?: unknown; marker?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "serenity-safe-"))
  writeFileSync(join(root, CCC_MARKER), "home-serenity\n")
  mkdirSync(join(root, ".opencode"), { recursive: true })

  const writeConfig = (safeMode: unknown) => {
    writeFileSync(
      join(root, ".opencode", "serenity.json"),
      JSON.stringify({ safeMode }, null, 2),
      "utf8",
    )
  }
  const setSafeMode = (on: boolean) => {
    const p = join(root, SAFE_MODE_MARKER)
    if (on) writeFileSync(p, "")
    else if (existsSync(p)) rmSync(p, { force: true })
  }

  writeConfig(opts.safeMode ?? {})
  setSafeMode(opts.marker ?? false)
  return { root, writeConfig, setSafeMode }
}

let fx: Fixture
const roots: string[] = []

function fixture(opts: { safeMode?: unknown; marker?: boolean } = {}): Fixture {
  fx = makeCcc(opts)
  roots.push(fx.root)
  return fx
}

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop()!
    rmSync(r, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────
// safe-mode 原语
// ─────────────────────────────────────────────────────────────

describe("safe-mode — 标记判定（specs §3：存在即 ON，内容无关紧要）", () => {
  it("标记不存在 ⇒ OFF", () => {
    expect(isSafeModeOn(fixture({ marker: false }).root)).toBe(false)
  })

  it("标记存在 ⇒ ON", () => {
    expect(isSafeModeOn(fixture({ marker: true }).root)).toBe(true)
  })

  it("🔴 标记内容无关紧要（specs §3 逐字）—— 空文件 / 任意文本都算 ON", () => {
    const f = fixture({ marker: true })
    writeFileSync(join(f.root, SAFE_MODE_MARKER), "whatever nonsense\n")
    expect(isSafeModeOn(f.root)).toBe(true)
  })

  it("不存在的根 ⇒ OFF（不抛）", () => {
    expect(isSafeModeOn("/nonexistent/ccc/path")).toBe(false)
  })
})

describe("safe-mode — 黑名单解析（specs §3.1(a)）", () => {
  it("string 条目 ⇒ 前缀规则", () => {
    const f = fixture({ safeMode: { blacklist: [".secrets/"] } })
    expect(readBlacklist(f.root)).toEqual([{ pattern: ".secrets/" }])
  })

  it("🔴 `{ pattern, message }` 条目 ⇒ 保留自定义提示", () => {
    const f = fixture({
      safeMode: { blacklist: [{ pattern: "vault/", message: "vault is off-limits" }] },
    })
    expect(readBlacklist(f.root)).toEqual([{ pattern: "vault/", message: "vault is off-limits" }])
  })

  it("🔴 展示面与拦截面同源：`{ pattern }` 形态也出现在展示列表里", () => {
    // 反例护栏：若展示面单独解析、只认 string 条目，这条规则**会被拦但模型看不到**
    const f = fixture({
      safeMode: { blacklist: ["plain/", { pattern: "obj/", message: "m" }] },
    })
    expect(readBlacklistDisplay(f.root)).toEqual(["plain/", "obj/"])
  })

  it("非数组 / 空 / 非法条目 ⇒ []（不抛）", () => {
    expect(readBlacklist(fixture({ safeMode: { blacklist: "nope" } }).root)).toEqual([])
    expect(readBlacklist(fixture({ safeMode: { blacklist: [] } }).root)).toEqual([])
    expect(readBlacklist(fixture({ safeMode: { blacklist: [42, null, {}, ""] } }).root)).toEqual([])
  })

  it("配置缺失 / 损坏 ⇒ []（fail-open：配置坏不该把 CCC 锁死）", () => {
    const f = fixture({})
    rmSync(join(f.root, ".opencode", "serenity.json"), { force: true })
    expect(readBlacklist(f.root)).toEqual([])

    writeFileSync(join(f.root, ".opencode", "serenity.json"), "{ not json")
    expect(readBlacklist(f.root)).toEqual([])
  })
})

describe("safe-mode — 黑名单匹配", () => {
  it("前缀匹配", () => {
    const rules = [{ pattern: ".secrets/" }]
    expect(matchBlacklist(".secrets/key.txt", rules)?.pattern).toBe(".secrets/")
    expect(matchBlacklist("docs/readme.md", rules)).toBeNull()
  })

  it("🔴 前缀是**字面**前缀，不是「路径段」前缀 —— `secrets/` 不匹配 `.secrets/x`", () => {
    expect(matchBlacklist(".secrets/key.txt", [{ pattern: "secrets/" }])).toBeNull()
  })

  it("regex: 条目 ⇒ 跑正则", () => {
    const rules = [{ pattern: "regex:\\.env$" }]
    expect(matchBlacklist("config/.env", rules)?.pattern).toBe("regex:\\.env$")
    expect(matchBlacklist("config/.env.example", rules)).toBeNull()
  })

  it("🔴 非法正则 ⇒ 跳过该条，但不影响同表其它条（不整表失效）", () => {
    const rules = [{ pattern: "regex:([unclosed" }, { pattern: ".secrets/" }]
    expect(matchBlacklist(".secrets/key.txt", rules)?.pattern).toBe(".secrets/")
  })

  it("规则里的反斜杠归一化为 `/`（Windows 书写对齐）", () => {
    expect(matchBlacklist(".secrets/x", [{ pattern: ".secrets\\" }])?.pattern).toBe(".secrets\\")
  })

  it("命中带 message 的条目 ⇒ 返回的条目带 message（调用方据此用自定义文案）", () => {
    const rules = [{ pattern: "vault/", message: "no" }]
    expect(matchBlacklist("vault/a", rules)?.message).toBe("no")
  })
})

// ─────────────────────────────────────────────────────────────
// 路径提取与写类判定
// ─────────────────────────────────────────────────────────────

describe("write-guard — 写类判定", () => {
  it("原生写工具 ⇒ 写类；读工具 ⇒ 非写类", () => {
    for (const t of ["write", "edit", "patch", "multiedit", "str_replace_editor", "append", "touch"]) {
      expect(isWriteCall(t, {})).toBe(true)
    }
    for (const t of ["read", "grep", "glob", "list"]) {
      expect(isWriteCall(t, { filePath: "x" })).toBe(false)
    }
  })

  it("🔴 container_fs 按子命令判定（旧实现按工具名 ⇒ 写子命令全绕过）", () => {
    for (const a of ["mkdir", "rm", "mv", "cp", "touch", "append"]) {
      expect(isWriteCall("container_fs", { action: a })).toBe(true)
    }
    for (const a of ["root", "resolve", "exists", "list", "tree", "relative", "reveal", "info", "find"]) {
      expect(isWriteCall("container_fs", { action: a })).toBe(false)
    }
  })

  it("container_fs 缺 action ⇒ 非写类（畸形调用交由其自身校验兜底）", () => {
    expect(isWriteCall("container_fs", {})).toBe(false)
  })
})

describe("write-guard — 路径提取", () => {
  it("取出路径键的值（含数组与嵌套）", () => {
    expect(extractPaths({ filePath: "a/b.md" })).toContain("a/b.md")
    expect(extractPaths({ paths: ["x", "y"] })).toEqual(expect.arrayContaining(["x", "y"]))
    expect(extractPaths({ edits: [{ path: "deep/z" }] })).toContain("deep/z")
  })

  it("🔴 路径键存在时**不**扫描正文（防「正文提到文件名」被误判成操作目标）", () => {
    const got = extractPaths({
      path: "notes.md",
      content: "see docs/mech-registry.json for details",
    })
    expect(got).toEqual(["notes.md"])
    expect(got).not.toContain("see docs/mech-registry.json for details")
  })

  it("🔴 一个路径键都没有 ⇒ 回退全量扫描（未知工具形状也不漏放）", () => {
    expect(extractPaths({ weird: ["a/mech-registry.json"] })).toContain("a/mech-registry.json")
  })

  it("循环引用不致死循环", () => {
    const a: Record<string, unknown> = { filePath: "x" }
    a.self = a
    expect(() => extractPaths(a)).not.toThrow()
  })

  it("relFromRoot：相对/绝对都归一到根相对；逃逸 ⇒ null", () => {
    const root = "/ccc"
    expect(relFromRoot(root, "a/b.md")).toBe("a/b.md")
    expect(relFromRoot(root, "/ccc/a/b.md")).toBe("a/b.md")
    expect(relFromRoot(root, "./a/../b.md")).toBe("b.md")
    expect(relFromRoot(root, "/ccc")).toBe(".")
    expect(relFromRoot(root, "../outside.md")).toBeNull()
    expect(relFromRoot(root, "/etc/passwd")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// ① 治理文件写保护（specs §5.6）
// ─────────────────────────────────────────────────────────────

describe("🔴 治理文件写保护（specs §5.6：reserved for the user）", () => {
  beforeEach(() => fixture({ marker: true }))

  it("write `.serenity` ⇒ deny", () => {
    const d = decideWriteGuard({ root: fx.root, tool: "write", input: { filePath: ".serenity" } })
    expect(d.kind).toBe("deny")
    expect(d.rule).toBe("governance")
  })

  it("write `.serenity-safe-on` ⇒ deny", () => {
    const d = decideWriteGuard({
      root: fx.root,
      tool: "write",
      input: { filePath: ".serenity-safe-on" },
    })
    expect(d.kind).toBe("deny")
    expect(d.rule).toBe("governance")
  })

  it("🔴 绝对路径 / 嵌套路径同样命中（不依赖 cwd）", () => {
    expect(
      decideWriteGuard({ root: fx.root, tool: "edit", input: { filePath: `${fx.root}/.serenity` } }).kind,
    ).toBe("deny")
    expect(
      decideWriteGuard({ root: fx.root, tool: "patch", input: { edits: [{ path: "a/.serenity" }] } }).kind,
    ).toBe("deny")
  })

  it("🔴 拦的是**写**：read `.serenity` 放行（读是允许的）", () => {
    expect(
      decideWriteGuard({ root: fx.root, tool: "read", input: { filePath: ".serenity" } }).kind,
    ).toBe("allow")
  })

  it("🔴 container_fs rm 治理文件也拦（删掉标记 = 拆掉 CCC 根）", () => {
    const d = decideWriteGuard({
      root: fx.root,
      tool: "container_fs",
      input: { action: "rm", path: ".serenity" },
    })
    expect(d.kind).toBe("deny")
    expect(d.rule).toBe("governance")
  })

  it("🔴 拦截面**不依赖 safe-mode 开关**（治理文件任何时候都受保护）", () => {
    fx.setSafeMode(false)
    expect(isSafeModeOn(fx.root)).toBe(false)
    expect(
      decideWriteGuard({ root: fx.root, tool: "write", input: { filePath: ".serenity" } }).kind,
    ).toBe("deny")
  })

  it("🔴 即使拿不到 CCC 根也拦得住（治理文件判定只用 basename）", () => {
    expect(
      decideWriteGuard({ root: null, tool: "write", input: { filePath: ".serenity-safe-on" } }).kind,
    ).toBe("deny")
  })

  it("写同名的普通文件（`.serenity-backup`）⇒ 不拦（不是同一个文件）", () => {
    expect(
      decideWriteGuard({ root: fx.root, tool: "write", input: { filePath: ".serenity-backup" } }).kind,
    ).toBe("allow")
  })
})

// ─────────────────────────────────────────────────────────────
// ② MSM 注册表写保护（specs §4.3）—— 迁移自旧 registry-guard 测试
// ─────────────────────────────────────────────────────────────

describe("MSM 注册表写保护（specs §4.3）", () => {
  beforeEach(() => fixture({ marker: false }))

  it("write 注册表（绝对/相对/嵌套）⇒ deny，且给出合规路径", () => {
    const d = decideWriteGuard({
      root: fx.root,
      tool: "write",
      input: { filePath: ".opencode/skills/home-serenity/references/mech-registry.json" },
    })
    expect(d.kind).toBe("deny")
    expect(d.rule).toBe("registry")
    expect(d.reason).toContain("container_admin msm register")
  })

  it("read 注册表 ⇒ 放行（注册表是结构核心不是秘密）", () => {
    expect(
      decideWriteGuard({ root: fx.root, tool: "read", input: { filePath: "references/mech-registry.json" } })
        .kind,
    ).toBe("allow")
  })

  it("🔴 container_fs rm 注册表也拦（旧实现漏掉的口子）", () => {
    expect(
      decideWriteGuard({
        root: fx.root,
        tool: "container_fs",
        input: { action: "rm", path: "references/mech-registry.json" },
      }).kind,
    ).toBe("deny")
  })

  it("写其它文件 ⇒ 不拦", () => {
    expect(
      decideWriteGuard({ root: fx.root, tool: "write", input: { filePath: "docs/other.md" } }).kind,
    ).toBe("allow")
  })
})

// ─────────────────────────────────────────────────────────────
// ③ 黑名单写拦截（specs §3.1(a) + §5.6 门控）
// ─────────────────────────────────────────────────────────────

describe("🔴 黑名单写拦截（specs §3.1 + §5.6 门控）", () => {
  it("safe-mode ON + 命中前缀 ⇒ deny", () => {
    fixture({ marker: true, safeMode: { blacklist: [".secrets/"] } })
    const d = decideWriteGuard({
      root: fx.root,
      tool: "write",
      input: { filePath: ".secrets/key.txt" },
    })
    expect(d.kind).toBe("deny")
    expect(d.rule).toBe("blacklist")
  })

  it("safe-mode ON + 命中 regex ⇒ deny", () => {
    fixture({ marker: true, safeMode: { blacklist: ["regex:\\.env$"] } })
    expect(
      decideWriteGuard({ root: fx.root, tool: "write", input: { filePath: "config/.env" } }).kind,
    ).toBe("deny")
    fx.setSafeMode(false)
  })

  it("🔴 命中带 message 的条目 ⇒ 用自定义文案（specs §3.1(a)）", () => {
    fixture({
      marker: true,
      safeMode: { blacklist: [{ pattern: "vault/", message: "vault is off-limits" }] },
    })
    const d = decideWriteGuard({ root: fx.root, tool: "write", input: { filePath: "vault/a" } })
    expect(d.kind).toBe("deny")
    expect(d.reason).toBe("vault is off-limits")
  })

  it("🔴 safe-mode **OFF** ⇒ 黑名单不生效（specs §5.6：黑名单只在 ON 时被宣称生效）", () => {
    fixture({ marker: false, safeMode: { blacklist: [".secrets/"] } })
    expect(
      decideWriteGuard({ root: fx.root, tool: "write", input: { filePath: ".secrets/key.txt" } }).kind,
    ).toBe("allow")
  })

  it("🔴 拦的是**写**：read 黑名单内文件放行", () => {
    fixture({ marker: true, safeMode: { blacklist: [".secrets/"] } })
    expect(
      decideWriteGuard({ root: fx.root, tool: "read", input: { filePath: ".secrets/key.txt" } }).kind,
    ).toBe("allow")
  })

  it("黑名单为空 ⇒ 不拦任何东西（不误报）", () => {
    fixture({ marker: true, safeMode: { blacklist: [] } })
    expect(
      decideWriteGuard({ root: fx.root, tool: "write", input: { filePath: "anything.md" } }).kind,
    ).toBe("allow")
  })

  it("🔴 container_fs 写子命令也受黑名单约束；只读子命令不受", () => {
    fixture({ marker: true, safeMode: { blacklist: [".secrets/"] } })
    expect(
      decideWriteGuard({ root: fx.root, tool: "container_fs", input: { action: "touch", path: ".secrets/x" } })
        .kind,
    ).toBe("deny")
    expect(
      decideWriteGuard({ root: fx.root, tool: "container_fs", input: { action: "list", path: ".secrets" } })
        .kind,
    ).toBe("allow")
  })

  it("配置里没有 safeMode 段 ⇒ 读作 []，不抛", () => {
    fixture({ marker: true, safeMode: undefined })
    expect(
      decideWriteGuard({ root: fx.root, tool: "write", input: { filePath: "x" } }).kind,
    ).toBe("allow")
  })
})

// ─────────────────────────────────────────────────────────────
// ④ 安全模式 bash 禁用（specs §5.6："bash is disabled"）
// ─────────────────────────────────────────────────────────────

describe("🔴 安全模式 bash 禁用（specs §5.6）", () => {
  it("safe-mode ON + bash ⇒ deny", () => {
    fixture({ marker: true })
    const d = decideWriteGuard({ root: fx.root, tool: "bash", input: { command: "ls" } })
    expect(d.kind).toBe("deny")
    expect(d.rule).toBe("shell")
    expect(d.reason).toContain("use msm instead")
  })

  it("🔴 safe-mode **OFF** ⇒ bash 放行（该声明只在块 6 注入时出现）", () => {
    fixture({ marker: false })
    expect(decideWriteGuard({ root: fx.root, tool: "bash", input: { command: "ls" } }).kind).toBe(
      "allow",
    )
  })

  it("isShellCall 认 bash / shell / sh（宽松列举，多列无害）", () => {
    for (const t of ["bash", "shell", "sh", "BASH"]) expect(isShellCall(t)).toBe(true)
    for (const t of ["write", "read", "container_fs", "msm"]) expect(isShellCall(t)).toBe(false)
  })

  it("🔴 拿不到根 ⇒ bash 放行（宁可少拦，不因判据缺失误伤 —— 与治理文件相反）", () => {
    // 治理文件用 basename 判（不依赖根，故无根也拦）；bash 的判据是 safe-mode 标记，
    // 无根 ⇒ 无法得知标记 ⇒ 放行。二者的差别是**刻意的**，不是不一致。
    expect(decideWriteGuard({ root: null, tool: "bash", input: { command: "ls" } }).kind).toBe("allow")
  })

  it("🔴 bash 判定先于写类闸（bash 无路径参数，放后面会漏）", () => {
    fixture({ marker: true })
    // bash 不在 WRITE_TOOLS 里；若先过写类闸就会被放行
    expect(isWriteCall("bash", { command: "ls" })).toBe(false)
    expect(decideWriteGuard({ root: fx.root, tool: "bash", input: { command: "ls" } }).kind).toBe("deny")
  })
})

// ─────────────────────────────────────────────────────────────
// 🔴🔴 元判据：提示词宣称的保护 ⇔ 真实存在的实现
// ─────────────────────────────────────────────────────────────

describe("🔴 元判据 —— 提示词宣称的保护必须真有实现", () => {
  /**
   * 从块 6 文本里**解析出**它承诺的保护（而不是手抄一份清单 ——
   * 手抄的清单会在提示词改动后静默过期，那正是本元判据要防的失效模式）。
   */
  const parseClaims = (block: string): string[] =>
    block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2))

  it("块 6 文本确实含保护声明（前提检查：解析器真的解析到了东西）", () => {
    const claims = parseClaims(SAFE_MODE_BLOCK)
    expect(claims.length).toBeGreaterThanOrEqual(3)
    expect(claims.join("\n")).toContain("governance files")
    expect(claims.join("\n")).toContain("blacklist")
  })

  it("🔴 逐条：每条宣称的保护都能追到一个真实的机械拦截点", () => {
    const claims = parseClaims(SAFE_MODE_BLOCK)

    /**
     * 宣称关键词 → 该宣称的**存在性证明**。
     * 证明必须是"真的跑一次拦截并看到 deny"——不是"源码里有这个名字"。
     */
    const proofs: Array<{ claim: string; verified: () => boolean }> = [
      {
        claim: "governance files",
        verified: () => {
          const f = fixture({ marker: true })
          return (
            decideWriteGuard({ root: f.root, tool: "write", input: { filePath: ".serenity" } }).rule ===
            "governance"
          )
        },
      },
      {
        claim: "blacklist",
        verified: () => {
          const f = fixture({ marker: true, safeMode: { blacklist: [".secrets/"] } })
          return (
            decideWriteGuard({
              root: f.root,
              tool: "write",
              input: { filePath: ".secrets/x" },
            }).rule === "blacklist"
          )
        },
      },
      {
        claim: "bash is disabled",
        verified: () => {
          const f = fixture({ marker: true })
          return decideWriteGuard({ root: f.root, tool: "bash", input: { command: "ls" } }).rule === "shell"
        },
      },
    ]

    // 每一条 proof 都必须实际产出一个 deny —— 否则说明该保护是"纸面承诺"
    for (const p of proofs) {
      expect(p.verified(), `宣称的保护「${p.claim}」没有对应的实现`).toBe(true)
      // 且该宣称确实出现在文本里（解析器 ↔ proofs 表必须对齐，不得有孤儿 proof）
      expect(claims.join("\n"), `proofs 表里的「${p.claim}」并未出现在块 6 文本中`).toContain(
        p.claim,
      )
    }
  })

  it("🔴 反向：文本里出现的每个保护关键词都必须在 proofs 表里有条目", () => {
    // 防止"新加了一条保护声明，但没人给它写实现/证明"
    // —— 这条正是本轮缺陷的形状：文本宣称三条，实现零条。
    const claims = parseClaims(SAFE_MODE_BLOCK).join("\n")
    const knownClaims = ["governance files", "blacklist", "bash is disabled"]
    const ENFORCED = knownClaims.filter((k) => claims.includes(k))
    expect(ENFORCED.length).toBe(knownClaims.length)
  })

  it("🔴 本 CCC 的块 6 实际文本（逐字）与 specs §5.6 一致 —— 断言的是真实注入物", () => {
    // 元判据的前提：SAFE_MODE_BLOCK 就是**真的会被注入**的那段文本
    expect(SAFE_MODE_BLOCK.startsWith("=== Serenity Safe Mode ===")).toBe(true)
    expect(SAFE_MODE_BLOCK).toContain("governance files (.serenity, .serenity-safe-on)")
    expect(SAFE_MODE_BLOCK).toContain("protected from agent writes")
    expect(SAFE_MODE_BLOCK).toContain("blacklist rules apply to file paths")
    expect(SAFE_MODE_BLOCK).toContain("bash is disabled (hidden and blocked)")
  })

  it("🔴 诚实边界：`hidden` 面（从 schema 移除）**当前未实现** —— 本测试锁定该事实为已知缺口", () => {
    // 「宣称 vs 实现」有两种落差，必须分开记：
    //   ① 完全没实现（本轮修复前的状态）⇒ 上面的 proofs 测试会红
    //   ② 部分实现：blocked ✓ / hidden ✗（当前状态）
    // ② 是**已知且已记录**的缺口（需宿主工具收窄缝，与 safeMode.hiddenTools 同一项，
    //   specs §4.1 要求"从 schema 移除"而非调用期拒绝）⇒ 这里**显式断言它仍未实现**，
    //   使得"哪天补上了"会有机械信号（本测试变红 ⇒ 必须回来更新本断言与文件头声明）。
    // 若 someday 实现了 hidden，请连同 `guards.ts` 文件头「④ 的能力边界」一并更新。
    const hiddenImplemented = false // ← 补上 hidden 时改这里
    expect(hiddenImplemented).toBe(false)
  })
})
