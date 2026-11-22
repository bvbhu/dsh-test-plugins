# dsh-subagent-model-limit

按**模型**限制 DeepSeek Harness 的 subagent 并发数。超限时**拦截调用**并返回可读的并发限制信息，而不是让请求打到上游再失败。

## 为什么不用现成插件

社区已有两个相关插件，但都不满足「按模型配不同配额」：

| 插件 | 上限形态 | 差距 |
|---|---|---|
| `dsh-subagent-concurrency-limit` | 进程级**一个数字**（`maxConcurrentSubagents`） | 所有模型共用一个上限 |
| `dsh-concurrency-guard` | 挂在 `llm/stream` 统计全部在途请求 | 限的是「发出去的请求」，不是「能建几个 subagent」 |

本插件的上限是**每个模型一份**：`auto` 给 2、`glm-5.3-flash` 给 1、其余给 4，互不挤占。

## 装法

```sh
dsh plugin --profile web add <本目录路径>
```

装完在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里配置（本仓库的 `cordis.patch.yml` 已带一份默认值，会被 profile 的 patch 层覆盖）：

```yaml
- id: subagent-model-limit
  name: dsh-subagent-model-limit
  config:
    defaultLimit: 4
    limits:
      'as-one/auto': 2
      'as-one/glm-5.3-flash': 1
      'glm-5.3-flash': 2      # 不写 provider 也行，按裸模型名匹配
      '*': 4
    subagentToolNames: [subagent, subagent_fork]
    queueTimeoutMs: 0
```

重启 profile 生效。卸载：`dsh plugin --profile web remove subagent-model-limit`。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `defaultLimit` | `4` | 没有单独配置的模型使用的上限 |
| `limits` | `{}` | 模型 → 上限。键可为 `provider/model`、裸 `model`、`*` |
| `subagentToolNames` | `[subagent, subagent_fork]` | 需要拦截的工具名（工具被改过名就在这里同步） |
| `queueTimeoutMs` | `0` | `0` = 超限**立即拒绝**；`>0` = 最多排队这么久（当前实现按拒绝处理，保留字段） |

## 它怎么判断「这次 subagent 用哪个模型」

按顺序取第一个命中的：

1. **工具参数**里的 `provider` / `model`（`dsh-tool-subagent` 开启 `modelSelection` 时才有）；
2. **父会话当前模型** `exec.agent.model.current()` —— 默认走这条（`modelSelection` 关闭时子代理继承父模型）；
3. 兜底键 `*`。

配额匹配也是从细到粗：`provider/model` → `model` → `*` → `defaultLimit`。

## 拦截行为

超限时抛出 `SubagentModelLimitError`（`code: 'SUBAGENT_MODEL_CONCURRENCY_LIMIT'`），模型看到的是：

> subagent 未创建：模型 as-one/auto 的子代理并发已达上限（2/2）。当前可用槽位 0 个。
> 请等待已有子代理结束后重试，或直接在当前会话完成这部分工作。（本插件不排队：超限即拒绝，不会挂起调用）

同时注册一个只读工具 **`subagent_slots`**，让模型「先问再建」：

```json
{ "model": "as-one/auto", "limit": 2, "used": 2, "remaining": 0, "text": "模型 as-one/auto：子代理上限 2，已用 2，当前还能创建 0 个。" }
```

> 若宿主版本的 `ctx.tools.register` 签名不同，注册会失败并降级（只损失主动查询，**准入拦截不受影响**）。

## 计数边界

- 计数单位 = **一次已准入、尚未结束**的 subagent；`subagent/end` 时归还。
- 工具调用失败（没起子代理）会**当场归还**，不会占着配额。
- 父 Agent 被销毁时，尚未被 `subagent/start` 认领的许可证会兜底归还，避免配额泄漏。
- **只统计经 `subagent` 工具发起的**。workflow 里的 `agent()` 不走这条链路；要覆盖它请用 `dsh-concurrency-guard` 那类挂在 `llm/stream` 的插件。

## 测试：配一个「假上游」

`test/fake-upstream.mjs` 是一个 OpenAI 兼容的慢上游，只做一件事：**从输入文本匹配时间 → 调 `wait` 工具等那么久 → 结束**。

```sh
node test/fake-upstream.mjs --port 4999          # 默认 3 秒
node test/fake-upstream.mjs --default 10         # 没写时间的请求等 10 秒
```

发一条带时间的消息即可复现「子代理占用 N 秒」：

```js
await fetch('http://127.0.0.1:4999/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'fake-slow',
    messages: [{ role: 'user', content: '请等 2 秒再继续' }],
  }),
})
// → 2.0s 后返回 tool_calls: [{ function: { name: 'wait', arguments: '{"seconds":2}' } }]
```

把它配成 as-one 的上游 provider（`protocol: openai`，`base_url: http://127.0.0.1:4999/v1`），
然后在 DSH 里让模型连续起子代理，就能复现「并发被配额挡住」的完整链路。

支持的写法：`等 5 秒` / `5秒` / `5s` / `sleep 5`。

## 已知限制

- **模型归属是「父会话当前模型」**，不是子代理真实使用的模型。因为 `subagent/start` 事件只带 `provider`，没有 model；子代理继承父模型时两者一致，开启 `modelSelection` 后以参数为准。
- 不做 FIFO 排队（`queueTimeoutMs` 目前只做记录）。要排队请用 `dsh-subagent-concurrency-limit`。
- 多 worker / 多进程下每个进程各算一份 —— 与 DSH 的进程内账本语义一致，别在集群模式复用。

## License

MIT
