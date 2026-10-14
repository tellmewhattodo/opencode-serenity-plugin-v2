import { describe, it, expect, afterEach } from "vitest"
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { createContainerTrajectoryTool } from "../src/tools/container_trajectory.js"
import { createPraxisTool } from "../src/tools/praxis.js"
import { createContainerAdminTool } from "../src/tools/container_admin.js"
import { __resetActiveTrajectories } from "../src/runtime/active-trajectory.js"
import { buildSessionBlock } from "../src/runtime/blocks/session.js"
import { assembleBlocks } from "../src/runtime/injection.js"

const ROOT = "/home/yh/home/home-serenity"
const WAKE = join(ROOT, "AGENT_SESSIONS/wake-registry.json")
const INBOX = join(ROOT, "AGENT_SESSIONS/_inbox")

/** 测试用宿主会话 id（活跃轨迹按它隔离） */
const SCOPE = "ses_test_scope_0001"

/** 备份/恢复可能被测试触碰的文件 */
let wakeBackup: string | null = null
function backupWake() {
  wakeBackup = existsSync(WAKE) ? readFileSync(WAKE, "utf8") : null
}
function restoreWake() {
  if (wakeBackup === null) rmSync(WAKE, { force: true })
  else writeFileSync(WAKE, wakeBackup)
}

async function run(
  tool: { execute: (a: never, c: never) => Promise<unknown> },
  args: unknown,
  scope: string = SCOPE,
) {
  return (await tool.execute(args as never, { sessionID: scope } as never)) as {
    output: unknown
    content: string
  }
}

afterEach(() => {
  rmSync(INBOX, { recursive: true, force: true })
  restoreWake()
  __resetActiveTrajectories()
})

describe("container_trajectory — list / show", () => {
  it("list ⇒ 清单 + 统计 + 活跃指针", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "list" })
    const out = r.output as { total: number; current: string | null }
    expect(out.total).toBeGreaterThan(0)
    expect(r.content).toContain("AGENT_SESSIONS/")
  })

  it("show S156 ⇒ 读到 SESSION.md 全文", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "show", name: "S156" })
    expect(r.content).toContain("SESSION: opencode-serenity-plugin")
  })

  it("show 不存在的 ⇒ 明确报错", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "show", name: "S99999" })
    expect(r.content).toContain("未找到轨迹")
  })
})

describe("container_trajectory — use（内联完整性检查）", () => {
  it("use 已存在的轨迹 ⇒ 激活（写**按会话隔离的内存状态**，不落盘）", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "use", name: "S156", force: true })
    expect(r.content).toContain("已激活")

    // 🔴 反向断言：**不再**写全局落盘 `.current`（并发串台 + 陈旧残留的根因）
    const cur = join(ROOT, "AGENT_SESSIONS/.current")
    const onDisk = existsSync(cur) ? readFileSync(cur, "utf8").trim() : null
    expect(onDisk).not.toBe("S156")

    // 正断言：list 能在**同一 scope** 下看到活跃标记
    const rl = await run(t, { action: "list" })
    expect((rl.output as { current: string | null }).current).toBe("S156")
  })

  it("🔴 并发隔离：A 会话 use 后，B 会话读不到（防串台）", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    await run(t, { action: "use", name: "S156", force: true }, "ses_scope_A")
    await run(t, { action: "use", name: "S151", force: true }, "ses_scope_B")

    const a = await run(t, { action: "list" }, "ses_scope_A")
    const b = await run(t, { action: "list" }, "ses_scope_B")
    expect((a.output as { current: string | null }).current).toBe("S156")
    expect((b.output as { current: string | null }).current).toBe("S151")

    // 第三个会话：无活跃轨迹（不受前两者影响）
    const c = await run(t, { action: "list" }, "ses_scope_C")
    expect((c.output as { current: string | null }).current).toBeNull()
  })

  it("🔴 绑定守卫按 scope 判：同一 scope 换目标需 force，不同 scope 不需", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    await run(t, { action: "use", name: "S156", force: true }, "ses_scope_X")

    const blocked = await run(t, { action: "use", name: "S151" }, "ses_scope_X")
    expect(blocked.content).toContain("需 force")

    // 换个 scope ⇒ 无历史绑定 ⇒ 不需要 force
    const ok = await run(t, { action: "use", name: "S151" }, "ses_scope_Y")
    expect(ok.content).toContain("已激活")
  })

  it("use 指向缺 SESSION.md 的轨迹 ⇒ 拒绝激活（不制造半截状态）", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "use", name: "S99999", force: true })
    expect(r.content).toContain("未找到轨迹")
  })

  // ── 🔴 跨模块集成：use → 块 9 注入（owner 报「注入有问题」的块 9 侧护栏）────
  it("🔴 use 之后，buildSessionBlock 立即产出块 9（同一模块实例，无落盘中转）", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "use", name: "S156", force: true }, "ses_integration")
    expect(r.content).toContain("已激活")

    const block = buildSessionBlock("ses_integration")
    expect(block).not.toBeNull()
    expect(block).toContain("=== Serenity Session ===")
    expect(block).toContain("Active session: S156")
    expect(block).toContain("SESSION.md path:")
    expect(block).toContain("TRAJECTORY-ASSISTANT:")
  })

  it("🔴 use → assembleBlocks 里也出现块 9（端到端装配）", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    await run(t, { action: "use", name: "S156", force: true }, "ses_assemble")

    const blocks = assembleBlocks({
      cccRoot: ROOT,
      cccName: "home-serenity",
      existingTexts: [],
      sessionID: "ses_assemble",
    })
    const heads = blocks.map((b) => b.split("\n")[0])
    expect(heads).toContain("=== Serenity Session ===")
    // 且必须**在末尾**（specs §5.0：Session 是第 9 块，殿后）
    expect(heads.indexOf("=== Serenity Session ===")).toBe(heads.length - 1)
  })
})

