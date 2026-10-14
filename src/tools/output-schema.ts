/**
 * 工具输出 schema（宿主契约）
 *
 * 🔴 为什么必须有这个文件（实测根因，2026-10-14 owner 报「工具调用有报错」）：
 *
 * 宿主对 `Tool.Result` 的判定是**二元的**（反编译宿主二进制所得原文）：
 *
 * ```js
 * if (tool.output === undefined) {                      // 工具**未**声明 output schema
 *   if ("output" in result) return fail("Tool result declared output without an output schema")
 *   return { output: undefined, content, ... }          // ← 只允许 content
 * }
 * if (!("output" in result)) return fail("Tool did not return its declared output")
 * const validated = yield validate(tool.output, result.output)
 * return { output: validated, content, ... }
 * ```
 *
 * ⇒ **两头堵**：声明了 `output` 就**必须**返回 `output`；没声明就**不许**返回 `output`。
 *
 * 我们的 9 个契约工具**全部**返回 `{ output: {...}, content }` 却**都没声明** `output`
 * ⇒ 命中第一条分支 ⇒ **每一次调用都失败**，报错文本 =
 * `Tool result declared output without an output schema`（用户侧看到的就是"工具调用有报错"）。
 *
 * 且失败**不落 `opencode.log`**（宿主只把它记进会话消息的 `metadata.toolCalls[].status="error"`）
 * —— 这正是它藏了这么久才被发现的原因。
 *
 * ## 为什么用「宽松对象 schema」而不是删掉 output
 *
 * 两条合法修法：① 声明 output schema（保留结构化输出）② 删掉 output（只留 content）。
 * 选 ①：我们的工具**刻意**产出结构化数据（模型在 code-mode 里 `tools.container_fs(...)`
 * 直接消费对象，而非解析文本）。删掉 output 会**降能力**，且丢掉 `output.error` 这类
 * 机器可判的字段。
 *
 * 各工具的输出形状**随 action 变化**（有的收 {error}，有的收 {entries,count}），
 * 故 schema 取**宽松对象**：`{type:"object"}` + 允许任意附加键。这既是**真实**描述
 * （输出恒为对象），又不虚构一个我们保证不了的字段集。
 */

/** 宽松对象 JSON Schema —— 所有 ACC 工具的 `output` 声明 */
export const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const
