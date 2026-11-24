# dsh-local-app

启动一个本地进程，用正则逐行抓取它输出里的 URL（通常带 key / token），等这个 URL
真的能应答，然后在 DSH Web UI 里渲染该页面。**除此之外不做任何事** —— 不注册工具、
不监听会话事件、不写存储。

## 它解决什么问题

本地服务的地址经常不是静态的：端口由 OS 分配、路径带一次性 token。把地址写进配置
等于每次重启都改一遍；而 **key 天然就在 URL 里**，抓行的过程同时把凭据带出来了 ——
不需要额外的凭据通道，也不需要落盘。

## 入口（三处，全部可选）

| 入口 | 槽位 | 说明 |
|---|---|---|
| 侧栏行 + 主面板 | `sidebar.panellist` / `main` | 完整面板：状态徽标 + 启停按钮 + iframe |
| 插件配置页 | `plugins.bundle.config`（key = `dsh-local-app`） | 插件详情页里的同一块面板 |
| 设置页「常规」 | `settings.general.item` | 只有状态 + 启停 + 打开，不放 iframe（那里是单行容器） |

## 安装

```powershell
dsh plugin --profile desktop add link:D:/projects/dsh-local-app
# 重启 DSH 生效（bundle 语义必须重启）
```

手动安装（当 CLI 因文件锁失败时）：

1. 把本目录复制/链接到 `C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-local-app`
2. 在 `cordis.patch.yml` 末尾追加：
   ```yaml
   - insert:
       - id: dsh-local-app
         name: 'dsh-local-app'
   ```
3. 重启 DSH

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 定向覆盖。**注意：patch 的 `config` 是整行
替换，不是深合并 —— 覆盖时必须把要保留的字段一并写全。**

```yaml
- id: dsh-local-app
  config:
    argv: ["D:/apps/mine/server.exe", "--serve"]
    cwd: "D:/apps/mine"
    urlExtractRegex: '(?<url>https?://\S+)'
    successMarkerRegex: ''
    fixedUrl: "http://127.0.0.1:4000/"
    probeFirst: true
    autoStart: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `argv` | `[]` | 启动命令（数组，不经 shell 插值）。空数组 = 不托管进程，只渲染 `fixedUrl` |
| `cwd` | `''` | 子进程工作目录；空 = 宿主当前目录 |
| `env` | `{}` | 额外环境变量 |
| `urlExtractRegex` | `(?<url>https?://\S+)` | 抓 URL 的正则，建议保留命名组 `(?<url>...)` |
| `successMarkerRegex` | `''` | 成功标志正则。**空串 = 禁用**（空模式匹配任意行，会导致"第一行即就绪"） |
| `fixedUrl` | `''` | 抓不到 URL 时的固定地址，同时是启动前的探活地址 |
| `probeFirst` | `true` | 启动前先探活，已在线则**接管** |
| `autoStart` | `true` | 插件加载即拉起 |
| `killOnDispose` | `true` | 插件卸载时终止自己拉起的进程 |
| `panelHeight` | `min(720px, 82vh)` | iframe 高度 |
| `openInNewTab` | `false` | 改为新标签打开（目标页拒绝被嵌时的退路） |

所有字段都标了 `.volatile()`：设置页里改它们免重载。

## 状态机

```
idle ──start──▶ probing ──可应答──▶ adopted（别人的进程：只接管，不杀，停止按钮隐藏）
                  │
                  └──不可达──▶ launching ──抓到 URL──▶ readying ──▶ ready
                                    └─超时 / 提前退出 / 异常──▶ failed
```

"接管"不是防御性代码而是必需的：如果服务已经在跑，盲目再 spawn 一个会撞端口；把
别人的进程当自己的杀掉更糟。

## 路由

单条前缀路由 `/lapp/api`，每个请求先过 `connection.requestRejection` 认证闸（401/403
照传，认证服务不可用按 503 拒绝）。方法一律 `POST` + JSON：

| 路径 | 语义 |
|---|---|
| `status` | 当前状态（含 `owned`，浏览器据此决定是否显示"停止"） |
| `start` / `stop` / `restart` | 启停 |
| `logs` | 进程输出尾部 |

浏览器侧的 fetch 一律用**文档相对**路径 `lapp/api/...`（服务的 index 带
`<base href="./">`，根绝对路径在带前缀的代理后会 404）。

## 安全

- **凭据清理**：交给子进程的环境先过滤 `KEY|PASSWORD|SECRET|TOKEN` 与 `DSH_*`。
- **不落盘**：抓到的 URL（含 key）只在内存里活到交给浏览器那一刻，不进配置、不进日志。
- **认证闸**：webserver 绑 `0.0.0.0` 时，无鉴权的"启停进程"接口等于远程代码执行入口。
- **只杀自己的进程**：`adopted` 状态下 `stop()` 是空操作。

## 已知边界

- 从局域网设备打开时，URL 里的 `127.0.0.1` 是**该设备自身**的回环，必然加载失败 ——
  这是限制不是泄露。要跨设备看需要同源反向代理，本版不做。
- 目标页若设了 `X-Frame-Options` / CSP `frame-ancestors`，iframe 会被拒；把
  `openInNewTab` 设为 `true` 即可。

## 自检

```powershell
node .smoke/run.mjs      # Supervisor 全链路（抓行 → 等应答 → 停止 → 接管）
node .smoke/client.mjs   # 浏览器半的注册契约（三个入口槽位）
```
