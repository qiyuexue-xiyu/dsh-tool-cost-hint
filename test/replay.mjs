/**
 * 真实会话回放自测：把**磁盘上真实的 session 日志**喂给构建产物 dist/index.js。
 *
 * 为什么需要它：单元测试用的是手工构造的事件，只能证明"我自己和我自己一致"。
 * 真机不显示 UI 时，必须先排除"host 侧根本没有产出数据"这一层：
 *   1. 真实事件里 tool/call 的 arguments 是长 JSON 文本、tool/result 的 message 结构完整；
 *   2. 真实日志里有大量本插件不认识的事件类型（permission/preset、request/header 等），
 *      投影的 apply 必须原样返回同一引用，不能因为陌生事件炸掉；
 *   3. 投影的 wire.viewSchema / stateSchema 必须能 parse 真实体量的数据。
 * 这三条只要有一条不成立，浏览器端就永远读不到 toolCostHint，UI 也就永远不渲染。
 *
 * 用法：node test/replay.mjs [session.v4.jsonl.zstd 路径]
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import zlib from 'node:zlib'

/* ---------------- 1. 解压会话日志 ---------------- */
/**
 * 会话日志是**多帧拼接的 zstd**（每次 append 一帧），而 node:zlib 的
 * zstdDecompressSync 只解第一帧，直接调和会只拿到 session 头。
 * 所以按 zstd 魔数拆帧、逐帧解、再拼起来。
 */
function readSessionEvents(file) {
  const buf = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let at = buf.indexOf(magic, 0)
  while (at !== -1) {
    offsets.push(at)
    at = buf.indexOf(magic, at + 4)
  }
  const chunks = []
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(offsets[i], end)).toString('utf8'))
    } catch {
      // 尾部截断的帧忽略：日志是滚动追加的，最后一帧可能还没写完
    }
  }
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

