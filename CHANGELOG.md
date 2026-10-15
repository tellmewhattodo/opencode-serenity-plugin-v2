# 更新日志

## v0.1.3 — safe-mode 保护实装 + 发布物卫生修复

### 修复

- 🔴🔴 **提示词"宣称"了 v2 根本没有的保护**（owner 报「safe-mode 标记开关实现有问题」）
  - **假陈述比缺功能更严重**：块 6 文本（specs §5.6 逐字）向模型宣称三项保护，而实现**一项都没有**
    ⇒ 模型据此认为自己受保护。
    | 宣称（块 6 原文） | specs 依据 | v0.1.2 实现 |
    |---|---|---|
    | `CCC governance files (.serenity, .serenity-safe-on) are protected from agent writes` | §5.6 | ❌ **无** |
    | `blacklist rules apply to file paths` | §3.1(a) + §5.6 | ❌ **无**（只**读**黑名单去拼注入文本，不拦） |
    | `bash is disabled (hidden and blocked)` | §5.6 | ❌ **无** |
  - **根因（结构性）**：**"决定要不要注入这段文本"与"决定要不要真的拦"是两处代码**，
    各自读配置 ⇒ 可以给出不同答案，且**没有任何机械信号**会报警。
  - **修法（两条）**：
    1. 新增 `src/runtime/safe-mode.ts` —— 标记判定与黑名单解析的**唯一实现**；
       **注入面与拦截面都从这里取判据**（`injection.ts` 与 `guards.ts` 不再各自解析）
       ⇒ 物理上不可能再出现"宣称与实现不一致"。
    2. 新增 `src/runtime/guards.ts`（合并旧 `registry-guard.ts`，旧文件删除）——
       在一个 `tool.hook("execute.before")` 缝上统一四类保护：
       治理文件 / MSM 注册表 / 黑名单 / bash 禁用。

- 🔴 **旧 registry-guard 的两处真实漏放**（合并时一并修掉）
  - **`container_fs` 完全绕过守卫**：旧实现只按**工具名**筛（`WRITE_TOOLS` 不含 `container_fs`）
    ⇒ `container_fs rm <...>/mech-registry.json`、`container_fs rm .serenity` **不被拦**。
    现按**子命令**判写类（`mkdir/rm/mv/cp/touch/append`），对齐 dsp `CC_FS_WRITE_ACTIONS`。
  - **`{ pattern, message }` 形态的黑名单条目在展示面被漏掉**：旧解析只认 string 条目
    ⇒ 该形态规则**会被拦、却不出现在注入的 `Active blacklist rules:` 行里**（反向的不一致）。
    现展示面与拦截面**同源**（`readBlacklistDisplay()` 从同一批 rule 取 pattern）。

- 🔴 **发布物携带已删除源的陈旧产物**（发布纪律缺陷，真读数取证）
  - **取证**：下载 npm 上的 `0.1.2` tarball 解包逐项列举 ⇒ 含三个**源文件早已删除**的产物：
    `dist/runtime/registry-guard.js`、`dist/runtime/container.js`、
    `dist/runtime/injection-probe.js`（开发期探针，其自身文件头写着「结论写入 docs 后本文件可删」）。
  - **根因**：`tsc` **只增不删**；`dist/` 被 `.gitignore` 忽略（**本地看不见**）却在
    `files: ["dist"]` 里（**会发布**）⇒ 缺陷对开发者不可见，只对用户可见。
    影响不止"多几个废文件"：发布包里带着**已废弃实现**与**会在 `SERENITY_V2_DIAG=1` 时
    向用户机器 `/tmp` 写文件的探针**（与 v0.1.1 修过的问题同类）。
  - **修法（两层）**：① `build` 前置 `clean`（治存量）；② 新增 `tests/publish-hygiene.test.ts`
    把"`dist` 必须与 `src` 双向一一对应"变成**机械判据**（治增量 —— 直接跑 `tsc` 会绕过 ①）。

### 变更

- `registry-guard.ts` → **`guards.ts`**（重命名 + 扩展；旧文件删除）。旧名在合并后已不副实。
- **黑名单只在 safe-mode ON 时生效**（对齐 §5.6 块内承诺：该声明只在块 6 被注入时出现）。

