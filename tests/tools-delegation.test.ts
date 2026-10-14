import { describe, it, expect, afterEach } from "vitest"
import { existsSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createHandymanTool } from "../src/tools/handyman.js"
import { createResidentTool } from "../src/tools/resident.js"

const ROOT = "/home/yh/home/home-serenity"
const JOBS = join(ROOT, "_tmp/handyman-jobs.json")
const RESIDENT_DIR = join(ROOT, "_tmp/resident")

async function run(tool: { execute: (a: never, c: never) => Promise<unknown> }, args: unknown) {
  return (await tool.execute(args as never, {} as never)) as { output: unknown; content: string }
}

let jobsBackup: string | null = null
afterEach(() => {
  // 恢复 jobs 清单
  if (jobsBackup === null) rmSync(JOBS, { force: true })
  else writeFileSync(JOBS, jobsBackup)
  rmSync(RESIDENT_DIR, { recursive: true, force: true })
})

describe("handyman — 契约面", () => {
  it("guide=true ⇒ 返回指南且不创建 agent", async () => {
    const t = createHandymanTool(ROOT)
    const r = await run(t, { guide: true })
    expect(r.content).toContain("handyman")
    expect(r.content).toContain("stop token")
  })

  it("无 task/jobs 且无 guide ⇒ 拒绝", async () => {
    const t = createHandymanTool(ROOT)
    const r = await run(t, {})
    expect(r.content).toContain("需要 task 或 jobs")
  })

  it("🔴 前台并行超 10 ⇒ 拒绝且声明一个都不起（specs 硬编码上限）", async () => {
    const t = createHandymanTool(ROOT)
    const jobs = Array.from({ length: 11 }, (_, i) => ({ task: `t${i}` }))
    const r = await run(t, { mode: "foreground", jobs })
    expect(r.content).toContain("超过foreground并行上限")
    expect(r.content).toContain("一个都不会启动")
  })

  it("🔴 恰好 10 个 ⇒ 不因上限被拒（边界）", async () => {
    const t = createHandymanTool(ROOT)
    const jobs = Array.from({ length: 10 }, (_, i) => ({ task: `t${i}` }))
    const r = await run(t, { mode: "foreground", jobs })
    // 可能因白名单配置而拒绝，但不应因「超上限」被拒
    expect(r.content).not.toContain("超过foreground并行上限")
  })

  it("白名单缺失或 model 不在白名单 ⇒ 明确拒绝（不静默）", async () => {
    const t = createHandymanTool(ROOT)
    const r = await run(t, { task: "x", model: "definitely/not-whitelisted-model" })
    // 要么无白名单、要么不在白名单 —— 两者都必须拒绝
    expect(r.content).toMatch(/未配置 handyman\.models|不在白名单/)
  })
})

describe("resident — 契约面", () => {
  it("list 空 ⇒ 提示无记录", async () => {
    const t = createResidentTool(ROOT)
    const r = await run(t, { action: "list" })
    expect(r.content).toContain("无常驻记录")
  })

  it("start 登记声明并明说执行链未接入（不假装已跑）", async () => {
    const t = createResidentTool(ROOT)
    const r = await run(t, { action: "start", name: "t1", command: "sleep 1000" })
    expect(r.content).toContain("已登记常驻声明")
    expect(r.content).toContain("执行链未接入")
    // 🔴 v1 教训必须写进回执
    expect(r.content).toContain("SIGKILL")
  })

  it("status 读到已登记项", async () => {
    const t = createResidentTool(ROOT)
    await run(t, { action: "start", name: "t2", command: "sleep 1" })
    const r = await run(t, { action: "status", name: "t2" })
    expect(r.content).toContain("t2")
    expect(r.content).toContain("declared")
  })

  it("stop 移除登记", async () => {
    const t = createResidentTool(ROOT)
    await run(t, { action: "start", name: "t3", command: "sleep 1" })
    const r = await run(t, { action: "stop", name: "t3" })
    expect(r.content).toContain("已移除常驻声明")
    expect(existsSync(join(RESIDENT_DIR, "t3.json"))).toBe(false)
  })

  it("未知动作 ⇒ 拒绝", async () => {
    const t = createResidentTool(ROOT)
    const r = await run(t, { action: "nope" })
    expect(r.content).toContain("未知动作")
  })
})

// 保持 jobsBackup 初始化（避免 afterEach 误删）
jobsBackup = existsSync(JOBS) ? readFileSync(JOBS, "utf8") : null
