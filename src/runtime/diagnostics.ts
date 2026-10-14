/**
 * 装载证据（diagnostics）—— 仅供开发期确认插件被加载与注册成功。
 *
 * 设计意图（EAP · R↓）：
 *   插件在宿主里是"静默"运行的，失败时只有日志。开发期需要一个**机械可查的证据**，
 *   否则只能靠"猜它有没有生效"（本项目已因此连踩三次坑）。
 *
 * 🔴 边界：这是**开发期诊断** —— **默认为关**（opt-in），只有显式设
 *   `SERENITY_V2_DIAG=1` 才启用。理由：插件在用户机器上是**静默后台**运行的，
 *   默认向 /tmp 写文件属于**未被请求的副作用**（隐私 + 磁盘 + 行为不可预期）。
 *
 *   判据变更记录（R↓）：v0.1.0 发布时为"默认开"（`SERENITY_V2_NO_DIAG !== "1"`），
 *   2026-10-14 装载验证时发现 **npm 安装的包在被宿主加载时也向 /tmp 写文件**
 *   ⇒ 改为默认关。开发期取证前先 export `SERENITY_V2_DIAG=1`。
 */

import { mkdirSync, writeFileSync } from "node:fs"

const DIR = process.env.SERENITY_V2_DIAG_DIR || "/tmp/serenity-v2-load"

/** 写一条诊断证据（失败不得影响插件） */
export function evidence(name: string, data: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(`${DIR}/${name}.json`, JSON.stringify(data, null, 2))
  } catch {
    // 证据写入失败不影响插件
  }
}

/** 是否启用诊断（**默认关**；设 SERENITY_V2_DIAG=1 才启用） */
export function diagnosticsEnabled(): boolean {
  return process.env.SERENITY_V2_DIAG === "1"
}
