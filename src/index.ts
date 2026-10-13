/**
 * Serenity ACC — opencode v2 插件入口
 *
 * 基于 @opencode/plugin@2.x 的 v2 插件 API：
 *   Plugin.define({ id, setup(ctx) })  →  ctx 是 26 域的 Context
 *
 * 🎯 架构要点（实测得出，见 docs/v2-capability-mapping.md）：
 *
 *   1. **`ctx` 是插件实例级的，不是会话级的**。
 *      `ctx.location.directory` = 服务进程启动时的 cwd，**不能**用作 CCC 判据
 *      （官方文档：「the plugin instance's location, not the location of every session」）。
 *
 *   2. **工具注册与 CCC 判定解耦**：
 *      工具注册在**宿主级**（与会话无关），激活与否下沉到**会话级**（注入面判定）。
 *      这与 specs §4.1「域外全局隐藏」的语义一致。
 *
 *   3. **注入面在会话级**：`ctx.session.hook("context", …)` 拿到 `SessionContext`
 *      （含 `system` / `messages` / `tools`），且有 `sessionID` ⇒ 可据会话判定 CCC。
 */

import { Plugin } from "@opencode/plugin"

import { registerTools } from "./tools/index.js"
import { registerInjectionProbe } from "./runtime/injection-probe.js"
import { evidence, diagnosticsEnabled } from "./runtime/diagnostics.js"

/** 插件 id（宿主用于去重与日志；同一 id 不得重复注册） */
const PLUGIN_ID = "serenity-acc"

export const SerenityPlugin = Plugin.define({
  id: PLUGIN_ID,

  async setup(ctx) {
    const diag = diagnosticsEnabled()

    if (diag) {
      evidence("loaded", {
        at: new Date().toISOString(),
        pluginId: PLUGIN_ID,
        contextKeys: Object.keys(ctx ?? {}).sort(),
        locationDirectory: ctx?.location?.directory ?? null,
      })
    }

    // ── 阶段 1：工具面注册（宿主级，不依赖 CCC 判定）────────────
    let disposers: Array<() => Promise<void> | void> = []
    try {
      disposers = await registerTools(ctx)
      if (diag) {
        // 自证：读回宿主实际注册的工具清单（机械证据，非自述）
        const registered = await ctx.tool.list()
        evidence("tools", {
          at: new Date().toISOString(),
          registeredCount: registered.length,
          registeredNames: registered.map((t) => t.id ?? t.name),
        })
      }
    } catch (e) {
      if (diag) {
        evidence("tools-error", {
          at: new Date().toISOString(),
          error: String(e),
          stack: e instanceof Error ? e.stack : null,
        })
      }
      throw e
    }

    // ── 阶段 2：注入面（会话级，按会话判定 CCC）────────────────
    // 见 docs/v2-capability-mapping.md §1：落点 = ctx.session.hook("context", …)
    const injectionDisposers = await registerInjectionProbe(ctx).catch((e) => {
      if (diag) evidence("injection-error", { error: String(e) })
      return []
    })

    // ── 阶段 3：cleanup ────────────────────────────────────────
    return async () => {
      // 逆序释放；单个失败不阻断其余（清理必须尽力而为）
      for (const dispose of [...injectionDisposers, ...disposers].reverse()) {
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
