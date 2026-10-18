import { defineConfig } from 'tsdown'

/**
 * 构建配置。
 *
 * 只产出一个 host 面入口 dist/index.js（ESM，Node 平台）。
 *
 * 【为什么没有 client 入口】
 * 本轮只做 host 面。注意不要"先把 dsh.client 声明上、产物以后再补"：宿主会按
 * dsh.client 声明去扫描并物化客户端产物，产物缺失时会**明确导致激活失败**，
 * 而不是静默跳过。所以第二轮加 client 时，必须同时做三件事（缺一不可）：
 *
 *   1. package.json 的 dsh 字段补上 client：
 *        "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
 *   2. 这里的 entry 加一路：entry: { index: 'src/index.ts', client: 'src/client.ts' }
 *      （产物落在 dist/client.js，与 dsh.client 期望的入口保持一致）
 *   3. client 面只依赖平台基座（React / Cordis / 静态 UI 库），不允许 import
 *      @deepseek-ai/dsh-client-ui-primitives 之类的 Harness 内部包；
 *      需要 host 数据就走 host 投影的 wire.view 或本插件注册的 HTTP 路由。
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  // d.ts 与 js 一起出，dist/index.d.ts 供 package.json 的 types/exports 指向。
  dts: true,
  clean: true,
  // 不发 sourcemap：dist/index.js.map 有 70 KB，比 host 产物本身还大，
  // 打包分发时白占体积；需要调试时本地临时改回 true 即可。
  sourcemap: false,
  // 插件自身不带 node_modules 里的运行时依赖打包进来：
  // @deepseek-ai/schemastery 作为真实 dependency 由包管理器安装。
  external: [/^@deepseek-ai\//],
})
