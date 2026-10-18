/**
 * 把每轮的工具注入量送到浏览器的"官方通道"：一个带 `wire.view` 的 session 投影。
 *
 * 【为什么必须新增这一段，而不是直接用第一轮的 ctx.emit】
 * 第一轮 host 面已经 emit 了 `tool-cost-hint/summary`，但那是**进程内** Cordis 事件。
 * DSH 的浏览器只认两样东西：装配期固定下来的 Remote namespace / 转发事件白名单，
 * 以及投影的 wire 视图。前者是 app.asar 构建时写死的（第三方插件无法在运行时追加），
 * 所以对一个第三方 bundle 而言，投影的 `wire.view` 是唯一能自动到达 client 的正规通道。
 * 备选方案是自注册 HTTP 路由 + 前端 fetch（billion-context 的做法），但那要自己管鉴权/
 * 生命周期/重连，而投影把这套全部复用框架现成机制（含尾页携带、checkpoint、断开重连后重建）。
 *
 * 【为什么这里不用 ctx.tokenMeter.measure()】
 * 投影必须是**从 session 日志纯折叠出来的**状态：它时刻可能被从头重放（重启、重连、
 * 缓存失效），而 tokenMeter 是活的服务、读的是当时的 surface，随时调用会破坏
 * "日志是唯一真相"这条前提。所以这里只用 src/events.ts 里的纯定价函数。
 *
 * 数字会不一样吗？不会。对 `surfaceOp: 'append'` 的 tool/result，
 * token meter 的节点定价就是 `estimateMessage(message)`——与这里逐字同一个函数。
 * 差别只出现在 image/file 附件被路由定价替换的场景，那种情况下这里得到的是启发式估值。
 * 所以 UI 上统一带 `≈`，并把口径写成"注入量"。
 *
 * 【为什么 pending 也要放进 state】
 * 重放时 apply 会从 turn/start 一路重跑到 turn/end，中途状态必须能完整重建。
 * 把"已发调用未配对结果"的清单塞进 state，重放结果与实时结果才严格一致。
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import {
  estimateToolCallBlockTokens,
  estimateToolResultMessageTokens,
  isErrorResult,
  readResultCallId,
  readToolCall,
  readToolResult,
  readTurn,
} from './events.js'
import type { Config } from './types.js'
import {
  TOOL_COST_HINT_PROJECTION_KEY,
  TOOL_COST_HINT_VIEW_VERSION,
  type ToolCostHintView,
  type ToolCostRowView,
  type TurnCostView,
} from './contract.js'

/** 未配对结果的合成桶名，与 host 面监听路径保持一致。 */
const ORPHAN_TOOL_NAME = '(unattributed)'

/** 投影里一行的累加器（不含 injectedTokens，读的时候才算）。 */
interface WireToolState {
  name: string
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
}

/** 已发未配对的调用。 */
interface WirePendingState {
  callId: string
  tool: string
}

/** 一轮的累加器。 */
interface WireTurnState {
  turn: number
  ended: boolean
  tools: WireToolState[]
  pending: WirePendingState[]
  unattributedCalls: number
  orphanResults: number
}

/**
 * 投影 state 的形状。
 *
 * 【为什么导出】fold / toView 也导出（便于脱离 Cordis 上下文做单测：喂一串假事件就能
 * 断言口径），而声明文件不允许导出函数引用私有类型名。
 */
export interface WireState {
  turns: WireTurnState[]
}

/* ------------------------------------------------------------------ *
 * schema
 *
 * 【为什么用 zod 而不是 schemastery】
 * 投影注册表对 stateSchema / viewSchema 只要求有 `.parse()`，且会对每次读做校验；
 * 上游 dsh-token-meter 的投影正是用 zod。Config 仍然用 schemastery（那是 Cordis 的
 * 插件配置约定），两者分工不冲突：配置是"用户写的"，投影是"日志折叠出来的"。
 * ------------------------------------------------------------------ */

const toolStateSchema = z.object({
  name: z.string(),
  calls: z.number(),
  errors: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
})

