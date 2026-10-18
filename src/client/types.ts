/**
 * client 侧类型定义。
 *
 * 这里只描述**我们真正用到的那一小块**运行时契约，而不是去 import
 * @deepseek-ai/dsh-client-ui-slots 等 Harness Client 包的完整类型：
 *   1. 官方明文禁止第三方 client bundle 依赖 Harness Client 包（打包时会被当成外部模块，
 *      运行时 require 可能拿到 undefined）；
 *   2. 这些包的类型在 npm 上没有稳定发布面，绑死它们会让插件在下个小版本就编译不过。
 * 所以下面全部是"结构类型"，字段多了少了都不会炸；用不到的一律 optional。
 */

/** 可见文案的键。 */
export type CopyKey = 'injected' | 'tok' | 'calls' | 'input' | 'output' | 'title'

/** slot 注入的翻译函数（由 locale 服务按条目 locale 绑定）。 */
export type Translator = (key: CopyKey, params?: Record<string, string | number>) => string

/**
 * 投影读取 hook。
 *
 * 这是 DSH 给出的**官方 host→client 数据通道**：session 作用域的 list slot 条目
 * 会从标准 props 里拿到 useProjection，按 host 侧注册的投影 key 读值。
 * 带 selector 的重载用于"只关心某一轮"，避免每轮都重渲染。
 */
export type UseProjection = (<T>(key: string) => T | undefined) & (<T, R>(
  key: string,
  select: (value: T | undefined) => R,
) => R)

/**
 * `conversation.chat.turnTail` 条目的 props。
 *
 * 【字段来源，不是猜的】
 * dsh-client-ui-chat 的 TurnTailNodeView 里明确写：
 *   renderSlot("conversation.chat.turnTail", { turn, seq, openFile })
 * 除这三个之外，session 作用域的 slot 条目还会拿到标准工具包（useProjection / t / locale 等）。
 * 全部标 optional：任何一个缺失都走惰性降级，绝不抛错拖垮整个 turn-tail 节点。
 */
export interface TurnTailProps {
  /**
   * 本轮轮次。
   *
   * 【重要：这里的 `turn` 不是数字】
   * 官方源码写的是 `renderSlot("conversation.chat.turnTail", { turn, seq, openFile })`，
   * 其中 `turn` 来自 `node.location.turn`，是 UI 侧的**整条轮次记录**
   * （CDP 实测到的形状：`{ turn: 1, start, end, status, steps }`）。
   * 早先把它声明成 `number` 并按数字校验，导致每一轮都判定"拿不到轮次号"而整块不渲染——
   * 这正是"插件已加载、样式已注入，但界面上什么都没有"的根因。
   * 故声明为联合类型，统一由 `normalizeTurn()` 取出轮次号。
   */
  turn?: number | { turn?: number }
  /** turn-tail 节点的末个事件 seq。当前未使用，保留字段。 */
  seq?: number
  /** 打开文件（官方原样透传，本插件不消费）。 */
  openFile?: (path: string) => void
  useProjection?: UseProjection
  t?: Translator
  locale?: string
}

/** slots 服务的最小面（只声明我们会调的两个方法）。 */
export interface SlotsLike {
  /** 等到目标 slot 被声明后再执行注册工厂；slot 永不存在则永不执行（天然惰性）。 */
  inject(name: string, factory: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

/** locale 服务的最小面。 */
export interface LocaleLike {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): (() => void) | void
}

/**
 * client 插件上下文的最小面。
 *
 * 同样刻意不写全：真实上下文是 Cordis Context 的 Proxy，服务都以 `ctx.<name>` 形式存在，
 * 但本插件只通过 ctx.get() 取服务、只用 effect 做清理，绑死完整类型只会带来升级噪音。
 */
export interface ClientContext {
  /** 取服务；缺失返回 undefined，不抛。 */
  get(name: string): unknown
  /** 注册随插件卸载自动执行的清理逻辑。 */
  effect(execute: () => void | (() => void), label?: string): unknown
}
