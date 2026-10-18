/**
 * client 面样式。
 *
 * 【为什么是 .ts 而不是 .css】
 * DSH 的 client 产物必须是**单个自包含的模块文件**（首行 window.__ModuleLoader__.load(...)），
 * 由浏览器模块加载器整体物化；官方所有 client bundle 都是把 CSS 作为字符串内联，
 * 再用一个带 `data-plugin-css` 标记的 <style> 标签注入（这样重复加载不会重复插入）。
 * 独立 .css 文件要么在打包时被拆成额外资源（加载器拿不到），要么需要额外的 CSS 处理链，
 * 对一个"只加一行提示"的插件不值得。所以样式单独成文件、但以字符串形式导出。
 *
 * 【风格约定（为什么这么克制）】
 * - 颜色全部继承 currentColor + opacity，不写死任何色值：这样自动跟随浅色/深色主题，
 *   也不会与 DSH 原生底部操作栏的配色冲突。
 * - 只用一个字号变量，读不到就回退 12px：DSH 的底部操作栏就是小字，12px 与之同级。
 * - 不用边框、不用背景块（展开时才给一个极浅的背景以区分层次），避免视觉噪音。
 * - 全部选择器以 .dsh-tch- 前缀命名，绝不命中官方 class。
 */

export const TOOL_COST_HINT_CSS = `
.dsh-tch-root {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
  font-size: var(--dsh-font-size-1, 12px);
  line-height: 1.5;
  color: inherit;
  opacity: 0.72;
  user-select: none;
}

.dsh-tch-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  opacity: 1;
}

.dsh-tch-toggle:hover { opacity: 0.78 }

.dsh-tch-toggle:focus-visible {
  outline: 1px solid currentColor;
  outline-offset: 2px;
  border-radius: 3px;
}

.dsh-tch-caret {
  display: inline-block;
  width: 8px;
  flex: none;
  opacity: 0.6;
  transition: transform 120ms ease;
}

.dsh-tch-caret[data-open="true"] { transform: rotate(90deg) }

.dsh-tch-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 不设 max-width：这条本来就在底部操作栏那一行里，宽度由所在列决定，
     写死 46ch 会在窄面板/分栏时把 "≈31K tok" 提前截成 "≈31K t…"。 */
  min-width: 0;
}

.dsh-tch-rows {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 2px 0 0 12px;
  padding: 3px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 5%, transparent);
}

.dsh-tch-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  column-gap: 10px;
  align-items: baseline;
}

.dsh-tch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-tch-num {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

.dsh-tch-row-error .dsh-tch-num:first-of-type { opacity: 1 }

.dsh-tch-total {
  margin-top: 2px;
  padding-top: 2px;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
`
