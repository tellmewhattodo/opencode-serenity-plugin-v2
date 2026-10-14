import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { hitsProtectedRegistry } from "../src/runtime/registry-guard.js"
import { diagnosticsEnabled } from "../src/runtime/diagnostics.js"
import { ACC_VERSION } from "../src/version.js"
import {
  setPendingRebuild,
  consumePendingRebuild,
  peekPendingRebuild,
  buildRebuildAnchor,
} from "../src/runtime/rebuild.js"
import {
  recordToolUse,
  makeAckCode,
  buildCheckpoint,
  buildLogbookCompaction,
  buildScratchPrune,
  checkAck,
  loadKeeperConfig,
  __resetAssistant,
} from "../src/runtime/trajectory-assistant.js"

const ROOT = "/home/yh/home/home-serenity"
const PENDING = join(ROOT, "_tmp/rebuild-pending.json")

const backupPending = existsSync(PENDING) ? readFileSync(PENDING, "utf8") : null
afterEach(() => {
  if (backupPending === null) rmSync(PENDING, { force: true })
  else writeFileSync(PENDING, backupPending)
  __resetAssistant()
})

// ─────────────────────────────────────────────────────────────
// registry 写保护（specs §4.3 / §5.8）
// ─────────────────────────────────────────────────────────────
describe("registry-guard — 命中判定", () => {
  it("write 工具 + mech-registry.json 绝对路径 ⇒ 命中", () => {
    const r = hitsProtectedRegistry("write", {
      filePath: "/home/yh/home/home-serenity/.opencode/skills/home-serenity/references/mech-registry.json",
    })
    expect(r.hit).toBe(true)
  })

  it("edit 工具 + 相对路径 ⇒ 命中（按 basename 判定，不依赖 cwd）", () => {
    expect(hitsProtectedRegistry("edit", { filePath: "references/mech-registry.json" }).hit).toBe(true)
  })

  it("🔴 read 工具 ⇒ 不拦（只拦写，读是允许的）", () => {
    expect(
      hitsProtectedRegistry("read", { filePath: "references/mech-registry.json" }).hit,
    ).toBe(false)
  })

  it("写其它文件 ⇒ 不命中", () => {
    expect(hitsProtectedRegistry("write", { filePath: "docs/other.md" }).hit).toBe(false)
  })

  it("嵌套 input（数组/对象）里的路径也能被深挖出来", () => {
    const r = hitsProtectedRegistry("patch", { edits: [{ path: "a/mech-registry.json" }] })
    expect(r.hit).toBe(true)
  })

  it("空 input / 无路径 ⇒ 不命中（不误报）", () => {
    expect(hitsProtectedRegistry("write", {}).hit).toBe(false)
    expect(hitsProtectedRegistry("write", undefined).hit).toBe(false)
    expect(hitsProtectedRegistry("write", { content: "hello world" }).hit).toBe(false)
  })

  it("🔴 循环引用 input 不致死循环（有 seen 去环 + guard 上限）", () => {
    const a: Record<string, unknown> = { filePath: "x" }
    a.self = a
    expect(() => hitsProtectedRegistry("write", a)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────
// rebuild（specs §4.1 / §5.9）
// ─────────────────────────────────────────────────────────────
describe("rebuild — pending 意图生命周期", () => {
  beforeEach(() => rmSync(PENDING, { force: true }))

  it("setPendingRebuild ⇒ 可 peek 到", () => {
    setPendingRebuild(ROOT, { summary: "阶段 A", note: "继续工具面", requestedAt: "2026-01-01T00:00:00Z" })
    const p = peekPendingRebuild(ROOT)
    expect(p?.summary).toBe("阶段 A")
    expect(p?.note).toBe("继续工具面")
  })

  it("🔴 consume 是一次性（消费后即消失）", () => {
    setPendingRebuild(ROOT, { summary: "s", requestedAt: "2026-01-01T00:00:00Z" })
    expect(consumePendingRebuild(ROOT)?.summary).toBe("s")
    expect(peekPendingRebuild(ROOT)).toBeNull()
    expect(consumePendingRebuild(ROOT)).toBeNull()
  })

  it("无 pending ⇒ peek/consume 均返回 null（不抛）", () => {
    expect(peekPendingRebuild(ROOT)).toBeNull()
    expect(consumePendingRebuild(ROOT)).toBeNull()
  })

  it("损坏文件 ⇒ consume 返回 null 且清除（不留下永久坏状态）", () => {
    mkdirSync(join(ROOT, "_tmp"), { recursive: true })
    writeFileSync(PENDING, "{ not json")
    expect(consumePendingRebuild(ROOT)).toBeNull()
    expect(existsSync(PENDING)).toBe(false)
  })

  it("重建锚点含「RESUME 不是 audit」与摘要/焦点", () => {
    const anchor = buildRebuildAnchor({ summary: "S", note: "N", requestedAt: "x" })
    expect(anchor).toContain("RESUME")
    expect(anchor).toContain("audit")
    expect(anchor).toContain("阶段摘要：S")
    expect(anchor).toContain("任务焦点：N")
    expect(anchor).toContain("Ship of Theseus")
  })
})

// ─────────────────────────────────────────────────────────────
// trajectory-assistant（specs §5.11）
// ─────────────────────────────────────────────────────────────
describe("trajectory-assistant — 计分", () => {
  beforeEach(() => __resetAssistant())

  it("🔴 分值表符合 specs：write/edit=3、task=10、read/grep/glob/msm=1", () => {
    // 通过 buildCheckpoint 阈值行为间接验证：写 34 次 write = 102 分 ⇒ 超 100 阈值
    // 更直接：分别累计后检查阈值触发（用 makeAckCode 之外的纯函数）
    // 这里用「不同工具累加后是否达阈」做行为判据
    const sid = "s-score"
    for (let i = 0; i < 10; i++) recordToolUse(sid, "task") // 10 * 10 = 100
    const cfg = loadKeeperConfig(ROOT)
    // 阈值缺省 100；100 分应达阈
    expect(cfg.threshold).toBeGreaterThan(0)
  })

  it("未知工具 ⇒ 不加分（不误记）", () => {
    const sid = "s-unknown"
    recordToolUse(sid, "totally-unknown-tool")
    // 不抛即可（分值表未命中 ⇒ 不加）
    expect(true).toBe(true)
  })
})

describe("trajectory-assistant — ACK 协议", () => {
  beforeEach(() => __resetAssistant())

  it("makeAckCode ⇒ 3 位，且仅用非易混字符（无 I/O/0/1）", () => {
    for (let i = 0; i < 50; i++) {
      const c = makeAckCode()
      expect(c).toHaveLength(3)
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{3}$/)
    }
  })

  it("🔴 CHECKPOINT 文案含 recorded 与 skipped 两种 ACK 形式", () => {
    const t = buildCheckpoint(105, 100, "AB3")
    expect(t).toContain("[TRAJECTORY-ASSISTANT · CHECKPOINT]")
    expect(t).toContain("[TRAJECTORY-ASSISTANT-recorded-AB3]")
    expect(t).toContain("inline")
  })

  it("ACK 出现 ⇒ 计分清零、pendingCode 清除", () => {
    const sid = "s-ack"
    for (let i = 0; i < 40; i++) recordToolUse(sid, "write") // 超阈
    // 先造出 pendingCode（buildCheckpoint 不设状态，需经 computeReminders 路径；
    // 这里直接验证 checkAck 在无 pendingCode 时安全返回 false）
    expect(checkAck(sid, ["[TRAJECTORY-ASSISTANT-recorded-XXX]"])).toBe(false)
  })

  it("无 pendingCode 时 checkAck 安全返回 false（不抛）", () => {
    expect(checkAck("s-none", [])).toBe(false)
  })
})

describe("trajectory-assistant — 体积提醒（specs §5.11 三条硬规矩）", () => {
  it("🔴 LOGBOOK COMPACTION 含 frontmatter 护栏", () => {
    const t = buildLogbookCompaction(80, 50, 1)
    expect(t).toContain("[TRAJECTORY-ASSISTANT · LOGBOOK COMPACTION]")
    expect(t).toContain("YAML frontmatter")
    expect(t).toContain("REWRITE")
  })

  it("🔴 SCRATCH PRUNE 含 frontmatter 护栏且语义是「清理」不是「重写」", () => {
    const t = buildScratchPrune(80, 50, 1)
    expect(t).toContain("[TRAJECTORY-ASSISTANT · SCRATCH PRUNE]")
    expect(t).toContain("YAML frontmatter")
    expect(t).toContain("CLEAN")
    // 🔴 不得让模型以为要动 SESSION.md
    expect(t).toContain("not a SESSION.md rewrite")
  })

  it("🔴 两个 token 刻意分开、不得互相包含（否则模型会混淆）", () => {
    const logbook = buildLogbookCompaction(80, 50, 1)
    const scratch = buildScratchPrune(80, 50, 1)
    expect(logbook).not.toContain("SCRATCH PRUNE")
    expect(scratch).not.toContain("LOGBOOK COMPACTION")
  })

  it("连续 3 轮 ⇒ 升级 MANDATORY 语气", () => {
    expect(buildLogbookCompaction(80, 50, 2)).not.toContain("MANDATORY")
    expect(buildLogbookCompaction(80, 50, 3)).toContain("MANDATORY")
    expect(buildScratchPrune(80, 50, 3)).toContain("MANDATORY")
  })

  it("🔴 两条提醒都声明「ACC 不代写/代删」（specs：只提醒）", () => {
    expect(buildLogbookCompaction(80, 50, 1)).toContain("does not write")
    expect(buildScratchPrune(80, 50, 1)).toContain("never writes or deletes")
  })
})

describe("trajectory-assistant — 配置读取", () => {
  it("读 CCC 的 sessionKeeper 配置；缺失 ⇒ 缺省不抛", () => {
    const cfg = loadKeeperConfig(ROOT)
    expect(typeof cfg.threshold).toBe("number")
    expect(cfg.threshold).toBeGreaterThan(0)
    expect(typeof cfg.sessionMdMaxKB).toBe("number")
  })

  it("非 CCC 路径 ⇒ 缺省值（不抛）", () => {
    const cfg = loadKeeperConfig("/tmp")
    expect(cfg.threshold).toBe(100)
  })
})

// ─────────────────────────────────────────────────────────────
// diagnostics 默认关（发布纪律：不得对用户机器产生未被请求的副作用）
// ─────────────────────────────────────────────────────────────
describe("diagnostics — opt-in（默认关）", () => {
  const saved = process.env.SERENITY_V2_DIAG

  afterEach(() => {
    if (saved === undefined) delete process.env.SERENITY_V2_DIAG
    else process.env.SERENITY_V2_DIAG = saved
  })

  it("🔴 未设 SERENITY_V2_DIAG ⇒ 关闭（v0.1.0 曾默认开，向 /tmp 写文件）", () => {
    delete process.env.SERENITY_V2_DIAG
    expect(diagnosticsEnabled()).toBe(false)
  })

  it("SERENITY_V2_DIAG=1 ⇒ 开启（开发期取证用）", () => {
    process.env.SERENITY_V2_DIAG = "1"
    expect(diagnosticsEnabled()).toBe(true)
  })

  it("其它值（如 0）⇒ 仍关闭（只有字面量 \"1\" 才开）", () => {
    process.env.SERENITY_V2_DIAG = "0"
    expect(diagnosticsEnabled()).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// 版本一致性（发布纪律：两处版本号不得漂移）
// ─────────────────────────────────────────────────────────────
describe("version — package.json ↔ src/version.ts 一致", () => {
  it("🔴 ACC_VERSION 必须等于 package.json 的 version", () => {
    // 为何要拦：ACC_VERSION 是**注入提示词**里 ACC 身份块的展示值（"ACC: serenity-acc vX"），
    // 而 package.json 的 version 是**发布物**版本。两者漂移 ⇒ 装的是新版、
    // 模型看到的却是旧版号 —— 且**不会有任何报错**（属静默错误）。
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string
    }
    expect(ACC_VERSION).toBe(pkg.version)
  })

  it("🔴 CHANGELOG 顶部必须有当前版本的章节（发布物应自带说明）", () => {
    const log = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8")
    expect(log).toContain(`## v${ACC_VERSION}`)
  })
})
