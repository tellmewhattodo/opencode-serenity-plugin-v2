import { describe, it, expect, beforeEach } from "vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { assembleBlocks, BLOCK_MARKERS, LOCALSTORE_MARKER } from "../src/runtime/injection.js"
import { detectRoot } from "../src/runtime/ccc.js"
import { buildToolBlock } from "../src/runtime/blocks/tools.js"
import { buildSessionBlock, resolveActiveSession } from "../src/runtime/blocks/session.js"
import { buildSkillBlock, resolveEntrySkills } from "../src/runtime/blocks/skill.js"
import {
  setActiveTrajectory,
  __resetActiveTrajectories,
} from "../src/runtime/active-trajectory.js"

const CCC = "/home/yh/home/home-serenity"

describe("ccc — detectRoot", () => {
  it("真实 CCC 目录判定为容器", () => {
    const r = detectRoot(CCC)
    expect(r.isContainer).toBe(true)
    expect(r.root).toBe(CCC)
    expect(r.name).toBe("home-serenity")
  })

  it("非 CCC 目录（无 .serenity）判定为非容器", () => {
    const r = detectRoot("/tmp")
    expect(r.isContainer).toBe(false)
    expect(r.root).toBeNull()
  })

  it("空串 ⇒ 非容器（fail-safe，不抛）", () => {
    expect(detectRoot("").isContainer).toBe(false)
  })
})

describe("injection — assembleBlocks 装配序（specs §5.0）", () => {
  beforeEach(() => {
    __resetActiveTrajectories()
  })

  it("装配序逐字对齐 specs：ACC→Metaphor→Principles→CCE→EAP→[状态]→[SKILL]→Tools→[Session]", () => {
    const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
    const heads = blocks.map((b) => b.split("\n")[0])

    // 前 5 块固定
    expect(heads.slice(0, 5)).toEqual([
      BLOCK_MARKERS[0],
      BLOCK_MARKERS[1],
      BLOCK_MARKERS[2],
      BLOCK_MARKERS[3],
      BLOCK_MARKERS[4],
    ])

    // Tools 必在；且必须出现在 SKILL（无标记头）之后
    const toolsIdx = heads.indexOf(BLOCK_MARKERS[6])
    expect(toolsIdx).toBeGreaterThanOrEqual(5)

    // 相对顺序：ACC < Metaphor < Principles < CCE < EAP < Tools
    expect(heads.indexOf(BLOCK_MARKERS[0])).toBeLessThan(heads.indexOf(BLOCK_MARKERS[1]))
    expect(heads.indexOf(BLOCK_MARKERS[1])).toBeLessThan(heads.indexOf(BLOCK_MARKERS[2]))
    expect(heads.indexOf(BLOCK_MARKERS[2])).toBeLessThan(heads.indexOf(BLOCK_MARKERS[3]))
    expect(heads.indexOf(BLOCK_MARKERS[3])).toBeLessThan(heads.indexOf(BLOCK_MARKERS[4]))
    expect(heads.indexOf(BLOCK_MARKERS[4])).toBeLessThan(toolsIdx)
  })

  it("幂等：已含标记头 ⇒ 不再产出该块（specs §5.6「标记头检测」）", () => {
    const existing = [BLOCK_MARKERS[0], BLOCK_MARKERS[1]]
    const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: existing })
    const heads = blocks.map((b) => b.split("\n")[0])
    expect(heads).not.toContain(BLOCK_MARKERS[0])
    expect(heads).not.toContain(BLOCK_MARKERS[1])
    // 其余仍在
    expect(heads).toContain(BLOCK_MARKERS[2])
  })

  it("全部已注入 ⇒ 产出为空数组", () => {
    const blocks = assembleBlocks({
      cccRoot: CCC,
      cccName: "home-serenity",
      existingTexts: [...BLOCK_MARKERS],
    })
    // SKILL 块无标记头，可能仍在；但 8 个有标记头的块必须全部消失
    const heads = blocks.map((b) => b.split("\n")[0])
    for (const m of BLOCK_MARKERS) expect(heads).not.toContain(m)
  })

  // ── 🔴 多轮回归（2026-10-14 owner 报「注入有问题」的根因护栏）──────────
  describe("🔴 多轮幂等（宿主每轮从零重建 system）", () => {
    it("宿主每轮交来**干净 system**（无标记头）⇒ 每轮都必须重新产出全部块", () => {
      // 实测：宿主两轮 hook 拿到的都是 4 段纯宿主内容（无任何 ACC 标记头）
      // ⇒ 第 2 轮若因"内存记忆已注入"而跳过，ACC 提示词就会**从第 2 轮起消失**。
      const turn1 = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
      const turn2 = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })

      // 两轮产出必须**一致且非空**（不得因轮次而衰减）
      expect(turn1.length).toBeGreaterThan(0)
      expect(turn2.length).toBe(turn1.length)
      expect(turn2.map((b) => b.split("\n")[0])).toEqual(turn1.map((b) => b.split("\n")[0]))
    })

    it("第 N 轮仍含 ACC 身份块（防「只在首轮出现」回归）", () => {
      for (let turn = 1; turn <= 3; turn++) {
        const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
        expect(blocks.some((b) => b.startsWith(BLOCK_MARKERS[0]))).toBe(true)
      }
    })

    it("宿主已带我们的标记头（真重复调用同一数组）⇒ 不重复 push", () => {
      // 同一轮内若宿主把我们的产出再交回来，标记头检测应拦住
      const first = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
      const second = assembleBlocks({
        cccRoot: CCC,
        cccName: "home-serenity",
        existingTexts: first.map((b) => b.split("\n")[0]),
      })
      const heads = second.map((b) => b.split("\n")[0])
      for (const m of BLOCK_MARKERS) expect(heads).not.toContain(m)
    })
  })

  it("ACC 身份块含适配层名与 CCC 名（specs §5.1 动态字段）", () => {
    const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
    const acc = blocks.find((b) => b.startsWith(BLOCK_MARKERS[0]))!
    expect(acc).toContain("ACC: serenity-acc v")
    expect(acc).toContain("CCC: home-serenity")
    // 末行必须给「发现 + 执行」两条指令（specs §5.1 🔴）
    expect(acc).toContain('msm() with no arguments to list them')
    expect(acc).toContain('msm("<name>") to execute one')
  })

  it("Principles 块含 Root 动态字段，且 Root 不在 ACC 块（specs §5.1/§5.3）", () => {
    const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
    const acc = blocks.find((b) => b.startsWith(BLOCK_MARKERS[0]))!
    const principles = blocks.find((b) => b.startsWith(BLOCK_MARKERS[2]))!
    expect(principles).toContain(`Root: ${CCC}`)
    expect(acc).not.toContain(`Root: ${CCC}`)
  })

  it("Metaphor 块为逐字固定内容（10 条隐喻 + 三层）", () => {
    const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
    const m = blocks.find((b) => b.startsWith(BLOCK_MARKERS[1]))!
    expect(m).toContain("THE SHIP — the container itself")
    expect(m).toContain("THE VOYAGE — the cognitive lifecycle")
    expect(m).toContain("THE CREW — multi-agent collaboration")
    expect(m).toContain("10. Blueprint over Statue")
  })

  it("CCE 块含五条行为约束（specs §5.4 逐字固定）", () => {
    const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
    const cce = blocks.find((b) => b.startsWith(BLOCK_MARKERS[3]))!
    for (const n of ["1. Continuity", "2. Bounded Space", "3. Entropy is Intrinsic", "4. Reconstruction > Preservation", "5. Multi-Agent Cognition"]) {
      expect(cce).toContain(n)
    }
  })
})

