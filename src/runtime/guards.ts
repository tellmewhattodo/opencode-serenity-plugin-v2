/**
 * Safe-mode 守卫（统一）—— specs §3 / §4.3 / §5.6 / §6 S1
 *
 * 🔴 本模块是 `registry-guard.ts` 的**合并后继任者**（2026-10-15）。
 *   合并理由：全部条目**共用同一个宿主缝**（`ctx.tool.hook("execute.before")`），
 *   且**判据同族**（"这次调用碰了哪个受保护目标"）。
 *   分处多个模块 ⇒ 各自判定"哪些工具算写类 / 工具怎么命名 / 怎么从 input 取路径"，
 *   而这些**必须一致**，否则会出现"注册表拦得住、治理文件拦不住"这类**静默缺口**。
 *   旧名 `registry-guard` 在合并后已不副实（它只管注册表），故改名并删除旧文件。
 *
 * 覆盖三类受保护目标（判定顺序 = 从"绝不放过"到"可配置"）：
 *   ① 治理文件 `.serenity` / `.serenity-safe-on`（specs §5.6 块内声明；**属用户能力**）
 *   ② MSM 注册表 `mech-registry.json`（specs §4.3：唯一合法写通道 = container_admin msm register/deregister）
 *   ③ 安全模式写黑名单 `safeMode.blacklist`（specs §3.1(a)；**前缀 / regex:**；条目可带自定义提示）
 *   ④ 安全模式 bash 禁用（specs §5.6 块内声明："bash is disabled (hidden and blocked)"）
 *
 * 🔴 拦截机制（依据 `tool.d.ts` 的实际签名，逐字）：
 *   `execute.before` 的 payload 为 `{ tool, sessionID, agent, messageID, id, input }`
 *   —— `tool` 与 `input` **未标 readonly** ⇒ 可变；但**没有决策字段**
 *   （不像 v1 的 `permission.ask` 有 `output.status`）
 *   ⇒ **唯一可靠的阻断 = 抛异常**（让工具调用失败）。
 *     改 `input` 只是"绕过"不是"阻断"，不作为主手段。
 *
 * 🔴 为什么路径判定**以 basename 为主**（① ② 两条）：
 *   守卫拿不到"工具会用哪个 cwd 解析相对路径"的保证 ⇒ 用 basename 判定**不依赖 cwd**，
 *   相对路径 / 绝对路径 / 嵌套结构一律命中。宁可误拦，不可漏放。
 *   代价：正文里恰好等于该 basename 的字符串会被误判 ⇒ 用**键名筛选**收敛（见 `extractPaths`）。
 *   ③ 黑名单相反：它是**用户可配置的路径前缀/正则语义**，必须按**相对 CCC 根**的路径匹配，
 *   否则规则换个挂载点就失效（见 `relFromRoot`）。
 *
 * ⚠️ ④ 的**能力边界（诚实声明，勿当已完全覆盖）**：本缝只能做到"**调用期拒绝**"，
 *   而 specs 对 bash 的期望是"**hidden and blocked**"（模型侧不可见）。
 *   "hidden"（从 schema 移除）需要宿主工具收窄缝 —— 与 `safeMode.hiddenTools`
 *   （specs §4.1「条件屏蔽」）是**同一个未实现项**，见 SESSION.md 待办。
 *   ⇒ 当前实现 = **blocked ✓ / hidden ✗**；提示词文本暂不改（它同时描述两件事），
 *     但缺口已在此显式记录，并由 `tests/safe-mode.test.ts` 的元判据测试**追踪**。
 */

import { relative, resolve, sep } from "node:path"

import type { SessionHookRegistrar, ToolHookRegistrar } from "../tools/types.js"
import { detectContainer } from "./ccc.js"
import { isSafeModeOn, matchBlacklist, readBlacklist } from "./safe-mode.js"

// ─────────────────────────────────────────────────────────────
// 受保护集合
// ─────────────────────────────────────────────────────────────

/**
 * 治理文件（specs §5.6：`.serenity` = CCC 根标记，`.serenity-safe-on` = 安全模式标记）。
 * **写 deny**；`container_fs rm` 删掉它们 = 拆掉整个 CCC 的根标记 ⇒ 同样属于写类，一并拦。
 */
