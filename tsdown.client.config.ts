/**
 * client 面打包配置 —— 单独一份，因为目标格式和 host 面完全不同。
 *
 * host 面（tsdown.config.ts）：ESM、platform node，跑在 Node 里，import 走 ESM。
 * client 面（本文件）：必须产出 DSH 浏览器加载器认得的**单文件 CJS 工厂**：
 *
 *   window.__ModuleLoader__.load({
 *     id: "dsh-tool-cost-hint",
 *     factory: (require) => { var module = {exports:{}}; var exports = module.exports; ...; return module.exports }
 *   })
 *
 * 官方所有 client bundle（dsh-client-ui-*、billion-context、模板里的 decoration/client.js）
 * 都是这个形状。它不是普通 ESM，也不是标准 CJS，而是"把 CJS 体塞进一个工厂函数"，
 * 所以这里的做法是：先让 tsdown 按 cjs 打成一个自包含 chunk，再用 renderChunk 包一层壳。
 * 这样做的好处是：TS/TSX 编译、tree-shaking、react 外部化全部交给打包器，
 * 只有最后那层壳由我们手写 —— 形状完全可控。
 *
 * 【为什么要 external react】
 * 浏览器里 React 由 DSH 的平台模块表提供，外部化后产物里是 require("react")，
 * 由加载器注入的 require 解析。自己打包 React 会导致**两份 React**，
 * hooks 立刻失效（Invalid hook call），这也是官方明确禁止的行为。
 * 除 react 之外不允许出现任何第三方依赖 —— 见 package.json 的 dsh.client.external 注释。
 *
 * 【如果这条构建链在你本机跑不通】
 * 这一层的产物形状是死要求，但生成方式不是。兜底办法：把 dist/client.js 换成一个
 * 手写的等价文件（官方 decoration 模板就是这么做的：client.js 里手写
 * window.__ModuleLoader__.load({...factory(require){...}})，package.json 不做构建）。
 */

import { defineConfig } from 'tsdown'

/** 打包器里识别插件用的 id，必须与 package.json 的 name 一致。 */
const PLUGIN_ID = 'dsh-tool-cost-hint'

/**
 * 把 CJS 输出包进 __ModuleLoader__ 工厂。
 *
 * renderChunk 是"产物已成型、写盘之前"的钩子，正好是套壳的位置。
 * 注意两点：
 *   1. 不能改动 code 内部的任何标识符 —— 壳只是提供 module / exports / require 三个自由度；
 *   2. 必须去掉尾部的 sourceMappingURL 注释，否则它会跑到 return 语句中间（无害但很脏）。
 *
 * 【为什么不 import Plugin 类型】tsdown 只承诺 defineConfig 的入参类型，不对外导出
 * rolldown/rollup 的插件类型；直接写形状（name + renderChunk）既能被结构检查接受，
 * 也不依赖任何未承诺的导出。
 */
function moduleLoaderShell() {
  return {
    name: 'dsh-client-module-loader-shell',
    renderChunk(code: string) {
      const body = code.replace(/^\/\/# sourceMappingURL=.*$/gm, '')
      const wrapped = [
        'window.__ModuleLoader__.load({',
        `  id: ${JSON.stringify(PLUGIN_ID)},`,
        '  factory: (require) => {',
        '    var module = { exports: {} }',
        '    var exports = module.exports',
        body,
        '    return module.exports',
        '  }',
        '})',
        '',
      ].join('\n')
      return { code: wrapped, map: null }
    },
  }
}

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'dist',
  // cjs 而不是 esm：壳里的工厂函数用的是 module/exports/require 这一套。
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  // 产物名必须是 client.js（package.json 的 exports["./client"] 指向它），
  // 而 package.json 是 "type": "module"，默认 cjs 会被命名成 .cjs —— 这里强制回 .js。
  outExtensions: () => ({ js: '.js' }),
  // 不 clean：host 面的产物先落到 dist，client 构建不能把它删掉。
  clean: false,
  // browser 产物不需要 d.ts，也避免 dist 里多出 client.d.ts 干扰加载器扫描。
  dts: false,
  sourcemap: false,
  // 关键：react 与所有 @deepseek-ai/* 一律外部化，由平台模块表提供。
  external: [/^react($|\/)/, /^react-dom($|\/)/, /^@deepseek-ai\//],
  plugins: [moduleLoaderShell()],
})
