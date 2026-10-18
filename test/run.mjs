/**
 * 两套自测的入口：按顺序 import 两个模块，它们各自在 import 时就跑完并打印结果。
 *
 * 为什么合并成一个入口：`npm test` 里写 `a.mjs && b.mjs` 依赖 PATH 上有 node，
 * 而本机 PATH 上没有（只有 Electron 的 node 模式），合成一个进程更省事。
 *
 * 用法：
 *   node test/run.mjs
 *   （本机）& 'D:\deepseek\DeepSeek Harness.exe' test/run.mjs   ← 需先 $env:ELECTRON_RUN_AS_NODE='1'
 */
let failed = false

await import('./host.mjs')
if (process.exitCode) failed = true

process.exitCode = 0
await import('./client.mjs')
if (process.exitCode) failed = true

console.log(`\nRESULT(host + client): ${failed ? 'FAIL' : 'PASS'}`)
process.exitCode = failed ? 1 : 0
