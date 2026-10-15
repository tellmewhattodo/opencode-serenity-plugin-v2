/**
 * Safe mode 原语 —— 标记判定 + 写黑名单解析 / 匹配（specs §3.1 · §5.6 · §6 S1）
 *
 * 🔴 本模块存在的理由（EAP · R↓）：**注入面与拦截面必须共用同一个判据源**。
 *
 *   块 6 的文本（specs §5.6 逐字）向模型**宣称**了三项保护：
 *     · bash is disabled (hidden and blocked)
 *     · blacklist rules apply to file paths
 *     · CCC governance files (.serenity, .serenity-safe-on) are protected from agent writes
 *
 *   而"决定要不要注入这段文本"与"决定要不要真的拦"是**两处代码**。
 *   若它们各自读配置，就可能给出**不同答案** ⇒ 提示词宣称了不存在的保护
 *   （= 假陈述，比"缺功能"更严重 —— 模型会据此认为自己受保护）。
 *   ⇒ 本模块是**唯一实现**；`injection.ts`（注入面）与 `guards.ts`（拦截面）
 *     都从这里取判据，物理上不可能不一致。
 *
 * 判据来源 = `<CCC>/.opencode/serenity.json` 的 `safeMode` 段（specs §3.1(a)）。
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/** 安全模式标记文件名（specs §3：**存在即 ON**，内容无关紧要；属**用户能力**） */
export const SAFE_MODE_MARKER = ".serenity-safe-on"

/** CCC 根标记文件名（specs §7 P1「有根」；内容 = 顶层入口 skill 名） */
export const CCC_MARKER = ".serenity"

/** CCC 级配置的相对路径（specs §3.1(a)） */
export const CONFIG_REL = join(".opencode", "serenity.json")

/**
 * 安全模式是否开启。
 *
 * 🔴 判据**故意只用标记文件的存在性**，不复制 v1 `isSafeModeOn` 的另外 5 条分支
 *   （env 覆盖 / `SERENITY_SAFE_MODE` / `/tmp` 运行态 / 旧 `.serenity-bash-off` 兼容 /
 *   server 模式缺省 ON）。两条理由：
 *     ① specs §3 的语义就是"存在即 ON"，标记文件是**唯一**的权威来源；
 *     ② **多一条分支 = 多一处注入面与拦截面可能不一致的地方**（见本文件头注释）。
 *   与 dsp 的实现一致（`existsSync(resolve(root, SAFE_MODE_MARKER))`）。
 *
 * @param cccRoot CCC 根
 */
export function isSafeModeOn(cccRoot: string): boolean {
  try {
    return existsSync(resolve(cccRoot, SAFE_MODE_MARKER))
  } catch {
    return false
  }
}

/** 黑名单条目（specs §3.1(a)：条目 = string 或 `{ pattern, message }`） */
export interface BlacklistRule {
  /** 原始写法：`".secrets/"`（前缀）或 `"regex:^..."`（正则） */
  readonly pattern: string
  /** 自定义拦截提示；未设置时用默认文案 */
  readonly message?: string
}

/** 读 CCC 级配置（读不到 / 损坏 ⇒ `{}`，**不抛**） */
function readConfig(cccRoot: string): { safeMode?: { blacklist?: unknown } } {
  try {
    const p = join(cccRoot, CONFIG_REL)
    if (!existsSync(p)) return {}
    // 容忍 BOM（手改配置的常见产物）
    return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")) as {
      safeMode?: { blacklist?: unknown }
    }
  } catch {
    return {}
  }
}

/**
 * 读写黑名单（specs §3.1(a)）。
 *
 * 形态：`string`（`"/etc/"` 前缀 或 `"regex:..."`）｜`{ pattern, message }`（带自定义提示）。
 * 读不到 / 非数组 / 条目非法 ⇒ **返回 []**（不拦任何东西）。
 *
 * 🔴 失败方向 = **不拦**（fail-open）：黑名单是**用户可配置的写保护**，
 *   不是结构性数据边界（后者见 §4.3 凭据面）；配置损坏时"少拦一次"可接受，
 *   而"配置损坏 ⇒ 全盘拒写"会直接把 CCC 锁死。
 */
export function readBlacklist(cccRoot: string): BlacklistRule[] {
  const raw = readConfig(cccRoot).safeMode?.blacklist
  if (!Array.isArray(raw)) return []

  const out: BlacklistRule[] = []
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim().length > 0) out.push({ pattern: item })
      continue
    }
    if (item && typeof item === "object") {
      const o = item as { pattern?: unknown; message?: unknown }
      if (typeof o.pattern === "string" && o.pattern.trim().length > 0) {
        out.push({
          pattern: o.pattern,
          ...(typeof o.message === "string" ? { message: o.message } : {}),
        })
      }
    }
  }
  return out
}

/**
 * 黑名单**展示用**文案（specs §5.6：有规则才追加 `Active blacklist rules: <规则列表>` 行）。
 *
 * 🔴 与 `readBlacklist` **同源**（从同一批 rule 取 pattern）——
 *   若注入面单独解析一遍，`{ pattern, message }` 形态的条目就会被漏掉：
 *   它**实际会被拦**（readBlacklist 认它），却**不出现在注入的规则列表里**
 *   ⇒ 又是一处"宣称与实现不一致"（只是方向相反）。本函数消除该分叉。
 */
export function readBlacklistDisplay(cccRoot: string): string[] {
  return readBlacklist(cccRoot).map((r) => r.pattern)
}

/**
 * 匹配黑名单条目；命中返回该条目，未命中返回 `null`。
 *
 * 语义（对齐 v1 `matchBlacklistEntry` / dsp `matchBlacklist`）：
 *   · `regex:<pat>` ⇒ 对**相对 CCC 根的路径**跑正则（非法正则 ⇒ 跳过该条，不影响其它条）
 *   · 其它 ⇒ **前缀匹配**（`rel.startsWith(pat)`）；规则里的反斜杠归一化为 `/`
 *     （Windows 上书写的规则要与 `/` 分隔的 rel 对齐）
 *
 * 🔴 匹配**输入 = 相对 CCC 根的路径**（不是绝对路径、不是 cwd 相对路径）——
 *   这样规则写法与 CCC 根解耦，同一个 CCC 换挂载点后规则依然有效。
 */
export function matchBlacklist(relPath: string, rules: readonly BlacklistRule[]): BlacklistRule | null {
  for (const rule of rules) {
    if (rule.pattern.startsWith("regex:")) {
      const body = rule.pattern.slice("regex:".length)
      if (!body) continue
      try {
        if (new RegExp(body).test(relPath)) return rule
      } catch {
        // 非法正则 ⇒ 跳过该条（不因此让整张黑名单失效）
      }
      continue
    }
    const pat = rule.pattern.split("\\").join("/")
    if (pat && relPath.startsWith(pat)) return rule
  }
  return null
}
