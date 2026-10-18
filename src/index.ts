/**
 * dsh-tool-cost-hint —— host 面。
 *
 * 一句话定位：不告诉你花了多少钱，只告诉你每个工具往你的上下文里塞了多少东西。
 *
 * 【本插件的三条硬边界】
 *   1. 不注册任何工具（没有 ctx.tools.register）——它不改变模型能做什么；
 *   2. 不往系统提示、不往任何模型可见 surface 里写东西——它不改变模型看到什么；
 *   3. 不 append 任何 session 事件——它不改变会话日志。
 * 也就是说：它是一个纯粹的**被动观察者**，对 agent loop 的行为影响为零，插件自身每轮
 * 额外消耗的模型 token 也是零（所有计算都在 host 的 JS 里，不产生任何请求）。
 *
 * 【为什么用 ctx.on('session/event') 而不是包一层工具调用】
 * 包装工具（改 tool 定义、在返回里塞字段）会污染模型上下文，正好违反第 2 条边界。
 * 而 session/event 是框架的**持久事实流**：tool/call 和 tool/result 是 agent loop 每
 * 一次工具调用都会 append 的事件，监听它既拿得到"调了几次"，也拿得到"结果有多大"，
 * 而且完全不影响这条流的产生方。
 *
 * 【时机：为什么一定要等到 turn/end 才算数】
 *   - tool/call 一到就可以确定"调了几次""参数多大"，这部分立刻累加；
 *   - tool/result 一到就可以确定"结果多大"，但**权威数字**来自 ctx.tokenMeter.measure()，
 *     而 measure() 是 O(surface) 的整表快照，绝不能每个事件都调一次；
 *   - 所以：事件到达时只做 O(1) 的增量记账（连结果内容都不缓存，只记 seq），
 *     在 turn/end 这个"本轮所有结果都已落地"的时刻**调一次** measure()，
 *     用节点 tokens 覆盖回退估算值，然后一次性整理出本轮摘要。
 *     这一步之后本轮的数据就是终态，不会再变。
 *
 * 【为什么把异常全部吞掉】
 * 监听器跑在 session.append() 的调用栈里（append → invokeContainedSessionObservers）。
 * 这里抛一个异常，就等于让 agent loop 的工具调用失败 —— 一个统计插件绝不能有这种权力。
 * 所以回调整体包 try/catch，任何意外都只降级（少算/退回估算），不影响主流程。
 */

import type { Context } from '@deepseek-ai/cordis'

// 这一行的唯一作用是引入 @deepseek-ai/dsh-session 对 cordis Events 的增强声明，
// 让 ctx.on('session/event', ...) 通过类型检查。它在运行时被完全擦除，
// 不会产生任何 import 请求（verbatimModuleSyntax 保证这一点）。
import type {} from '@deepseek-ai/dsh-session'

import {
  estimateToolCallBlockTokens,
  estimateToolResultMessageTokens,
  isErrorResult,
  readResultCallId,
  readToolCall,
  readToolResult,
  readTurn,
  type SessionEventLike,
  type SessionLike,
  type TokenMeterLike,
} from './events.js'
import {
  ATTRIBUTION_VERSION,
  type Config,
  type ToolUsage,
  type TurnToolUsageSummary,
} from './types.js'
import { registerWireProjection } from './wire.js'

/**
 * 重新导出 Config。
 *
 * cordis loader 是从**插件模块的导出面**上取 Config 的（用来做 config 校验、默认值
 * 填充与设置界面表单），所以它必须出现在本模块的导出里，而不能只在 types.ts 里定义。
 */
export { Config } from './types.js'

