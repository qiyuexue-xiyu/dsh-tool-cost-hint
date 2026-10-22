# dsh-tool-cost-hint

[![Listed on awesome-dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/qiyuexue-xiyu/dsh-tool-cost-hint/)

> 不告诉你花了多少钱，只告诉你每个工具往你的上下文里塞了多少东西。

---

## ✅ 已收录：现在可以直接在 DSH 里搜到

本插件已收录进 DSH 官方插件精选列表 [awesome-dsh-plugin](https://awesome-dsh-plugin.com)，
分类 **用量与计费（usage）**：

**插件页：https://awesome-dsh-plugin.com/p/qiyuexue-xiyu/dsh-tool-cost-hint/**

### 安装方式（按你的 DSH 类型选）

| 你的 DSH | 怎么装 |
| --- | --- |
| **桌面版 / 任意版本，想省事** | 打开 DSH 的「插件」页，搜索 **`dsh-tool-cost-hint`**（或搜「工具 token」「注入量」），点安装 |
| 有 `dsh` 命令的 CLI 版 | `dsh plugin add <你的 profile 名> dsh-tool-cost-hint` |
| 想装指定版本 | `dsh plugin add <你的 profile 名> https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint/releases/download/v0.2.0/dsh-tool-cost-hint-0.2.0.tgz` |
| 连不上 GitHub | 用发布好的离线自包含包，见「路线 A2」 |

> 注意：**桌面版（Electron）的 `desktop` profile 被主进程独占，`dsh plugin add` 一定会失败**
> （`error: profile "desktop" is managed exclusively by the Electron application`）。
> 桌面版请用 DSH 的插件页搜索安装，或按本文件开头的「⚠️ 安装前必读」手改 `package.json`。

收录意味着 DSH 的插件市场会把本插件列出来、可直接安装；安装走的是 GitHub Release 上
**预构建好的 tarball**（`dist/` 已打包在内），**不需要 Node 构建链、不需要本地编译**，几秒装完。

纯被动观察插件：**不注册工具**、**不往模型上下文写任何东西**、**不 append 任何 session 事件**。
它只监听 `session/event`，在每轮结束时整理出"这一轮谁调了哪些工具、各几次、各自注入多少 token"。

**当前范围：host 面（记账）+ client 面（对话流内一行可折叠提示，`conversation.chat.turnTail`）。**
host 面归因口径与第一轮完全一致，第二轮只新增了"把已有折叠结果送到浏览器"的通道和渲染层，没有改动任何计数逻辑。

---

## ⚠️ 安装前必读（桌面版用户）

**DSH 桌面版（Electron）的 `desktop` profile 被主进程独占，`dsh plugin` 命令对它是只读的：**

```text
$ dsh plugin --profile desktop add file:.../dsh-tool-cost-hint-0.2.0.tgz
error: profile "desktop" is managed exclusively by the Electron application
```

这不是权限问题、也不是命令写错，而是设计如此——桌面端的 profile 由 Electron 应用自己管理。
**所以如果你的 DSH 是桌面版，安装本插件的唯一方法就是手动改配置文件**，`dsh plugin add` 永远会失败。

### 桌面版手动安装（三步）

设你的用户目录为 `%USERPROFILE%`（即 `C:\Users\<你的用户名>`），插件包放在任意位置，例如
`C:\Users\you\Downloads\dsh-tool-cost-hint-0.2.0.tgz`。

**第 1 步：把包装进 profile。** 打开命令行，在
`%USERPROFILE%\.dsh\profiles\desktop\` 里执行（这一步只是解包，不会触发 Electron 限制）：

```bash
npm install "C:\Users\you\Downloads\dsh-tool-cost-hint-0.2.0.tgz"
# 或者用 pnpm（DSH 自带）：pnpm add "C:\Users\you\Downloads\dsh-tool-cost-hint-0.2.0.tgz"
```

装完应该出现 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-tool-cost-hint\dist\index.js`。
（如果想直接链接源码目录调试，改用 `npm install "file:C:/path/to/dsh-tool-cost-hint"`，
或在 `node_modules` 里建一个指向源码目录的 Junction。）

**第 2 步：改 `%USERPROFILE%\.dsh\profiles\desktop\package.json`。** 用记事本打开，改两处：

```jsonc
{
  "dependencies": {
    // ……原有的依赖都保留，只追加下面这一行……
    "dsh-tool-cost-hint": "file:C:/Users/you/Downloads/dsh-tool-cost-hint-0.2.0.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……原有的 bundle 都保留，数组末尾追加下面这一项……
        "dsh-tool-cost-hint"
      ]
    }
  }
}
```

两处都要改，缺一不可：
- `dependencies` 让它能被 `require` 解析到（路径写成 `file:` + 正斜杠，或 `link:` 指向源码目录）；
- **`dsh.profile.bundles` 数组末尾的 `"dsh-tool-cost-hint"` 才是真正让它被加载的开关**。
  写进 bundles 后，loader 会自动套用它自带的 `cordis.patch.yml` 把 `tool-cost-hint` 这行插进组合。

改之前建议先备份 `package.json`。**注意 JSON 不允许注释**，上面代码块里的 `//` 只是说明，别抄进文件。

**第 3 步：完全退出 DSH 进程再重开**（不是关窗口；插件在启动时组合，托盘退出或任务管理器结束进程都行）。

### 验证装好了没有

重开后随便发一轮**用到工具**的消息（比如让它读个文件），回复底部操作栏上方会出现一行：

```text
🛠 read ×1 · pwsh ×2 · ≈3.4K tok
```

点它展开：逐行的 `工具名 / ×次数 / 输入 / 输出`，末行 `注入量 ≈Z tok`。**没有这一行就是没装上**，按顺序查：

1. `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里两处都改了吗？（最常见的原因就是只改了 `dependencies` 忘了 `dependencies` 之外的 bundles）
2. `node_modules\dsh-tool-cost-hint\dist\index.js` 存在吗？
3. 重启时是不是只关了窗口、进程还活着？

> 非桌面版（`dsh web` / `dsh tui` 命令行启动）不受影响，可以直接
> `dsh plugin --profile <profile> add file:<tgz 路径>`，无需手改 JSON。

---

## 0. 怎么把插件发给别人

> **推荐：直接让对方在 DSH 的「插件」页搜 `dsh-tool-cost-hint`。**
> 插件已被 [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/qiyuexue-xiyu/dsh-tool-cost-hint/) 收录，
> 搜索安装走的是预构建 tarball，不用终端、不用构建、不用手改配置。

**不想搜索的话，把下面这一条命令发给对方，复制粘贴就装好了：**

```bash
dsh plugin --profile web add https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint/releases/latest/download/dsh-tool-cost-hint-0.2.0.tgz
```

DSH 会把以 `.tgz` 结尾的 http(s) 直链识别成远程 tarball 直接拉取（见下文的解析表），
所以对方**不需要先下载文件、不需要 Node 构建链**，`dist/` 已经打包在里面。

> 注意 `--profile web` 里的 `web` 要换成对方实际使用的 profile 名。
> 桌面版（Electron）不适用——看本文件开头的「⚠️ 安装前必读」。

桌面版看本文件开头的「⚠️ 安装前必读」——`dsh plugin` 对 desktop profile 一定会失败，必须手改 `package.json`。

当前 Release：https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint/releases/tag/v0.2.0

---

**注意：本仓库的网页地址本身不是一个可以直接安装的地址。**

```text
# ❌ 这些都不行（网页地址不是安装源）
dsh plugin add https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint
```

DSH 的安装来源有四种（依据 `dsh-plugin-manager/lib/types/install-spec.js` 的 `parseInstallSpec`）：

| 来源 | 命令形态 | 解析结果 | 能不能用在本插件 |
| --- | --- | --- | --- |
| npm 包名 | `dsh plugin --profile web add dsh-tool-cost-hint` | `registry` | **暂不可用**——还没发布到 npm registry（包名未被占用） |
| GitHub 源码 | `dsh plugin --profile web add github:qiyuexue-xiyu/dsh-tool-cost-hint` | `git` | 可用，但拉**源码**（`dist/` 不在 git 里），对方要有 Node 构建链 |
| **HTTP tarball 直链** | `dsh plugin --profile web add <https://…​.tgz>` | `tarball`，`host` = `github.com` | **✅ 可用，一条命令直接装，无需下载、无需构建** |
| 本地 tarball | `dsh plugin --profile web add <绝对路径>.tgz` | `tarball`，带 `path` | ✅ 可用，但对方得先有文件 |

> 关键：以 `.tgz` / `.tar.gz` 结尾的 http(s) URL 会被识别为 `tarball` 直链（`install-spec.js:16` 的 `TARBALL_SPEC`，
> 判定在 `:69-75`），pnpm 直接把它当远程 tarball 拉下来。**本地相对路径会被拒绝**
> （`install-spec.js:67-68`：`a local path must be absolute`），所以一律用绝对路径或 http 直链。
>
> 另注：`github:owner/repo` 拉的是**源码**而不是构建产物，装完可能没有 `dist/`。想省掉这一步就用 tarball 直链。

### 路线 A：一条命令直接装（最省事，推荐）

把下面这一整条发给对方，复制粘贴即可：

```bash
dsh plugin --profile web add https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint/releases/latest/download/dsh-tool-cost-hint-0.2.0.tgz
```

- 不需要先下载文件，不需要 Node 构建链（`dist/` 已经打包在 tarball 里）；
- `releases/latest/download/<文件名>` 永远指向最新 Release，不会失效；
- 已实测：该链接 `302 → release-assets.githubusercontent.com`，返回 35176 字节、合法 gzip，sha256 = `9a407f35…0a4d8`，与本地构建产物**逐字节一致**。

前提是对方能访问 `github.com`。若不能，走「路线 A2」发文件。

### 路线 A2：发 tarball 文件（对方连不上 GitHub 时）

先自己打包（`dist/` 必须先构建好，见第 8 节）：

```bash
npm run build
pnpm pack        # 或 npm pack，产出 dsh-tool-cost-hint-0.2.0.tgz
```

把 `dsh-tool-cost-hint-0.2.0.tgz`（约 35 KB）通过微信 / 网盘 / 邮件发给对方，对方执行（**路径要写绝对路径**）：

```bash
# 非桌面版
dsh plugin --profile web add "D:\Downloads\dsh-tool-cost-hint-0.2.0.tgz"
```

桌面版按本文件开头的「⚠️ 安装前必读」手改 `package.json`（`dsh plugin` 对 desktop profile 永远会失败）。

安全提示：对方用非官方渠道拿到的文件时，先核对 sha256 再装（Windows）：

```bash
certutil -hashfile dsh-tool-cost-hint-0.2.0.tgz SHA256
```

`v0.2.0` 的期望值：`9a407f35ec830b52ef40ad81bd97729563e9b09c7dc2bd6ad389c4a81ab0a4d8`

### 路线 B：发布到 npm registry（之后就能"一个包名直接装"）

发布后对方只需要：

```bash
dsh plugin --profile web add dsh-tool-cost-hint
```

需要的东西：

1. 一个 npm 账号（https://www.npmjs.com/signup），本机 `npm login`；
2. `npm publish`（包名 `dsh-tool-cost-hint` 目前**未被占用**，已确认 registry 返回 404）；
3. 之后每次更新 `npm version patch && npm publish`。

这是唯一能做到"我发个名字，对方一条命令装好"的路线。注意 `dist/` 必须在发布前构建好——包里的 `files` 白名单要求 `dist/` 存在（见第 8 节）。

> ⚠️ 已知障碍：部分网络环境下 `npmjs.com`（注册 / 登录 / 发布网页）不可达，而 `registry.npmjs.org`
> 的**读取**是通的。这种情况下无法自行发布，可选做法：
> ① 换一个能访问 npmjs.com 的网络完成一次发布（之后更新可用 Automation Token + API）；
> ② 请能访问的人代发一次（注意：该账号即持有包名 `dsh-tool-cost-hint`）；
> ③ 暂不发布，用路线 A / A2 分发——对方体验差别只是"一条 URL 命令"而非"一个包名"。
>
> 发布前建议先 `npm view dsh-tool-cost-hint` 确认包名仍未被占用（当前确认未被占用）。

### 路线 C：进 DSH Plugin Hub 插件市场（覆盖面最大）

> **✅ 本插件已经通过这条路被收录了。** 下面保留完整过程作为参考。
> 实际生效的是 **awesome-dsh-plugin**（DSH 市场 `dshmarket` 的唯一数据源），不是 dsh-plugin.org。

**已完成的收录事实**（可作为同行的操作参照）：

1. 收录源仓库：[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
   条目放在 `data/plugins/`，**文件名必须是 `owner__repo.yml`**（仓库带子目录时用 `--子路径`）；
2. 提交的 PR：[#7843](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7843)，已合并；
3. 条目内容（这就是本插件现在用的 7 行）：

```yaml
url: https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint
name: qiyuexue-xiyu/dsh-tool-cost-hint
category: usage
description:
  en: 'Per-turn tool cost line in the chat stream: ...'
  zh: '每轮对话结束后在回复底部追加一行可折叠提示：...'
tarball: https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint/releases/download/v0.2.0/dsh-tool-cost-hint-0.2.0.tgz
```

4. 收录后 `https://awesome-dsh-plugin.com/plugins.json` 的 `count` 增加、条目出现，DSH 内置市场随之可见。

提交时遇到的两个坑，记下来省得再踩：

- **不能直接往对方仓库推分支**。GitHub 对非协作者强制 fork → 在自己 fork 里建分支 → 跨仓库开 PR。
  `awesome-dsh-plugin` 对普通账号只有 `pull: true`，直接 `POST /git/refs` 会 404。
- **首次贡献者的 CI 不会自动跑**，PR 页面显示 `1 workflow awaiting approval`，
  要维护者点一下「Approve and run」。这期间 `mergeable_state` 显示 `unstable`，**不是失败**。

另有一个更早提到的市场 dsh-plugin.org，本插件**没有**走它，README 里不再把它的徽章当作已收录凭据。

> **重要：市场页 ≠ DSH 内的「插件中心」。**
> dsh-plugin.org 官方说法是「DSH 内的『插件中心』只展示能用 NPM 一键安装的插件」。没有 npm 包时，
> 仓库仍会被市场收录、有详情页（安装命令是 `github:qiyuexue-xiyu/dsh-tool-cost-hint` 源码安装），
> 但**不会出现在 DSH 客户端的插件中心/搜索框里**。想让人在 DSH 里直接搜到，路线 B 是前置条件。

提交使用的 Issue 正文模板：

```markdown
### 仓库地址
https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint

### 一句话价值
每轮对话结束后，在 assistant 回复底部追加一行可折叠提示，告诉你这一轮每个工具各被调用了多少次、
分别往上下文里注入了多少 token，点开可看逐工具的输入/输出明细。

### 能力分类
记忆与上下文

### 安装命令
dsh plugin --profile web add https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint/releases/latest/download/dsh-tool-cost-hint-0.2.0.tgz

### 兼容与运行要求
DSH 0.2.0-rc.2 及以上（Cordis 4 插件规范）；host 面 Node >= 20；client 面 platform: web。
纯被动观察：不注册工具、不注入系统提示、不写入 session 日志，插件自身每轮额外 token 消耗为 0。

### 许可证
MIT

### 截图 / 演示
折叠态：🛠 pwsh ×15 · read ×4 · write ×7 · skill ×1 · +4 · ≈31K tok
展开态逐行显示「工具名 / ×次数 / 输入 tok / 输出 tok」，末行为「注入量 ≈31K tok」。

### 补充说明
- 归因口径：输入 = tool/call 参数 token（官方 estimate 定价），输出 = tool/result 结果 token；
  两者之和标注为「注入量」而非「花费量」，不与计费、缓存命中混淆。
- 尚未发布 npm 包（包名 dsh-tool-cost-hint 未被占用），因此不进入 DSH 内置插件中心搜索。
- 桌面版（Electron）的 desktop profile 被应用独占，`dsh plugin add` 会报
  `profile "desktop" is managed exclusively by the Electron application`，桌面版需手改 profile 的 package.json。

### 提交前自查
- [x] 仓库已公开
- [x] 已添加 GitHub topic：dsh-plugin
- [x] README 包含安装命令
- [x] 插件导出 apply(ctx) 模块
- [x] 仓库根目录包含 package.json
```

### 四条路怎么选

- 只想给一两个朋友试：**路线 A**（发一条 http 直链命令），一分钟搞定；
- 对方连不上 GitHub：**路线 A2**（发 32 KB 的 tgz 文件）；
- 想让人在 DSH 里搜到名字就装、且能持续更新：**路线 B**（需要能访问 npmjs.com 的账号）；
- 想被更多人搜到：**路线 C**（已完成收录，见上）。

> 补充：DSH 客户端界面上的「添加插件」输入框，接受包名 / `github:owner/repo` / **http(s) tarball 直链** / 绝对路径。
> 填 GitHub **仓库**地址拉的是源码（可能需要本机构建）；**填 Release 的 `.tgz` 直链最稳**，因为 `dist/` 已经打包好了。

---

## 1. 文件清单

```
dsh-tool-cost-hint/
├─ package.json          # dsh.bundle + dsh.client 声明 + 依赖
├─ cordis.patch.yml      # 组合插入行（同时可用作 --patch 覆盖）
├─ tsconfig.json         # 只做类型检查（noEmit），产物交给 tsdown
├─ tsdown.config.ts      # 构建 host 入口 → dist/index.js
├─ tsdown.client.config.ts # 构建 client 入口 → dist/client.js（包 __ModuleLoader__ 壳）
├─ README.md
└─ src/
   ├─ index.ts           # apply()：监听、记账、轮末折叠、emit
   ├─ events.ts          # 纯函数：事件读取/校验 + token 定价
   ├─ types.ts           # host 对外契约：ToolUsage / TurnToolUsageSummary / Config
   ├─ contract.ts        # host↔client 共享的形状：投影 key + ToolCostHintView
   ├─ wire.ts            # 投影定义：同一套折叠逻辑 + wire.view（浏览器数据通道）
   └─ client/
      ├─ index.tsx       # 折叠条组件 + slot 注册 + 惰性降级
      ├─ style.ts        # 内联 CSS 字符串（client 产物必须自包含）
      └─ types.ts        # client 侧结构类型（不依赖 Harness Client 包）
```

---

## 2. 归因口径（本插件唯一的"技术核心"）

| 字段 | 含义 | 来源 |
| --- | --- | --- |
| `inputTokens` | 该工具**调用侧**注入量：本轮 tool/call 事件里 tool-call 块的（工具名 + 参数 JSON）token | `estimate`（官方公式） |
| `outputTokens` | 该工具**结果侧**注入量：tool/result 追加进模型可见 surface 的那条 tool 消息的 token | `meter` 优先，`estimate` 回退 |
| `injectedTokens` | 前两者之和，**UI 上展示的就是这个数**，标签为"注入量" | 派生 |

为什么叫"注入量"而不是"花费量"：

- provider 只报整轮的 usage（uncachedInput / cacheRead / output …），**没有任何 per-tool 计费数据**；
- 命中缓存后，"注入 3000 token"和"花了 3000 token 的钱"是两件事。
- 因此本插件不引入任何价格换算、不显示金额；计价留给 `dsh-bill` 这类插件，两边口径不重叠。

为什么 `inputTokens` 只能是估算：

- `tool/call` **不是 surface 事件**（模型可见 surface 只有 system/developer/user/assistant 消息和 tool/result），
  它在 `ctx.tokenMeter.measure()` 里没有独立节点，拿不到官方数字；
- 但 tool-call 块确实会进入下一次请求，必须算进去；
- 于是用 token meter **自己的**定价公式（`estimate.js` 的 tool-call 分支）：
  `ceil(name.length/4) + ceil(arguments.length/4) + 4`，并**不计 block.id**（上游也不计，计了就对不上）。

> 结论：这不是"重算一个已有的数"，而是"补一个框架没有单独露出来的数"，且公式与框架逐字一致。
> 数据结构里用 `inputTokensSource` / `outputTokensSource` 显式标出来源，UI 上可以区分"计量"与"估算"。

---

## 3. 事件时机（为什么等 `turn/end`）

| 事件 | 到达时做什么 | 为什么 |
| --- | --- | --- |
| `turn/start` | 建本轮累加器 | 拿到 `startedSeq` / `startedAt`，用于时长与定位 |
| `tool/call` | `calls += 1`，累加 `inputTokens`，登记待配对调用 | O(1)，参数已在事件里，不需要任何服务 |
| `tool/result` | 配对 `callId`，累加 `errors`，**只记 seq + 一个估算数字** | 不缓存结果正文：工具结果动辄几十 KB，长会话里留在插件内存里既浪费又长期驻留 |
| `turn/end` | **调一次** `ctx.tokenMeter.measure()`，用节点 tokens 覆盖估算值，折叠成摘要，emit | `measure()` 是 O(surface) 的整表快照，只能一轮一次；此时本轮所有结果都已落地，数据到了终态 |

未配对情况都显式记录，不静默吞掉：

- `unattributedCalls`：发了 tool/call 但没等到 tool/result（中断/仍在跑）→ `outputTokens` 记 0，`calls` 与 `inputTokens` 照算；
- `orphanResults`：收到 tool/result 但没有配对调用（插件中途加载、框架补写恢复结果）→ 归到合成桶 `(unattributed)`，结果 token 照算。

---

## 4. 推送接口设计（三层，第三层第二轮已落地）

三层，边界很清楚：

1. **内存态（host 内部）**：`WeakMap<Session, SessionBook>`，`SessionBook.turns: Map<turn, TurnAccumulator>`
   就是需求里的 `Map<turnId, ToolUsage[]>` 进行中形态；轮次结束后折叠成
   `SessionBook.summaries: TurnToolUsageSummary[]`（按 `config.keepTurns` 环形裁剪）。
2. **进程内事件总线（本轮交付）**：
   `ctx.emit('tool-cost-hint/summary', summary)`，payload 类型 `TurnToolUsageSummary`。
   host 侧任何插件可 `ctx.on('tool-cost-hint/summary', ...)` 消费。
3. **到浏览器的通道（第二轮已实现第 1 条）**：
   - **host 投影 + `wire.view`**：`src/wire.ts` 把同一套折叠逻辑注册成 `toolCostHint` 投影，在 definition 上声明
     `wire.view`，值算好后框架直接送到 client 尾页，client 不自己折事件（官方推荐路线，见 §6）；
   - 自注册 HTTP 路由 + client 侧 `fetch`：`billion-context` 就是这么做的（`/bili/origin`）。本插件不需要——
     投影已经能自动复用尾页携带、checkpoint 和重连重建。

明确**不能**用的路径：自定义 **session 事件**。会话日志的读者只容忍信封带 `ignorable: true` 的未知类型，
而 live `append()` 无法设置该标记 —— 一旦往日志里塞自定义 type，这个会话之后就打不开了。
同理，普通插件也无法把自定义 Cordis 事件加进 API gateway 的转发白名单，所以第 2 层**到不了浏览器**。

### 摘要 JSON 形状（`TurnToolUsageSummary`）

```json
{
  "version": 1,
  "sessionId": "session-3",
  "turn": 7,
  "startedSeq": 120,
  "endedSeq": 148,
  "durationMs": 41230,
  "reason": "completed",
  "tools": [
    { "name": "read", "calls": 4, "errors": 0, "inputTokens": 96,
      "outputTokens": 8120, "injectedTokens": 8216,
      "inputTokensSource": "estimate", "outputTokensSource": "meter" }
  ],
  "totalCalls": 4,
  "totalErrors": 0,
  "totalInputTokens": 96,
  "totalOutputTokens": 8120,
  "totalInjectedTokens": 8216,
  "unattributedCalls": 0,
  "orphanResults": 0
}
```

排序固定：`injectedTokens` 降序 → `calls` 降序 → `name` 升序（同一轮数据永远同样顺序，UI 与日志可复现）。

---

## 5. Host 侧验证步骤

### 5.0 构建

```powershell
cd <repo>\dsh-tool-cost-hint
pnpm install     # devDependencies 里的 @deepseek-ai/* 是"仅类型"依赖，只用于 tsc
pnpm typecheck   # 可选：tsc --noEmit
pnpm build       # 产物 dist/index.js + dist/index.d.ts
```

> `@deepseek-ai/cordis`、`@deepseek-ai/dsh-session` 只用于类型检查，运行时**不 import** 它们
> （它们躺在 DSH 的 app.asar 里，从 profile 目录根本解析不到）。运行时唯一依赖是
> `@deepseek-ai/schemastery`（Config schema）。

### 5.1 让 `name` 可解析

loader 是按 profile 的 `node_modules` 解析 `cordis.patch.yml` 里的 `name` 的。所以先把包挂进 profile：

```powershell
# 把 <你的 profile 名> 换成实际名字；desktop 见文首「安装前必读」
dsh plugin --profile <你的 profile 名> add file:<本插件目录的绝对路径>
```

（`dsh plugin --profile <name> <pnpm-args...>` 会把参数转给 pnpm。也可以自己 `pnpm add file:...`。）

### 5.2 先看组合结果（不启动，最快的排错手段）

```powershell
dsh --profile <你的 profile 名> --dump-config --patch <本插件目录>/cordis.patch.yml
```

输出里应当出现一行 `id: tool-cost-hint` / `name: dsh-tool-cost-hint`，并带上 `config`。
**没有这一行 = patch 没被读到**，此时不要继续往下试。

### 5.3 启动并观察

`--patch <path>` 是 launcher 级参数，语义是"在 profile 层之后再叠一层 patch"，**可重复**，且是单值收集器
（不是变长参数，别把 app 参数紧跟在它后面）：

```powershell
dsh --profile <你的 profile 名> --patch <本插件目录>/cordis.patch.yml
```

验证时把 patch 里的 `logToConsole` 改成 `true`（或临时用一个只覆盖 config 的 patch 文件）。

启动成功的标志（stderr）：

```
[tool-cost-hint] armed (attribution v1, keepTurns=20, emitEvent=true)
```

然后在会话里跑几个会用工具的任务，每轮结束后 stderr 会出现：

```
[tool-cost-hint] {"version":1,"sessionId":"...","turn":1,...,"tools":[...]}
```

- **没有 `armed` 行** → patch 没生效，回到 5.2；
- **有 `armed` 但没有摘要行** → 那一轮没有工具调用（纯对话轮次不产出摘要），或 `tool/call` / `tool/result`
  没走到本插件（检查是否有别的插件把行 `disabled` 了）。

### 5.4 验证计数与 token 是否可信

1. **调用次数**：摘要里某工具的 `calls` 应等于该轮 assistant 实际发出的工具调用数（含被中断的那些）。
2. **结果侧 token**：`totalOutputTokens` 应能与上下文面板 / `ctx.tokenMeter.measure()` 的
   对应 tool/result 节点 `tokens` 对上（因为就是同一来源）。任何 `outputTokensSource: "estimate"`
   的工具说明该轮 meter 不可用或节点缺失，这种数字只能当量级参考。
3. **失败/中断**：故意中断一轮（工具还在跑就结束），检查 `unattributedCalls > 0` 且该轮仍有摘要产出。
4. **中途加载**：在已有会话里热重载插件，检查 `orphanResults` 是否正确反映了"只看得到结果"的情况。

### 5.5 验证"零侵入"

- session 日志里**不应出现**任何新的事件 type（`grep tool-cost-hint <session.jsonl>` 应为空）；
- 系统提示、工具列表、模型可见消息**不应有任何变化**；
- 关掉 `emitEvent` 后，插件仍然算数，只是不通知任何人。

### 5.6 client 联调（浏览器侧）

1. **产物存在**：`dist/client.js` 开头必须是 `window.__ModuleLoader__.load({ id: "dsh-tool-cost-hint", factory: … })`。
   如果不是这个形状，说明 `tsdown.client.config.ts` 里的包装插件没生效，浏览器会直接报加载失败。
2. **投影注册上了**：host stderr 不应出现 `sessionProjections is unavailable`；
   在 devtools 里 `useProjection("toolCostHint")` 的返回值形如 `{ v: 1, turns: [{ turn, tools: [...] }] }`。
3. **条目挂上了**：在一轮的 turn-tail 节点（`[data-turn-tail]`）内部应当能看到一行 `🛠 …`；
   没有的话先看 console 有没有 `[tool-cost-hint]` 开头的警告——所有失败路径都只警告、不抛错。
4. **点开对比**：展开态里各工具的 `输入/输出` 与 host stderr 里同一轮的 `inputTokens/outputTokens` 必须逐字一致
   （同一套 `estimate` 函数算出来的，差一位就说明两边取的不是同一批事件）。

---

## 6. client 面：挂哪里、怎么拿到数据、怎么降级

### 6.1 为什么挂在 `conversation.chat.turnTail`

DSH 的"轮末"是两个 slot，都在 turn-tail 节点里、渲染在自底向上那一行操作区：

| slot | 谁声明的 | 条目拿到的 props | 适不适合 |
| --- | --- | --- | --- |
| `conversation.chat.turnTail` | ui-chat 的 `conversation.chat.node`（`key: "turn-tail"` 的 children） | `{ turn, seq, openFile }` | **用了这个**：能拿到 `turn`，可按轮取值；位置就在操作栏那一行 |
| `conversation.chat.assistant-actions` | 同上（children） | `{ messageId }` | 不合适：在 hover 才显现的**图标条**里，塞不进多行折叠内容，也拿不到 turn |

turn-tail 的渲染顺序是 `[turnTail, MessageIconActions(extraActions=assistantActions, usageAction=…)]`，
我们把一行折叠条注册进 `turnTail`，视觉上就贴在原生底部操作栏的位置，不用自己写定位。

**没有用 `data-*` 钩子去定位官方 DOM**：读别的插件的 DOM/样式是官方明令禁止的，而且官方结构一变就碎；
slot 本来就是"已经留好空位"的正规接入点（turn-tail 节点上的 `data-turn-tail="<turn>"` 只用于你在 devtools 里核对）。

### 6.2 数据怎么来：投影 `wire.view`，不是事件

client 侧的 `useProjection("toolCostHint")` 读的是 host 注册的 session 投影（`src/wire.ts`）：

- **不能用自定义 Cordis 事件**：API gateway 的转发白名单是构建期写死的，第三方插件加不进去；
- **更不能往 session 里 append 自定义事件**：未知 type 没有 `ignorable` 标记，会让会话之后打不开；
- 投影的 `wire.view` 是唯一"算好再送到浏览器"的正规通道，还顺带白拿尾页携带、checkpoint 和重连重建。

`src/wire.ts` 的 `fold()` **刻意不用 `ctx.tokenMeter.measure()`**：投影必须能从日志纯折叠重建，
不能依赖某个服务在某一刻的整表快照。对 append 型的 `tool/result`，meter 节点的定价函数就是
`estimateMessage`，和我们这里调的是同一个函数、同一个数（第二轮已用断言脚本核对过）。

### 6.3 惰性降级（探测不到就什么都不做）

| 情况 | 行为 |
| --- | --- |
| `ctx.slots` 服务不存在 | `apply` 直接 return，只在 stderr 打一行 `[tool-cost-hint] slots service is unavailable` |
| slot 名不存在（ui-chat 没装/改名） | `slots.inject(name, …)` 的回调永远不会被调用；不报错、不重试、不查询 DOM |
| 投影没注册成功（`sessionProjections` 缺失） | host 侧打一行警告并跳过注册；client 的 `useProjection` 拿到 `undefined/{}` |
| 该轮没有数据（纯对话轮、或插件是中途加进来的历史轮） | `pickTurn()` 返回 `undefined` → 组件 `return null`，**不占位、不留空行** |
| 视图形状不对（版本不匹配/字段缺失） | 同上，形状校验不过就当没有数据，绝不抛错把会话渲染带崩 |

所有注册都走 `ctx.effect()` / `slots.inject()`，卸载即清理：`<style>` 标签会被移除，slot 条目会被摘掉。

### 6.4 视觉

- 折叠态一行：`🛠 read ×2 · edit ×1 · ≈1.2K tok`
- 展开态逐行：`工具名 / ×N（失败时带 !N）/ 输入 X / 输出 Y`，末行 `注入量 ≈Z`
- 全部颜色继承 `currentColor` + `opacity`，字号 `var(--dsh-font-size-1, 12px)`，数字 `tabular-nums`；
  没有硬编码颜色，所以亮/暗主题自动跟随，不写主题分支。
- 合计文案走 locale 字典（zh/en），用的是**"注入量"**，不是"花费"或"金额"。

---

## 7. 与需求的两处偏差（都是有意为之）

1. **`dsh.client` 在第二轮才声明。**
   宿主会按 `dsh.client` 去扫描并物化客户端产物，**产物缺失会明确导致激活失败**（不是静默跳过），
   所以第一轮（只有 host 面）声明它就是主动制造启动故障。第二轮既然真的产出了 `dist/client.js`，
   就一并声明了：`"client": { "platform": "web", "immediately": true }`。
   `immediately: true` 的含义是"应用启动即加载"，而不是等某个 slot 被渲染才惰性加载——
   因为我们的条目要挂到每轮的 turn-tail 上，越早注册越不会漏掉首轮。

2. **`cordis.patch.yml` 的双重身份。**
   它既是 `dsh.bundle.patch` 指向的 bundle 补丁文件（被列进 profile 的 `dsh.profile.bundles` 后自动生效），
   也可以直接作为 `--patch` 的覆盖文件（同一份 YAML 数组格式）。两种用法语义完全一致，所以不需要两份文件。

---

## 8. 分发（打包给另一台机器）

```bash
# 在本插件目录里（先确认 dist/ 是新的：npm run build）
npm install          # 首次、或换了机器之后
npm run build        # 产出 dist/index.js + dist/client.js
npm pack             # 产出 dsh-tool-cost-hint-0.2.0.tgz
```

`files` 白名单只放 8 个文件：`package.json`、`README.md`、`cordis.patch.yml`、
`dist/index.js`、`dist/index.d.ts`、`dist/client.js`、`locale/zh.json`、`locale/en.json`。
`node_modules/`、`src/`、`test/`、各种 ts 配置、lockfile 都不会进包（`.gitignore` 只影响 git，`files` 才决定包里有什么）。
`dist/index.js.map` 也不再进包（`tsdown.config.ts` 里 `sourcemap: false`，那个 map 有 70 KB，比 host 产物本身还大）。

另一台机器上（目标 profile 不是 `desktop` 时）：

```bash
dsh plugin --profile <profile> add file:C:/path/to/dsh-tool-cost-hint-0.2.0.tgz
```

装完确认两件事：`package.json` 的 `dsh.profile.bundles` 里出现了 `dsh-tool-cost-hint`；
`dsh --profile <profile> --dump-config` 里有 `- id: tool-cost-hint`。然后重启 DSH。

> **`desktop` profile 见本文开头的「安装前必读」——`dsh plugin add` 会直接被拒，只能手改配置文件。**

---

## 9. 下一轮（不在本轮范围）

- 客户端 bundle 的构建目前依赖 `tsdown` 的 `outExtensions` + 一个内联 `renderChunk` 包装插件；
  若你的 tsdown 版本不吃这两个选项，退回"手写 `dist/client.js`"（官方 decoration 模板就是手写的，
  `window.__ModuleLoader__.load({ id, factory })` 的壳见 `tsdown.client.config.ts` 顶部注释）。
- 回看更早的轮次：投影已经按 `keepTurns` 保留了最近 N 轮，若要"整段会话汇总"，扩视图即可，不用改折叠。
- 跨会话持久化（如果需要）：投影缓存 + checkpoint，而不是自己写盘。
