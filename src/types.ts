/**
 * dsh-tool-cost-hint —— 领域模型与插件配置（host 面）。
 *
 * 【为什么把类型单独放一个文件】
 * 这里的结构就是插件的**对外契约**：下一轮的 client UI、以及任何下游消费者都只依赖
 * 这些字段。把"归因口径"集中在一处，口径要变时只有这里需要动，且必然带着版本号一起动。
 */

import Schema from '@deepseek-ai/schemastery'

/**
 * 归因口径版本号。
 *
 * 【为什么必须有】
 * summary 是要被推出去的（本轮是 Cordis 事件，下一轮是 client 视图）。消费方必须能
 * 判断"我手里这堆数字是按哪套口径算的"。任何影响数值含义的改动都必须递增：
 * 换定价公式、换 token 来源（meter ↔ estimate）、增删字段语义、改变错误/未配对调用的处理。
 *
 * 特别注意：**增加一个纯展示用的字段不需要递增**（老消费方忽略即可）；
 * 但**改变某个已有字段的算法必须递增**。
 */
export const ATTRIBUTION_VERSION = 1

/**
 * token 数字的来源，用来在 UI 上区分"框架官方计量"和"按官方公式的估算值"。
 *
 * - 'meter'    ：取自 ctx.tokenMeter.measure(session).nodes 里该事件的 tokens，
 *                与上下文压力条用的是同一套数，可直接与 /context 面板对数。
 * - 'estimate' ：没有 meter 数据时的回退，用 @deepseek-ai/dsh-token-meter/estimate
 *                完全相同的公式（CHARS_PER_TOKEN=4、BLOCK_OVERHEAD=4、ROLE_OVERHEAD=4）算。
 *                host 侧应当显示为"估算"，不要与 meter 数字混为一谈。
 */
export type TokenSource = 'meter' | 'estimate'

/**
 * 单个工具在一轮内的使用情况。
 *
 * 【三个 token 字段的口径 —— 这是本插件唯一的"技术核心"，务必守住】
 *
 *   inputTokens    该工具**调用侧**注入的量：本轮的 tool/call 事件里，
 *                  assistant 生成的 tool-call 块（工具名 + 参数 JSON）占多少 token。
 *                  来源：estimate（官方公式）。没有 meter 来源可用 —— 见下方说明。
 *
 *   outputTokens   该工具**结果侧**注入的量：tool/result 事件追加进模型可见 surface
 *                  的那条 tool 消息占多少 token。
 *                  来源：优先 meter（该 tool/result 事件的 surface 节点 tokens），
 *                        回退 estimate。
 *
 *   injectedTokens = inputTokens + outputTokens。这是 UI 上要显示的"注入量"。
 *
 * 【为什么叫注入量，不叫花费量】
 * provider 只报整轮的 usage（uncachedInput / cacheRead / output / ...），没有任何
 * per-tool 的计费数据；而且命中缓存之后，"注入 3000 token"和"花了 3000 token 的钱"
 * 完全是两件事。所以本插件只声明"这个工具往上下文里塞了多少东西"，绝不换算金额。
 * 计价是 dsh-bill 这类插件的职责，两边口径不重叠。
 *
 * 【为什么 inputTokens 只能是 estimate】
 * tool/call 不是 surface 事件（模型看到的 surface 只有 system/developer/user/assistant
 * 消息和 tool/result），它在 tokenMeter 里没有独立节点，从 measure() 拿不到；而它确实
 * 会以 tool-call 块的形式进入下一次请求，所以必须算进去。于是唯一正确的做法是用
 * token meter 自身的定价公式（estimate.js 里 tool-call 块：
 * ceil(name/4) + ceil(arguments/4) + 4），而不是自创一套启发式。
 * 也就是说：**这不是"自己重算一个已有数"，而是在补一个框架没有单独暴露的数**，
 * 且公式与框架逐字一致。
 */
export interface ToolUsage {
  /** 工具名，来自 tool/call 的 data.name。 */
  name: string
  /** 本轮内该工具被调用了几次（= tool/call 事件数）。 */
  calls: number
  /** 其中结果带 isError 的次数（含框架合成的 TOOL_OUTCOME_UNKNOWN 等恢复结果）。 */
  errors: number
  /** 调用参数侧的注入量（estimate）。 */
  inputTokens: number
  /** 工具结果侧的注入量（meter 优先，estimate 回退）。 */
  outputTokens: number
  /** = inputTokens + outputTokens。UI 展示的就是这个数。 */
  injectedTokens: number
  /** inputTokens 的来源标记。当前恒为 'estimate'，字段保留是为了口径可演进。 */
  inputTokensSource: TokenSource
  /**
   * outputTokens 的来源标记：本轮该工具所有结果都能从 meter 拿到就是 'meter'；
   * 只要有一条回退到公式估算，整个工具就标 'estimate'（宁可保守，不混报）。
   */
  outputTokensSource: TokenSource
}