/**
 * 发给 Cordis 事件总线的摘要事件名。
 *
 * 【为什么用 ctx.emit 而不是 session.append 一个自定义事件】
 * session 事件是**持久日志**，读者只接受白名单内的事件类型；未知类型只有在信封带
 * ignorable: true 时才被容忍，而 live append 根本没法设这个标记 —— 一旦往日志里塞
 * 自定义类型，这个会话之后就打不开了。所以插件的数据通道只能是进程内事件总线，
 * 不能是会话日志。
 *
 * 【它能不能直接到浏览器？不能。】
 * client 侧只能通过 API gateway 的转发白名单订阅 host 事件，普通插件无法凭空往白名单里
 * 加事件源。所以本轮这个事件只服务 host 内部消费者；下一轮 UI 要取数，走两条正规路径
 * 之一（见 README 的"推送接口设计"）：host 投影的 wire.view，或插件自己注册的 HTTP 路由。
 */
export const SUMMARY_EVENT = 'tool-cost-hint/summary'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 一轮结束（且本轮有工具调用）时由 dsh-tool-cost-hint 发出。 */
    'tool-cost-hint/summary'(summary: TurnToolUsageSummary): void
  }
}

/** 插件名。与 cordis.patch.yml 里的 id 无强绑定，但保持一致便于排查。 */
export const name = 'tool-cost-hint'

/**
 * 服务依赖：**故意为空**。
 *
 * 唯一的可选依赖是 tokenMeter，但它不能写进 inject：cordis 的依赖刷新是"遍历 inject 的
 * 每个 key，缺一个就 INACTIVE"，也就是说写进去就是硬依赖。在没装 token meter 的 profile
 * （headless / 精简组合）里，插件会直接不激活。
 * 所以改成运行时 ctx.get('tokenMeter') 判空，拿不到就退化成纯估算，功能降级但不消失。
 */
export const inject: string[] = []

/**
 * 收到了 tool/result 却没有配对 tool/call 时使用的合成工具名。
 *
 * 什么时候会发生：插件是在一轮任务**中途**被加载/重启的（于是这一轮的 tool/call 已经
 * 写进日志、但插件没看见），或者框架为中断的调用补写了恢复结果。
 * 这些结果确实进了模型上下文，不能丢，所以单独归到一个可识别的桶里。
 */
const ORPHAN_TOOL_NAME = '(unattributed)'

/** 已观测到、尚未收到结果的调用。 */
interface PendingCall {
  callId: string
  /** 工具名，收到结果时用来回填归属。 */
  tool: string
  /** tool/call 事件的 seq，便于排查。 */
  callSeq: number
  /** 调用参数侧已经算出的注入量。 */
  inputTokens: number
  /**
   * 该调用来自 `excludeTools` 黑名单。
   *
   * 【为什么被排除的调用也要登记】不登记的话，它的 tool/result 配对失败，
   * 会被误记成孤儿结果（(unattributed) 桶），等于"排除没排干净"。
   * 登记成 suppressed 后，调用侧不计、结果侧也直接丢弃，两边一起消失。
   */
  suppressed?: boolean
}

/** 单个工具在一轮内的增量记账。 */
interface ToolAccumulator {
  name: string
  calls: number
  errors: number
  inputTokens: number
  /**
   * 每条 tool/result 的 seq 与回退估算值。
   *
   * 【关键决策：不缓存消息内容】
   * 只存 seq + 一个数字，绝不把工具结果正文留在内存里。工具结果动辄几十 KB，
   * 长会话下把正文留在插件内存里既浪费又可能长期驻留。真正需要权威数字时，
   * turn/end 上用 seq 去 measure() 的节点表里查，或者干脆用这里已经算好的估算值。
   */
  results: Array<{ seq: number; estimatedTokens: number }>
}

/**
 * 一轮的累加器。
 *
 * 这就是需求里的 Map<turnId, ToolUsage[]> 的"进行中"形态：turns 以 turnId 为键，
 * 每个值里 tools 以工具名为键做增量累加；轮次结束时折叠成 ToolUsage[] 存进
 * SessionBook.summaries —— 那就是最终的 Map<turnId, ToolUsage[]>。
 */
interface TurnAccumulator {
  turn: number
  /** 本轮最早被观测到的事件 seq（通常是 turn/start）。 */
  startedSeq: number
  /** 本轮最早被观测到的时刻，用于算 durationMs。 */
  startedAt: number
  pending: Map<string, PendingCall>
  tools: Map<string, ToolAccumulator>
  orphanResults: number
}