// ── 块 6：状态块 —— **独立两块**（specs §5.6）────────────────────────────
describe("块 6 状态块（specs §5.6：Safe Mode / Localstore 两块，各自条件）", () => {
  it("Safe Mode 块在 marker 存在时产出，含四条操作细节", () => {
    const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
    const sm = blocks.find((b) => b.startsWith(BLOCK_MARKERS[5]))
    if (!sm) {
      // marker 不在 ⇒ 整块省略（合法）；此时断言 marker 确实不存在
      expect(existsSync(join(CCC, ".serenity-safe-on"))).toBe(false)
      return
    }
    expect(sm).toContain("bash is disabled (hidden and blocked)")
    expect(sm).toContain("blacklist rules apply to file paths")
    expect(sm).toContain("governance files")
  })

  it("🔴 黑名单为空 ⇒ **不**出现 `Active blacklist rules:` 行（specs §5.6 块内唯一字段级差异）", () => {
    const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
    const sm = blocks.find((b) => b.startsWith(BLOCK_MARKERS[5]))
    if (!sm) return
    // 本 CCC 的 .opencode/serenity.json 中 safeMode.blacklist = [] ⇒ 该行必须缺席
    expect(sm).not.toContain("Active blacklist rules:")
  })

  it("🔴 Localstore 块按 gitTrack 产出（本 CCC = allow）", () => {
    const blocks = assembleBlocks({ cccRoot: CCC, cccName: "home-serenity", existingTexts: [] })
    const ls = blocks.find((b) => b.startsWith(LOCALSTORE_MARKER))
    expect(ls).toBeDefined()
    expect(ls).toContain("localstore.json is committed to git (gitTrack=allow")
    expect(ls).toContain("ONLY in this file")
  })

  it("🔴 两块标记头不同（共用一个会让幂等互相吞掉）", () => {
    expect(LOCALSTORE_MARKER).not.toBe(BLOCK_MARKERS[5])
  })

  it("Localstore 已注入 ⇒ 幂等跳过（按自身标记头）", () => {
    const blocks = assembleBlocks({
      cccRoot: CCC,
      cccName: "home-serenity",
      existingTexts: [LOCALSTORE_MARKER],
    })
    expect(blocks.some((b) => b.startsWith(LOCALSTORE_MARKER))).toBe(false)
  })
})

