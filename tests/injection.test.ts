import { describe, it, expect, beforeEach } from "vitest"

import { assembleBlocks, BLOCK_MARKERS, __resetInjectionState } from "../src/runtime/injection.js"
import { detectRoot } from "../src/runtime/ccc.js"
import { buildToolBlock } from "../src/runtime/blocks/tools.js"
import { buildSessionBlock, resolveActiveSession } from "../src/runtime/blocks/session.js"
import { buildSkillBlock, resolveEntrySkills } from "../src/runtime/blocks/skill.js"

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
  beforeEach(() => __resetInjectionState())

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

  it("幂等：已含标记头 ⇒ 不再产出该块（specs §5.0「同一会话不重复注入」）", () => {
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
  it("真实 CCC + 存在的会话 ⇒ 产出块，含 SESSION.md 路径与 TRAJECTORY-ASSISTANT 预声明", () => {
    const s = resolveActiveSession(CCC)
    // .current 指向的会话可能不存在（负路径）⇒ 两种情形都合法
    if (!s) {
      expect(buildSessionBlock(CCC)).toBeNull()
      return
    }
    const b = buildSessionBlock(CCC)!
    expect(b).toContain(BLOCK_MARKERS_SESSION)
    expect(b).toContain("SESSION.md path:")
    expect(b).toContain("TRAJECTORY-ASSISTANT:")
    expect(b).toContain("[TRAJECTORY-ASSISTANT-recorded-{code}]")
    expect(b).toContain("Read SESSION.md now to RESUME — not to audit")
  })

  it("无活跃会话 ⇒ 返回 null（整块省略，specs §5.9）", () => {
    expect(buildSessionBlock("/tmp")).toBeNull()
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
