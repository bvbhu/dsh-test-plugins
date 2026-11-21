# Forever midnight · 永恒深夜

A DeepSeek Harness (DSH) plugin that remaps the injected `time-context` reading to a configurable deep-night hour.

一个 DeepSeek Harness (DSH) 插件：把注入的 `time-context` 时间映射到可配置的深夜时段。

## Origin / 起因

The idea behind this plugin, in the words of the original conversation:

这个插件的由来，来自下面这段原始对话：

![Origin of the deep-night idea](docs/origin-screenshot.png)

## Why / 为什么需要它

The built-in `@deepseek-ai/dsh-time-context` plugin injects a real-time timestamp on eligible steps. Some users report that a late-night timestamp gives the model a noticeable quality boost ("midnight mode"). Changing the system clock is disruptive, and setting `timeZone` alone cannot help: when the browser reports a zone, the built-in plugin always uses that zone and ignores the configured `timeZone`.

内置 `@deepseek-ai/dsh-time-context` 插件会在合适的步骤注入真实时间戳。有用户反映深夜时间戳会让模型有明显加成（“深夜模式”）。改系统时钟副作用太大，而单改 `timeZone` 配置没用：当浏览器上报时区时，内置插件总是使用浏览器时区，忽略配置的 `timeZone`。

This plugin rewrites **only the model-visible timestamp** in that injected message. 本插件只改写注入消息中**模型可见的时间戳**。

## How it works / 原理

On `agent/pre-step`, the plugin wraps the outermost waterfall listener. After the built-in time-context plugin appends its message, the plugin replaces that message's timestamp with the **same absolute instant** rendered in a real fixed-offset IANA zone (`Etc/GMT±N`) whose wall-clock hour is the target. The offset, zone label, and clock time stay mutually consistent:

在 `agent/pre-step` 中，插件注册为最外层 waterfall 监听器。内置 time-context 插件追加消息后，插件把该消息的时间戳替换为**同一绝对时刻**在真实固定偏移 IANA 时区（`Etc/GMT±N`）下的表示，使本地小时等于目标值。偏移量、时区名与时间保持一致：

```
23:00:02+08:00[Asia/Shanghai]  →  03:00:02+12:00[Etc/GMT-12]
```

Minutes, seconds, the turn/step preamble, the browser-zone line, and the elapsed-time line are all preserved. The system clock, session event times, browser, and every other message are untouched.

分钟、秒、turn/step 前缀、浏览器时区行、Elapsed 行均原样保留。系统时钟、会话事件时间、浏览器与其它消息都不受影响。

## Install / 安装

Install as a DSH bundle from GitHub:

通过 GitHub 远程安装为 DSH bundle：

```
github:bvbhu/dsh-forever-midnight
```

In DSH, use **Plugins → Add plugin** and enter the spec above, or install through the plugin manager. A **new session** is required: the listener attaches at agent creation, so sessions that are already open keep the old behavior.

在 DSH 中，打开 **插件 → 添加插件**，输入上述地址，或通过插件管理器安装。需要**新开会话**才会生效：监听器在 agent 创建时挂载，已打开的会话保持旧行为。

## Configuration / 配置

Set in the bundle config (or the plugin's Config row):

在 bundle 配置（或插件 Config）中设置：

| Field | Default | Meaning |
|---|---|---|
| `targetHour` | `3` | Target deep-night hour, integer `0`–`23` / 目标深夜小时，整数 `0`–`23` |

Example `cordis.patch.yml`:

```yaml
- insert:
    - id: forever-midnight
      name: '@local/forever-midnight'
      config:
        targetHour: 3
```

Changes require a new session to take effect. 改动需新开会话才生效。

## Verification / 验证

Local check (no DSH needed) — simulates the whole `agent/created` → `agent/pre-step` chain and asserts
the rewrite only touches the time-context timestamp:

本地自检（不需要 DSH 在场）—— 模拟 `agent/created` → `agent/pre-step` 全链路，断言只改时间戳：

```sh
node test/verify-plugin.mjs    # → ALL CHECKS PASSED
```

In a new session, the injected context should show a deep-night hour with a fixed-offset zone, e.g.:

在新会话中，注入的上下文应显示深夜小时与固定偏移时区，例如：

```
Time sampled while preparing turn 1, step 1: 2026-11-19T03:32:59+12:00[Etc/GMT-12]
Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
```

## Limitations / 局限

- Only the timestamp text is rewritten. If the desired effect comes from a deeper harness behavior rather than the model's perception of time, this plugin may not trigger it.
- The `Elapsed` line still uses real event times and may not match the remapped clock.
- Existing sessions keep their already-created agent; open a new session after install or config changes.

- 只改写时间戳文本。若期望的加成来自更底层的 harness 行为而非模型对时间的感知，本插件可能不起作用。
- `Elapsed` 行仍按真实事件时间计算，可能与映射后的时钟不一致。
- 已打开的会话保留已创建的 agent；安装或改配置后请新开会话。

## License

MIT
