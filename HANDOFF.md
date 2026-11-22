# 交接文档 · dsh-subagent-model-limit

> 写给接手的人（或未来的我）。读完这份就该能独立开发和维护，不必再翻对话记录。
> 最后更新：2026-11-17

---

## 1. 它是什么

一个 DeepSeek Harness 插件：**按模型限制 subagent 并发数**。

现有的 `dsh-subagent-concurrency-limit` 上限是**一个进程级数字**（`maxConcurrentSubagents`），所有模型共用。本插件的上限是**每个模型一份**：`as-one/auto` 给 2、`as-one/glm-5.3-flash` 给 1、其余给 4，互不挤占。

超限时**拦截调用**并返回可读信息，而不是把请求发到上游再失败。

---

## 2. 当前状态

| 部分 | 状态 | 说明 |
|---|---|---|
| host 侧拦截 | ✅ 已验证 | 真实链路跑通过：父会话 `deepseek-flash`，子代理指定 `auto`，插件按 `as-one/auto` 计数（1/1）并拒绝第二个 |
| 四级配额匹配 | ✅ 单测覆盖 | `provider+model` → `provider/*` → `*/model` → `*/*` → `defaultLimit` |
| `countMainAgent` | ✅ API 已验证 | 设置页可勾选并保存，落盘 `config.json`；真实并发场景未专门跑 |
| 设置页 UI | ✅ 已验证 | 插件管理页里能看到「子代理并发上限」表格、增删行、主会话勾选、保存（实测改 defaultLimit=6 + 勾选 → 落盘成功，已恢复默认） |
| 假上游 | ✅ 已验证 | 输入「等 2 秒」→ 等 2.0 秒 → 返回 `wait(seconds=2)` |

**测试**：`node --test test/model-resolution.test.mjs` → 16/16 通过（零依赖，不需要 DSH 在场）。

---

## 3. 架构

```
┌─ host（Node 进程）────────────────────────────┐
│ lib/index.js                                  │
│  ├ resolveModel(exec)   这次调用落在哪个模型   │
│  ├ capFor(cfg, resolved) 查配额（四级匹配）    │
│  ├ Gate                 每个模型一个闸门       │
│  ├ tools/execute        拦截 subagent，超限拒  │
│  ├ agent/status         主 agent 只占不拦      │
│  └ webServer 路由       /subagent-model-limit/ │
│                          api/config           │
└───────────────────────────────────────────────┘
                     ▲ HTTP (fetch)
┌─ client（浏览器）─────────────────────────────┐
│ lib/client.js                                 │
│  └ plugins.bundle.config → SettingsPanel      │
└───────────────────────────────────────────────┘
```

### 为什么 client 走 HTTP 而不是 DSH 的 settings RPC

DSH 的 settings gateway **只对官方 namespace 开放写入**（`dsh-ui-appearance` 的源码注释原话：*"the harness settings gateway only exposes its hard-coded product namespaces to browser clients, so a third-party namespace cannot be written through the settings RPC"*）。

`ctx.configForms` 也只接受**Host 注册的** settings namespace。

所以第三方插件要保存自己的配置，只有两条路：
1. 自定义 typert Remote（要代码生成，重）；
2. 注册自己的 HTTP 路由（as-one 的 `/as-one/api/*` 同款，轻）。

本插件选 2。

### 配置存放

`~/.dsh/subagent-model-limit/config.json`（设置页写它）。

**为什么不用 `cordis.patch.yml`**：那是**用户的**配置文件，插件不该去改写它。插件自己的 `cordis.patch.yml` 里的 config 只作为首次安装的默认值，运行时被上面那个 JSON 覆盖。

优先级：`config.json` > bundle config > 内置默认。

---

## 4. DSH 侧的关键事实（都是实测出来的，踩过坑）

### 4.1 拦截 subagent 的三个扩展点

