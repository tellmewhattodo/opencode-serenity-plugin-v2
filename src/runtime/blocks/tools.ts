/**
 * 块 8：Tools（specs §5.8）
 *
 * 纪律（specs §5.8）：
 *   - 列**常驻**工具（恒注册恒可见）；**条件可见工具不列**（避免"清单有、实际无"）
 *   - 每行与实现文本**逐字一致**（镜像纪律）
 *   - 必含 registry 写保护声明（`never edit mech-registry.json directly`）
 *
 * 🔴 本块内容随实现进度增长：当前只实现了 dashboard，其余工具**尚不可用**
 *    ⇒ 按"注册事实"原则**只列已实现的**（列了却无会让模型误判能力）
 *    ⚠️ 这是**过渡态**：9 个契约工具全部实现后，本块应恢复 specs 的完整清单。
 */

/** 已实现的工具行（随实现推进而增补；镜像纪律：与实现逐字一致） */
const IMPLEMENTED_TOOL_LINES: string[] = [
  "  container_fs — container filesystem operations (15 subcommands: root/resolve/exists/list/tree/relative/mkdir/rm/mv/cp/touch/append/reveal/info/find)",
  "  container_git— git operations (status/commit/push/log/pull/diff; commit auto-pushes unless noPush)",
  "  container_trajectory — one trajectory: its persistent body (SESSION.md) + its timeline. list / show / create / use (activate; inline integrity check) / rebuild (clear-and-rebuild in place, Ship of Theseus) / send-now (deliver RIGHT NOW; synchronous receipt) / send-later (one future instant; fire-and-forget — no recall) / cro-guide",
  "  container_admin — container administration (the maintenance bay): role (Skiff roles) / msm (register/deregister/check/guide/catalog/ccc-config) / config (view)",
  "  dashboard    — always-on container instruments: health (CCC three-principle check + registry integrity) / time (now) / wait (N seconds)",
  "  msm          — execute a registered CCC MSM: msm(name, args); partial name returns candidates; inspect=true shows usage",
  "  praxis       — actionable theory injection: praxis (index) / praxis eap / praxis neat / praxis cce / praxis ontology",
  "  handyman     — delegate work to a worker agent on a CCC-whitelisted model; mode=\"foreground\" (default) = one-shot delegation (jobs=[...] fans out in parallel, cap 10); mode=\"background\" = loop-validated worker (completion code + round cap + progress file)",
  "  resident     — resident agent (host superset): start (blocks, like loop) / stop / status / list. Process cleanup on interrupt is mandatory",
]

/** msm 调用协议（4 行，specs §5.8 要求） */
const MSM_PROTOCOL = `
MSM call (registered CCC MSMs, deterministic Mech & Semi-Mech):
  Execute:       msm("<name>", ["<arg1>", "<arg2>"])   — run a registered MSM directly (partial name returns matching candidates)
  Inspect:       msm("<name>", [], inspect=true)       — view that MSM's usage/flags without running
  Index:         msm()                                 — summary of registered MSMs by skill
  Manage:        container_admin msm register|deregister|check (registry is ACC-managed — never edit mech-registry.json directly)`

export function buildToolBlock(): string {
  return `=== Serenity Tools ===
The ACC (this plugin) provides the following built-in tools:

${IMPLEMENTED_TOOL_LINES.join("\n")}
${MSM_PROTOCOL}`
}
