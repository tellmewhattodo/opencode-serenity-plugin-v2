# v2 能力 → Serenity 契约映射（P0-④ 探测结果）

> **日期**：2026-10-14 · **SDK**：`@opencode/plugin@2.0.28`（`dist/promise/*.d.ts` 逐字取证）
> **目的**：把 v1 的每一项 ACC 能力，映射到 v2 的精确落点。
> **结论**：✅ **全部能力都有落点，且多处比 v1 更清晰。**

---

## 1. 注入面（9 块系统提示词）—— 🎯 落点已确证

**v1 的做法**：`experimental.chat.system.transform(input, output: { system: string[] })`

**v2 的落点**：`ctx.session.hook("context", handler)`

```ts
// dist/promise/session.d.ts（逐字）
export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID;
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>;
}

export interface SessionRequest {
  readonly sessionID: Session.ID;
  readonly model: Model.Ref;
  system: Array<SystemPart>;      // ← 注入点（可变）
  messages: Array<Message>;
  options: SessionRequestOptions;
}
```

**判据（实测）**：`SessionContext.system` 是 `Array<SystemPart>` 且**不是 readonly**
（对比：`sessionID`/`model` 标了 `readonly`，`system`/`messages`/`options` 没有）
⇒ **可写 ⇒ 可注入**。

**优势**：
- v1 只能注入 `string[]`；v2 是结构化的 `Array<SystemPart>` ⇒ **可标注来源、可判重**
- v2 的 hook 按 **`SessionRequestKind`** 分流：`"primary" | "compaction" | "title" | "generate"`
  ⇒ **可以精确做到"只注入主循环，不污染标题生成"**（v1 做不到）

---

## 2. rebuild（借道压缩）—— 🎯 落点已确证

**v1 的做法**：`experimental.session.compacting` + `experimental.compaction.autocontinue` + `session.summarize`

**v2 的落点**：`ctx.session.hook("compaction", handler)` + `ctx.session.compact(...)`

```ts
export interface SessionCompaction extends SessionContext {
  /** Set to use this compaction and skip the model request. */
  result?: SessionCompactionResult;
}
export interface SessionCompactionResult {
  summary: string;
  providerState?: SessionMessage.ProviderState;
  metadata?: Record<string, unknown>;
  tokens?: TokenUsage.Info;
}
```

**关键**：`result` **可直接设定** ⇒ 可**跳过模型请求**自定摘要（v1 只能"替换 prompt / 追加 context"）
⇒ **v2 的 rebuild 实现比 v1 更直接、更省 token**。

`SessionDomain` 还直接暴露 `compact` 与 `context` 方法。

---

## 3. 工具面（9 契约工具）—— 🎯 已实测注册通路

```ts
// dist/promise/tool.d.ts（逐字）
export interface ToolDomain {
  readonly transform: Transform<ToolEditor>;
  readonly reload: () => Promise<void>;
  readonly list: () => Promise<readonly (Info & { readonly id: string })[]>;
  readonly hook: Hooks<ToolHooks>;
}
export interface ToolEditor {
  list(); get(id);
  namespace(namespace: Tool.Namespace): void;   // ← 官方命名空间
  add<Input, Output>(tool: Info<Input, Output>): void;
  update(id, update): void;
  remove(id): void;
}
```

**优势**：v2 有官方 `namespace()` ⇒ 9 个契约工具的命名比 v1 更规范。

---

## 4. 拦截缝（registry 写保护等）

| 需求 | v1 | v2 落点 |
|---|---|---|
| 工具执行前拦截 | `tool.execute.before` | `ctx.tool.hook("execute.before", …)` ✅ |
| 工具执行后拦截 | `tool.execute.after` | `ctx.tool.hook("execute.after", …)`（含 `status`/`result`/`error`，**可改结果**）✅ |
| 权限拦截 | `permission.ask` | `ctx.permission` 域 ✅ |
| 文件路径拦截 | 靠 `tool.execute.before` 手写 | 同 + `ctx.permission` |

---

## 5. 会话控制

`SessionDomain` 暴露（逐字）：
```
create | get | remove | switchAgent | switchModel | prompt | generate |
command | compact | synthetic | interrupt | update | move | wait | context
```
⇒ v1 的会话能力（含 `rebuild` 所需）**全部覆盖，且有富余**（`interrupt` / `switchModel` / `move` 是 v1 没有的）。

---

## 6. 持久化

v1：自管文件。
v2：`ctx.storage`（`StorageDomain`，每插件命名空间，含 `get/set/remove/scan`）
⇒ trajectory-assistant 的计分状态可用官方存储，**不再手写文件**。

---

## 7. 12 个 session hook（完整清单，逐字）

```
prompt | context | compaction | generate | title |
model.request | http.request | http.response |
experimental.ws.handshake | experimental.ws.send | experimental.ws.receive | retry
```

---

## 8. 结论