const GOVERNANCE_BASENAMES = new Set([".serenity", ".serenity-safe-on"])

/**
 * MSM 注册表（specs §4.3）：写成 deny、**读成 allow**（注册表是结构核心不是秘密，
 * 需被 dashboard/output-guard 等读取建 MSM 词表）。此处只拦写类调用。
 */
const PROTECTED_BASENAMES = new Set(["mech-registry.json"])

/**
 * 原生写类工具（读工具不在此列 ⇒ 读不被拦，specs 只护"写"）。
 * 宽松列举：不同宿主/世代的命名（`multiedit` 见 v1 先例，`str_replace_editor` 见 dsp 先例）
 * —— 多列一个名字的代价只是"这个工具若存在则受检"，不引入误拦。
 */
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "multiedit",
  "str_replace_editor",
  "append",
  "touch",
])

/**
 * shell 工具名（specs §5.6 块内声明："bash is disabled (hidden and blocked)"）。
 * 宽松列举已知命名；**多列无害**（不存在的名字永远不会出现在 payload 里）。
 * ⚠️ 隐藏面（hidden）未实现 —— 见文件头「④ 的能力边界」。
 */
const SHELL_TOOLS = new Set(["bash", "shell", "sh"])

/**
 * `container_fs` 的**写类子命令**（本轮补上的真实缺口）：
 * 旧 `registry-guard` 只按工具名筛（`WRITE_TOOLS` 不含 `container_fs`）
 * ⇒ `container_fs rm .opencode/skills/<ccc>/references/mech-registry.json`、
 * `container_fs rm .serenity` **完全绕过守卫**。
 * 对齐 dsp `CC_FS_WRITE_ACTIONS`。其余 9 子命令（root/resolve/exists/list/tree/relative/
 * reveal/info/find）为只读 ⇒ **不查黑名单**（同 read 语义）。
 */
const CC_FS_WRITE_ACTIONS = new Set(["mkdir", "rm", "mv", "cp", "touch", "append"])

/** 判定一次调用是否为写类（写类才受三类保护约束） */
export function isWriteCall(tool: string, input: unknown): boolean {
  const t = tool.toLowerCase()
  if (t === "container_fs") {
    const action = (input as { action?: unknown } | undefined)?.action
    return typeof action === "string" && CC_FS_WRITE_ACTIONS.has(action)
  }
  return WRITE_TOOLS.has(t)
}

// ─────────────────────────────────────────────────────────────
// 路径提取
// ─────────────────────────────────────────────────────────────

/**
 * **像路径的键名**（大小写不敏感）。
 * 只要命中，其字符串值就被当作路径候选。
 */
const PATH_KEYS = new Set([
  "path",
  "paths",
  "filepath",
  "file",
  "files",
  "filename",
  "src",
  "source",
  "dst",
  "dest",
  "target",
  "targetpath",
  "cwd",
  "dir",
  "directory",
])

/** 键名里含这些子串的也视为路径键（覆盖 `targetPath` / `outputDir` / `newFilePath` 这类命名） */
const PATH_KEY_HINTS = ["path", "file", "dir"]

/** 明确**不是**路径的键（内容类）——避免把正文里提到的文件名误判成操作目标 */
const CONTENT_KEYS = new Set([
  "content",
  "text",
  "new_string",
  "old_string",
  "newstring",
  "oldstring",
  "message",
  "description",
  "patch",
  "patchtext",
])

function isPathKey(key: string): boolean {
  const k = key.toLowerCase()
  if (CONTENT_KEYS.has(k)) return false
  if (PATH_KEYS.has(k)) return true
  return PATH_KEY_HINTS.some((h) => k.includes(h))
}

/**
 * 深挖 input，取出**路径候选**字符串。
 *
 * 🔴 与旧实现的差异（为什么改）：旧 `hitsProtectedRegistry` **扫描 input 里所有字符串**，
 *   于是 `container_fs append {path:"notes.md", content:"see docs/mech-registry.json"}`
 *   会把**正文**误判成"要写注册表" ⇒ 假拦截。
 *   新实现**优先只取路径键**的值；仅当**一个路径键都没找到**时才回退到全量扫描
 *   （保住"未知工具形状也不漏放"的老属性 —— 写工具调用却没有路径键本身即畸形）。
 *
 * 去环（`seen`）与上限（`guard`）保留自旧实现：input 可能是循环引用或极深对象。
 */
