# dsh-local-app

托管一个本地进程，从它的输出里抓出带 token 的 URL，等它能应答后在 DSH Web UI 里直接渲染该页面。不注册工具、不写存储。

```sh
dsh plugin --profile <name> add github:bvbhu/dsh-test-plugins#dsh-local-app
```

重启 DSH 后，侧栏、插件页、设置页三处入口都会出现状态与启停按钮。

详细说明见 [DETAILS.md](DETAILS.md)。
