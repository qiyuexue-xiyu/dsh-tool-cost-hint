/**
 * 独立计算"期望值"：只用官方 @deepseek-ai/dsh-token-meter/estimate，
 * 不碰插件自己的实现，这样断言才有意义（不是自己和自己对答案）。
 *
 * 官方没有单独的 "tool-call 块定价" 导出，但 tool-call 块就是 content 块的一种，
 * estimateContent([toolCallBlock]) 的结果就等于 ceil(name/4) + ceil(arguments/4) + BLOCK_OVERHEAD。
 */
export {
  ROLE_OVERHEAD,
  estimateContent,
  estimateMessage,
  estimateStructuralBlock,
  estimateSystemMessage,
  estimateToolsTokens,
} from '@deepseek-ai/dsh-token-meter/estimate'

import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'

export function estimateToolCallBlockTokens(name, argsJson) {
  return estimateContent([{ type: 'tool-call', id: 'x', name, arguments: argsJson }])
}