export function extractPaths(input: unknown): string[] {
  const byKey: string[] = []
  const all: string[] = []
  const seen = new Set<unknown>()
  const stack: unknown[] = [input]
  let guard = 0

  while (stack.length > 0 && guard++ < 1000) {
    const cur = stack.pop()
    if (cur === null || cur === undefined) continue

    if (typeof cur === "string") {
      all.push(cur)
      continue
    }
    if (typeof cur !== "object") continue
    if (seen.has(cur)) continue
    seen.add(cur)

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v)
      continue
    }

    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (typeof v === "string" && isPathKey(k)) byKey.push(v)
      stack.push(v)
    }
  }

  return byKey.length > 0 ? byKey : all
}

/** 取路径的**末段**（basename；不依赖 cwd —— 相对/绝对/嵌套一律命中） */
function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] ?? ""
}

/**
 * 把候选路径规约成**相对 CCC 根**的路径（黑名单语义用）。
 *
 * 三档（按可信度降序）：
 *   ① 候选是根内绝对路径 ⇒ 直接 relative
 *   ② 候选是相对路径 ⇒ `resolve(root, 候选)` 后再 relative（工具的相对路径基准 = 会话 cwd = CCC 根）
 *   ③ 结果逃出根 ⇒ 返回 `null`（不参与黑名单匹配；路径越界的拒绝是各工具 `path-guard` 的职责）
 *
 * 🔴 归一化分隔符为 `/`：黑名单规则由用户手写，用 `/` 书写；Windows 下 rel 会给 `\`。
 */