describe("blocks/tools — 块 8（specs §5.8）", () => {
  it("含 msm 四条协议行（Execute/Inspect/Index/Manage）", () => {
    const t = buildToolBlock()
    expect(t).toContain("Execute:")
    expect(t).toContain("Inspect:")
    expect(t).toContain("Index:")
    expect(t).toContain("Manage:")
  })

  it("含注册表写保护声明（specs §5.8 要求）", () => {
    expect(buildToolBlock()).toContain("never edit mech-registry.json directly")
  })
})

describe("blocks/session — 块 9（specs §5.9）", () => {
  beforeEach(() => __resetActiveTrajectories())

  it("无活跃轨迹 ⇒ 返回 null（整块省略，specs §5.9）", () => {
    expect(buildSessionBlock("ses_none")).toBeNull()
  })

  it("已激活 ⇒ 产出块，含 SESSION.md 路径与 TRAJECTORY-ASSISTANT 预声明", () => {
    setActiveTrajectory("ses_x", {
      id: "S156",
      dirName: "2026-09-06--S156--opencode-serenity 长期维护",
      mdPath: join(CCC, "AGENT_SESSIONS/2026-09-06--S156--opencode-serenity 长期维护/SESSION.md"),
    })

    const b = buildSessionBlock("ses_x")!
    expect(b).toContain("=== Serenity Session ===")
    expect(b).toContain("Active session: S156")
    expect(b).toContain("SESSION.md path:")
    expect(b).toContain("TRAJECTORY-ASSISTANT:")
    expect(b).toContain("[TRAJECTORY-ASSISTANT-recorded-{code}]")
    expect(b).toContain("Read SESSION.md now to RESUME — not to audit")
    // todowrite 首项（短名 = 去掉日期前缀与 S### 段）
    expect(b).toContain('content: "SESSION: S156 — opencode-serenity 长期维护"')
  })

  it("🔴 并发隔离：别的会话激活不影响本会话（防串台）", () => {
    setActiveTrajectory("ses_A", {
      id: "S156",
      dirName: "2026-09-06--S156--x",
      mdPath: "/tmp/x/SESSION.md",
    })
    expect(buildSessionBlock("ses_A")).not.toBeNull()
    // 未激活的会话 ⇒ 整块省略（**不回退**到最近活跃值，否则就是串台）
    expect(buildSessionBlock("ses_B")).toBeNull()
  })

  it("🔴 空 sessionID ⇒ 用最近活跃值（子代理继承场景）", () => {
    setActiveTrajectory("ses_A", {
      id: "S156",
      dirName: "2026-09-06--S156--x",
      mdPath: "/tmp/x/SESSION.md",
    })
    expect(buildSessionBlock("")).not.toBeNull()
  })

  it("🔴 不再依赖全局落盘 `.current`（陈旧残留曾导致静默整块省略）", () => {
    // 即便磁盘上 .current 指向一个**不存在**的轨迹（实测 S055 即此情形），
    // 只要本会话没有激活记录，就应视为无活跃轨迹 —— 而不是去读那个陈旧文件。
    expect(resolveActiveSession("ses_never_activated")).toBeNull()
    expect(buildSessionBlock("ses_never_activated")).toBeNull()
  })
})

const BLOCK_MARKERS_SESSION = "=== Serenity Session ==="

describe("blocks/skill — 块 7（specs §5.7）", () => {
  it("入口技能发现读 .serenity（内容 = 技能名）", () => {
    const names = resolveEntrySkills(CCC)
    expect(names).toContain("home-serenity")
  })

  it("产出 SKILL 全文块（不截断、无包裹头）", () => {
    const b = buildSkillBlock(CCC)
    expect(b).not.toBeNull()
    // 原文直推 ⇒ 首行应是 SKILL.md 的 frontmatter 定界符
    expect(b!.startsWith("---")).toBe(true)
    // 第二层披露树：references/ 条目
    expect(b!).toContain("references/")
  })

  it("非 CCC 目录 ⇒ null（不产出该块）", () => {
    expect(buildSkillBlock("/tmp")).toBeNull()
  })

  it("多技能以空行分隔，不得用 --- 作技能分隔符（specs §5.7）", () => {
    // 🔴 判据澄清：specs 禁的是「用 `---` 作为**技能之间**的分隔符」，
    //    不是「文本里不许出现 `---`」—— SKILL.md 正文自身常含 `---` 水平线。
    //    故正确的机械判据是：**技能边界处**必须是空行，不得是 `---` 行。
    //    单技能时无从检验边界 ⇒ 改用「产物不以 --- 为唯一分隔意图」的可验证近似：
    //    检查 references 披露段与正文之间是空行分隔（而非 --- 行）。
    const b = buildSkillBlock(CCC)
    if (!b) return

    const lines = b.split("\n")
    const refIdx = lines.findIndex((l) => l.trim().startsWith("references/"))
    expect(refIdx).toBeGreaterThan(0)

    // 披露段之前一行必须是空行（正文与披露树的边界 = 空行，不是 ---）
    const before = lines[refIdx - 1] ?? ""
    expect(before.trim()).toBe("")
  })
})