### 测试

- 133 → **183**（+50）
  - `tests/safe-mode.test.ts`（**+53**）：标记判定 / 黑名单两形态 / 写类与 shell 判定 /
    路径提取 / 三类保护的正面与**反向**断言（读放行、非 CCC 行为、同名文件不误伤）
  - `tests/publish-hygiene.test.ts`（**+4**）：dist ↔ src 双向一一对应 + 已退役模块点名回归
- 🔴🔴 **新增元判据测试**（本轮缺陷的直接护栏）：**提示词里宣称的保护，必须真有对应实现**。
  - 从块 6 文本**解析出**承诺 → 逐条要求能跑出一个真实的 deny（不是"源码里有这个名字"）
  - **反向断言**：文本里出现的每个保护关键词都必须在证明表里有条目
    ⇒ "改了提示词却忘了实现"会立刻变红（本轮缺陷正是这个形状：文本宣称三条、实现零条）
  - **已验齿**：用变异探针（临时清空 `GOVERNANCE_BASENAMES`）确认该测试会红并给出
    `宣称的保护「governance files」没有对应的实现` —— **不能变红的测试不是测试**。
  - 与"测试测了工厂产物而非注册产物"同族：**测的东西与被断言的东西不是同一个**。

### 接线级验证（非纯函数）

- 真 CCC 上走 `registerWriteGuard` **真实代码路径**（注册回调 → 解析会话根 → 决策 → 抛异常），
  **10/10 通过**：
  - 拒绝：写 `.serenity` / `.serenity-safe-on`（含绝对路径）、`container_fs rm .serenity`、
    写 `mech-registry.json`、`bash`（真 CCC 带 safe-mode 标记）
  - **放行（对照组，证明不是"一律拒绝"）**：读 `.serenity`、写普通文件、
    `container_fs list` 只读子命令、非 CCC 会话 + bash
  - 非 CCC 会话 + 写 `.serenity` ⇒ **仍拒绝**（治理文件判定不依赖根）

### 已知缺口（未实现，诚实记录）

- `bash` 的 **hidden 面**未实现：本缝只做"**调用期拒绝**"，specs §5.6 期望的是
  "hidden **and** blocked"。hidden 需宿主工具收窄缝 —— 与 `safeMode.hiddenTools`
  （§4.1「条件屏蔽」：**从 schema 移除**而非调用期拒绝）是**同一项**。
  当前 = **blocked ✓ / hidden ✗**；该事实由元判据测试**显式锁定**（补上时会变红，从而必须回来更新声明）。
- `safeMode.hiddenTools` 条件隐藏：未实现（同上）。
- 域外全局隐藏（specs §4.1）：未实现（`ToolEditor.remove` 通路待验证）。

## v0.1.2 — 工具面致命修复（所有工具调用都失败）

### 修复

- 🔴🔴 **9 个契约工具全部缺少 `output` schema 声明 ⇒ 每一次调用都失败**（owner 实测发现）
  - **根因**（反编译宿主二进制所得契约，逐字）——宿主对 `Tool.Result` 的判定是**二元的**：
    ```js
    if (tool.output === undefined) {
      if ("output" in result) fail("Tool result declared output without an output schema")
      return { output: undefined, content, ... }
    }
    if (!("output" in result)) fail("Tool did not return its declared output")
    ```
    **两头堵**：声明了 `output` 就必须返回 `output`；没声明就不许返回 `output`。
  - 我们的工具**全部**返回 `{ output, content }` 却都没声明 ⇒ 命中第一条 ⇒ **每次调用都失败**。
    用户侧看到的就是「工具调用有报错」（v0.1.0 / v0.1.1 均如此）。
  - **判据**（owner 会话实录，非推测）：`session.context` 中该 assistant 消息带
    `metadata.toolCalls[].status = "error"`，`content` 文本 = `Tool result declared output without an output schema`。
  - 🔴 **为何藏得久**：该错误**不落 `opencode.log`**，只进会话消息 metadata ⇒ 只看日志会以为"无异常"。
  - **修法**：新增 `src/tools/output-schema.ts`（宽松对象 schema，`additionalProperties: true`），
    在**注册的最后一跳**统一补声明 ⇒ 单点、新增工具自动覆盖。
    选「声明 schema」而非「删掉 `output`」：工具刻意产出结构化数据（code-mode 里
    `tools.container_fs(...)` 直接消费对象），删掉会降能力并丢掉 `output.error` 等机器可判字段。
  - ⚠️ **v1 不受影响**：v1 的工具契约里**没有** `output` 概念（只返回 content）⇒ 这是 v2 引入
    `output`/`content` 二分后的**新缺陷**。

