/**
 * 网关 HTTP 面**公共原语** —— 错误体映射 + 请求体读取 + JSON 写出。
 *
 * ## 为什么从 server.ts 拆出来
 *
 * 「对外 API 接口」组件(`src/components/api-interface/`)要按 OpenAI Chat 与
 * Anthropic Messages 两种语义各自解码/编码，但它们共用的**错误映射与读写原语**
 * 必须只有一份：错误体形状(`{"detail": …}`)、状态码、`Retry-After` 头、
 * `rawBody` 逐字透传 —— 任何一处分叉都会让两个端点对同一个上游错误给出
 * 不同的答复。
 *
 * 拆到这里之后 `server.ts` 只剩「路由分发 + 委托」，组件侧直接 import 本文件
 * 即可，**不产生 core → src → core 的循环依赖**。
 *
 * ⚠️ 零第三方依赖：只用 `node:` 内建。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  UpstreamError,
  UpstreamErrorKind,
  type GatewayErrorBody,
} from "./types.js";

/** 并发全忙提示(app.py:76 BUSY_DETAIL,2026-10-13 定:不排队、不带 Retry-After)。 */
export const BUSY_DETAIL =
  "并发已满:该模型当前所有档位的并发上限都已占满,请稍后重试";

/** 注入方可声明的请求级错误(对齐 `_REQUEST_LEVEL_KINDS`:换成员也必然同样失败)。 */
export const REQUEST_LEVEL_KINDS: ReadonlySet<string> = new Set([
  UpstreamErrorKind.BadRequest,
  UpstreamErrorKind.AuthChallenge,
]);

/**
 * 与 errors.py `_REQUEST_LEVEL_KINDS` 同口径:请求本身有问题,不换成员重试。
 * 供注入方在 Upstream 实现内决定「失败前是否换档」——本层只做映射,不换档。
 */
export function isRequestLevel(exc: UpstreamError): boolean {
  return REQUEST_LEVEL_KINDS.has(exc.kind);
}

// ---------------------------------------------------------------------------
// 错误映射(app.py:_as_http / _busy_or_upstream 对应物)
// ---------------------------------------------------------------------------

export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: GatewayErrorBody,
    readonly headers?: Record<string, string>,
    /**
     * 上游原始响应体的**逐字**字节(仅「原样透传」用)。
     *
     * 有它时出口直接写这段字节,不再 `JSON.stringify(body)` —— 上游回的可能是
     * HTML / 纯文本,包一层 `{"detail": "..."}` 就已经是「修改」了。`body` 仍
     * 保留一份可读表示,供请求日志与内部诊断读。
     */
    readonly rawBody?: string,
  ) {
    super(JSON.stringify(body));
    this.name = "GatewayHttpError";
  }
}

/**
 * UpstreamError → 客户端能读懂的 HTTP 错误(app.py:_as_http)。
 *
 * ⚠️ 有上游原件(`exc.raw`)时**逐字透传**:状态码与响应体都照上游的写回去,
 * 一个字符都不改(用户 m36329:「只要上游有返回值,就返回上游返回的原始内容,
 * 不做修改」)。分类器那套「认证失败 — 上游:…」的人话只进请求日志与内部决策,
 * 不上屏 —— 否则客户端看到的是网关的猜测,而它本可以拿到真实答复去自己判断
 * (例如上游 400 里点的具体参数名)。
 *
 * 只有**自造**错误(并发已满、号池耗尽、网络异常 —— 这些根本没有上游答复)
 * 才走 `detail` 的 detail.error 形状。
 */
export function upstreamErrorToHttp(exc: UpstreamError): GatewayHttpError {
  const headers: Record<string, string> = {};
  if (exc.retryAfter !== undefined) {
    headers["Retry-After"] = String(Math.max(1, Math.floor(exc.retryAfter)));
  }
  const raw = exc.raw;
  if (raw !== undefined) {
    const status = Number.isFinite(raw.status) && raw.status >= 400 ? raw.status : exc.httpStatus;
    // 上游给的是 JSON 就还它 JSON(连同原结构),否则按文本原样回。
    const body: GatewayErrorBody =
      raw.json !== undefined
        ? (raw.json as GatewayErrorBody)
        : ({ detail: raw.text } as GatewayErrorBody);
    if (raw.contentType !== undefined && !raw.contentType.startsWith("application/json")) {
      // 非 JSON 的错误体(HTML 网关页 / 纯文本):别假装是 JSON。
      headers["Content-Type"] = raw.contentType;
    }
    // 逐字写回上游原文 —— rawBody 让 sendJson 跳过 JSON.stringify。
    return new GatewayHttpError(
      status,
      body,
      Object.keys(headers).length > 0 ? headers : undefined,
      raw.text,
    );
  }
  return new GatewayHttpError(
    exc.httpStatus,
    { detail: { error: { type: exc.kind, message: exc.detail } } },
    Object.keys(headers).length > 0 ? headers : undefined,
  );
}

/** 整条链都没选出来时的出口(app.py:_busy_or_upstream):all_busy → 503 capacity。 */
export function allBusyError(): GatewayHttpError {
  return new GatewayHttpError(503, {
    detail: { error: { type: "capacity", message: BUSY_DETAIL } },
  });
}

// ---------------------------------------------------------------------------
// 请求体读取
// ---------------------------------------------------------------------------

export async function readJsonBody(
  req: IncomingMessage,
  limitBytes = 64 * 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > limitBytes) {
      throw new GatewayHttpError(413, { detail: "请求体过大" });
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new GatewayHttpError(400, { detail: "请求体不是合法 JSON" });
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
  rawBody?: string,
): void {
  // rawBody 优先:那是上游原文,`body` 只是它的可读影子(见 GatewayHttpError)。
  const payload =
    rawBody !== undefined ? Buffer.from(rawBody, "utf8") : Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    ...headers,
  });
  res.end(payload);
}
