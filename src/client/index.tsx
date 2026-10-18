/**
 * dsh-tool-cost-hint —— client 面。
 *
 * 干什么：在每轮结束时，于 assistant 消息底部操作栏那一行左侧，追加一行可折叠的
 *        「本轮工具调用次数 + 注入量」。默认折叠成一行，点开逐工具展开。
 *
 * 【数据从哪来】不订阅任何事件、不 fetch、不碰 DOM 里的业务数据。
 * 只读 host 侧注册的 session 投影 `toolCostHint`（见 ../wire.ts），通过 slot 标准 props
 * 里的 useProjection 拿值。这是 DSH 官方给第三方插件的唯一可靠 host→client 通道：
 *   - Cordis 自定义事件到不了浏览器（api-remotes 的转发白名单是构建期写死的）；
 *   - 往 session 里 append 自定义 type 会让会话无法重开（无 ignorable 标记）。
 *
 * 【挂在哪个 slot，为什么不是 assistant-actions】
 * dsh-client-ui-chat 的 TurnTailNodeView 里写得很清楚：
 *   renderSlot("conversation.chat.turnTail", { turn, seq, openFile })
 *   renderSlot("conversation.chat.assistant-actions", { messageId })  // 在 hover 才显现的图标条里
 * assistant-actions 只给 messageId，拿不到 turn，而且是横向图标条（放不下多行）；
 * turnTail 就在同一个底部行、且**直接给 turn**，正好能和 host 摘要里的 turn 对齐。
 * 所以选 turnTail。这比用 data-* 钩子去 DOM 里找位置更稳，也不需要监听 DOM 变化。
 *
 * 【为什么用 createElement 而不是 JSX 语法】
 * 本插件没有独立的 client 打包链（见 tsdown.client.config.ts），产物要能被打包器
 * 原样输出成 __ModuleLoader__ 工厂。用 h() 就不依赖任何 jsx 转换配置，
 * 无论谁打包、用什么 jsx runtime，产物形状都是可预测的。
 */

import { createElement as h, useMemo, useState, type ReactElement } from 'react'

import {
  TOOL_COST_HINT_PROJECTION_KEY,
  type ToolCostRowView,
  type ToolCostHintView,
  type TurnCostView,
} from '../contract.js'
import { TOOL_COST_HINT_CSS } from './style.js'
import type { ClientContext, CopyKey, LocaleLike, SlotsLike, Translator, TurnTailProps } from './types.js'

/** 插件标识：同时用作 css 标签的 data-plugin、slot 条目 id、locale 命名空间。 */
const PKG = 'tool-cost-hint'

/** 折叠条注入的 slot。 */
const SLOT_NAME = 'conversation.chat.turnTail'

/** slot 条目 id：在同一个 slot 内必须唯一。 */
const ENTRY_ID = PKG

/** 排序位：排在官方条目之后，不抢位、不插队。 */
const ENTRY_ORDER = 20

/** locale 命名空间。 */
const LOCALE_NS = PKG

/**
 * 折叠态最多列几个工具。
 * 【为什么设上限】一轮里读十几个文件的场景很常见，全列出来会把底部操作栏撑成
 * 一条超长文本，反而变成视觉噪音。超出的部分显示成 +N，展开后仍然全量可见。
 */
const MAX_INLINE_TOOLS = 4

/** 文案。没有 locale 服务时用 zh 这份兜底，保证任何时候都不出现裸 key。 */
const DICTIONARIES: Record<'zh' | 'en', Record<CopyKey, string>> = {
  zh: {
    injected: '注入量',
    tok: 'tok',
    calls: '次',
    input: '输入',
    output: '输出',
    title: '本轮工具调用直接注入上下文的 token 估算，不是计费金额',
  },
  en: {
    injected: 'injected',
    tok: 'tok',
    calls: 'calls',
    input: 'in',
    output: 'out',
    title: 'Estimated tokens the tools injected into the context this turn — not billing',
  },
}

const FALLBACK: Record<CopyKey, string> = DICTIONARIES.zh

/**
 * 取翻译函数。
 *
 * slot 条目的 `t` 是由 locale 服务按 `register({ locale })` 绑定的，拿不到就退回内置
 * 中文文案——宁可少一个语言支持，也不能让 UI 上出现 'tool-cost-hint.injected' 这种裸 key。
 */
function translatorOf(t: Translator | undefined): Translator {
  if (typeof t !== 'function') return (key) => FALLBACK[key] ?? key
  return (key, params) => {
    const value = t(key, params)
    // locale 未注册该 key 时，服务通常原样返回 key，这里兜住。
    return typeof value === 'string' && value.length > 0 && value !== key ? value : (FALLBACK[key] ?? key)
  }
}