/**
 * 一轮结束时整理出来的摘要。本轮通过 Cordis 事件 'tool-cost-hint/summary' 推送，
 * 下一轮会同时作为 host 投影的 wire view 送到 client。
 */
export interface TurnToolUsageSummary {
  /** 归因口径版本，见 ATTRIBUTION_VERSION。 */
  version: number
  /** 会话 id（session.id）。拿不到时为空串，消费方需容忍。 */
  sessionId: string
  /** 轮次号，来自 turn/start、tool/call、turn/end 的 data.turn。 */
  turn: number
  /** 本轮 turn/start 的 seq；插件在本轮中途才加载时可能等于首个观测到的工具事件 seq。 */
  startedSeq: number
  /** 本轮 turn/end 的 seq。 */
  endedSeq: number
  /** 本轮从首个观测事件到 turn/end 的墙钟毫秒数。 */
  durationMs: number
  /** 轮次结束原因，取 turn/end 的 data.reason.kind；取不到时为 'unknown'。 */
  reason: string
  /** 按 injectedTokens 降序排列，同值按 calls 降序、再按名字升序，保证输出稳定。 */
  tools: ToolUsage[]
  /** 本轮工具调用总次数。 */
  totalCalls: number
  /** 本轮工具错误总次数。 */
  totalErrors: number
  /** 本轮所有工具调用参数侧的总注入量。 */
  totalInputTokens: number
  /** 本轮所有工具结果侧的总注入量。 */
  totalOutputTokens: number
  /** = totalInputTokens + totalOutputTokens。 */
  totalInjectedTokens: number
  /**
   * 发出了 tool/call 但直到 turn/end 都没等到 tool/result 的调用数。
   * 正常为 0；中断、崩溃、工具还在跑就结束轮次时会 > 0。
   * 这些调用的 outputTokens 计为 0（确实没往上下文里塞结果），但仍然计入 calls 与 inputTokens。
   */
  unattributedCalls: number
  /**
   * 收到了 tool/result 却没有对应 tool/call 的次数。
   * 插件在本轮中途加载、或框架补写恢复结果时会出现；这些结果的 outputTokens 仍然计入。
   */
  orphanResults: number
}

/** 插件配置。字段都在 cordis.patch.yml 里可改。 */
export interface Config {
  /** 轮次结束时是否 ctx.emit('tool-cost-hint/summary', summary)。 */
  emitEvent: boolean
  /** 是否把每轮摘要以单行 JSON 打到 stderr（host 侧验证用）。 */
  logToConsole: boolean
  /** 每个会话在内存里保留最近多少轮摘要。0 = 不保留历史，只推送。 */
  keepTurns: number
  /** 不计入统计的工具名。 */
  excludeTools: string[]
}

/**
 * Config schema。
 *
 * 【为什么用 schemastery 而不是手写 if】
 * 1. cordis.patch.yml 里写的 config 会先过这个 schema 拿到默认值 + 校验，写错字段名
 *    会在启动时就报出来，而不是安静地跑一套错参数；
 * 2. 设置界面可以直接拿这个 schema 渲染表单，用户不必读源码就知道有哪些旋钮。
 * 默认值一律先用 default() 声明，apply() 里仍然做一次兜底归一化（见 index.ts），
 * 因为 `--patch` 传进来的 config 有可能是整体替换后的残缺对象。
 */
export const Config: Schema<Config> = Schema.object({
  emitEvent: Schema.boolean()
    .default(true)
    .description('轮次结束时是否发出 tool-cost-hint/summary 事件。关闭后插件只在内存里留数据，不触发任何下游。'),
  logToConsole: Schema.boolean()
    .default(false)
    .description('把每轮摘要以单行 JSON 打到 stderr，用于确认 tool/call 与 tool/result 是否被正确捕获。'),
  keepTurns: Schema.natural()
    .min(0)
    .max(200)
    .default(20)
    .description('每个会话保留最近多少轮摘要（下一轮 UI 回看用）。0 表示不保留历史。'),
  excludeTools: Schema.array(Schema.string())
    .default([])
    .description('不计入统计的工具名黑名单，例如把纯核算类工具排除掉。'),
})
