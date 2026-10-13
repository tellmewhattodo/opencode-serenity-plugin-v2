/**
 * 装载证据（diagnostics）—— 仅供开发期确认插件被加载与注册成功。
 *
 * 设计意图（EAP · R↓）：
 *   插件在宿主里是"静默"运行的，失败时只有日志。开发期需要一个**机械可查的证据**，
 *   否则只能靠"猜它有没有生效"（本项目已因此连踩三次坑）。
 *
 * 🔴 边界：这是**开发期诊断**，发布前应改为 opt-in（如环境变量开启），
 *   否则会在用户机器上写 /tmp 文件。
 */

import { mkdirSync, writeFileSync } from "node:fs"

const DIR = "/tmp/serenity-v2-load"

/** 写一条诊断证据（失败不得影响插件） */
export function evidence(name: string, data: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(`${DIR}/${name}.json`, JSON.stringify(data, null, 2))
  } catch {
    // 证据写入失败不影响插件
  }
}

/** 是否启用诊断（开发期默认开；设 SERENITY_V2_NO_DIAG=1 关闭） */
export function diagnosticsEnabled(): boolean {
  return process.env.SERENITY_V2_NO_DIAG !== "1"
}