/** token 数的短写法：<1000 原样，<10000 保留一位 K，再往上取整 K / M。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 10_000) return `${(value / 1000).toFixed(1)}K`
  if (value < 1_000_000) return `${Math.round(value / 1000)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * 把 turnTail slot 传进来的 `turn` 归一成轮次号。
 *
 * 【为什么需要归一 —— 真实踩过的坑】
 * `conversation.chat.turnTail` 的业务 props 里，`turn` **不是数字，而是整条轮次记录**
 * （运行时实测形状：`{ turn: 1, start, end, status, steps }`，见 CDP 抓到的 props）。
 * 最初实现按数字写了 `typeof turn === 'number'` 的校验，于是每次渲染都判定"没有轮次号"
 * 而直接 `return null`——表现就是"插件装了、样式注入了、组件也渲染了，但屏幕上什么都没有"。
 * 所以这里同时接受三种形态：数字、轮次记录（取 `.turn`）、以及 `{ turn: number }` 包装。
 */
function normalizeTurn(turn: unknown): number | undefined {
  const value = typeof turn === 'number'
    ? turn
    : (turn !== null && typeof turn === 'object' ? (turn as { turn?: unknown }).turn : undefined)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 从投影里挑出某一轮，并做一次形状校验。
 *
 * 【为什么要校验】投影值跨版本时字段可能缺失（host 侧升了 stateVersion 而 client 没跟上、
 * 或者另一个同名 key 被占用）。任何不符合预期的形状都当成"没有数据"，返回 undefined，
 * 让组件整体不渲染——**这比渲染出半截或 0 值要好**，也符合"探测不到就完全惰性"。
 */
function pickTurn(view: unknown, turn: unknown): TurnCostView | undefined {
  const turnNumber = normalizeTurn(turn)
  if (turnNumber === undefined) return undefined
  if (view === null || typeof view !== 'object') return undefined
  const turns = (view as ToolCostHintView).turns
  if (!Array.isArray(turns)) return undefined
  const hit = turns.find((entry) => entry !== null && typeof entry === 'object' && entry.turn === turnNumber)
  if (hit === undefined || !Array.isArray(hit.tools)) return undefined
  return hit
}

/** 折叠态的工具列表文案，超限折叠成 +N。 */
function inlineTools(tools: ToolCostRowView[]): string {
  const shown = tools.slice(0, MAX_INLINE_TOOLS).map((row) => `${row.name} ×${row.calls}`)
  const rest = tools.length - shown.length
  if (rest > 0) shown.push(`+${rest}`)
  return shown.join(' · ')
}

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

function TurnToolCostHint(props: TurnTailProps): ReactElement | null {
  const { turn, useProjection, t } = props
  const tr = translatorOf(t)
  const [expanded, setExpanded] = useState(false)

  /**
   * 【为什么只按 key 取整表、不传 selector】
   * selector 重载的返回值身份语义在各版本里不完全一样，用它做派生会让"每次事件都重算"
   * 与"缓存"之间的行为变得不可预测。这里取整表后在 useMemo 里按 turn 挑，
   * 行为等价、且对投影版本演进更宽容。每轮一个迷你组件，重算成本可以忽略。
   *
   * 【关于 hook 顺序】
   * useProjection 本身是个 hook，但它是 slot 条目注入的标准 props，同一条目在整个生命周期
   * 里身份稳定，所以这个三元的走向是恒定的，不会出现"上次走了 hook、这次没走"的错位。
   * 万一某个版本真没提供它，这个条目从一开始就是 undefined，也就恒走一遍空分支。
   */
  const raw = typeof useProjection === 'function'
    ? (useProjection as unknown as (key: string) => unknown)(TOOL_COST_HINT_PROJECTION_KEY)
    : undefined

  const cost = useMemo(() => pickTurn(raw, turn), [raw, turn])

  // 没有这一轮的数据（纯对话轮次 / 插件刚加载 / host 没注册投影）→ 什么都不渲染。
  if (cost === undefined || cost.tools.length === 0) return null

  const totalInjected = cost.totalInjectedTokens

  /**
   * 折叠态那一行。
   *
   * 【为什么口径写"注入量 / injected"而不是"花费"】
   * 这些数字是"工具调用往上下文里塞了多少 token"的估算，与计费无关（缓存命中、
   * 路由定价、供应商差异全都不在口径内）。措辞一旦变成"花费"就会误导用户去和账单对账。
   */
  const toggle = h(
    'button',
    {
      type: 'button',
      className: 'dsh-tch-toggle',
      'aria-expanded': expanded,
      title: tr('title'),
      onClick: () => setExpanded((value) => !value),
    },
    h('span', { className: 'dsh-tch-caret', 'data-open': expanded, 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
    h('span', { className: 'dsh-tch-label' }, `🛠 ${inlineTools(cost.tools)} · ≈${formatTokens(totalInjected)} ${tr('tok')}`),
  )

  if (!expanded) return h('div', { className: 'dsh-tch-root' }, toggle)

  const rows = cost.tools.map((row) =>
    h(
      'div',
      { className: row.errors > 0 ? 'dsh-tch-row dsh-tch-row-error' : 'dsh-tch-row', key: row.name },
      h('span', { className: 'dsh-tch-name', title: row.name }, row.name),
      h('span', { className: 'dsh-tch-num' }, row.errors > 0 ? `×${row.calls} !${row.errors}` : `×${row.calls}`),
      h('span', { className: 'dsh-tch-num' }, `${tr('input')} ${formatTokens(row.inputTokens)}`),
      h('span', { className: 'dsh-tch-num' }, `${tr('output')} ${formatTokens(row.outputTokens)}`),
    ))

  const total = h(
    'div',
    { className: 'dsh-tch-total' },
    h('span', null, tr('injected')),
    h('span', null, `≈${formatTokens(totalInjected)} ${tr('tok')}`),
  )

  return h(
    'div',
    { className: 'dsh-tch-root' },
    toggle,
    h('div', { className: 'dsh-tch-rows' }, ...rows, total),
  )
}

/* ------------------------------------------------------------------ *
 * 样式注入
 * ------------------------------------------------------------------ */

/**
 * 注入 <style>。
 *
 * 【为什么要判断是否已存在】client 模块可能被重新物化（HMR、断线重连后重建启动图），
 * 官方 bundle 全部用 `data-plugin-css` 标记去重，这里照做。
 * 【为什么清理函数只移除自己创建的那个标签】别人的标签不归我们管，误删会连带弄丢
 * 同一插件另一份实例的样式。
 */
function installStyles(ctx: ClientContext): void {
  ctx.effect(() => {
    if (typeof document === 'undefined' || document.head === null) return
    const tagId = `${PKG}/style`
    if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return

    const tag = document.createElement('style')
    tag.dataset.plugin = PKG
    tag.dataset.pluginCss = tagId
    tag.textContent = TOOL_COST_HINT_CSS
    document.head.appendChild(tag)

    // 卸载即摘除：样式是本插件唯一自己持有的 DOM 资源。
    return () => { tag.remove() }
  }, 'tool-cost-hint: styles')
}

/* ------------------------------------------------------------------ *
 * 插件导出
 * ------------------------------------------------------------------ */

/**
 * 【为什么 slots 是硬依赖、locale 不是】
 * slots 是挂载点本身，缺了它插件毫无意义，写进 inject 让 Cordis 保证 apply 时已就绪；
 * locale 只影响文案语言，用 ctx.get() 判空即可（写进 inject 会变成硬依赖，
 * 在精简 profile 里会让整个插件 INACTIVE，连 UI 都不出现）。
 */
export const inject: string[] = ['slots']

export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots') as SlotsLike | undefined

  // 【惰性降级 1】slots 服务不在：直接放弃，不产生任何副作用。
  if (slots === undefined || typeof slots.inject !== 'function') {
    warn('slots service is unavailable; client UI stays off')
    return
  }

  installStyles(ctx)

  // 有 locale 就注册词典并让条目 t 绑定到本命名空间；没有就不用 locale 选项，走内置中文。
  let useLocale = false
  const locale = ctx.get('locale') as LocaleLike | undefined
  if (locale !== undefined && typeof locale.register === 'function') {
    try {
      ctx.effect(() => {
        locale.register(LOCALE_NS, DICTIONARIES as unknown as Record<string, Record<string, string>>)
      }, 'tool-cost-hint: locale')
      useLocale = true
    } catch (error) {
      warn(`locale registration failed: ${describe(error)}`)
    }
  }

  const options: Record<string, unknown> = {
    name: SLOT_NAME,
    id: ENTRY_ID,
    order: ENTRY_ORDER,
  }
  if (useLocale) options.locale = LOCALE_NS

  /**
   * 【惰性降级 2：slot 不存在】
   * `slots.inject(name, factory)` 是**延迟**注册：目标 slot 被声明时才执行工厂，
   * 永远不被声明就永远不执行。所以即使某个 DSH 版本改了这个 slot 的名字，
   * 这里也只是安静地不挂载，不会抛错、不会阻断其它插件。
   *
   * 【为什么不用 ctx.effect 包一层】
   * slot 注册本身就是 context-owned 的：条目 disposer 挂在当前 fiber 上，插件卸载时
   * 框架会自动摘除（并递归清理它声明的子 slot）。ctx.effect 在这里再包一层只会造成
   * 二次 dispose。真正需要声明式清理的只有上面那个 <style> 标签。
   */
  try {
    slots.inject(SLOT_NAME, () => slots.register(options, TurnToolCostHint))
  } catch (error) {
    warn(`slot registration failed: ${describe(error)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 诊断
 * ------------------------------------------------------------------ */

/** 只打一行、绝不抛。client 侧的异常会直接白屏一面，所以全部 catch 住降级。 */
function warn(message: string): void {
  try {
    // eslint-disable-next-line no-console
    console.warn(`[${PKG}] ${message}`)
  } catch {
    // 连 console 都没有的极端环境：什么都不做。
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