### 测试

- 125 → **133**（+8，全部为返回值契约护栏）
  - 新增 `hostValidateResult()`：**把宿主判定复刻成可测函数**（含两条反例自证）
  - 9 工具全部声明 `output` schema；工具名与 specs §4.1 一致
  - `container_fs` 各子命令（含错误分支、逃逸分支）的返回值全部过宿主判定
  - 每个工具的 `not_in_ccc` 分支也过判定（`needsRoot` 包装路径）
- 🔴 **方法论教训**：测试最初断言**各工具工厂的裸产物**而失败 —— 恰好暴露
  「测的不是宿主真收到的那批对象」（`withOutputSchema` / `needsRoot` 都是**注册期**才包的）。
  现改为对 `buildTools()` 的产物断言（并为此把该函数抽出导出）。

## v0.1.1 — 注入正确性修复

### 修复

- 🔴🔴 **注入在第二轮起消失**（owner 报「注入有问题」，已确证）—— **最严重的一处**
  - **根因**：`injection.ts` 除「标记头检测」外另有一个按 sessionID 的内存 `injected` Set。
    实测**宿主每轮从零重建 `system`**（三轮 hook 收到的都是 4 段纯宿主内容，无 ACC 标记头）
    ⇒ 该 Set 让**第 2 轮起整块跳过**，ACC 提示词**只在首条消息出现**
  - **判据**（探针观测 `http.request` 实发报文，同一会话连续三轮）：
    | 轮次 | 修复前 primary 报文 | 含 ACC | 修复后 | 含 ACC |
    |---|---|---|---|---|
    | 1 | 78,181 B | ✅ true | 78,185 B | ✅ true |
    | 2 | 34,770 B | ❌ **false** | 78,220 B | ✅ **true** |
    | 3 | — | — | 78,255 B | ✅ **true** |
  - **修法**：删除内存 Set，幂等**只**按标记头检测（specs §5.6）；每轮重新装配（实测无重复块）
- 🔴 **活跃轨迹串台 / 陈旧 ⇒ 块 9 静默消失**
  - **根因**：读全局落盘单值 `AGENT_SESSIONS/.current`。实测该文件 = `S055`，
    而 `AGENT_SESSIONS/` 下**无 S055 目录** ⇒ 解析失败、块 9 **静默整块省略**（无报错）。
    且全局单值 ⇒ 并发会话**互相覆盖**
  - **修法**：改为**按会话隔离的内存状态**（`runtime/active-trajectory.ts`，key = 宿主 sessionID）。
    判据来源 = v1 `active-state.ts` 与 dsp `activeStore` 均如此；
    `container_trajectory use` 不再写 `.current`；**精确匹配失败不回退全局值**（回退即串台）
- 🔴 **`diagnostics` 改为 opt-in（默认关）** —— v0.1.0 默认开，导致**包被宿主加载时向用户机器写 `/tmp/serenity-v2-load/`**
  - 新判据：`SERENITY_V2_DIAG=1` 才启用（旧判据 `SERENITY_V2_NO_DIAG !== "1"` 默认开）
  - 落点可用 `SERENITY_V2_DIAG_DIR` 覆写
  - 理由：插件在用户机器上是静默后台进程，默认写 `/tmp` 属**未被请求的副作用**

### 测试

- 107 → **118**（+11）
  - 多轮幂等 3 条（两轮产出必须一致非空 / 三轮仍含 ACC 块 / 真重复调用不重复 push）
  - 活跃轨迹 scope 隔离 3 条（A 不影响 B / 空 scope 用最近值 / 不再依赖落盘 `.current`）
  - `container_trajectory use` 4 条（**反向断言不再写 `.current`** / 并发隔离 / 绑定守卫按 scope / 缺 SESSION.md 拒绝）
  - 跨模块集成 2 条（`use` → `buildSessionBlock` 产出块 9 / `use` → `assembleBlocks` 末尾含块 9）