describe("container_trajectory — rebuild（登记意图）", () => {
  it("rebuild 无 summary ⇒ 拒绝", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "rebuild" })
    expect(r.content).toContain("需要 summary")
  })

  it("rebuild 带 summary ⇒ 登记意图并指向 v2 落点", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "rebuild", summary: "下一阶段" })
    expect(r.content).toContain("rebuild 意图已登记")
    // 🔴 必须说明 v2 的真实落点（机制面已接入）
    expect(r.content).toContain("compaction")
    expect(r.content).toContain("跳过模型请求")
  })
})

describe("container_trajectory — send-now（有回执）", () => {
  it("投递 ⇒ 落收件箱并给回执", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "send-now", target: "S156", message: "hi" })
    expect(r.content).toContain("已投递")
    expect(r.content).toContain("同步回执")
    expect(existsSync(INBOX)).toBe(true)
  })

  it("缺 target/message ⇒ 拒绝", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "send-now", target: "S156" })
    expect(r.content).toContain("需要 target 与 message")
  })
})

describe("container_trajectory — send-later（fire-and-forget）", () => {
  it("+30m ⇒ 落唤醒注册表，并声明无回执", async () => {
    backupWake()
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "send-later", target: "S156", at: "+30m", message: "later" })
    expect(r.content).toContain("已排定")
    // 🔴 必须显式声明 fire-and-forget 语义
    expect(r.content).toContain("无回执")
    expect(r.content).toContain("不可回收")
  })

  it("非法时刻 ⇒ 拒绝", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "send-later", target: "S156", at: "not-a-time", message: "x" })
    expect(r.content).toContain("无法解析时刻")
  })
})

describe("container_trajectory — cro-guide", () => {
  it("无参数 ⇒ 返回指南", async () => {
    const t = createContainerTrajectoryTool(ROOT)
    const r = await run(t, { action: "cro-guide" })
    expect(r.content).toContain("CRO")
    expect(r.content).toContain("send-later")
    expect(r.content).toContain("禁轮询")
  })
})

describe("praxis（四段 + 索引）", () => {
  it("无参 ⇒ 索引含四段", async () => {
    const t = createPraxisTool(ROOT)
    const r = await run(t, {})
    for (const s of ["eap", "neat", "cce", "ontology"]) expect(r.content).toContain(s)
  })

  it("各段可注入且非空", async () => {
    const t = createPraxisTool(ROOT)
    for (const s of ["eap", "neat", "cce", "ontology"]) {
      const r = await run(t, { section: s })
      expect(r.content.length).toBeGreaterThan(100)
    }
  })

  it("eap 段含三变量", async () => {
    const t = createPraxisTool(ROOT)
    const r = await run(t, { section: "eap" })
    expect(r.content).toContain("E↑")
    expect(r.content).toContain("R↓")
    expect(r.content).toContain("S↑")
  })

  it("ontology 段必须点明「工具 vs 方法文本」的分工", async () => {
    const t = createPraxisTool(ROOT)
    const r = await run(t, { section: "ontology" })
    expect(r.content).toContain("引擎")
  })

  it("未知段 ⇒ 拒绝", async () => {
    const t = createPraxisTool(ROOT)
    const r = await run(t, { section: "nope" })
    expect(r.content).toContain("未知段")
  })
})

describe("container_admin — msm 注册表", () => {
  it("check ⇒ 完整性检查有结果", async () => {
    const t = createContainerAdminTool(ROOT)
    const r = await run(t, { domain: "msm", action: "check" })
    expect(r.content).toContain("注册表完整性检查")
  })

  it("catalog ⇒ 按 skill 统计", async () => {
    const t = createContainerAdminTool(ROOT)
    const r = await run(t, { domain: "msm", action: "catalog" })
    expect(r.content).toContain("MSMs registered")
  })

  it("guide ⇒ 声明写保护", async () => {
    const t = createContainerAdminTool(ROOT)
    const r = await run(t, { domain: "msm", action: "guide" })
    expect(r.content).toContain("写保护")
  })

  it("🔴 register path 逃逸 ⇒ 拒绝", async () => {
    const t = createContainerAdminTool(ROOT)
    const r = await run(t, {
      domain: "msm",
      action: "register",
      name: "evil",
      path: "../../../etc/passwd",
    })
    expect(r.content).toContain("逃逸")
  })

  it("config ⇒ 列出存在的配置文件", async () => {
    const t = createContainerAdminTool(ROOT)
    const r = await run(t, { domain: "config" })
    expect(r.content).toContain("CCC 根")
  })

  it("未知域 ⇒ 拒绝", async () => {
    const t = createContainerAdminTool(ROOT)
    const r = await run(t, { domain: "nope" })
    expect(r.content).toContain("未知域")
  })

  it("🔴 autopilot 域已退场 ⇒ 不在可枚举值里（specs）", async () => {
    const t = createContainerAdminTool(ROOT)
    const r = await run(t, { domain: "autopilot" })
    expect(r.content).toContain("未知域")
    expect(r.content).not.toContain("autopilot 已启用")
  })
})