| 扩展点 | 语义 | 能否 await |
|---|---|---|
| `ctx.on('tools/execute', async (exec, next))` | 环绕 dispatch | ✅ 本插件用这个 |
| `ctx.tools.guard(guard)` | 同步强制拒绝，不可被后续插件翻回 | ❌ |
| `ctx.on('tools/pre-execute')` | `allow/deny/ask/cancel` | ✅ |

管线顺序：`pre-execute → guards → tools/execute → post-execute → finalizeContent → tools/result`。

### 4.2 怎么知道「这次调用用哪个模型」

按顺序：
1. **工具参数** `exec.arguments.provider` / `.model` —— 只有 `dsh-tool-subagent` 开了 `modelSelection` 才有；
2. **父会话当前模型** `exec.agent.model.current()` → `{ provider, model, reasoningEffort? }`；
3. 兜底 `*`。

⚠️ `subagent/start` 事件的 `SubagentRunInfo` **只有 `provider`，没有 model**（`dsh-subagent/src/types.ts:95`）。所以不能靠事件归模型，必须在拦截时就把模型绑定到 reservation 上 —— 这就是 `AsyncLocalStorage` 的作用。

### 4.3 「模型指定 subagent 模型」需要三件事同时满足

只开 `modelSelection` **不够**，实测被挡了三次：

1. **工具层**：`dsh-base` 默认没开 `modelSelection` → 工具不接受 `provider`/`model` 参数；
2. **策略层**：开了之后报
   `child LLM route "as-one/deepseek-flash" is not allowed for this Session; without a recorded model-selection policy, explicit selection is limited to the parent route`
   （`dsh-tool-subagent/src/model-selection.ts:142`：没有 policy 时只允许与父路由**完全一致**）；
3. **记录时机**：`subagent-model-selection-settings` 的 `enabled + allowedModels` 只在**新建的顶层 Session** 上落 policy（`model-selection-settings.ts:67-71`），老会话改配置也不生效。

完整可用的 overlay 见 `test/overlay-model-selection.yml`。

### 4.4 为什么主 agent 计数挂在 `agent/status`

`llm/stream` 是 waterfall，但它的 `options` 里**没有 agent 身份**，分不清主会话与子代理。`agent/status` 带 `info.agent`，能判断深度。

`countMainAgent` 的语义：主会话跑起来就占一份名额，**但永不拦截**（只调 `Gate.enterUnchecked`，从不比较上限）。

深度判断是**启发式**（`delegationDepth()`）：先读 agent 上的 `depth`/`delegationDepth` 字段，读不到就看 `session.header.origin === 'subagent'`。不硬依赖 `delegationDepthOf`，避免解析不到那个包时整个插件挂掉。

### 4.5 `plugins.bundle.config` 的约定

```js
ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
  name: 'plugins.bundle.config',
  key: '<bundle 包名>',   // 必须等于 package.json 的 name
  locale: NS,             // 可选
  inject: () => ({...}),  // 可选
}, Component))
```

`dsh-client-ui-plugin-manager/src/client/config-ledger.ts` 用 `ctx.slots.entries('plugins.bundle.config')` 的 `options.key` 决定哪些 bundle 在插件管理页里出现「配置」区。

官方参考实现：`dsh-experimental-client-ui-voice-input`、`dsh-cua`。

### 4.6 client 插件格式

```js
window.__ModuleLoader__.load({
  id: '<包名>',
  factory(require) {
    const React = require('react')   // React 来自浏览器模块表，不要自己装
    return { inject: ['slots'], apply(ctx) { /* 注册 slot */ } }
  },
})
```

不需要构建工具 —— 用 `React.createElement` 手写即可（本插件就是这么做的）。

---

## 5. 怎么测

### 5.1 单测

```sh
node --test test/model-resolution.test.mjs
```

### 5.2 假上游（制造可控并发）

```sh
node test/fake-upstream.mjs --port 4999      # 默认每次等 3 秒
```

发一条带时间的消息，它就复现「子代理占用 N 秒」：

```js
await fetch('http://127.0.0.1:4999/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'fake-slow', messages: [{ role: 'user', content: '请等 2 秒' }] }),
})
// → 2.0s 后返回 tool_calls: wait({"seconds":2})
```