| v1 能力 | v2 落点 | 判定 |
|---|---|---|
| 9 契约工具 | `ctx.tool.transform` + `namespace()` | ✅ 更好 |
| 9 块注入 | `ctx.session.hook("context")` | ✅ 更好（结构化 + 可按 kind 分流） |
| rebuild | `ctx.session.hook("compaction")` + `result` | ✅ 更好（可跳过模型请求） |
| registry 写保护 | `ctx.tool.hook("execute.before")` | ✅ 等价 |
| trajectory-assistant | `ctx.storage` + `context` hook | ✅ 更好 |
| 会话控制 | `SessionDomain` 15 个方法 | ✅ 覆盖有余 |
| 条件可见工具 | `ToolEditor.remove` + 域过滤 | 🟡 待实现验证 |
| 域外全局隐藏 | 同 v1（靠作用域限制） | 🟡 待实现验证 |

> 🎯 **下一步（P1）**：按本表的落点实现工具面与注入面。
> **实现顺序**：① 修正 CCC 探测（location 语义，见下）→ ② 9 契约工具骨架 → ③ context hook 注入。

---

## 9. ⚠️ 一个必须修正的语义误解（实测教训）

**现象**：插件装载成功，但 `container.isContainer === false`，导致提前 return、工具面未注册。

**根因**：我用 `ctx.location.directory` 作为 CCC 判据，但**该字段是"插件实例所在位置"**
（= 服务进程启动时的 cwd），**不是"每个会话所在的位置"**。

官方文档对此有明确说明（引述）：
> "It is available in both Promise and Effect plugins. **This is the plugin instance's location,
> not the location of every session it can access or event it receives.**"

**实证**：
```json
// /tmp/serenity-v2-load/container.json
{ "isContainer": false, "root": null, "markerPath": null }
// 而 loaded.json 的 locationDirectory = ".../AI_LAB/opencode-serenity-plugin"（服务 cwd）
```

---

## 10. ✅ 会话级 CCC 判据 —— 已实证找到

**正确来源**：`Session.Info.location.directory`（会话对象自带位置，与 `sessionID` 一一对应）

**读取方式**（在 context hook 内）：
```ts
const session = await ctx.session.get({ sessionID })
const cccDir = session.location.directory     // ← 会话级位置
```

**实测证据**（`/tmp/serenity-v2-load/context-hook.json`，真实会话）：
```json
{
  "sessionID": "ses_ec9c0ca1effeuaXevS4y6wN0H9",
  "agent": "home-serenity",
  "sessionLocation": { "directory": "/home/yh/home/home-serenity" }   // ← CCC！判据成立
}
```
对照：同一次会话的 `api session.create` 返回体亦含
`"location":{"directory":"/home/yh/home/home-serenity"}`。

**重要旁证**：在**非 CCC** 目录（`/home/yh`）建的会话，**context hook 不触发我们插件** ——
因为**插件按 location 加载**。⇒ 语义自洽：**插件在哪个 location 加载，就服务哪个 location 的会话**。

---

## 11. ✅ 9 块注入的真实数据形态 —— 已实证

**实测**（同一份证据文件）：
```json
"topLevelKeys": ["agent","messages","model","options","sessionID","system","tools"],
"systemType": "array",
"systemLength": 4,
"systemPartsPreview": [
  { "type": "text", "text": "You are an AI agent running in OpenCode, a coding agent harness..." },
  { "type": "text", "text": "# Your Model\n- Name: ...\n- Provider ID: ..." },
  { "type": "text", "text": "# Code Mode\n\nUse the `execute` tool..." },
  { "type": "text", "text": "When you create a worktree..." }
]
```

**判据**：
- `system` 是 **`Array<{type:"text", text:string}>`**（`SystemPart`）⇒ **注入 = push 新 part**
- 数组**非 readonly**（可直接 mutate）⇒ 与 §1 的推断一致
- 注入 content 会与宿主自身的 4 个 part 并列 ⇒ **需自行去重/判存**（避免重复注入）

**v2 与 v1 的注入差异**：

| | v1 | v2 |
|---|---|---|
| 载体 | `string[]` | `Array<SystemPart>`（结构化） |
| 注入 | push 字符串 | push `{type:"text", text}` |
| 去重 | 字符串比对 | 可按 type/来源比对 |
| 分流 | 无 | 有 `SessionRequestKind`（primary/compaction/title/generate） |

> 🎯 **结论：9 块注入在 v2 上可实现，且落点已实证。**
> 实现方式：在 `ctx.session.hook("context", …)` 内，先按 `sessionID` 取 `location.directory`
> 判定 CCC，判定通过则向 `input.system` push 9 块对应 part。

---

## 12. 教训（第四次同类）—— 已完成勘误

🔴 v2 的 `Context` 是**插件实例级**的，而 ACC 的多数语义是**会话级**的。
**插件实例 ≠ 会话** —— 所有"按 CCC 判定"的逻辑都要在**会话级**做（`session.get(sessionID).location`）。

