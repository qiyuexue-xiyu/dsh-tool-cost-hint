/**
 * client 面逻辑自测（不开浏览器）：把 dist/client.js 当"浏览器模块"加载，
 * 用假的 window.__ModuleLoader__ 和假的 react 把工厂跑起来，
 * 再直接调用组件函数，检查折叠态/展开态渲染出来的文本。
 *
 * 覆盖的是"逻辑对不对"，不是"长得对不对"——外观仍然由你在真实界面里看。
 */
import assert from 'node:assert/strict'

const BUNDLE_URL = new URL('../dist/client.js', import.meta.url)

const failures = []
const lines = []
function check(label, fn) {
  try {
    fn()
    lines.push(`PASS  ${label}`)
  } catch (error) {
    failures.push(`${label}\n        ${error.message.split('\n').join('\n        ')}`)
    lines.push(`FAIL  ${label}`)
  }
}

/* ---------------- 1. 假浏览器环境 ---------------- */
let entry
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      entry = value
    },
  },
}

await import(BUNDLE_URL.href)

check('产物形状：window.__ModuleLoader__.load 被调用且带 id', () => {
  assert.ok(entry !== undefined, '没有调用 __ModuleLoader__.load')
  assert.equal(entry.id, 'dsh-tool-cost-hint')
  assert.equal(typeof entry.factory, 'function')
})

/* ---------------- 2. 假 react（只实现用到的那三个 API） ---------------- */
let expandedMode = false
const react = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat() } }
  },
  useState(initial) {
    return [expandedMode ? true : initial, () => {}]
  },
  useMemo(factory) {
    return factory()
  },
}
const requireStub = (id) => {
  if (id === 'react') return react
  throw new Error(`unexpected require: ${id}`)
}

const moduleExports = entry.factory(requireStub)

check('client 导出：apply 是函数、inject 声明了 slots', () => {
  assert.equal(typeof moduleExports.apply, 'function')
  assert.deepEqual(moduleExports.inject, ['slots'])
})

/* ---------------- 3. 假 client ctx ---------------- */
const disposers = []
const warnings = []
let registeredSlot = null
let registeredEntry = null
const ctx = {
  get(name) {
    if (name === 'slots') {
      return {
        inject(slotName, factory) {
          registeredSlot = slotName
          factory()
        },
        register(options, component) {
          registeredEntry = { options, component }
          return () => true
        },
      }
    }
    return undefined
  },
  effect(execute) {
    const dispose = execute()
    if (typeof dispose === 'function') disposers.push(dispose)
    return { dispose }
  },
}

const originalWarn = console.warn
console.warn = (message) => {
  warnings.push(String(message))
}

moduleExports.apply(ctx)
console.warn = originalWarn

check('挂载点：注册到 conversation.chat.turnTail，而不是 assistant-actions', () => {
  assert.equal(registeredSlot, 'conversation.chat.turnTail')
  assert.equal(registeredEntry.options.name, 'conversation.chat.turnTail')
  assert.equal(registeredEntry.options.id, 'tool-cost-hint')
  assert.equal(typeof registeredEntry.options.order, 'number')
})

check('挂载时没有任何告警（正常路径）', () => {
  assert.deepEqual(warnings, [], `告警：${warnings.join(' | ')}`)
})

/* ---------------- 4. 渲染 ---------------- */
const view = {
  v: 1,
  turns: [
    {
      turn: 1,
      ended: true,
      tools: [
        { name: 'read', calls: 2, errors: 1, inputTokens: 22, outputTokens: 24, injectedTokens: 46 },
        { name: 'edit', calls: 1, errors: 0, inputTokens: 9, outputTokens: 9, injectedTokens: 18 },
      ],
      totalCalls: 3,
      totalInputTokens: 31,
      totalOutputTokens: 33,
      totalInjectedTokens: 64,
      unattributedCalls: 0,
      orphanResults: 0,
    },
  ],
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.props) return textOf(node.props.children)
  return ''
}