- 🔴 **教训留档**：旧测试 `expect(readFileSync(cur)).toBe("S156")` **把 bug 当正确行为断言** ——
  它保证「写 `.current`」，而正是 `.current` 的陈旧/串台导致块 9 失败。
  ⇒ **测试通过 ≠ 实现正确**；本轮改为反向断言。

## v0.1.0 — opencode v2 首个可用版本

> **定位**：opencode v2 插件体系上的 Serenity ACC **全契约面**实现。
> 与 v1（`@shgroup/opencode-serenity-plugin`，已冻结）**代码独立** —— v2 插件 API 是全新体系
> （`Plugin.define` + 域 transform/hook，命令式注册），v1 的 hooks 形态无法平移。

### 工具面 — 9 契约工具（specs §4.1）

`container_fs`（15 子命令）/ `container_git`（6 动作）/ `container_trajectory`（8 动作）/
`container_admin`（role/msm/config）/ `dashboard` / `msm` / `praxis` /
`handyman` / `resident`

- **路径守卫**（RR5）：所有文件操作限定 CCC 根内，逃逸自动阻断
  - 判据用 `path.relative()` 而非前缀比较 —— 前缀比较有经典陷阱（`/root` 与 `/root-evil` 共享前缀）
- `container_git`：commit 默认随后自动 push；**push 成功判据 = `--porcelain` stdout 有 ref 行**
  （不用"stderr 为空"—— 实证该判据会把超时误报为成功）
- `handyman`：前台并行上限 10（硬编码），**超限拒绝且一个都不起**
- `container_trajectory`：`send-later` 回执显式声明 fire-and-forget（无回执/不可回收）

### 注入面 — 9 块（specs §5.0–§5.9）

装配序：**ACC → Metaphor → Principles → CCE → EAP → [状态] → [SKILL] → Tools → [Session]**

- 落点 = `ctx.session.hook("context")`（`system: Array<SystemPart>` 可写）
- **幂等**：按标记头检测 + 会话级去重（specs §5.0）
- SKILL 块含**第二层披露树**（references 一级条目 + `skill.ttl`，只给名/首标题/字节）
- Session 块含 **TRAJECTORY-ASSISTANT 预声明**（机制先于提醒）

### 机制面 — 三项

1. **registry 写保护**（`tool.hook("execute.before")`）
   - 🔴 payload **无决策字段** ⇒ 唯一可靠阻断 = **抛异常**（改 input 只是绕过）
   - 判据 = basename 命中（不依赖 cwd）+ 深挖嵌套 + 去环
2. **rebuild**（`session.hook("compaction")`）
   - 🔴 v2 独有优势：`result` 可直设 ⇒ **跳过模型请求**
   - 两段式：登记 pending → 压缩时消费；锚点含 RESUME-not-audit
3. **trajectory-assistant**
   - 计分（write/edit=3、task=10、read/grep/glob/msm=1、+1/分钟）+ 阈值提醒
   - token：`CHECKPOINT`（有 ACK）/ `LOGBOOK COMPACTION` / `SCRATCH PRUNE`
   - 🔴 三条硬规矩：两 token 刻意分开 / 体积提醒含 frontmatter 护栏 / **只提醒不代写代删**

### 架构要点（实测得出）

- **会话级 CCC 判定**：`ctx` 是**插件实例级**的（`location.directory` = 服务进程 cwd），
  ACC 语义是**会话级**的 ⇒ 判据取 `session.get(sessionID).location.directory`
- **注册与判定解耦**：工具注册在宿主级；激活判定下沉到 execute 时（经 `ToolContext.sessionID`）
  与注入面 —— 与 specs §4.1「域外全局隐藏」语义一致

### 测试

**104 个测试全绿**（5 个文件）：
注入 18 / container_fs 28 / 轨迹 23 / 委派 10 / 机制 25

### 装载验证

- 宿主 `@opencode/cli@2.0.28` + SDK `@opencode/plugin@2.0.28`
- 实测：工具注册 **9/9**（宿主工具总数 23→31）；注入 **9/9 块**；机制 **4/4 注册项**
