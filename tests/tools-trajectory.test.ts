import { describe, it, expect, afterEach } from "vitest"
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { createContainerTrajectoryTool } from "../src/tools/container_trajectory.js"
import { createPraxisTool } from "../src/tools/praxis.js"
import { createContainerAdminTool } from "../src/tools/container_admin.js"

const ROOT = "/home/yh/home/home-serenity"
const WAKE = join(ROOT, "AGENT_SESSIONS/wake-registry.json")
const INBOX = join(ROOT, "AGENT_SESSIONS/_inbox")

/** 备份/恢复可能被测试触碰的文件 */
let wakeBackup: string | null = null
function backupWake() {
  wakeBackup = existsSync(WAKE) ? readFileSync(WAKE, "utf8") : null
}
function restoreWake() {
  if (wakeBackup === null) rmSync(WAKE, { force: true })
  else writeFileSync(WAKE, wakeBackup)
}

async function run(tool: { execute: (a: never, c: never) => Promise<unknown> }, args: unknown) {
  return (await tool.execute(args as never, {} as never)) as { output: unknown; content: string }
}

afterEach(() => {
  rmSync(INBOX, { recursive: true, force: true })
  restoreWake()
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
  it("use 已存在的轨迹 ⇒ 激活并写 .current；测后恢复", async () => {
    const cur = join(ROOT, "AGENT_SESSIONS/.current")
    const backup = existsSync(cur) ? readFileSync(cur, "utf8") : null
    try {
      const t = createContainerTrajectoryTool(ROOT)
      const r = await run(t, { action: "use", name: "S156", force: true })
      expect(r.content).toContain("已激活")
      expect(readFileSync(cur, "utf8").trim()).toBe("S156")
    } finally {
      if (backup !== null) writeFileSync(cur, backup)
    }
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
    expect(r.content).toContain("rebuild 请求已登记")
    // 🔴 必须说明 v2 的真实落点（不假装已实现）
    expect(r.content).toContain("compaction")
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