const pendingStateSchema = z.object({
  callId: z.string(),
  tool: z.string(),
})

const turnStateSchema = z.object({
  turn: z.number(),
  ended: z.boolean(),
  tools: z.array(toolStateSchema),
  pending: z.array(pendingStateSchema),
  unattributedCalls: z.number(),
  orphanResults: z.number(),
})

const wireStateSchema = z.object({
  turns: z.array(turnStateSchema),
})

const rowViewSchema = z.object({
  name: z.string(),
  calls: z.number(),
  errors: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  injectedTokens: z.number(),
})

const turnViewSchema = z.object({
  turn: z.number(),
  ended: z.boolean(),
  tools: z.array(rowViewSchema),
  totalCalls: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalInjectedTokens: z.number(),
  unattributedCalls: z.number(),
  orphanResults: z.number(),
})

const wireViewSchema = z.object({
  v: z.number(),
  turns: z.array(turnViewSchema),
})

/* ------------------------------------------------------------------ *
 * 纯折叠
 * ------------------------------------------------------------------ */

/** 取（或建）这一轮的累加器。返回新数组，保持纯函数语义。 */
function withTurn(state: WireState, turn: number, mutate: (draft: WireTurnState) => void, keepTurns: number): WireState {
  const index = state.turns.findIndex((entry) => entry.turn === turn)
  const source: WireTurnState = index === -1
    ? { turn, ended: false, tools: [], pending: [], unattributedCalls: 0, orphanResults: 0 }
    : state.turns[index]!

  // 深拷贝到可变副本：投影 state 可能被冻结，且重放要求 apply 不改入参。
  const draft: WireTurnState = {
    turn: source.turn,
    ended: source.ended,
    tools: source.tools.map((row) => ({ ...row })),
    pending: source.pending.map((row) => ({ ...row })),
    unattributedCalls: source.unattributedCalls,
    orphanResults: source.orphanResults,
  }
  mutate(draft)

  const turns = state.turns.slice()
  if (index === -1) turns.push(draft)
  else turns[index] = draft

  // 只保留最近 keepTurns 轮：state 大小有界，重放代价也就有界。
  const trimmed = turns.length > keepTurns ? turns.slice(turns.length - keepTurns) : turns
  return { turns: trimmed }
}

/** 取（或建）某工具的累加行。 */
function toolSlot(draft: WireTurnState, name: string): WireToolState {
  let row = draft.tools.find((entry) => entry.name === name)
  if (row === undefined) {
    row = { name, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0 }
    draft.tools.push(row)
  }
  return row
}

/**
 * 折叠一个事件。
 *
 * 【必须做到的两件事】
 * 1. 与自己无关的事件**返回同一个 state 引用**——注册表用 Object.is 做闸门，
 *    返回新对象会让下游每个事件都被重新广播一次。
 * 2. 有变化时必须返回新对象，不能原地改（注册表按不可变快照做比较）。
 */
export function fold(state: WireState, event: { type: string; data: unknown }, keepTurns: number): WireState {
  if (event.type === 'tool/call') {
    const call = readToolCall(event.data)
    if (call === undefined) return state
    return withTurn(state, call.turn, (draft) => {
      const row = toolSlot(draft, call.name)
      row.calls += 1
      row.inputTokens += estimateToolCallBlockTokens(call.name, call.arguments)
      draft.pending.push({ callId: call.callId, tool: call.name })
    }, keepTurns)
  }

  if (event.type === 'tool/result') {
    const result = readToolResult(event.data)
    if (result === undefined) return state
    return withTurn(state, result.turn, (draft) => {
      const callId = readResultCallId(result)
      const index = callId === undefined ? -1 : draft.pending.findIndex((entry) => entry.callId === callId)
      let name: string
      if (index === -1) {
        // 没配对到调用：插件中途加载、或框架补写的恢复结果。
        // 结果确实进了上下文，所以照样计入，归到合成桶以免污染真实工具均值。
        name = ORPHAN_TOOL_NAME
        draft.orphanResults += 1
      } else {
        name = draft.pending[index]!.tool
        draft.pending.splice(index, 1)
      }
      const row = toolSlot(draft, name)
      // 合成桶的 calls 只在"结果对不上调用"时递增，calls 与 results 才配平。
      if (index === -1) row.calls += 1
      if (isErrorResult(result)) row.errors += 1
      row.outputTokens += estimateToolResultMessageTokens(result.message)
    }, keepTurns)
  }

  if (event.type === 'turn/end') {
    const turn = readTurn(event.data)
    if (turn === undefined) return state
    const known = state.turns.some((entry) => entry.turn === turn)
    // 整轮没有工具事件：不建条目，避免给纯对话轮次留空壳。
    if (!known) return state
    return withTurn(state, turn, (draft) => {
      draft.ended = true
      // 走到 turn/end 还没配对的调用，就是"发了没回"的，一次性结清。
      draft.unattributedCalls += draft.pending.length
      draft.pending = []
    }, keepTurns)
  }

  return state
}

