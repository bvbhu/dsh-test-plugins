# dsh-quilt-compact

把「整段历史一次摘要」换成分块摘要 → 归并的分层压缩，并在结果里写入会话搜索锚点。

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-test-plugins#dsh-quilt-compact
```

不禁用宿主压缩、不替换 `ctx.compaction`、不注册 adapter；任一步失败都回退到宿主原摘要。

详细说明：[DETAILS.md](DETAILS.md)（English: [DETAILS.en.md](DETAILS.en.md)）。
