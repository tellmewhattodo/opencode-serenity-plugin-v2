/**
 * CCC 判定 —— **会话级**（实测语义，见 docs/v2-capability-mapping.md §10）
 *
 * 🔴 为什么不直接用 `ctx.location`：
 *   `ctx` 是**插件实例级**的，`ctx.location.directory` = 服务进程启动时的 cwd
 *   （官方文档：「the plugin instance's location, not the location of every session」）。
 *   ACC 的语义是**会话级**的 ⇒ 判据必须取该会话自己的 `location.directory`。
 *
 * 判据（specs §7 激活协议）：CCC 根 = 含 `.serenity` 标记文件的目录。
 */

import { existsSync } from "node:fs"
import { basename, join } from "node:path"

import type { SessionHookRegistrar } from "../tools/types.js"

export interface ContainerInfo {
  readonly isContainer: boolean
  readonly root: string | null
  readonly name: string
}

const NOT_A_CONTAINER: ContainerInfo = { isContainer: false, root: null, name: "" }

/** 判定给定目录是否为 CCC */
export function detectRoot(directory: string): ContainerInfo {
  if (!directory) return NOT_A_CONTAINER
  try {
    if (!existsSync(join(directory, ".serenity"))) return NOT_A_CONTAINER
    return { isContainer: true, root: directory, name: basename(directory) }
  } catch {
    return NOT_A_CONTAINER
  }
}

/**
 * 会话级 CCC 判定。
 *
 * 取 `session.get({ sessionID }).location.directory`（会话自身位置）。
 * 取不到会话 ⇒ 非 CCC（fail-safe：宁可不激活，也不误注入）。
 */
export async function detectContainer(
  ctx: SessionHookRegistrar,
  sessionID: string,
): Promise<ContainerInfo> {
  if (!sessionID || typeof ctx.session.get !== "function") return NOT_A_CONTAINER

  try {
    const session = (await ctx.session.get({ sessionID })) as {
      location?: { directory?: string }
    }
    const dir = session?.location?.directory
    if (typeof dir !== "string" || dir.length === 0) return NOT_A_CONTAINER
    return detectRoot(dir)
  } catch {
    return NOT_A_CONTAINER
  }
}
