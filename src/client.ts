/**
 * As One(合一)DSH 插件 —— client 半入口。
 *
 * cordis 插件形状(platform "web" 由 package.json 的 dsh.client 声明):
 * 注册 locale 字典、侧栏行(sidebar.panellist)与主面板(main)。
 *
 * 页面本体是共享视图层 @as-one/panel-ui(与 Electron 面板同一套代码);
 * 数据全部走文档相对 fetch(见 ./client/api.ts),不 import 任何宿主/Node 类型。
 */

import { bindPanelBridge } from "./client/api.js";
import { startChimePoller } from "./client/chime.js";
import { injectAsOneStyles } from "./client/styles.js";

import type { Context } from "./client/context.js";
import { LOCALE_NS, en, zh } from "./client/locales.js";
import { AsOnePanelIcon, AsOnePanelPage } from "./client/panel.js";
import { AsOneCurrentModelBadge } from "./client/routeBadge.js";
import { SubagentModelSelect } from "./client/subagent-model-select.js";

// 共享面板样式内联注入(幂等)+ 数据桥接到 HTTP 路由,使 lib/client.js 自包含。
injectAsOneStyles();
bindPanelBridge();

export const BUNDLE_NAME = "@bvbhu/as-one";
export const PANEL_ID = "as-one";
export const PANEL_ORDER = 30;

export const name = "@bvbhu/as-one/client";

/** client 侧依赖的服务座位(与 dsh.client.inject 的包一致)。 */
export const inject = ["slots", "locale"];

export function apply(ctx: Context, _config: Record<string, unknown> = {}): void {
  // ── locale 字典 ─────────────────────────────────────────────
  ctx.effect(() => ctx.locale.register(LOCALE_NS, "zh-CN", zh));
  ctx.effect(() => ctx.locale.register(LOCALE_NS, "zh", zh));
  ctx.effect(() => ctx.locale.register(LOCALE_NS, "en", en));
  const t = ctx.locale.bind(LOCALE_NS);

  // ── 提示音轮询(dsh-chime 合并)──────────────────────────────
  // bot-notify 行(host 半)发通知时入队音效,这里每 250ms 取走播放。
  ctx.effect(startChimePoller, "as-one chime poller");

  // ── 侧栏行 + 主面板 ─────────────────────────────────────────
  ctx.effect(() =>
    ctx.slots.inject("sidebar.panellist", () =>
      ctx.slots.register(
        { name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: () => t("nav"), locale: LOCALE_NS },
        AsOnePanelIcon,
      ),
    ),
  );
  ctx.effect(() =>
    ctx.slots.inject("main", () =>
      ctx.slots.register(
        { name: "main", key: PANEL_ID, locale: LOCALE_NS },
        AsOnePanelPage,
      ),
    ),
  );
  // 输入框**内部**的工具行:显示这个会话**当前请求**实际使用的真实模型。
  // 槽位与 dsh-connect 系列同一格(`conversation.input.left`,list 型、会话作用域),
  // `order` 排在 dsh-connect 的积分读数(4)之后,读起来是「模型在前、额度在后」。
  //
  // ⚠️ **不要在这里给 inject**:会话作用域的 `BUILTIN_SOURCE`
  // (`dsh-client-ui-session/lib/client.js`) 已经会把 `{ sessionId }` 与
  // `useProjection` 作为框架标准属性发给每个条目。再写一个
  // `inject: (sessionId) => ({ sessionId })` 只会让「宿主是否给 inject 传参」
  // 这个实现细节决定 `props.sessionId` 是真是假 —— 传空就把它覆盖成 undefined,
  // 徽标从此静默消失(不报错,最难查的那种)。
  ctx.effect(() =>
    ctx.slots.inject("conversation.input.left", () =>
      ctx.slots.register(
        {
          name: "conversation.input.left",
          id: "as-one-current-model",
          order: 5,
          locale: LOCALE_NS,
        },
        AsOneCurrentModelBadge,
      ),
    ),
  );
  // continuation 子代理会话的模型选择器:原生选择器对子代理会话硬禁用,
  // 这里自建一个视觉/交互一模一样的控件。组件内部用 useProjection('subagent')
  // 判断 mode==='continuable' 才渲染,one-shot / unknown / 普通会话一律返回 null。
  // 位置放在输入框**右下角**的 `conversation.input.right`(提交按钮前的紧凑控件,
  // list 型、会话作用域)—— 与 DSH 原生模型选择器的位置一致,而原生那个 seat 是
  // single 且被硬禁用,subagent 会话里是空的,这里补一个自建的。
  // order 必须大于 musicpanel 的 `music-composer-cluster`(order 10,同一 right 槽):
  // right 内按 order 升序排,原生模型槽`conversation.input.model`又在 right 之后,
  // 子代理里原生模型返回 null,所以「right 槽最后一项」才占据原生模型的位置。
  // 之前 order 6 < 10 让选择器排在音乐控件前面,比父会话原生模型左移了一整块
  // 音乐控件宽度;设 11 后顺序变成 音乐 → 本选择器,和父会话视觉对齐。
  ctx.effect(() =>
    ctx.slots.inject("conversation.input.right", () =>
      ctx.slots.register(
        {
          name: "conversation.input.right",
          id: "as-one-subagent-model",
          order: 11,
          locale: LOCALE_NS,
        },
        SubagentModelSelect,
      ),
    ),
  );
}
