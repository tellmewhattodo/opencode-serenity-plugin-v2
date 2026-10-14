/**
 * rebuild —— 轨迹原地重建（Ship of Theseus，specs §4.1 / §5.9）
 *
 * 语义：**同一 trajectory 的持久身体（SESSION.md）不动**；
 *   会话（载体重建）被清空并重新锚定到 SESSION.md 的「当前状态」。
 *
 * v2 落点（实测取证，见 docs/v2-capability-mapping.md §2）：
 *   `ctx.session.hook("compaction", …)`
 *   其 payload 为 `SessionCompaction extends SessionContext { result?: SessionCompactionResult }`
 *   🔴 **`result` 可直接设定 ⇒ 可跳过模型请求**（v1 只能"替换 prompt/追加 context"）
 *   ⇒ v2 的 rebuild **比 v1 更直接、更省 token**。
 *
 * 实现策略（两段）：
 *   ① **意图登记**：`container_trajectory rebuild` 落一个 pending 标记（含 summary/note）
 *   ② **压缩时消费**：本 hook 检测到 pending ⇒ 向 `system` 追加**重建锚点**，
 *      并设 `result` 给出确定性摘要（跳过模型），从而完成"原地重建"。
 *
 * 🔴 边界：本机制**不删除**任何文件；SESSION.md 是持久身体，永不移动。
 */

import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import type { SessionHookRegistrar } from "../tools/types.js"
import { evidence, diagnosticsEnabled } from "./diagnostics.js"
import { detectContainer } from "./ccc.js"

/** pending 重建意图的落点（相对 CCC 根） */
const PENDING_REL = "_tmp/rebuild-pending.json"

export interface RebuildIntent {
  sessionID?: string
  summary: string
  note?: string
  requestedAt: string
}

/** 登记重建意图（由 container_trajectory rebuild 调用） */
export function setPendingRebuild(cccRoot: string, intent: RebuildIntent): string {
  const dir = join(cccRoot, "_tmp")
  mkdirSync(dir, { recursive: true })
  const p = join(cccRoot, PENDING_REL)
  writeFileSync(p, JSON.stringify(intent, null, 2))
  return p
}

/** 读并清除重建意图（一次性消费） */
export function consumePendingRebuild(cccRoot: string): RebuildIntent | null {
  const p = join(cccRoot, PENDING_REL)
  if (!existsSync(p)) return null
  try {
    const intent = JSON.parse(readFileSync(p, "utf8")) as RebuildIntent
    rmSync(p, { force: true })
    return intent
  } catch {
    rmSync(p, { force: true })
    return null
  }
}

/** 只读探测（不消费；供诊断） */
export function peekPendingRebuild(cccRoot: string): RebuildIntent | null {
  const p = join(cccRoot, PENDING_REL)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RebuildIntent
  } catch {
    return null
  }
}

/** 生成重建锚点文本（告诉重建后的自己：读 SESSION.md 接着干） */
export function buildRebuildAnchor(intent: RebuildIntent): string {
  return [
    `=== Serenity Rebuild Anchor ===`,
    `This conversation was rebuilt in place (Ship of Theseus).`,
    `你的持久身体（SESSION.md）未变；本会话是被替换的载体。`,
    ``,
    `下一步：`,
    `  1. 读 SESSION.md 的「当前状态」与「待 owner 裁决」两段 —— **RESUME，不是 audit**`,
    `  2. 从那里接着干；不要重述历史`,
    ``,
    `阶段摘要：${intent.summary}`,
    intent.note ? `任务焦点：${intent.note}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n")
}

/**
 * 注册 rebuild 机制。
 *
 * @returns disposers
 */
export async function registerRebuild(
  ctx: SessionHookRegistrar,
): Promise<Array<() => Promise<void>>> {
  const reg = await ctx.session.hook("compaction", async (input: unknown) => {
    const it = input as {
      sessionID?: unknown
      system?: unknown
      result?: unknown
    }
    const sessionID = String(it.sessionID ?? "")
    const diag = diagnosticsEnabled()

    const cc = await detectContainer(ctx, sessionID)
    if (!cc.isContainer || !cc.root) return

    const intent = peekPendingRebuild(cc.root)
    if (!intent) return

    // 若意图指定了目标会话，则只对该会话生效
    if (intent.sessionID && intent.sessionID !== sessionID) return

    // 消费（一次性）
    consumePendingRebuild(cc.root)

    // ① 向 system 追加重建锚点
    if (Array.isArray(it.system)) {
      ;(it.system as Array<{ type: string; text: string }>).push({
        type: "text",
        text: buildRebuildAnchor(intent),
      })
    }

    // ② 🔴 设 result ⇒ 跳过模型请求（v2 独有优势）
    //    确定性摘要把"下一步"钉死，不依赖模型重新总结而丢失焦点。
    it.result = {
      summary: `会话已原地重建。持久身体 = SESSION.md（未变）。阶段摘要：${intent.summary}${
        intent.note ? `｜焦点：${intent.note}` : ""
      }`,
    }

    if (diag) {
      evidence("rebuild-consumed", {
        at: new Date().toISOString(),
        sessionID,
        cccRoot: cc.root,
        summary: intent.summary,
        note: intent.note ?? null,
        skippedModelRequest: true,
      })
    }
  })

  return [() => reg.dispose()]
}