/** 在元素树里按 className 找全部（按 class 列表逐项匹配，不依赖完整字符串）。 */
function find(node, className) {
  const out = []
  walk(node, (element) => {
    const classes = typeof element.props.className === 'string' ? element.props.className.split(/\s+/) : []
    if (classes.includes(className)) out.push(element)
  })
  return out
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node === null || typeof node !== 'object' || !node.props) return
  visit(node)
  walk(node.props.children, visit)
}

function render(props, expanded) {
  expandedMode = expanded
  return registeredEntry.component({
    turn: 1,
    seq: 108,
    openFile: () => {},
    useProjection: () => view,
    t: undefined,
    ...props,
  })
}

/* 折叠态 */
const collapsed = render({}, false)
const collapsedText = textOf(collapsed)
check('折叠态：一行「🛠 read ×2 · edit ×1 · ≈64 tok」', () => {
  assert.match(collapsedText, /🛠 read ×2 · edit ×1 · ≈64 tok/, `实际：${collapsedText}`)
})
check('折叠态：不含输入/输出明细（点开才显示）', () => {
  assert.ok(!collapsedText.includes('输入'), `实际：${collapsedText}`)
})
check('折叠态：aria-expanded=false 且 title 提示"不是计费金额"', () => {
  const [button] = find(collapsed, 'dsh-tch-toggle')
  assert.ok(button !== undefined, '没找到 .dsh-tch-toggle')
  assert.equal(button.props['aria-expanded'], false)
  assert.match(button.props.title, /注入/, `实际：${button.props.title}`)
})

/* 展开态 */
const expanded = render({}, true)
const expandedText = textOf(expanded)
check('展开态：逐行给出 工具名 / 次数 / 输入 / 输出', () => {
  // 四列之间靠 CSS column-gap 拉开，所以按"单元格"逐个比对，而不是比拼接后的整句。
  const rows = find(expanded, 'dsh-tch-row').map((row) =>
    (Array.isArray(row.props.children) ? row.props.children : [row.props.children]).map(textOf),
  )
  assert.deepEqual(rows, [
    ['read', '×2 !1', '输入 22', '输出 24'],
    ['edit', '×1', '输入 9', '输出 9'],
  ])
})
check('展开态：合计标注为「注入量」而不是花费/金额', () => {
  assert.match(expandedText, /注入量/)
  assert.ok(!/花费|金额|成本/.test(expandedText), `出现了计费措辞：${expandedText}`)
})
check('展开态：合计数字与 host 摘要的 totalInjectedTokens 一致', () => {
  assert.match(expandedText, /≈64 tok/, `实际：${expandedText}`)
})

/* 惰性降级 */
check('惰性：该轮没有数据 → 返回 null（不占位）', () => {
  assert.equal(render({ turn: 99 }, false), null)
  assert.equal(render({}, false) !== null, true, '同一轮应当有内容')
})
check('惰性：没有 useProjection 这个 prop → 返回 null', () => {
  assert.equal(render({ useProjection: undefined }, false), null)
})
check('惰性：视图形状不对（字段缺失）→ 返回 null', () => {
  expandedMode = false
  const bad = registeredEntry.component({
    turn: 1,
    useProjection: () => ({ v: 1, turns: [{ turn: 1 }] }),
  })
  assert.equal(bad, null)
})
check('惰性：slots 服务缺失时 apply 只告警不抛', () => {
  const captured = []
  const prev = console.warn
  console.warn = (m) => captured.push(String(m))
  moduleExports.apply({ get: () => undefined, effect: () => ({ dispose() {} }) })
  console.warn = prev
  assert.equal(captured.length, 1, `实际告警 ${captured.length} 条`)
  assert.match(captured[0], /slots service is unavailable/)
})

console.log(lines.join('\n'))
console.log(`\n断言 ${lines.length} 条，失败 ${failures.length} 条`)
if (failures.length > 0) console.log('\n' + failures.join('\n'))
console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
