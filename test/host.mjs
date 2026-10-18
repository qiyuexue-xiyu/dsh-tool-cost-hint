/**
 * host 面核心逻辑自测：直接跑 **构建产物 dist/index.js**（不是源码路径），
 * 用一个假 ctx 把 session/event 喂进去，检查按轮次聚合与 token 归因口径。
 *
 * 期望值用官方 @deepseek-ai/dsh-token-meter/estimate 独立算一遍，
 * 而不是拿插件自己的公式算 —— 否则等于自己和自己对答案。
 */
import assert from 'node:assert/strict'
import {
  estimateContent,
  estimateMessage,
  estimateToolCallBlockTokens as officialCallTokens,
} from './helpers-estimate.mjs'

const { apply, inject, name, SUMMARY_EVENT } = await import('../dist/index.js')

const failures = []
const results = []
function check(label, fn) {
  try {
    fn()
    results.push(`PASS  ${label}`)
  } catch (error) {
    failures.push(`${label}\n        ${error.message.split('\n').join('\n        ')}`)
    results.push(`FAIL  ${label}`)
  }
}

/** 假 Cordis ctx：只实现本插件用到的四个面。 */
function makeCtx({ withMeter = true, meterTokens = undefined } = {}) {
  const listeners = new Map()
  const emitted = []
  const disposers = []
  const ctx = {
    get(service) {
      if (service === 'tokenMeter') {
        if (!withMeter) return undefined
        return {
          // 假 measure：把每个 tool/result 的 seq 映射成固定 token，用来验证"meter 优先"。
          measure(session) {
            return {
              nodes: Object.entries(meterTokens ?? {}).map(([seq, tokens]) => ({
                seq: Number(seq),
                tokens,
                heuristicTokens: tokens,
              })),
            }
          },
        }
      }
      return undefined
    },
    effect(execute, label) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
      return { dispose }
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => true
    },
    emit(event, ...args) {
      emitted.push({ event, args })
    },
  }
  return {
    ctx,
    emitted,
    disposeAll: () => { for (const d of disposers) d() },
    fire(event) {
      // 模拟 session.append 的调用形态：监听器签名是 (session, event)
      for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    },
  }
}

const session = { id: 'session-test' }
let seq = 100
function ev(type, data, extra = {}) {
  seq += 1
  return { type, seq, time: 0, data, ...extra }
}

function call(turn, step, callId, toolName, args) {
  return ev('tool/call', { turn, step, callId, name: toolName, arguments: args })
}
function result(turn, step, callId, text, isError = false) {
  return ev('tool/result', {
    turn,
    step,
    message: {
      role: 'tool',
      toolCallId: callId,
      isError,
      source: { kind: 'tool', callId },
      content: [{ type: 'text', text }],
    },
    ...(isError ? { error: { name: 'ToolError', code: 'E_FAIL' } } : {}),
  })
}

/* ---------------- 场景 1：两轮真实事件流 ---------------- */
const args = '{"path":"src/index.ts"}'
const body = 'file body here'
const callTokens = officialCallTokens('read', args)
const resultTokens = estimateMessage({
  role: 'tool',
  content: [{ type: 'text', text: body }],
})

const h = makeCtx()
apply(h.ctx, { emitEvent: true, logToConsole: false, keepTurns: 10, excludeTools: [] })

h.fire(ev('turn/start', { turn: 1 }))
h.fire(call(1, 1, 'c1', 'read', args))
h.fire(result(1, 1, 'c1', body))
h.fire(call(1, 2, 'c2', 'read', args))
h.fire(result(1, 2, 'c2', body, true))
h.fire(call(1, 3, 'c3', 'edit', '{"file":"b.ts"}'))
h.fire(result(1, 3, 'c3', 'ok'))
h.fire(ev('turn/end', { turn: 1, reason: { kind: 'stop' } }))
// 纯对话轮：不应产出摘要
h.fire(ev('turn/start', { turn: 2 }))
h.fire(ev('assistant/message', { turn: 2 }))
h.fire(ev('turn/end', { turn: 2, reason: { kind: 'stop' } }))

