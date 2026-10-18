/**
 * session/event 的读取、校验与 token 定价。
 *
 * 【设计约束】这个文件里全是纯函数，不出现 ctx、不出现任何 IO。
 * 原因有两个：
 *   1. 可单测：给一个假 event 就能验证计数与定价，不需要起一个 Cordis 上下文；
 *   2. 可兜底：index.ts 的监听回调只需要一个 try/catch 包住"取数据 + 算数"这一段，
 *      异常绝不会冒泡回 session.append 的调用栈（那是 agent loop 的主路径）。
 *
 * 【payload 的事实来源】不是猜的，是照 dsh-agent-loop 的 appendToolCall / appendToolResult
 * 逐字段抄下来的：
 *
 *   tool/call  data = { turn, step, callId, name, arguments }
 *     - arguments 是**原始 JSON 文本字符串**（不是对象），空调用时可能是 undefined。
 *
 *   tool/result data = { turn, step, message, error?, meta? }
 *     - message 是一条 role: 'tool' 的消息，toolCallId 与 source.callId 都指向配对的 callId；
 *     - error.info 存在时才带 error 字段，形如 { name, code, message? }；
 *     - 失败/中断时由 ToolCallRecovery 补写合成结果，code 为 TOOL_OUTCOME_UNKNOWN
 *       或 TOOL_NOT_STARTED（此时可能没有对应的真实调用）。
 *
 * 任何字段都可能因为版本演进缺席，所以下面所有读取都做 typeof 校验、拿不到就返回
 * undefined / 0，绝不 throw。
 */

import type { TokenSource } from './types.js'

/** tool/call 事件的 data。 */
export interface ToolCallData {
  turn: number
  step: number
  /** assistant 生成的调用 id，tool/result 靠它配对。 */
  callId: string
  /** 工具名，也就是统计的分组键。 */
  name: string
  /** 原始 JSON 文本；可能为空串或缺失。 */
  arguments: string
}

/** tool/result 消息里我们关心的字段（其余字段不读、也不缓存）。 */
export interface ToolResultMessage {
  isError?: boolean
  toolCallId?: string
  source?: { kind?: string; callId?: string }
  content?: unknown
}

/** tool/result 事件的 data。 */
export interface ToolResultData {
  turn: number
  step: number
  message: ToolResultMessage
  error?: { name?: string; code?: string; message?: string }
}

/**
 * 事件信封里我们会用到的部分。
 *
 * 【为什么不用 @deepseek-ai/dsh-session 的 SessionEvent 类型】
 * 那样会把整个 envelope 的类型（surfaceOp / sourceEventSeqs / ignorable ...）绑进来，
 * 而这些字段我们一个都不读。这里只要 type / seq / data 三个，剩下的用 unknown 接，
 * 既不会因为上游加字段而编译失败，也不会误用没验证过的字段。
 */
export interface SessionEventLike {
  type: string
  seq: number
  data: unknown
}

/** session 对象里我们会用到的部分（session.id 是 Session 的原生 getter）。 */
export interface SessionLike {
  id: string
}

/**
 * tokenMeter 服务的最小面。
 *
 * 【为什么不 import @deepseek-ai/dsh-token-meter】
 * 插件是从 profile 的 node_modules 里加载的，而 @deepseek-ai/* 这些包躺在 DSH 的
 * app.asar 内部，从 profile 目录向上查找根本解析不到 —— 真去 import 会让插件加载失败。
 * 所以运行时一律走 `ctx.get('tokenMeter')` 拿服务实例（服务缺失时插件照样能跑，
 * 只是 outputTokens 退回估算值）。这也是为什么 inject 里不写 tokenMeter：
 * 写了就变成硬依赖，在没装 meter 的 profile 里插件会直接 INACTIVE。
 *
 * 只声明 measure 一个方法：它是 O(surface) 的整表快照，正好一轮取一次。
 * 注意 measure 内部对 malformed 事件会 throw，调用点必须 try/catch。
 */
export interface TokenMeterLike {
  measure(session: unknown): {
    nodes?: ReadonlyArray<{ seq: number; tokens?: number; heuristicTokens?: number }>
  } | undefined
}

/* ------------------------------------------------------------------ *
 * 事件读取
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 读出一个数字型 turn 号；拿不到就 undefined。 */
export function readTurn(data: unknown): number | undefined {
  if (!isRecord(data)) return undefined
  const turn = data['turn']
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
}

/** 校验 tool/call 的 data。 */
export function readToolCall(data: unknown): ToolCallData | undefined {
  if (!isRecord(data)) return undefined
  const turn = data['turn']
  const step = data['step']
  const callId = data['callId']
  const name = data['name']
  if (typeof turn !== 'number' || typeof name !== 'string' || name === '') return undefined
  if (typeof callId !== 'string') return undefined
  return {
    turn,
    step: typeof step === 'number' ? step : -1,
    callId,
    name,
    // arguments 是原始 JSON 文本；空调用时可能是 undefined，统一归一成空串，
    // 避免下游每个使用点都要处理 undefined。
    arguments: typeof data['arguments'] === 'string' ? data['arguments'] : '',
  }
}