export function relFromRoot(root: string, candidate: string): string | null {
  try {
    const normRoot = resolve(root)
    const abs = resolve(normRoot, candidate)
    const rel = relative(normRoot, abs)
    if (rel === "" || rel === ".") return "."
    if (rel === ".." || rel.startsWith(`..${sep}`)) return null
    return rel.split(sep).join("/")
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// 决策（纯函数 —— 可直接单测，无需宿主）
// ─────────────────────────────────────────────────────────────

export interface GuardDecision {
  readonly kind: "allow" | "deny"
  /** deny 的理由（抛出的异常文本）；允许时为 undefined */
  readonly reason?: string
  /** deny 命中的规则类别（诊断/测试用；不面向模型） */
  readonly rule?: "governance" | "registry" | "blacklist" | "shell"
}

const ALLOW: GuardDecision = { kind: "allow" }

/** 是否 shell 工具（安全模式开启时禁用） */
export function isShellCall(tool: string): boolean {
  return SHELL_TOOLS.has(tool.toLowerCase())
}

/**
 * 纯判定：这次工具调用是否被 **safe-mode 守卫**拒绝。
 *
 * @param root CCC 根；`null` ⇒ 拿不到根（仍执行**不依赖根**的 ①② 两条保护；
 *             ③④ 需要根才能判 safe-mode 开关 / 算相对路径 ⇒ 无根时跳过）
 */
export function decideGuard(opts: {
  root: string | null
  tool: string
  input: unknown
}): GuardDecision {
  const { root, tool, input } = opts

  // ── ④ 安全模式 bash 禁用（specs §5.6："bash is disabled"）────────────────
  // 🔴 顺序：**先于**写类判定 —— shell 不是写类工具（它没有路径参数），
  //    若放在写类闸之后，safe-mode 下 bash 就能照常执行（= 纸面承诺）。
  // 🔴 门控 = safe-mode ON（specs §5.6：该声明只在块 6 被注入时出现）。
  if (isShellCall(tool)) {
    if (root && isSafeModeOn(root)) {
      return {
        kind: "deny",
        rule: "shell",
        // 对齐 v1 的措辞（`bash is disabled, use msm instead`）
        reason: "bash is disabled, use msm instead",
      }
    }
    return ALLOW
  }

  if (!isWriteCall(tool, input)) return ALLOW

  const candidates = extractPaths(input)

  // ── ① 治理文件（specs §5.6：`.serenity` / `.serenity-safe-on` 保留给用户）────
  for (const c of candidates) {
    const base = basenameOf(c)
    if (GOVERNANCE_BASENAMES.has(base)) {
      return {
        kind: "deny",
        rule: "governance",
        // 不解释 safe-mode 机制本身（specs §5.6：安全模式是**用户能力**）
        reason: [
          `CCC governance file "${base}" is reserved for the user — agent must not write.`,
          `尝试写入：${c}`,
        ].join("\n"),
      }
    }
  }

  // ── ② MSM 注册表（specs §4.3 / §5.8）────────────────────────────────
  for (const c of candidates) {
    if (PROTECTED_BASENAMES.has(basenameOf(c))) {
      return {
        kind: "deny",
        rule: "registry",
        reason: [
          `mech-registry.json 受写保护（ACC-managed）——禁止用 ${tool} 直接编辑。`,
          `尝试写入：${c}`,
          ``,
          `合规路径：`,
          `  container_admin msm register    （新增 MSM）`,
          `  container_admin msm deregister  （移除 MSM）`,
          `  container_admin msm check       （完整性检查）`,
        ].join("\n"),
      }
    }
  }

  // ── ③ 安全模式写黑名单（specs §3.1(a)；**仅在安全模式开启期间**生效）──────
  // 🔴 门控是 specs §5.6 块内文本的直接承诺：「**Safe mode is ON** … blacklist rules
  //    apply to file paths」——黑名单只在 safe-mode ON 时被宣称生效，故实现必须同门控。
  //    （safe-mode 是**用户能力**：标记不存在 ⇒ 整块文本不注入 ⇒ 不存在任何黑名单承诺。）
  if (root && isSafeModeOn(root)) {
    const rules = readBlacklist(root)
    if (rules.length > 0) {
      for (const c of candidates) {
        const rel = relFromRoot(root, c)
        if (rel === null) continue
        const hit = matchBlacklist(rel, rules)
        if (hit) {
          return {
            kind: "deny",
            rule: "blacklist",
            // 命中自定义 message ⇒ 用它（specs §3.1(a)：条目可带 message）；否则用默认文案
            reason: hit.message ?? `[serenity] ${tool} to "${rel}" is not allowed.`,
          }
        }
      }
    }
  }

  return ALLOW
}

// ─────────────────────────────────────────────────────────────
// 宿主接线
// ─────────────────────────────────────────────────────────────

/**
 * 注册 safe-mode 守卫。
 *
 * 根解析按 `sessionID` → 会话位置 → CCC 根（与注入面 / 工具面**同一套会话级判据**，
 * 见 `docs/v2-capability-mapping.md` §10）。取不到根**不放弃**：
 * ①② 两条保护不依赖根，照常生效。
 *
 * @returns disposers
 */
export async function registerGuards(
  ctx: ToolHookRegistrar & SessionHookRegistrar,
): Promise<Array<() => Promise<void>>> {
  const reg = await ctx.tool.hook("execute.before", async (event: unknown) => {
    const e = event as { tool?: unknown; sessionID?: unknown; input?: unknown }
    const tool = String(e?.tool ?? "")

    // 先做**廉价**预筛：既不写也不 shell 的调用直接返回，不做根解析
    // （避免每次读类调用都去打宿主 session API）。
    // 🔴 shell 也在列 —— 它的判定要读 safe-mode 标记（需要根）。
    if (!isWriteCall(tool, e?.input) && !isShellCall(tool)) return

    // 黑名单 / safe-mode 门控需要根；取不到 ⇒ null（①② 仍生效）
    let root: string | null = null
    try {
      const cc = await detectContainer(ctx, String(e?.sessionID ?? ""))
      root = cc.isContainer ? cc.root : null
    } catch {
      root = null
    }

    const d = decideGuard({ root, tool, input: e?.input })
    if (d.kind === "deny" && d.reason) {
      // 🔴 唯一可靠的阻断 = 抛异常（见文件头注释）
      throw new Error(d.reason)
    }
  })

  return [() => reg.dispose()]
}