/** 单个会话的内存状态。整块由 ctx.effect 拥有，卸载即丢弃。 */
interface SessionBook {
  /** 已结束轮次的摘要，按时间正序，长度受 config.keepTurns 限制。 */
  summaries: TurnToolUsageSummary[]
  /** 进行中/本轮刚结束待整理的轮次。 */
  turns: Map<number, TurnAccumulator>
}

export function apply(ctx: Context, rawConfig?: Config): void {
  const config = normalizeConfig(rawConfig)
  const excluded = new Set(config.excludeTools)

  /**
   * 会话内存态。
   *
   * 【为什么用 WeakMap 以 session 对象为键】
   * 会话被回收后整条记录自动消失，不需要维护"哪个会话还活着"的登记表。
   *
   * 【为什么还要套一层 ctx.effect】
   * WeakMap 里条目要等 GC；而插件被卸载时我们希望**立刻**丢掉全部数据与索引，
   * 而不是等一次不确定的 GC。effect 的 dispose 把 store 换成一个空 WeakMap，
   * 旧的那张表失去唯一引用即可被回收 —— 这就是"资源由 ctx.effect 拥有"。
   * 注意顺序：effect 必须**先于** ctx.on 注册，保证监听器第一次触发时 store 已经就绪。
   */
  let store = new WeakMap<object, SessionBook>()
  ctx.effect(() => {
    store = new WeakMap<object, SessionBook>()
    return () => {
      store = new WeakMap<object, SessionBook>()
    }
  }, 'tool-cost-hint/state')

  if (config.logToConsole) {
    // 只打一行，确认插件挂上了。正常使用时不打任何东西，保持 host 日志干净。
    process.stderr.write(
      `[tool-cost-hint] armed (attribution v${ATTRIBUTION_VERSION}, keepTurns=${config.keepTurns}, emitEvent=${config.emitEvent})\n`,
    )
  }

  /**
   * 注册监听。
   *
   * ctx.on 把监听器绑到当前 fiber 上，插件卸载时框架自动摘除 —— 不要手动 removeListener，
   * 手动的 remove 会和 fiber 的生命周期打架（重复卸载、卸载顺序错误）。
   */
  ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    try {
      handleSessionEvent(session, event)
    } catch (error) {
      // 绝不让统计逻辑影响 agent loop：这里只降级、只记日志。
      reportInternalError(error)
    }
  })

  /**
   * 第二轮新增：把同一份统计再折叠成一个 session 投影，供 client 面读取。
   *
   * 【为什么要两条路同时走，而不是直接替换掉 ctx.emit】
   * 上面的内存 book + `tool-cost-hint/summary` 是 host 侧自用的（进程内、能拿到完整
   * 摘要含 durationMs/seq 区间），投影则是给浏览器的。两者折叠同一套纯定价函数，
   * 断言口径一致（见 src/wire.ts 顶部注释）。
   *
   * 【为什么放在最后注册】
   * 它依赖 sessionProjections 服务；服务缺失时只打一行提示就返回，绝不能影响
   * 上面已经装好的监听器。
   */
  registerWireProjection(ctx, config)

  function handleSessionEvent(session: SessionLike, event: SessionEventLike): void {
    switch (event.type) {
      case 'turn/start':
        onTurnStart(session, event)
        return
      case 'tool/call':
        onToolCall(session, event)
        return
      case 'tool/result':
        onToolResult(session, event)
        return
      case 'turn/end':
        onTurnEnd(session, event)
        return
      default:
        // 其余事件（step/*、assistant/message、request/header、compaction/* ...）
        // 与本插件口径无关，直接忽略。忽略得越早，长会话下的开销越低。
        return
    }
  }

  function bookOf(session: SessionLike): SessionBook {
    const key = session as unknown as object
    let book = store.get(key)
    if (book === undefined) {
      book = { summaries: [], turns: new Map() }
      store.set(key, book)
    }
    return book
  }

  /**
   * 取本轮累加器，没有就懒建。
   *
   * 【为什么要懒建】插件可能在一轮中途才加载（热重载、配置文件改动后的重新挂载），
   * 这时收不到 turn/start。如果只认 turn/start，整个这一轮就会被漏掉。
   * 所以任何带 turn 号的事件都能把累加器建起来，startedSeq/startedAt 退化为"首次观测"。
   */
  function turnOf(book: SessionBook, turn: number, seq: number): TurnAccumulator {
    let accumulator = book.turns.get(turn)
    if (accumulator === undefined) {
      accumulator = {
        turn,
        startedSeq: seq,
        startedAt: Date.now(),
        pending: new Map(),
        tools: new Map(),
        orphanResults: 0,
      }
      book.turns.set(turn, accumulator)
    } else if (seq < accumulator.startedSeq) {
      accumulator.startedSeq = seq
    }
    return accumulator
  }

  function toolOf(accumulator: TurnAccumulator, toolName: string): ToolAccumulator {
    let tool = accumulator.tools.get(toolName)
    if (tool === undefined) {
      tool = { name: toolName, calls: 0, errors: 0, inputTokens: 0, results: [] }
      accumulator.tools.set(toolName, tool)
    }
    return tool
  }

  function onTurnStart(session: SessionLike, event: SessionEventLike): void {
    const turn = readTurn(event.data)
    if (turn === undefined) return
    turnOf(bookOf(session), turn, event.seq)
  }

  function onToolCall(session: SessionLike, event: SessionEventLike): void {
    const call = readToolCall(event.data)
    if (call === undefined) return

    const accumulator = turnOf(bookOf(session), call.turn, event.seq)

    // 黑名单过滤：**仍然登记 pending**，否则它的 tool/result 会配不上调用、被误算成
    // 孤儿结果（(unattributed) 桶）——自测发现的真实缺陷。
    // 登记但不计调用数、不计 token、不建工具行：两边一起被丢掉才叫"排除"。
    if (excluded.has(call.name)) {
      accumulator.pending.set(call.callId, {
        callId: call.callId,
        tool: call.name,
        callSeq: event.seq,
        inputTokens: 0,
        suppressed: true,
      })
      return
    }

    const tool = toolOf(accumulator, call.name)

    tool.calls += 1
    const inputTokens = estimateToolCallBlockTokens(call.name, call.arguments)
    tool.inputTokens += inputTokens

    // 记下待配对的调用。同一个 callId 重复出现（重试/重放）时覆盖，
    // 但 calls 已经各算一次 —— 每次 tool/call 都是一次真实的调用意图。
    accumulator.pending.set(call.callId, {
      callId: call.callId,
      tool: call.name,
      callSeq: event.seq,
      inputTokens,
    })
  }

  function onToolResult(session: SessionLike, event: SessionEventLike): void {
    const result = readToolResult(event.data)
    if (result === undefined) return

    const accumulator = turnOf(bookOf(session), result.turn, event.seq)
    const callId = readResultCallId(result)
    const pending = callId === undefined ? undefined : accumulator.pending.get(callId)

    // 黑名单工具的结果：配对成功后直接丢弃，不建行、不计数、不计 token。
    if (pending?.suppressed === true) {
      accumulator.pending.delete(pending.callId)
      return
    }

    let toolName: string
    if (pending !== undefined) {
      toolName = pending.tool
      accumulator.pending.delete(pending.callId)
    } else {
      // 没有配对调用：插件中途加载，或框架补写的恢复结果。
      // 结果确实进了上下文，所以照样计入，但归到合成桶里，避免污染真实工具的均值。
      toolName = ORPHAN_TOOL_NAME
    }

    if (excluded.has(toolName)) return

    const tool = toolOf(accumulator, toolName)
    if (pending === undefined) {
      accumulator.orphanResults += 1
      // 合成桶的 calls 只在"结果对不上调用"时递增，这样 calls 与 results 才配平。
      tool.calls += 1
    }
    if (isErrorResult(result)) tool.errors += 1
    tool.results.push({
      seq: event.seq,
      estimatedTokens: estimateToolResultMessageTokens(result.message),
    })
  }

  function onTurnEnd(session: SessionLike, event: SessionEventLike): void {
    const turn = readTurn(event.data)
    if (turn === undefined) return

    const book = bookOf(session)
    const accumulator = book.turns.get(turn)
    // turn/start 会为每一轮建累加器（为了记住 startedSeq），所以"存在累加器"不等于
    // "这一轮有工具调用"——纯对话轮次同样存在。判断依据必须是有没有工具行：
    // 空轮次直接丢弃，不 finalize、不 emit、不入 summaries。
    // （这条是自测发现的一处真实偏差：先前只看 accumulator 是否存在，导致纯对话轮次
    //  也会 emit 一条 tools: [] 的空摘要。）
    if (accumulator === undefined) return
    if (accumulator.tools.size === 0) {
      book.turns.delete(turn)
      return
    }

    const summary = finalize(accumulator, session, event)

    book.turns.delete(turn)
    if (config.keepTurns > 0) {
      book.summaries.push(summary)
      // 环形裁剪：只留最近 keepTurns 轮。
      const overflow = book.summaries.length - config.keepTurns
      if (overflow > 0) book.summaries.splice(0, overflow)
    }

    if (config.logToConsole) {
      // 单行 JSON：方便 `| Select-String` / `| jq` 直接过滤。
      process.stderr.write(`[tool-cost-hint] ${JSON.stringify(summary)}\n`)
    }

    if (config.emitEvent) {
      ctx.emit(SUMMARY_EVENT, summary)
    }
  }

  /** 把一轮的增量记账折叠成终态摘要。这里会做唯一一次 measure() 调用。 */
  function finalize(
    accumulator: TurnAccumulator,
    session: SessionLike,
    endEvent: SessionEventLike,
  ): TurnToolUsageSummary {
    // 唯一的 O(surface) 调用，一轮一次。拿不到（服务缺失 / 日志不完整）就返回 undefined，
    // 全部退回估算值。
    const metered = readMeteredNodeTokens(ctx, session)

    const tools: ToolUsage[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCalls = 0
    let totalErrors = 0

    for (const acc of accumulator.tools.values()) {
      let outputTokens = 0
      let allMetered = acc.results.length > 0
      for (const result of acc.results) {
        const fromMeter = metered?.get(result.seq)
        if (fromMeter !== undefined) {
          outputTokens += fromMeter
        } else {
          outputTokens += result.estimatedTokens
          allMetered = false
        }
      }

      const injectedTokens = acc.inputTokens + outputTokens
      tools.push({
        name: acc.name,
        calls: acc.calls,
        errors: acc.errors,
        inputTokens: acc.inputTokens,
        outputTokens,
        injectedTokens,
        // 调用参数侧没有 meter 来源，恒为官方公式估算。
        inputTokensSource: 'estimate',
        outputTokensSource: allMetered ? 'meter' : 'estimate',
      })

      totalInputTokens += acc.inputTokens
      totalOutputTokens += outputTokens
      totalCalls += acc.calls
      totalErrors += acc.errors
    }

    // 排序固定：注入量降序 → 调用次数降序 → 名字升序。
    // 固定顺序是为了让 UI 与日志可复现（同一轮同样的数据永远同样的顺序）。
    tools.sort((left, right) => {
      if (right.injectedTokens !== left.injectedTokens) return right.injectedTokens - left.injectedTokens
      if (right.calls !== left.calls) return right.calls - left.calls
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })

    return {
      version: ATTRIBUTION_VERSION,
      sessionId: typeof session.id === 'string' ? session.id : '',
      turn: accumulator.turn,
      startedSeq: accumulator.startedSeq,
      endedSeq: endEvent.seq,
      durationMs: Math.max(0, Date.now() - accumulator.startedAt),
      reason: readTurnEndReason(endEvent.data),
      tools,
      totalCalls,
      totalErrors,
      totalInputTokens,
      totalOutputTokens,
      totalInjectedTokens: totalInputTokens + totalOutputTokens,
      // 本轮发出了调用但没等到结果：结果没进上下文，outputTokens 记 0 是正确的。
      unattributedCalls: accumulator.pending.size,
      orphanResults: accumulator.orphanResults,
    }
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/** turn/end 的 data = { turn, reason: { kind } }，取不到就给 'unknown'。 */
function readTurnEndReason(data: unknown): string {
  if (typeof data !== 'object' || data === null) return 'unknown'
  const reason = (data as Record<string, unknown>)['reason']
  if (typeof reason !== 'object' || reason === null) return 'unknown'
  const kind = (reason as Record<string, unknown>)['kind']
  return typeof kind === 'string' ? kind : 'unknown'
}

/**
 * 取一次 token meter 的表面节点表，压缩成 seq → tokens。
 *
 * 【为什么先试 measure 再退化】
 * ctx.tokenMeter.measure(session) 给出的 nodes[].tokens 就是上下文压力条用的那套数，
 * 与 /context 面板能对上，是"官方计量"。但它有两个坑，都在这里处理掉：
 *   1. 服务可能不存在（精简 profile）→ ctx.get 返回 undefined → 退化为全估算；
 *   2. 日志不完整时 measure 会 throw（例如存在没有配对 step/start 的 step/end）
 *      → 必须 try/catch，绝不能让它冒泡进 append 的调用栈。
 */
function readMeteredNodeTokens(
  ctx: Context,
  session: SessionLike,
): Map<number, number> | undefined {
  // ctx.get 的类型面来自 Services 增强，而 tokenMeter 的增强在 app.asar 里的包中，
  // 插件这边解析不到，所以这里用一次收窄的断言拿服务，避免把整个 Services 类型绑进来。
  const meter = (ctx as unknown as { get(name: string): unknown }).get('tokenMeter') as
    | TokenMeterLike
    | undefined
  if (meter === undefined || meter === null || typeof meter.measure !== 'function') return undefined

  try {
    const snapshot = meter.measure(session)
    const nodes = snapshot?.nodes
    if (!Array.isArray(nodes)) return undefined
    const map = new Map<number, number>()
    for (const node of nodes) {
      if (typeof node?.seq !== 'number') continue
      const tokens = typeof node.tokens === 'number' ? node.tokens : node.heuristicTokens
      if (typeof tokens === 'number') map.set(node.seq, tokens)
    }
    return map
  } catch {
    return undefined
  }
}

/**
 * 配置归一化。
 *
 * 【为什么 schema 已经给了默认值还要再归一化一次】
 * `--patch` 传进来的 config 行是**整体替换**语义：用户只写 `{ logToConsole: true }`
 * 时，其余字段在到达 apply 之前可能已经是 undefined。这里做一次防御性归一化，
 * 保证即使绕过 schema（直接程序化 plugin() 挂载）也不会因为 undefined 而崩。
 */
function normalizeConfig(raw: Config | undefined): Required<Config> {
  const config = (raw ?? {}) as Partial<Config>
  return {
    emitEvent: config.emitEvent !== false,
    logToConsole: config.logToConsole === true,
    keepTurns:
      typeof config.keepTurns === 'number' && Number.isFinite(config.keepTurns)
        ? Math.min(200, Math.max(0, Math.trunc(config.keepTurns)))
        : 20,
    excludeTools: Array.isArray(config.excludeTools)
      ? config.excludeTools.filter((entry): entry is string => typeof entry === 'string')
      : [],
  }
}

/**
 * 内部异常上报。
 *
 * 只走 stderr 且带固定前缀：不进 session 日志（那是模型可见事实流，不能塞调试信息），
 * 不 throw（会影响 agent loop），不依赖 logger 服务（那样又多一个硬依赖）。
 */
function reportInternalError(error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.stderr.write(`[tool-cost-hint] internal error ignored: ${detail}\n`)
}