/** 校验 tool/result 的 data。 */
export function readToolResult(data: unknown): ToolResultData | undefined {
  if (!isRecord(data)) return undefined
  const turn = data['turn']
  const step = data['step']
  const message = data['message']
  if (typeof turn !== 'number' || !isRecord(message)) return undefined
  const rawError = data['error']
  const result: ToolResultData = {
    turn,
    step: typeof step === 'number' ? step : -1,
    message: message as ToolResultMessage,
  }
  if (isRecord(rawError)) {
    result.error = {
      name: typeof rawError['name'] === 'string' ? rawError['name'] : undefined,
      code: typeof rawError['code'] === 'string' ? rawError['code'] : undefined,
      message: typeof rawError['message'] === 'string' ? rawError['message'] : undefined,
    }
  }
  return result
}

/**
 * 从 tool/result 里取出配对的 callId。
 *
 * 【为什么要两个来源】正常路径上 message.toolCallId 与 message.source.callId 都指向
 * 同一个调用；但合成结果（ToolCallRecovery 补写的失败结果）以及格式演进时，
 * 不一定两者都在。所以按"先 source.callId、后 toolCallId"的顺序取，任一命中即可。
 */
export function readResultCallId(data: ToolResultData): string | undefined {
  const fromSource = data.message.source?.callId
  if (typeof fromSource === 'string' && fromSource !== '') return fromSource
  const fromMessage = data.message.toolCallId
  if (typeof fromMessage === 'string' && fromMessage !== '') return fromMessage
  return undefined
}

/** 结果是否算一次错误。 */
export function isErrorResult(data: ToolResultData): boolean {
  if (data.message.isError === true) return true
  // 合成结果一定带 error 字段；真实失败结果 message.isError 也会是 true。
  return data.error !== undefined
}

/* ------------------------------------------------------------------ *
 * token 定价（与 @deepseek-ai/dsh-token-meter/estimate 逐字一致）
 * ------------------------------------------------------------------ */

/**
 * 这三个常量必须与 token meter 的 estimate.js 保持一致：
 *   CHARS_PER_TOKEN = 4   每 4 个字符约 1 token
 *   BLOCK_OVERHEAD  = 4   每个内容块的结构开销
 *   ROLE_OVERHEAD   = 4   每条消息的角色开销
 * 改之前先去核对上游；上游若变更，这两个数字要跟着变，并递增 ATTRIBUTION_VERSION。
 */
export const CHARS_PER_TOKEN = 4
export const BLOCK_OVERHEAD = 4
export const ROLE_OVERHEAD = 4

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 一个 tool-call 块的 token 量。
 *
 * 与上游 estimate.js 的 tool-call 分支逐字一致：
 *   ceil(name.length / 4) + ceil(arguments.length / 4) + BLOCK_OVERHEAD
 * 注意上游**不计 block.id**，所以这里也不计 —— 计了就会与 meter 的数字对不上。
 */
export function estimateToolCallBlockTokens(name: string, argsJson: string): number {
  return textTokens(name) + textTokens(argsJson) + BLOCK_OVERHEAD
}

/**
 * 一组内容块的 token 量（对应上游 estimateContent）。
 *
 * 只覆盖本插件会遇到的块类型：text / reasoning / tool-call。其余类型（例如图片、文件
 * 附件）在上游有专门的定价，这里不做猜测定价 —— 统一按"一个块的结构开销"计，
 * 并让 outputTokensSource 落到 'estimate'，提醒消费方这是保守估算。
 * 实际运行时 desktop profile 一定有 tokenMeter，走不到这条回退路径。
 */
export function estimateContentTokens(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0
  let total = 0
  for (const block of blocks) {
    if (!isRecord(block)) {
      total += BLOCK_OVERHEAD
      continue
    }
    const type = typeof block['type'] === 'string' ? block['type'] : ''
    switch (type) {
      case 'text':
      case 'reasoning': {
        const text = typeof block['text'] === 'string' ? block['text'] : ''
        total += textTokens(text) + BLOCK_OVERHEAD
        break
      }
      case 'tool-call': {
        const name = typeof block['name'] === 'string' ? block['name'] : ''
        const args = typeof block['arguments'] === 'string' ? block['arguments'] : ''
        total += estimateToolCallBlockTokens(name, args)
        break
      }
      default:
        total += BLOCK_OVERHEAD
        break
    }
  }
  return total
}

/**
 * 一条 tool 结果消息的 token 量（对应上游 estimateMessage 的非 system 分支）。
 *
 * tool 结果消息在下一轮请求里是一条 role: 'tool' 的消息，所以除了内容块之外还要加
 * 一次 ROLE_OVERHEAD。少加这一项就会系统性偏低。
 */
export function estimateToolResultMessageTokens(message: unknown): number {
  if (!isRecord(message)) return ROLE_OVERHEAD
  return estimateContentTokens(message['content']) + ROLE_OVERHEAD
}

/** 把来源标记收敛成一个类型，方便 index.ts 里做联合判断。 */
export type { TokenSource }
