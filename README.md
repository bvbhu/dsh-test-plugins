# Forever midnight · 永恒深夜

把 DSH 注入的 `time-context` 时间戳映射到可配置的深夜时段（只改模型可见的那行时间，不动系统时钟）。

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-test-plugins#dsh-forever-midnight
```

装完**新开会话**才生效（监听器在 agent 创建时挂载）。

详细说明见 [DETAILS.md](DETAILS.md)。
