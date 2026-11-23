/**
 * 「对外 API 接口」子组件 —— 装配入口。
 *
 * ## 职责边界
 *
 * 本组件只做**对外线格式**：OpenAI Chat Completions 与 Anthropic Messages 的
 * 请求解码、响应/流式编码、以及两者共用的 SSE 骨架。选路 / 并发 / 换档 /
 * 凭据全部走注入依赖（{@link ApiInterfaceDeps}），**不 import**
 * router/scheduler/连接器 —— 与 `core/gateway/types.ts` 的注入边界一致。
 *
 * 两条语义收敛到**同一条内部链路**：
 *
 *     chat body        → UpstreamRequest ─┐
 *                                          ├→ router → scheduler → adapter
 *     messages body → BlockRequest + chat →┘
 *
 * 公开的装配函数是 {@link applyApiInterface}：把 `chat` 与 `message` 两个
 * handler 装成一张路由表，网关（`core/gateway/server.ts`）按路径分发委托，
 * 宿主（`src/routes.ts`）也可以 `mount()` 到 `ctx.webServer`。
 *
 * @module src/components/api-interface
 */

import { handleChatCompletions } from "./chat.js";
import { handleMessages, MESSAGES_PATH } from "./message.js";
import type {
  ApiInterface,
  ApiInterfaceDeps,
  ApiRoute,
} from "./types.js";

export { handleChatCompletions, toUpstreamRequest } from "./chat.js";
export {
  handleMessages,
  fromAnthropicRequest,
  toMessagesUpstreamRequest,
  toAnthropicMessage,
  createAnthropicSseCodec,
  anthropicUsageFrom,
  stopReasonOf,
  newMessageId,
  MESSAGES_PATH,
  type AnthropicInbound,
  type AnthropicMessage,
  type AnthropicContentBlock,
  type AnthropicUsage,
} from "./message.js";
export {
  chatSseCodec,
  forwardSseStream,
  forwardStream,
  sseEventFrame,
  type OnStreamResult,
  type SseStreamCodec,
  type StreamOutcome,
} from "./stream.js";
export type {
  ApiHttpRequest,
  ApiHttpResponse,
  ApiInterface,
  ApiInterfaceDeps,
  ApiRoute,
  ApiRouteHandler,
} from "./types.js";

/** OpenAI Chat Completions 端点的路径（路由表与宿主挂载共用）。 */
export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/**
 * 装配对外 API 接口。
 *
 * @param deps 注入依赖（选路 / 会话派生 / 日志 / 请求完成记账）
 * @param mount 可选的注册器：给了就立刻把每个端点交出去（宿主 webServer 形态）
 * @returns 路由表 + `routeOf` / `mount`，供网关按路径分发
 */
export function applyApiInterface(
  deps: ApiInterfaceDeps,
  mount?: (route: ApiRoute) => void,
): ApiInterface {
  const routes: ApiRoute[] = [
    {
      method: "POST",
      path: CHAT_COMPLETIONS_PATH,
      handle: (req, res) => handleChatCompletions(req, res, deps),
    },
    {
      method: "POST",
      path: MESSAGES_PATH,
      handle: (req, res) => handleMessages(req, res, deps),
    },
  ];
  const byPath = new Map(routes.map((route) => [route.path, route]));

  const api: ApiInterface = {
    routes,
    routeOf: (path) => byPath.get(path.replace(/\/+$/, "") || "/"),
    mount(register) {
      for (const route of routes) register(route);
    },
  };
  if (mount) api.mount(mount);
  return api;
}
