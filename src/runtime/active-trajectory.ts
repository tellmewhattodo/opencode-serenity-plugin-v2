/**
 * 活跃轨迹状态 —— **按会话隔离**（内存 Map，不落盘）
 *
 * 🔴 为什么不是 `AGENT_SESSIONS/.current`（实测教训，2026-10-14 owner 报"注入有问题"）：
 *   1. **它是全局单值** ⇒ 多个并发会话**互相串台**（A 会话 use 后，B 会话也读到同一个值）
 *   2. **它是落盘文件** ⇒ 进程重启后**残留陈旧值**。实测本机 `.current` = `S055`，
 *      而 `AGENT_SESSIONS/` 下**根本没有 S055 目录** ⇒ 块 9 解析失败、**静默整块省略**，
 *      且无任何报错（属最难查的一类）
 *
 * 判据来源：v1（`src/session/active-state.ts`）与 dsp（`activeStore` Map，key = 会话 id）
 *   均采用**内存 + 按会话隔离**。dsp 源码注释明载该演进理由：
 *   「不落盘——避免落盘标记文件累积与跨会话串台（落盘版 .dsh/active-sessions/<scope> 已被此方案取代）」
 *   ⇒ 回归先例，不再自创落盘单值方案。
 *
 * 进程重启恢复：本实现暂不恢复（v2 侧后续可对齐 dsp 的"从 events 解析 [SESSION CONTEXT] 标记"）。
 *   不恢复的后果 = 块 9 暂时省略（**退化为缺块，而非错块**）—— 优于给出**错误的活跃会话**。
 */

import type { ActiveTrajectory } from "./blocks/session.js"

/** scope（宿主会话 id）→ 活跃轨迹。并行多会话各自 key 隔离，互不污染。 */
const activeStore = new Map<string, ActiveTrajectory>()

/** 全局最近活跃（供无 scope 上下文使用，如子代理继承） */
let lastActive: ActiveTrajectory | null = null

export function setActiveTrajectory(scope: string, info: ActiveTrajectory): void {
  activeStore.set(scope, info)
  lastActive = info
}

export function getActiveTrajectory(scope: string): ActiveTrajectory | null {
  return activeStore.get(scope) ?? null
}

export function getLastActiveTrajectory(): ActiveTrajectory | null {
  return lastActive
}

export function clearActiveTrajectory(scope: string): void {
  activeStore.delete(scope)
}

/** 供测试隔离 */
export function __resetActiveTrajectories(): void {
  activeStore.clear()
  lastActive = null
}
