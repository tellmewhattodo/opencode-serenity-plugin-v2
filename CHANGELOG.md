# 更新日志

## v0.1.1 — 未发布（发布前请先 bump package.json）

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
