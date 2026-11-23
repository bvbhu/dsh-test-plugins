/**
 * 基于 node:http 的网关服务面 —— **只做路由分发与委托**。
 *
 * 端点集合（组件装配，见 `src/components/api-interface/`）：
 * - `POST /v1/chat/completions` —— OpenAI Chat Completions 语义；
 * - `POST /v1/messages`       —— Anthropic Messages 语义；
 * - `GET  /v1/models`         —— 逻辑模型 + 真实模型并列（本文件提供，
 *   因为它依赖注入的 `modelProvider`，不属任何「线格式」）。
 *
 * 两个 POST 端点的处理逻辑已整体抽到 `src/components/api-interface/`：
 * 本文件只负责
 *
 * 1. **路由形状**（未注册路径 404 / 方法不匹配 405，均在鉴权之前 ——
 *    Starlette 对已注册路径的 `Depends(require_key)` 行为）；
 * 2. **鉴权**（`requireKey`，`/v1/*` 全部走同一套）；
 * 3. **委托**（`applyApiInterface(deps).routeOf(path).handle(req, res)`）；
 * 4. **统一错误出口**（`GatewayHttpError` / `UpstreamError` → HTTP，见 http.ts）。
 *
 * 上游 **没有**的端点不臆造（test_gateway_e2e §0 钉死 `/health` 与
 * `/api/scheduler` 均已移除，2026-10-12）：
 * - ~~POST /v1/completions~~、~~POST /v1/embeddings~~、~~GET /health~~
 *   —— TODO(阶段二 DSH 形态若需要再议,需先在参考实现侧补语义)。
 *
 * 错误映射（实现见 `http.ts`，形状与拆分前逐字节一致）：
 * - 上游 {@link UpstreamError} → `{"detail": {"error": {"type": kind, "message": detail}}}`
 *   + `Retry-After` 头（`_as_http`，app.py:2327-2343）；
 * - 并发全忙(all_busy) → 503 `{"detail": {"error": {"type": "capacity", ...}}}`
 *   （`_busy_or_upstream`，app.py:2314-2318，不带 Retry-After —— 不排队就没承诺）；
 * - 已开流之后上游失败 → **不改状态码**（响应头已出去，Starlette 的
 *   "response already started" 教训，test_stream_interrupt.py）：让流断在那里。
 *
 * 客户端断开：`clientDisconnectSignal`（sse.ts）→ 中止上游迭代；未发字节前的
 * 断开直接结束请求。**零第三方依赖**：只用 node: 内建。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { requireKey } from "./auth.js";
import {
  GatewayHttpError,
  sendJson,
  upstreamErrorToHttp,
} from "./http.js";
import { UpstreamError, type GatewayOptions } from "./types.js";
import {
  applyApiInterface,
  type ApiInterface,
} from "../../src/components/api-interface/index.js";

// ---------------------------------------------------------------------------
// 稳定对外出口（拆分前由本文件定义，宿主/测试/桌面端仍按原路径 import）
// ---------------------------------------------------------------------------

export {
  BUSY_DETAIL,
  GatewayHttpError,
  REQUEST_LEVEL_KINDS,
  allBusyError,
  isRequestLevel,
  readJsonBody,
  sendJson,
  upstreamErrorToHttp,
} from "./http.js";
export { forwardStream } from "../../src/components/api-interface/stream.js";

// ---------------------------------------------------------------------------
// 路由表里非「线格式」的那部分
// ---------------------------------------------------------------------------

async function handleModels(res: ServerResponse, options: GatewayOptions): Promise<void> {
  const entries = await options.modelProvider.listModels();
  sendJson(res, 200, { object: "list", data: entries });
}

function notFound(res: ServerResponse, method: string, path: string): void {
  // 删除探针后,未注册路径就是普通 404(FastAPI `{"detail":"Not Found"}`)。
  sendJson(res, 404, { detail: `Not Found: ${method} ${path}` });
}

function methodNotAllowed(res: ServerResponse, method: string, path: string): void {
  // FastAPI 对已注册路径的方法不匹配回 405 `{"detail":"Method Not Allowed"}`。
  sendJson(res, 405, { detail: `Method Not Allowed: ${method} ${path}` });
}

// ---------------------------------------------------------------------------
// 服务器
// ---------------------------------------------------------------------------

export function createGatewayServer(options: GatewayOptions): Server {
  // 装配对外 API 接口：两个端点 + 注入依赖（不 import router/scheduler）。
  const api: ApiInterface = applyApiInterface({
    resolveUpstream: options.resolveUpstream,
    deriveSessionId: options.deriveSessionId,
    logger: options.logger,
    onRequestDone: options.onRequestDone,
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res, options, api);
  });
  // 客户端断开时不要再往死连接写(SSE 半途断开会很常见)
  server.on("clientError", (err, socket) => {
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      void err;
    }
  });
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
  api: ApiInterface,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method ?? "GET").toUpperCase();

  // ---- 1. 路由形状(先于鉴权 —— Starlette 的行为:未注册路径/方法不匹配
  //         在 Depends(require_key) 之前就返回 404/405) ----
  const isModels = path === "/v1/models";
  const apiRoute = isModels ? undefined : api.routeOf(path);
  if (!isModels && apiRoute === undefined) {
    // TODO(阶段二再议,不在本阶段臆造):POST /v1/completions、POST /v1/embeddings、
    // /health —— 上游均未实现(test_gateway_e2e §0:/health 已移除 404)。
    notFound(res, method, path);
    return;
  }
  if (isModels && method !== "GET") {
    methodNotAllowed(res, method, path);
    return;
  }
  if (apiRoute !== undefined && method !== apiRoute.method) {
    methodNotAllowed(res, method, path);
    return;
  }

  try {
    // ---- 2. 鉴权(require_key;/v1/* 全部走,对齐 FastAPI Depends) ----
    const denied = requireKey(req, options.keyProvider);
    if (denied) {
      sendJson(res, denied.status, denied.body);
      return;
    }

    // ---- 3. 委托 ----
    if (isModels) {
      await handleModels(res, options);
      return;
    }
    await apiRoute!.handle(req, res);
  } catch (exc) {
    if (res.writableEnded) return;
    if (exc instanceof GatewayHttpError) {
      // rawBody = 上游原文(原样透传时才有):sendJson 优先写它。
      sendJson(res, exc.status, exc.body, exc.headers, exc.rawBody);
      return;
    }
    if (exc instanceof UpstreamError) {
      // 统一 kind→HTTP 映射(_as_http 口径)。请求级错误(bad_request /
      // auth_challenge)与其它 kind 在这里都只是映射 —— 换档循环属于注入方:
      // 未发字节的失败若要换档,应由注入方在 Upstream 实现内完成。
      const mapped = upstreamErrorToHttp(exc);
      sendJson(res, mapped.status, mapped.body, mapped.headers, mapped.rawBody);
      return;
    }
    options.logger?.error?.("[gateway] internal error", exc);
    sendJson(res, 500, { detail: "Internal Server Error" });
  }
}

/** 便利启动:listen 随机端口(loopback)。返回实际端口。 */
export function startGateway(
  options: GatewayOptions,
  listenOpts: { host?: string; port?: number } = {},
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createGatewayServer(options);
  const host = listenOpts.host ?? "127.0.0.1";
  const port = listenOpts.port ?? 0; // 0 = 随机端口(loopback shim 形态)
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        server,
        port: actualPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}