支持 `等 5 秒` / `5秒` / `5s` / `sleep 5`。

### 5.3 真实链路（已跑通的那次）

```sh
dsh --profile web \
  --patch "D:\projects\dsh-test-plugins\dsh-subagent-model-limit\test\overlay-model-selection.yml" \
  --port 65202 --no-open
```

然后在浏览器里：
1. **新建会话**（policy 只对新会话生效）；
2. 让它并行发两个 `subagent(provider=as-one, model=auto)`；
3. 期望：第一个 `started`，第二个被拒，报错形如
   `subagent 未创建：模型 as-one/auto 的子代理并发已达上限（1/1）。当前可用槽位 0 个。…`

overlay 里把 `as-one/auto` 压到 1 就是为了让第二个必被拒。

### 5.4 打开 401 页面的办法

`dsh web` 的 token 是**一次性**的：用扩展 `browser_navigate` 直接跳带 `?token=` 的地址，query 会被吃掉，落到 401 页。

绕过办法（已验证）：在页面里执行

```js
location.href = 'http://127.0.0.1:65202/?token=<新 token>'
```

---

## 6. 已知限制 / 待办

1. **`countMainAgent` 的真实并发场景未跑**：API 层和 UI 保存都验证了，但没实测「主会话占一个名额后，子代理可用名额真的少一个」。验证点见 §5.5。
2. **配额在 Gate 创建时固化**：`gateOf()` 第一次遇到某模型时就把当时的 `capFor` 结果写进 `Gate.limit`。改了配置需要插件重载（或重启实例）才对新模型生效。
4. **client 文案硬编码中文**，没走 `ctx.locale`（DSH 的 practices 建议走）。中文环境够用，要国际化再补。
5. **只统计经 `subagent` 工具发起的**。workflow 里的 `agent()` 不走这条链路。
6. **多 worker 下每个进程各算一份**（与 DSH 进程内账本语义一致，别在集群模式用）。
7. `queueTimeoutMs` 字段保留了但**没有实现排队**，当前恒为「立即拒绝」。

---

## 7. 当前目录与 profile 状态

> 2026-11-22 核对：本节已按实际情况更新，原文写的「已 link 进 web profile」**不成立**。

- **目录**：`D:\projects\dsh-test-plugins\dsh-subagent-model-limit`（2026-11 从
  `D:\projects\dsh-subagent-model-limit` 搬入实验工作区）。
- **profile 状态**：`~/.dsh/profiles/web` 与 `desktop` 的 `package.json` 里都**没有**它。
  想在真机试验，先重新 link（profile 记的是绝对路径）：

  ```sh
  dsh plugin --profile <profile> add link:D:/projects/dsh-test-plugins/dsh-subagent-model-limit
  # 重启 DSH 后生效
  ```

- **版本控制**：尚未 `git init`。`.gitignore` 已就绪（`node_modules/`、`.fake.pid`、`*.log`、
  `.DS_Store`）；将来独立成仓库或并入工作区的多分支仓库时直接初始化即可。
- **运行时数据**：`~/.dsh/subagent-model-limit/config.json`，**不随目录迁移**。要带走就手动拷。

---

## 8. 文件清单

| 文件 | 作用 |
|---|---|
| `lib/index.js` | host 侧全部逻辑（配置解析、模型解析、配额匹配、闸门、拦截、主 agent 计数、HTTP API） |
| `lib/client.js` | 插件管理页的配置面板（`plugins.bundle.config`） |
| `cordis.patch.yml` | bundle patch + 首次安装的默认配置 |
| `package.json` | 含 `dsh.bundle.patch` 与 `dsh.client` 声明、`./client` export |
| `test/model-resolution.test.mjs` | 16 个单测 |
| `test/fake-upstream.mjs` | 可控慢上游 |
| `test/overlay-model-selection.yml` | 让「按模型指定子代理模型」可用的完整 overlay（带逐条注释） |