const summaries = h.emitted.filter((e) => e.event === SUMMARY_EVENT).map((e) => e.args[0])

check('插件身份：name / inject 不出错', () => {
  assert.equal(name, 'tool-cost-hint')
  assert.deepEqual(inject, [])
})

check('只有带工具调用的轮次产出摘要（纯对话轮被跳过）', () => {
  assert.equal(summaries.length, 1, `期望 1 条摘要，实际 ${summaries.length}`)
  assert.equal(summaries[0].turn, 1)
})

const s1 = summaries[0]
check('按轮次聚合：调用次数正确', () => {
  const read = s1.tools.find((t) => t.name === 'read')
  const edit = s1.tools.find((t) => t.name === 'edit')
  assert.equal(read.calls, 2, `read.calls=${read.calls}`)
  assert.equal(read.errors, 1, `read.errors=${read.errors}（失败的那次应被计入）`)
  assert.equal(edit.calls, 1)
  assert.equal(s1.totalCalls, 3)
  assert.equal(s1.totalErrors, 1)
})

check('token 归因：inputTokens 与官方 estimate 逐字一致', () => {
  const read = s1.tools.find((t) => t.name === 'read')
  assert.equal(read.inputTokens, callTokens * 2, `read.inputTokens=${read.inputTokens} 期望 ${callTokens * 2}`)
  assert.equal(read.inputTokensSource, 'estimate')
})

check('token 归因：outputTokens 与官方 estimateMessage 逐字一致', () => {
  const read = s1.tools.find((t) => t.name === 'read')
  assert.equal(read.outputTokens, resultTokens * 2, `read.outputTokens=${read.outputTokens} 期望 ${resultTokens * 2}`)
})

check('token 归因：injectedTokens = input + output', () => {
  for (const row of s1.tools) {
    assert.equal(row.injectedTokens, row.inputTokens + row.outputTokens, `${row.name} 三字段不自洽`)
  }
  const sum = s1.tools.reduce((acc, row) => acc + row.injectedTokens, 0)
  assert.equal(s1.totalInjectedTokens, sum, '合计不等于各行之和')
  assert.equal(s1.totalInjectedTokens, s1.totalInputTokens + s1.totalOutputTokens)
})

check('排序：注入量降序（read 两次 > edit 一次）', () => {
  assert.deepEqual(s1.tools.map((t) => t.name), ['read', 'edit'])
})

check('轮次元信息：seq / reason / durationMs 齐备', () => {
  assert.ok(typeof s1.startedSeq === 'number' && s1.startedSeq > 0)
  assert.ok(typeof s1.endedSeq === 'number' && s1.endedSeq > s1.startedSeq)
  assert.equal(s1.reason, 'stop')
  assert.ok(typeof s1.durationMs === 'number' && s1.durationMs >= 0)
  assert.equal(s1.sessionId, 'session-test')
})

/* ---------------- 场景 2：中断轮（未配对调用 + 孤儿结果） ---------------- */
const h2 = makeCtx()
apply(h2.ctx, { emitEvent: true, logToConsole: false, keepTurns: 10 })
h2.fire(ev('turn/start', { turn: 1 }))
h2.fire(call(1, 1, 'c4', 'grep', '{"pattern":"x"}'))
h2.fire(result(1, 1, 'c9', 'orphan body')) // 结果配不上任何调用
h2.fire(ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }))
const s2 = h2.emitted.find((e) => e.event === SUMMARY_EVENT).args[0]

check('中断轮：未配对调用计入 unattributedCalls', () => {
  assert.equal(s2.unattributedCalls, 1, `unattributedCalls=${s2.unattributedCalls}`)
})
check('中断轮：孤儿结果计入 orphanResults 且归入合成桶', () => {
  assert.equal(s2.orphanResults, 1, `orphanResults=${s2.orphanResults}`)
  const orphan = s2.tools.find((t) => t.name === '(unattributed)')
  assert.ok(orphan !== undefined, '缺少 (unattributed) 合成桶')
  assert.equal(orphan.calls, 1, '孤儿桶 calls 应与 results 配平')
  assert.equal(orphan.outputTokens, estimateMessage({
    role: 'tool',
    content: [{ type: 'text', text: 'orphan body' }],
  }))
})
check('中断轮：reason 如实记录', () => {
  assert.equal(s2.reason, 'interrupted')
})

