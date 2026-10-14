# Serenity ACC — opencode v2

> **为 OpenCode v2 提供认知容器（CCC）基础设施的 ACC 插件。**

基于 [`@opencode/plugin`](https://www.npmjs.com/package/@opencode/plugin) v2 插件 API
（`Plugin.define` + Context 域）实现，语义对齐
[Serenity-ACC specs v2.0.0](../serenity-acc-specs)。

---

## 这是什么

不是安全沙箱 —— 是**认知容器**。

它在包含 `.serenity` 标记文件的目录（= CCC）中激活，提供三件事：

| 面 | 内容 |
|---|---|
| **工具面** | 9 个契约工具（见下） |
| **注入面** | 9 块系统提示词装配（ACC 身份 / Metaphor / Principles / CCE / EAP / 状态 / SKILL / Tools / Session） |
| **机制面** | registry 写保护 / 重建（Ship of Theseus）/ 轨迹督促（trajectory-assistant） |

**不在 CCC 内 ⇒ 零影响**（不注册激活、不注入、不改行为）。

---

## 安装

```bash
# 方式一：npm 包
opencode plugin add @shgroup/opencode-serenity-plugin-v2

# 方式二：本地目录 / Git（宿主 `plugins` 配置，值为目录路径）
# opencode.jsonc:
#   "plugins": ["/path/to/opencode-serenity-plugin-v2"]
#
# 或项目内自动加载：
#   <CCC>/.opencode/plugins/<name>/index.ts
```

> 📌 `@opencode/plugin` 是 **peer 依赖**（宿主在运行时提供）。
> 本地开发时需在插件目录装它：`npm i @opencode/plugin@2.0.28`

---

## 工具面（9 契约工具）

| 工具 | 能力 |
|---|---|
| `container_fs` | 文件系统 15 子命令（**路径逃逸自动阻断**） |
| `container_git` | git 6 动作（commit 默认随后自动 push） |
| `container_trajectory` | 轨迹 8 动作（list/show/create/use/rebuild/send-now/send-later/cro-guide） |
| `container_admin` | 机务舱（role / msm 注册表 / config） |
| `dashboard` | 仪表（health / time / wait） |
| `msm` | MSM 单入口执行与发现 |
| `praxis` | 理论注入（索引 + eap/neat/cce/ontology） |
| `handyman` | 委派编排（foreground / background） |
| `resident` | 常驻 agent（start 阻塞挂住 / stop / status / list） |

---

## 关键设计（EAP · R↓）

### 1. 会话级 CCC 判定

`ctx` 是**插件实例级**的（`ctx.location.directory` = 服务进程 cwd），
而 ACC 的语义是**会话级**的 ⇒ 判据取会话自身位置：

```ts
const session = await ctx.session.get({ sessionID })
const cccDir = session.location.directory
```

### 2. 注册与判定解耦

工具注册在**宿主级**（与会话无关）；激活判定下沉到 **execute 时**
（经 `ToolContext.sessionID`）与**注入面**。这与 specs §4.1「域外全局隐藏」语义一致。

### 3. 路径守卫用 `path.relative()`

不用前缀比较 —— 前缀比较有经典陷阱：
`/root` 与 `/root-evil` 共享前缀，但后者在根外。

### 4. rebuild 走压缩链

v2 的 `session.hook("compaction")` 的 `result` **可直接设定** ⇒
**跳过模型请求**（比 v1 只能"改 prompt / 追加 context"更省）。

---

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc -p tsconfig.json
```

---

## 与 v1 的关系

| | v1（`opencode-serenity-plugin`） | v2（本仓） |
|---|---|---|
| 运行时 | OpenCode v1 | **OpenCode v2** |
| 插件形态 | 返回 hooks 对象（声明式） | `Plugin.define` + 域 transform/hook（**命令式**） |
| 状态 | 🔒 **已冻结**（v0.9.0-final） | 活跃开发 |

v1 与 v2 **代码独立**（不复用源码）——v2 的插件体系是全新的，无法平移。

---

## License

MIT
