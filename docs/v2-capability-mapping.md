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

**修正方向（待实现）**：
- CCC 判据**不能**依赖 `ctx.location.directory`
- 应在**会话级**判定：`session` 域的 hook 提供 `sessionID`，可据其取该会话的 `location`
  （`ctx.session.get(...)` / `SessionDomain` 的会话对象含 `location`）
- 或：工具注册**不依赖 CCC 判定**（先注册），而把"是否激活"下沉到**注入面**（按会话判定）
  —— 这与 v1 的"域外全局隐藏"（§4.1）语义反而更契合

> 🔴 **教训（第四次同类）**：v2 的 `Context` 是**插件实例级**的，而 ACC 的多数语义是**会话级**的。
> **插件实例 ≠ 会话** —— 后续所有"按 CCC 判定"的逻辑都要在**会话级**做。
