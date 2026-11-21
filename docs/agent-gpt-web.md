# ChatGPT 浏览器渠道与视频解析 · 操作指南（agent 用）

> 本文是 **agent 操作类文档**，随仓库公开。本仓库不收录提示词编制类材料（提示词模板、
> 写作指南、案头素材），那些内容留在 `.gitignore` 排除的 `skills/`、`prompts/` 下。
>
> 本文继承自早期 AICD 工作区的 `gpt-web` 本地技能文档，已按本 bundle 的实际工具名重写；
> 旧文档里的 `gpt <子命令>` CLI（`D:\projects\AICD\gpt.cmd`）不在本仓库，路径已失效，相关内容删除。

## 何时用

用户要求「用 ChatGPT 网页生成/修改图片」「分析本地视频画面」时，用本 bundle 的工具，
**不要**用通用浏览器工具自己去点 chatgpt.com。

## 前置条件

- DSH 0.2.2 系列、Node ≥ 20。
- 浏览器渠道：Chrome 已登录 <https://chatgpt.com>，并装有 DSH-Browser-Control 扩展；
  本地桥 `http://127.0.0.1:9777`（预设里 `bridgeUrl` / `token` 已有默认值）。
- 视频工具：ffmpeg（推荐，`ffmpegPath` 可配置）；没有时 `video_probe` / `video_frames`
  回退到 Chrome。
- 生图端点渠道（可选）：模型与 key 在 设置 → 插件 → Pixmax Workflow 里配置，
  key 存 DSH 凭据中心（`PIXMAX_WORKFLOW_IMAGE_<PROVIDER>_API_KEY`）。

## 工具入口

预设「AI 视频工作流」自带全部工具；其他预设看不到，需要手动把工具行加进去。

| 工具 | 用途 |
| --- | --- |
| `model_list` | 列出可用生图模型、端点、默认模型、key 是否已配 |
| `image_generation` | 生成 / 修改图片 |
| `video_probe` / `video_frames` / `video_scenes` / `video_sheet` | 视频探测、截帧、镜头切点、总览图 |
| `pixmax` | Pixmax CLI 的零积分操作（详见 README） |

## 生图

`image_generation` 必须给 `prompt`；渠道由 `model` 决定（不传 = 设置页默认模型）：

- `browser/gpt-image-2`：ChatGPT 网页版，免 key、用网页额度、支持参考图与改图、
  分钟级、可能被 Cloudflare 拦截、输出固定 PNG。
- 其他 OpenAI 兼容端点（例如 `sensenova/sensenova-u1.5-lite`）：按张计费、秒级、
  支持 1–5 张参考图、`size` 支持 512–4096（32 倍数）/ 2K / 4K、`format` 可选 png/jpeg/webp。

```text
image_generation prompt="一张蓝色马克杯的产品摄影，纯白背景"
image_generation prompt="改成水彩风格，保留轮廓" ref=["D:/pics/ref.png"] out="D:/pics/out.png"
```

参数：`prompt`（必填）、`model`、`ref`（参考图路径数组）、`out`、`size`、`format`、
`watermark`、`timeout`（默认 300 秒）、`background`。

- 产物默认落在 `<root>/images/<时间>-<摘要>.<format>`；`<root>` = `DSH_GPT_ROOT`，
  未设置时为 `~/.dsh/gpt-web`。
- 浏览器渠道的 `size` 只作为文字提示写进 prompt；端点渠道才真正设置尺寸。
- 网页生成返回 PNG；免费额度用尽时会报错。

## 异步（不阻塞对话）

生成可能几分钟：不急时用 `background: true`。

```text
image_generation prompt="..." background=true → job_id
```

- 立即返回 `job_id`，完成后会收到会话内通知。
- `job_output job_id=...` 读结果；`job_kill job_id=...` 取消。
- 依赖 `dsh-tool-jobs`（预设自带）；任务只在 DSH 进程内。

## 视频解析

```text
video_probe  path=...                       # 时长 / 分辨率 / 帧率 / 编码
video_frames path=... every=2               # 每 2 秒一帧
video_frames path=... times=["3","00:12"]   # 指定时间点
video_frames path=... frames=[96,120]       # 指定帧号（需 ffmpeg）
video_scenes path=... threshold=0.25        # 镜头切点
video_sheet  path=... cover=true            # 一张总览图
```

- 默认走 ffmpeg；没有 ffmpeg 时探测与截帧回退 Chrome。
- 帧 / 总览图作为图片块附加到当前会话，会话模型需声明 image 输入。
- 单次最多 16 帧；`width` 只缩小不放大；`max_frames` 是上限不是配额。

## 注意

1. **不要用浏览器工具自己点 chatgpt.com** —— 用本 bundle 的工具。
2. **串行**：浏览器渠道同一时间只跑一个调用（后台 job 也不行，桥接一次只做一个动作）。
3. 当前网络下新开 chatgpt.com 标签页可能被 Cloudflare 拦截；已有标签页可正常发送，
   必要时复用现有标签页（`reuseExistingTab`，预设默认开）。
4. 对话会出现在你自己的 ChatGPT 历史里；介意就自行删除。
5. 把 ChatGPT 网页版当自动化接口批量调用不符合其服务条款取向，请自行控制频率与风险。
