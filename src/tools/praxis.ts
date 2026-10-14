/**
 * praxis — 可实践理论注入（specs §4.1）
 *
 * 契约：`praxis`（索引，无参）/ 四段 `eap` / `neat` / `cce` / `ontology`
 *
 * 语义（specs）：
 *   - `praxis` 无参 ⇒ **索引**（有哪些段）
 *   - 各段 = **方法文本**（渐进披露：按需注入）
 *   - 🔴 `ontology` 段 = 本体工程**方法文本**；与同名**工具**分属两面（一个**说**、一个**跑**）
 *
 * 实现说明：方法文本存于 `<CCC>/.opencode/praxis/<section>.md`（若存在则读，否则给内置要点版）。
 *   这样 CCC 可自定义文本，而插件提供**结构**与**回退**。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { SerenityTool } from "./types.js"

const NAME = "praxis"

/** 四段（specs §4.1：eap / neat / cce / ontology） */
const SECTIONS = ["eap", "neat", "cce", "ontology"] as const
type Section = (typeof SECTIONS)[number]

const input = {
  type: "object",
  properties: {
    section: {
      type: "string",
      enum: SECTIONS as unknown as string[],
      description: "要注入的框架段；省略 ⇒ 索引",
    },
  },
  additionalProperties: false,
} as const

/** 内置要点版（CCC 未提供自定义文本时的回退） */
const BUILTIN: Record<Section, string> = {
  eap: `# EAP — 显式抽象原则（Explicit Abstraction Principle）

思维的功能价值 = 其**外部可重建性**。三变量：

- **E↑ 显式** — 变量/实体定义清楚；关系有方向与基数；边界划定。
  避免歧义词（"处理"、"优化" → 具体化）。
- **R↓ 可重建** — 关键决策记录**理由与备选**；不跳级（先对齐上层再下沉）。
- **S↑ 稳定** — 结构可重复再生；不依赖隐式上下文。

## 输出前自检
1. 实体定义了吗？关系方向/基数写了吗？
2. 边界在哪（什么在范围内/什么不在）？
3. 有歧义词吗？
4. 跳级了吗？
5. 后来者能据此重建我的**推理**（不只是结论）吗？`,

  neat: `# Neat — 设计协作协议

**小步对齐、显式决策、文档驱动、不跳级。**

## 五层（严格自上而下）
需求 → 范围 → 方案 → 接口 → 实现

🔴 **不跳级**：上层未对齐不得下沉。跳级的代价是返工（在错误前提上建了整座楼）。

## 纪律
- 一次只推进**一个决策**，对齐后再下一个
- 每个选择记录**理由**与**被否项**（R↓）
- 结论沉淀到**具名文件**（不是散在对话里）`,

  cce: `# CCE — 认知连续性工程

在有限资源下维持认知实体的**身份 / 可达性 / 演化能力**。CCE 不优化认知，它**保全认知得以继续的条件**。

## 五条行为约束
1. **连续性** — 每次交互都改变容器未来状态；行动前先看既有决策与约束。你是轨迹的一部分，不是新起点。
2. **有界空间** — 尊重边界；不假设容器未积累的知识。
3. **熵是内在的** — 每次输出都在增熵或减熵；优先**组织、去重、交叉引用、抽象**。
4. **重建 > 保存** — 记录要让未来能恢复**推理过程**（理由、备选、约束），不只是结论。
5. **多智能体认知** — 容器是共享的；写给**将来进入的 agent**，让他们能接着干。

## 操作熵
H_op = 因失序导致的额外认知成本。健康 = H_op ≤ H_critical。
连续性条件：组织速度 ≥ 积累速度（ΔH_org ≥ ΔH_in）。`,

  ontology: `# Ontology — 本体工程方法（方法文本；执行引擎是同名工具）

## 何时建模
当**关系本身**是知识的主要载体时（而非条目列表）。

## Turtle 编码要点
- 实体用 'a <Type>'
- 关系要有**方向与基数**
- 约束写成公理（':ax-… a sr:Axiom'）

## 四组判据
- **M1-M10 结构**：语法/必填/唯一性等
- **L1-L5 语义提示**：层次、命名、一致性
- **D1-D8 语义审查**：含 OntoClean 元属性
- **V1-V4 运行时合规**：声明 vs 现实

## OEPE 循环
Observe → Encode → Probe → Evolve（观察→编码→探测→演化）

🔴 **本体工作不是"没有工具"，而是"它有引擎"** —— 用 ontology 工具跑：
  ontology init / check / explain / verify / review / compliance。`,
}

/** 索引文本 */
function index(): string {
  return `praxis — 可实践理论注入（按需加载，渐进披露）

可用段：
  eap       — 显式抽象原则（E↑ / R↓ / S↑ + 输出前自检）
  neat      — 设计协作协议（五层：需求→范围→方案→接口→实现）
  cce       — 认知连续性工程（五条行为约束 + 操作熵）
  ontology  — 本体工程方法（判据组 + OEPE 循环）

用法：praxis(section="eap") 注入该段。
（ontology 段是**方法文本**；要**跑**本体引擎请用 ontology 工具。）`
}

export function createPraxisTool(cccRoot: string): SerenityTool {
  return {
    name: NAME,
    description:
      "可实践理论注入：无参 ⇒ 索引；section=eap|neat|cce|ontology ⇒ 注入该段方法文本。",
    input,

    async execute(raw: { section?: string }) {
      const a = raw ?? {}
      const section = a.section as Section | undefined

      if (!section) {
        return { output: { sections: SECTIONS }, content: index() }
      }

      if (!SECTIONS.includes(section)) {
        return {
          output: { error: "unknown_section", section },
          content: `✗ 未知段「${String(section)}」（可用：${SECTIONS.join(" / ")}）`,
        }
      }

      // CCC 自定义文本优先（存在则用），否则内置回退
      const custom = join(cccRoot, ".opencode/praxis", `${section}.md`)
      if (existsSync(custom)) {
        try {
          const body = readFileSync(custom, "utf8")
          return { output: { section, source: "custom", bytes: body.length }, content: body }
        } catch {
          // 读失败 ⇒ 回退内置
        }
      }

      const body = BUILTIN[section]
      return { output: { section, source: "builtin", bytes: body.length }, content: body }
    },
  }
}

/** 列出 CCC 自定义的 praxis 段（供诊断） */
export function listCustomPraxis(cccRoot: string): string[] {
  const dir = join(cccRoot, ".opencode/praxis")
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"))
  } catch {
    return []
  }
}
