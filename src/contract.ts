/**
 * host 面与 client 面共享的 wire 契约。
 *
 * 【为什么单独一个文件】
 * 这份类型是两面唯一的耦合点：host 的投影 `view()` 产出它，client 的折叠条消费它。
 * 放在一处，任何字段改动都会同时打红两侧的编译，而不是在运行时才发现对不上。
 *
 * 【纯类型 + 常量，无副作用】
 * client 侧会把它打进浏览器包里，所以这里不能 import 任何 Node 能力，也不能有逻辑。
 */

/** 投影键。host 注册、client 读取都用它，避免两边各写一份字符串。 */
export const TOOL_COST_HINT_PROJECTION_KEY = 'toolCostHint'

/** 视图版本。折叠语义变化时递增，旧的 client 包遇到新版本可以选择不渲染。 */
export const TOOL_COST_HINT_VIEW_VERSION = 1

/**
 * 一个工具在一轮内的注入量。
 *
 * 字段名刻意与 host 面 `ToolUsage` 对齐，但这里是**纯估算**口径：
 * 投影必须能从 session 日志纯折叠出结果，而 `ctx.tokenMeter` 是服务、不是日志，
 * 随时调用会破坏"日志是唯一真相"的前提。详见 src/wire.ts 顶部说明。
 */
export interface ToolCostRowView {
  /** 工具名。未配对结果会归入 `(unattributed)` 合成桶。 */
  name: string
  /** 本轮调用次数。 */
  calls: number
  /** 本轮出错的结果数。 */
  errors: number
  /** 调用侧注入量（工具名 + 参数 JSON）。 */
  inputTokens: number
  /** 结果侧注入量（追加进模型可见上下文的 tool 消息）。 */
  outputTokens: number
  /** inputTokens + outputTokens，UI 上标为"注入量"。 */
  injectedTokens: number
}

/** 一轮的汇总。 */
export interface TurnCostView {
  turn: number
  /** 该轮是否已收到 turn/end。 */
  ended: boolean
  /** 按 injectedTokens 降序排好的工具行。 */
  tools: ToolCostRowView[]
  totalCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalInjectedTokens: number
  /** 发了调用但没等到结果（中断/仍在跑）。 */
  unattributedCalls: number
  /** 收到结果却没配对到调用（插件中途加载、框架补写恢复结果）。 */
  orphanResults: number
}

/** `toolCostHint` 投影的视图值，也就是 client 通过 useProjection 拿到的东西。 */
export interface ToolCostHintView {
  v: number
  turns: TurnCostView[]
}
