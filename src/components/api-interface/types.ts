/**
 * 对外 API 接口组件的**端口契约** —— 请求/响应/事件形状。
 *
 * ## 这个组件是干什么的
 *
 * 网关对外提供两种调用方式，语义不同但内部链路只有一条：
 *
 * - **OpenAI Chat Completions**（`chat.ts`）—— `/v1/chat/completions`；
 * - **Anthropic Messages**（`message.ts`）—— `/v1/messages`。
 *
 * 两者都收敛到 `BlockRequest` / `UpstreamRequest` → router/scheduler/adapter，
 * 不存在第二条上游链路。本文件只声明「谁被注入进来」「handler 长什么样」，
 * 不含任何运行时逻辑（契约与实现分开，handler 才能被单测直接驱动）。
 *
 * @module src/components/api-interface/types
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ChatCompletionRequest,
  RequestDoneInfo,
  Upstream,
} from "@as-one/core/src/gateway/types.js";

/** 入站 HTTP 请求（node:http；宿主 webServer 的 req 与之结构兼容）。 */
export type ApiHttpRequest = IncomingMessage;

/** 出站 HTTP 响应（node:http；SSE 直写靠它）。 */
export type ApiHttpResponse = ServerResponse;

/** 一个对外端点的处理函数。 */
export type ApiRouteHandler = (req: ApiHttpRequest, res: ApiHttpResponse) => Promise<void>;

/** 组件日志口（`info` 可缺：宿主路由的 logger 只有 warn/error）。 */
export type ApiLogger = Pick<Console, "warn" | "error"> & {
  info?: (...data: unknown[]) => void;
};

/** 一个对外端点：方法 + 路径 + handler。 */
export interface ApiRoute {
  readonly method: "POST";
  readonly path: string;
  readonly handle: ApiRouteHandler;
}

/**
 * 组件的注入依赖 —— 组件**不 import** 任何 router/scheduler/连接器：
 * 选路、并发、换档、凭据全部由注入方实现（与 `GatewayOptions` 同一边界）。
 */
export interface ApiInterfaceDeps {
  /** 模型 → 上游适配器；未知模型返回 `undefined`（→ 404）。 */
  resolveUpstream(model: string): Upstream | undefined;
  /**
   * 会话亲和 id 派生（可选）。
   *
   * Messages 入站会先解码成同一份 chat IR 再调它 —— 两个端点因此共享
   * 完全相同的会话派生口径（`sessionIdOf` 只看 `messages`，两种形状都吃）。
   */
  deriveSessionId?(body: ChatCompletionRequest): string | undefined;
  /**
   * 选路前的异步钩子（可选）—— 宿主用它做「先更新额度到期时间，再调度」。
   * 抛错原样上抛，交给外层错误出口。
   */
  beforeResolve?(): Promise<void> | void;
  /**
   * 请求前闸（可选）：返回 `true` = 已写响应并终止本次处理。
   * 宿主用它做渠道级熔断（例如 WorkBuddy 11140 后整渠道拒绝）。
   */
  guard?(model: string, req: ApiHttpRequest, res: ApiHttpResponse): boolean;
  /**
   * 失败钩子（可选）：上游/内部失败在**重新抛出前**调用一次。
   * 宿主用它触发渠道熔断；它抛错不得掩盖原错误（组件内部吞掉并记日志）。
   */
  onFailure?(exc: unknown): Promise<void> | void;
  logger?: ApiLogger;
  /** 请求完成钩子（请求日志/统计的唯一入口，语义同 `GatewayOptions`）。 */
  onRequestDone?(info: RequestDoneInfo): void;
  /**
   * Messages 响应 id 生成器（`msg_…`）。测试注入定值，
   * 生产缺省按时间 + 随机生成，**不参与路由**。
   */
  newMessageId?(): string;
}

/** 装配好的对外 API 接口。 */
export interface ApiInterface {
  /** 已注册的全部端点（顺序即声明顺序）。 */
  readonly routes: readonly ApiRoute[];
  /** 按路径取端点（忽略方法；405 判定由调用方做）。 */
  routeOf(path: string): ApiRoute | undefined;
  /** 把每个端点交给注册器（宿主 webServer 挂载 / 网关路由表装配）。 */
  mount(register: (route: ApiRoute) => void): void;
}