/** 把 state 投影成 client 视图：算注入量、排序、结出总计。 */
export function toView(state: WireState): ToolCostHintView {
  const turns: TurnCostView[] = state.turns.map((entry) => {
    const tools: ToolCostRowView[] = entry.tools
      .map((row) => ({ ...row, injectedTokens: row.inputTokens + row.outputTokens }))
      .sort((left, right) =>
        right.injectedTokens - left.injectedTokens
        || right.calls - left.calls
        || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

    let totalCalls = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    for (const row of tools) {
      totalCalls += row.calls
      totalInputTokens += row.inputTokens
      totalOutputTokens += row.outputTokens
    }

    return {
      turn: entry.turn,
      ended: entry.ended,
      tools,
      totalCalls,
      totalInputTokens,
      totalOutputTokens,
      totalInjectedTokens: totalInputTokens + totalOutputTokens,
      // 未结清的在途调用也算进总数，否则"次数"会在中途显得偏少。
      unattributedCalls: entry.unattributedCalls + entry.pending.length,
      orphanResults: entry.orphanResults,
    }
  })

  // 轮次升序：client 按 turn 精确定位，顺序只影响可读性。
  turns.sort((left, right) => left.turn - right.turn)
  return { v: TOOL_COST_HINT_VIEW_VERSION, turns }
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

/** 投影注册表的最小面（避免 import app.asar 内的包）。 */
interface SessionProjectionsLike {
  register(definition: unknown): () => void
}

/** 注册 wire 投影。服务不在就安静跳过，绝不因为"看不到 UI 数据"而阻断会话。 */
export function registerWireProjection(ctx: Context, config: Config): void {
  // 同 index.ts 的理由：Services 的类型增强在 app.asar 内的包里，插件侧解析不到，
  // 所以这里用一次收窄断言取服务，避免把整个 Services 类型绑进来。
  const projections = (ctx as unknown as { get(name: string): unknown }).get('sessionProjections') as
    | SessionProjectionsLike
    | undefined
  if (projections === undefined) {
    // 不是致命错误：没有投影服务时，host 面监听路径照常工作，只是 UI 拿不到数据。
    process.stderr.write('[tool-cost-hint] sessionProjections is unavailable; client channel stays off\n')
    return
  }

  const keepTurns = Math.max(1, Math.trunc(config.keepTurns))

  // 注册即 effect：插件卸载时投影随之撤销，client 尾页不再携带这个 key。
  ctx.effect(
    () => projections.register({
      key: TOOL_COST_HINT_PROJECTION_KEY,
      stateVersion: 1,
      stateSchema: wireStateSchema,
      // 不从 header 取任何东西：本投影只关心 tool/call 与 tool/result。
      init: (): WireState => ({ turns: [] }),
      apply: (state: WireState, event: { type: string; data: unknown }) => fold(state, event, keepTurns),
      wire: {
        viewSchema: wireViewSchema,
        view: (state: WireState) => toView(state),
      },
    }),
    'tool-cost-hint: wire projection',
  )
}
