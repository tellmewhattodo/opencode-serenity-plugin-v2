/**
 * CCC（认知容器）运行时探测
 *
 * 语义（对齐 specs §7 激活协议）：
 *   - CCC 的判据 = 存在 `.serenity` 标记文件
 *   - 不在 CCC 内 ⇒ 插件零影响（不注册工具、不注入）
 *
 * v2 的 ctx 提供 `ctx.location.directory`（本插件实例所在目录）。
 */

/** 探测结果 */
export interface ContainerInfo {
  /** 是否处于 CCC 内 */
  readonly isContainer: boolean
  /** CCC 根目录（非 CCC 时为 null） */
  readonly root: string | null
  /** 标记文件路径 */
  readonly markerPath: string | null
}

/** CCC 标记文件名（specs §7） */
const MARKER = ".serenity"

/**
 * 从宿主 Context 探测 CCC。
 *
 * 判据来源：`ctx.location.directory`（官方文档：插件实例所在位置）。
 * 不假设一定有值 ⇒ 缺失时按"非 CCC"处理（fail-safe：宁可不激活）。
 */
export async function detectContainer(ctx: {
  location?: { directory?: string }
}): Promise<ContainerInfo> {
  const dir = ctx?.location?.directory
  if (typeof dir !== "string" || dir.length === 0) {
    return { isContainer: false, root: null, markerPath: null }
  }

  const markerPath = `${dir}/${MARKER}`
  const { existsSync } = await import("node:fs")

  if (!existsSync(markerPath)) {
    return { isContainer: false, root: null, markerPath: null }
  }

  return { isContainer: true, root: dir, markerPath }
}
