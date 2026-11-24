# dsh-subagent-model-limit

按模型限制 subagent 并发数（四级配额匹配：`provider+model` → `provider/*` → `*/model` → `*/*`），超限直接拒绝并返回可读原因。

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-test-plugins#dsh-subagent-model-limit
```

设置页「插件 → 子代理并发上限」可改配额；配置落 `~/.dsh/subagent-model-limit/config.json`。

详细说明见 [DETAILS.md](DETAILS.md)；开发交接见 [HANDOFF.md](HANDOFF.md)。