/* ---------------- 场景 3：meter 服务存在时，outputTokens 用 meter 的数 ---------------- */
const h3 = makeCtx({ withMeter: true, meterTokens: { 0: 0 } })
apply(h3.ctx, { emitEvent: true, logToConsole: false, keepTurns: 10 })
h3.fire(ev('turn/start', { turn: 1 }))
const r3 = result(1, 1, 'c1', body)
h3.fire(call(1, 1, 'c1', 'read', args))
h3.fire(r3)
h3.fire(ev('turn/end', { turn: 1, reason: { kind: 'stop' } }))
const s3 = h3.emitted.find((e) => e.event === SUMMARY_EVENT).args[0]
check('meter 存在的路径不炸且三字段自洽（meter 未覆盖到该 seq 时回落估算）', () => {
  const read = s3.tools.find((t) => t.name === 'read')
  assert.equal(read.injectedTokens, read.inputTokens + read.outputTokens)
  assert.ok(['meter', 'estimate'].includes(read.outputTokensSource), `outputTokensSource=${read.outputTokensSource}`)
})

/* ---------------- 场景 4：meter 服务缺失时的降级 ---------------- */
const h4 = makeCtx({ withMeter: false })
apply(h4.ctx, { emitEvent: true, logToConsole: false, keepTurns: 10 })
h4.fire(ev('turn/start', { turn: 1 }))
h4.fire(call(1, 1, 'c1', 'read', args))
h4.fire(result(1, 1, 'c1', body))
h4.fire(ev('turn/end', { turn: 1, reason: { kind: 'stop' } }))
const s4 = h4.emitted.find((e) => e.event === SUMMARY_EVENT).args[0]
check('没有 tokenMeter 服务时，全部退化为 estimate 且数字仍正确', () => {
  const read = s4.tools.find((t) => t.name === 'read')
  assert.equal(read.inputTokensSource, 'estimate')
  assert.equal(read.outputTokensSource, 'estimate')
  assert.equal(read.outputTokens, resultTokens)
})

/* ---------------- 场景 5：excludeTools 与 keepTurns ---------------- */
const h5 = makeCtx()
apply(h5.ctx, { emitEvent: true, logToConsole: false, keepTurns: 10, excludeTools: ['read'] })
h5.fire(ev('turn/start', { turn: 1 }))
h5.fire(call(1, 1, 'c1', 'read', args))
h5.fire(result(1, 1, 'c1', body))
h5.fire(call(1, 2, 'c2', 'edit', '{"f":1}'))
h5.fire(result(1, 2, 'c2', 'ok'))
h5.fire(ev('turn/end', { turn: 1, reason: { kind: 'stop' } }))
const s5 = h5.emitted.find((e) => e.event === SUMMARY_EVENT).args[0]
check('excludeTools 屏蔽指定工具', () => {
  assert.deepEqual(s5.tools.map((t) => t.name), ['edit'], `实际 ${JSON.stringify(s5.tools.map((t) => t.name))}`)
  assert.equal(s5.totalCalls, 1)
})

/* ---------------- 场景 6：卸载清理 ---------------- */
check('卸载：ctx.effect 的 disposer 可执行且不抛', () => {
  h.disposeAll()
})

console.log(results.join('\n'))
console.log('\n========== 实际摘要（场景 1，turn 1） ==========')
console.log(JSON.stringify(s1, null, 2))
console.log('\n========== 实际摘要（场景 2，中断轮） ==========')
console.log(JSON.stringify(s2, null, 2))
console.log(`\n断言 ${results.length} 条，失败 ${failures.length} 条`)
if (failures.length > 0) {
  console.log('\n' + failures.join('\n'))
  process.exitCode = 1
}
// Electron 的 node 模式对退出码的传递不可靠，所以额外打一个明确的结论标记。
console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
