/**
 * 工具面类型 — 复用宿主类型，不自造
 *
 * 取用方式：`@opencode/plugin/promise/tool`（实测可用 —— 宿主 `exports` 的 `"./*"` 支持多段路径）。
 *
 * 说明：主入口 `dist/promise/index.d.ts` **未再导出** `ToolEditor` / `Info`，
 * 故必须走子路径。若宿主后续把它们加进主入口，应改回 `@opencode/plugin` 具名导入。
 */

import type {
  ToolEditor as HostToolEditor,
  Info as HostToolInfo,
} from "@opencode/plugin/promise/tool"

/** 本插件注册的工具（promise 侧 Info） */
export type SerenityTool = HostToolInfo

/** 工具编辑器（宿主原样） */
export type ToolEditor = HostToolEditor

/** 一次注册的句柄 */
export interface Registration {
  dispose(): Promise<void>
}

/** 宿主 ctx 中本插件实际依赖的部分（用于单测注入假 ctx） */
export interface ToolRegistrar {
  tool: {
    transform(callback: (editor: ToolEditor) => void): Promise<Registration>
  }
}

/** session.hook 的注册面（注入面用） */
export interface SessionHookRegistrar {
  session: {
    hook(
      name: "context",
      callback: (input: unknown) => Promise<void> | void,
    ): Promise<Registration>
  }
}