const file = process.argv[2]
if (file === undefined || !existsSync(file)) {
  console.error('用法: node test/replay.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}
const events = readSessionEvents(file)

/* ---------------- 2. 假 ctx（含 sessionProjections） ---------------- */
function makeCtx() {
  const listeners = new Map()
  const emitted = []
  const definitions = []
  const ctx = {
    get(service) {
      if (service === 'sessionProjections') {
        return {
          register(definition) {
            definitions.push(definition)
            return () => {}
          },
        }
      }
      // 故意不提供 tokenMeter：走"回退到官方 estimate"的路径，
      // 因为浏览器端看到的投影只能靠纯折叠，必须保证这条路径本身是对的。
      return undefined
    },
    effect(execute) {
      const dispose = execute()
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
    definitions,
    replay(session, all) {
      for (const event of all) {
        for (const listener of listeners.get('session/event') ?? []) listener(session, event)
      }
    },
  }
}

/* ---------------- 3. 回放 ---------------- */
const { apply, SUMMARY_EVENT } = await import('../dist/index.js')

const h = makeCtx()
apply(h.ctx, { emitEvent: true, logToConsole: false, keepTurns: 50, excludeTools: [] })

const session = { id: 'replay' }
h.replay(session, events)

const summaries = h.emitted.filter((e) => e.event === SUMMARY_EVENT).map((e) => e.args[0])

/* ---------------- 4. 投影：纯折叠 + schema parse ---------------- */
const definition = h.definitions[0]
let state
let view
let viewParseError
if (definition !== undefined) {
  state = definition.init({ id: 'replay', createdAt: 0 }, 0)
  for (const event of events) {
    const next = definition.apply(state, event)
    // 陌生事件必须原样返回（注册表靠 Object.is 闸门跳过下游计算）
    if (next === undefined) throw new Error(`apply 返回了 undefined，事件 ${event.type} seq=${event.seq}`)
    state = next
  }
  const rawView = definition.wire.view(state)
  try {
    viewParseError = undefined
    view = definition.wire.viewSchema.parse(rawView)
  } catch (error) {
    viewParseError = error
    view = rawView
  }
}

/* ---------------- 5. 断言 ---------------- */
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

const realCalls = events.filter((e) => e.type === 'tool/call')
const realTurnsWithTools = new Set(realCalls.map((e) => e.data.turn))

console.log(`\n会话事件 ${events.length} 条，tool/call ${realCalls.length} 次，涉及 ${realTurnsWithTools.size} 轮\n`)

check('host 侧按轮次产出摘要（与真实轮数一致）', () => {
  assert.equal(summaries.length, realTurnsWithTools.size, `期望 ${realTurnsWithTools.size} 轮，实际 ${summaries.length} 轮`)
})

check('每轮摘要的调用总数与真实日志一致', () => {
  for (const summary of summaries) {
    const expected = realCalls.filter((e) => e.data.turn === summary.turn).length
    assert.equal(summary.totalCalls, expected, `turn ${summary.turn}: 期望 ${expected}，实际 ${summary.totalCalls}`)
  }
})

check('注入量 = 输入 + 输出，且都为正数', () => {
  for (const summary of summaries) {
    for (const tool of summary.tools) {
      assert.equal(
        tool.injectedTokens,
        tool.inputTokens + tool.outputTokens,
        `${tool.name} 的 injectedTokens 不等于两者之和`,
      )
      assert.ok(tool.inputTokens > 0, `${tool.name} 的 inputTokens 竟然为 0`)
      assert.ok(tool.outputTokens >= 0, `${tool.name} 的 outputTokens 为负`)
    }
    assert.equal(summary.totalInjectedTokens, summary.totalInputTokens + summary.totalOutputTokens)
  }
})

check('投影注册成功且 key 正确', () => {
  assert.ok(definition !== undefined, '插件没有向 sessionProjections 注册投影')
  assert.equal(definition.key, 'toolCostHint')
  assert.equal(typeof definition.wire.view, 'function')
})

check('投影 view 能通过 wire.viewSchema.parse（浏览器拿到的一定是校验过的形状）', () => {
  assert.equal(viewParseError, undefined, `viewSchema.parse 失败: ${viewParseError?.message}`)
})

check('投影折叠出的轮次数与 host 摘要一致', () => {
  assert.equal(view.turns.length, summaries.length, `投影 ${view.turns.length} 轮 vs 摘要 ${summaries.length} 轮`)
})

check('投影与摘要的数字逐轮一致（两条路必须同源）', () => {
  for (const summary of summaries) {
    const turn = view.turns.find((item) => item.turn === summary.turn)
    assert.ok(turn !== undefined, `投影里没有 turn ${summary.turn}`)
    assert.equal(turn.totalCalls, summary.totalCalls, `turn ${summary.turn} 调用数不一致`)
    assert.equal(turn.totalInputTokens, summary.totalInputTokens, `turn ${summary.turn} 输入 token 不一致`)
    assert.equal(turn.totalOutputTokens, summary.totalOutputTokens, `turn ${summary.turn} 输出 token 不一致`)
    assert.equal(turn.totalInjectedTokens, summary.totalInjectedTokens, `turn ${summary.turn} 注入量不一致`)
  }
})

check('逐工具归因：投影行的 name 来自真实 tool/call', () => {
  const names = new Set()
  for (const turn of view.turns) for (const tool of turn.tools) names.add(tool.name)
  for (const call of realCalls.slice(0, 50)) names.add(call.data.name)
  const missing = [...new Set(realCalls.map((e) => e.data.name))].filter((name) => !names.has(name))
  assert.equal(missing.length, 0, `投影里缺失工具: ${missing.join(', ')}`)
})

console.log(results.join('\n'))
if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败:\n${failures.join('\n')}`)
  console.log('\nRESULT: FAIL')
  process.exitCode = 1
} else {
  const sample = view.turns.at(-1)
  console.log('\n最后一轮视图样例:')
  console.log(JSON.stringify(sample, null, 1))
  console.log('\nRESULT: PASS')
}
