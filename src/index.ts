/**
 * Serenity ACC — opencode v2 插件入口
 *
 * 基于 @opencode/plugin@2.x 的 v2 插件 API：
 *   Plugin.define({ id, setup(ctx) })  →  ctx 是 26 域的 Context
 *
 * 本文件 = 装配层（composition root）：
 *   1. 探测/记录运行时环境（CCC 根、safe-mode）
 *   2. 注册工具面（ctx.tool.transform）
 *   3. 装载注入面 / 机制面（后续 Phase 接入）
 *   4. 返回 cleanup（插件卸载时执行）
 *
 * 证据锚点：`docs/osp-v2-host-capability-verification.md`
 */

import { Plugin } from "@opencode/plugin"

import { detectContainer, type ContainerInfo } from "./runtime/container.js"
import { registerTools } from "./tools/index.js"

/** 插件 id（宿主用于去重与日志；同一 id 不得重复注册） */
const PLUGIN_ID = "serenity-acc"

export const SerenityPlugin = Plugin.define({
  id: PLUGIN_ID,

  async setup(ctx) {
    // ── 阶段 1：环境探测 ────────────────────────────────────────
    const container: ContainerInfo = await detectContainer(ctx)

    // 不在 CCC 内 ⇒ 零影响退出（与 v1 的「非 CCC 目录零侵入」语义一致）
    if (!container.isContainer) {
      return
    }

    ctx.app?.version // 触碰一次，确认 ctx 形态（仅为类型校验）

    // ── 阶段 2：工具面 ─────────────────────────────────────────
    const disposers = await registerTools(ctx, container)

    // ── 阶段 3：cleanup ────────────────────────────────────────
    return async () => {
      // 逆序释放；单个失败不阻断其余（清理必须尽力而为）
      for (const dispose of [...disposers].reverse()) {
        try {
          await dispose()
        } catch {
          // 清理期异常不抛出：避免掩盖真正的卸载原因
        }
      }
    }
  },
})

export default SerenityPlugin
