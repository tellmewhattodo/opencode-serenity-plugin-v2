/**
 * 注入面探针 —— 验证 `ctx.session.hook("context", …)` 真的被触发。
 *
 * 目的（P0-④ 收尾）：
 *   在写 9 块注入之前，先用最小探针确认：
 *     ① hook 被调用的时机与频次
 *     ② `SessionContext` 的实际字段（对照 .d.ts）
 *     ③ `system` 的**实际结构**（SystemPart 长什么样 —— 决定 9 块怎么拼）
 *     ④ `sessionID` 能否用于**会话级** CCC 判定
 *
 * 用法：开发期诊断；确认后本文件可删（其结论写入 docs）。
 */

import type { SessionHookRegistrar } from "../tools/types.js"
import { evidence, diagnosticsEnabled } from "./diagnostics.js"

export async function registerInjectionProbe(
  ctx: SessionHookRegistrar,
): Promise<Array<() => Promise<void>>> {
  if (!diagnosticsEnabled()) return []

  const reg = await ctx.session.hook("context", (input: unknown) => {
    const sys = (input as { system?: unknown }).system
    evidence("context-hook", {
      at: new Date().toISOString(),
      sessionID: String((input as { sessionID?: unknown }).sessionID ?? ""),
      agent: String((input as { agent?: unknown }).agent ?? ""),
      topLevelKeys: Object.keys(input ?? {}).sort(),
      systemType: Array.isArray(sys) ? "array" : typeof sys,
      systemLength: Array.isArray(sys) ? sys.length : null,
      // 取第一个元素看结构（决定 9 块如何拼装）
      systemSample: Array.isArray(sys) ? JSON.stringify(sys[0]).slice(0, 800) : null,
      messagesCount: Array.isArray((input as { messages?: unknown[] }).messages)
        ? (input as { messages: unknown[] }).messages.length
        : null,
    })
  })

  return [() => reg.dispose()]
}
