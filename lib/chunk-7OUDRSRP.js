// core/gateway/types.ts
var UpstreamErrorKind = {
  RateLimit: "rate_limit",
  Auth: "auth",
  AuthChallenge: "auth_challenge",
  Upstream: "upstream",
  BadRequest: "bad_request",
  Timeout: "timeout",
  Connection: "connection",
  AlreadyStreaming: "already_streaming"
};
var KIND_SPEC = {
  rate_limit: [429, true],
  auth: [401, false],
  auth_challenge: [502, false],
  upstream: [502, true],
  bad_request: [400, false],
  timeout: [504, true],
  connection: [502, true],
  already_streaming: [502, false]
};
var RAW_BODY_MAX = 256 * 1024;
var UpstreamError = class _UpstreamError extends Error {
  kind;
  detail;
  retryAfter;
  /** 上游原始 HTTP 状态码(若有);`_busy_or_upstream` 的 all_cooldown 出口要用。 */
  statusCode;
  /**
   * 上游错误响应的原件(有上游答复时必带)。
   *
   * `upstreamErrorToHttp()` 见到它就**原样**写回客户端的 body + 状态码,
   * `detail` 只在没有原件(自造错误:并发已满、池耗尽、网络异常)时才上屏。
   */
  raw;
  constructor(kind, detail, opts = {}) {
    super(detail || kind);
    this.name = "UpstreamError";
    this.kind = kind;
    this.detail = detail || kind;
    if (opts.retryAfter !== void 0) this.retryAfter = opts.retryAfter;
    if (opts.statusCode !== void 0) this.statusCode = opts.statusCode;
    if (opts.raw !== void 0) this.raw = opts.raw;
  }
  /** 回给客户端的 HTTP 状态码(errors.py `_KIND_SPEC` 派生)。 */
  get httpStatus() {
    return KIND_SPEC[this.kind]?.[0] ?? 502;
  }
  /** 能否换一个端点重试。 */
  get retryable() {
    return KIND_SPEC[this.kind]?.[1] ?? true;
  }
  /** 上游非 2xx → 分类错误(对齐 `classify_status`,errors.py:73)。 */
  static fromStatus(statusCode, detail, retryAfter) {
    let kind;
    if (statusCode === 429) kind = UpstreamErrorKind.RateLimit;
    else if (statusCode === 401 || statusCode === 403) kind = UpstreamErrorKind.Auth;
    else if (statusCode >= 500 && statusCode <= 599) kind = UpstreamErrorKind.Upstream;
    else kind = UpstreamErrorKind.BadRequest;
    return new _UpstreamError(kind, detail, { retryAfter, statusCode });
  }
};
var EnvKeyProvider = class {
  constructor(envVarName = "ONE_API_KEY", env = process.env) {
    this.envVarName = envVarName;
    this.env = env;
  }
  envVarName;
  env;
  getKey() {
    const raw = this.env[this.envVarName];
    return raw === void 0 ? void 0 : raw.trim();
  }
};

// core/gateway/auth.ts
import { timingSafeEqual } from "node:crypto";
var AUTH_ERROR_DETAIL = "缺少或错误的网关 key";
function missingKeyWarning(source) {
  return `未设置 ${source} —— 网关当前无鉴权:所有请求放行。设置它并重启网关即恢复鉴权。`;
}
function extractPresentedKey(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.length > 0) {
    const text = authorization.trim();
    if (text.toLowerCase().startsWith("bearer ")) return text.slice(7).trim();
    return text;
  }
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.length > 0) return xApiKey.trim();
  const url = req.url ?? "";
  const qIndex = url.indexOf("?");
  if (qIndex !== -1) {
    const query = new URLSearchParams(url.slice(qIndex + 1));
    const key = query.get("key");
    if (key) return key.trim();
  }
  return "";
}
function constantTimeEqual(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
function checkAuth(req, keyProvider) {
  const expected = (keyProvider.getKey() ?? "").trim();
  const presented = extractPresentedKey(req);
  if (!expected) {
    warnMissingKeyOnce(keyProvider);
    return { ok: true, presentedKey: presented };
  }
  if (!presented || !constantTimeEqual(presented, expected)) {
    return { ok: false, status: 401, body: { detail: AUTH_ERROR_DETAIL } };
  }
  return { ok: true, presentedKey: presented };
}
function requireKey(req, keyProvider) {
  const result = checkAuth(req, keyProvider);
  return result.ok ? null : { status: result.status, body: result.body };
}
var warnedMissing = false;
function warnMissingKeyOnce(keyProvider) {
  if (warnedMissing) return;
  warnedMissing = true;
  const source = keyProvider instanceof EnvKeyProvider ? keyProvider.envVarName ?? "ONE_API_KEY" : "网关 key 来源";
  const message = missingKeyWarning(source);
  const emit = keyProvider.onMissingKeyWarning ?? ((msg) => console.warn(msg));
  emit(message);
}

// core/gateway/http.ts
var BUSY_DETAIL = "并发已满:该模型当前所有档位的并发上限都已占满,请稍后重试";
var REQUEST_LEVEL_KINDS = /* @__PURE__ */ new Set([
  UpstreamErrorKind.BadRequest,
  UpstreamErrorKind.AuthChallenge
]);
var GatewayHttpError = class extends Error {
  constructor(status, body, headers, rawBody) {
    super(JSON.stringify(body));
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.rawBody = rawBody;
    this.name = "GatewayHttpError";
  }
  status;
  body;
  headers;
  rawBody;
};
function upstreamErrorToHttp(exc) {
  const headers = {};
  if (exc.retryAfter !== void 0) {
    headers["Retry-After"] = String(Math.max(1, Math.floor(exc.retryAfter)));
  }
  const raw = exc.raw;
  if (raw !== void 0) {
    const status = Number.isFinite(raw.status) && raw.status >= 400 ? raw.status : exc.httpStatus;
    const body = raw.json !== void 0 ? raw.json : { detail: raw.text };
    if (raw.contentType !== void 0 && !raw.contentType.startsWith("application/json")) {
      headers["Content-Type"] = raw.contentType;
    }
    return new GatewayHttpError(
      status,
      body,
      Object.keys(headers).length > 0 ? headers : void 0,
      raw.text
    );
  }
  return new GatewayHttpError(
    exc.httpStatus,
    { detail: { error: { type: exc.kind, message: exc.detail } } },
    Object.keys(headers).length > 0 ? headers : void 0
  );
}
function allBusyError() {
  return new GatewayHttpError(503, {
    detail: { error: { type: "capacity", message: BUSY_DETAIL } }
  });
}
async function readJsonBody(req, limitBytes = 64 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limitBytes) {
      throw new GatewayHttpError(413, { detail: "请求体过大" });
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GatewayHttpError(400, { detail: "请求体不是合法 JSON" });
  }
}
function sendJson(res, status, body, headers, rawBody) {
  const payload = rawBody !== void 0 ? Buffer.from(rawBody, "utf8") : Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    ...headers
  });
  res.end(payload);
}

// core/gateway/sse.ts
var SSE_RESPONSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
  // 流式响应没有已知长度;node:http 会自动走 chunked。禁 keep-alive 复用由 server 层决定。
  Connection: "keep-alive"
};
function ssePackChunk(chunk) {
  return sseFrame(`data: ${JSON.stringify(chunk)}`);
}
function ssePackDone() {
  return sseFrame("data: [DONE]");
}
function sseFrame(payload) {
  return Buffer.from(`${payload}

`, "utf-8");
}
function clientDisconnectSignal(req, res, external) {
  const controller = new AbortController();
  let settled = false;
  const fire = () => {
    if (settled) return;
    settled = true;
    controller.abort(new Error("client disconnected"));
  };
  if (req.aborted) {
    fire();
    return controller.signal;
  }
  req.once("aborted", fire);
  res?.once("close", () => {
    if (!res.writableEnded) fire();
  });
  if (external) {
    if (external.aborted) {
      fire();
    } else {
      const onAbort = () => fire();
      external.addEventListener("abort", onAbort, { once: true });
      controller.signal.addEventListener("abort", () => {
        external.removeEventListener("abort", onAbort);
      }, { once: true });
    }
  }
  return controller.signal;
}

// core/gateway/request-fields.ts
var CONSUMED_FIELDS = ["session_id", "prompt_cache_key"];
var CACHE_ROUTING_KEY_FIELD = "prompt_cache_key";
var FORWARDED_FIELDS = [
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  // OpenAI 的同义字段(`max_tokens` 的新名字),网关一起收。
  "max_completion_tokens",
  "stop",
  "tools",
  "tool_choice",
  // 思考强度:只原样透传,网关不解释、不改写。
  "reasoning_effort",
  // camelCase 别名(部分 SDK 这么发)—— 归一到 `reasoning_effort`。
  "reasoningEffort",
  "stream_options",
  "user",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "response_format",
  "seed",
  "metadata",
  "parallel_tool_calls",
  "logit_bias",
  "chat_template_kwargs"
];
var KNOWN_FIELDS = /* @__PURE__ */ new Set([
  ...FORWARDED_FIELDS,
  ...CONSUMED_FIELDS
]);
function classifyRequestFields(body) {
  const forwarded = [];
  const consumed = [];
  const discarded = [];
  if (body === null || typeof body !== "object") {
    return { forwarded, consumed, discarded };
  }
  for (const key of Object.keys(body)) {
    if (CONSUMED_FIELDS.includes(key)) {
      consumed.push(key);
    } else if (FORWARDED_FIELDS.includes(key)) {
      forwarded.push(key);
    } else {
      discarded.push(key);
    }
  }
  return { forwarded, consumed, discarded };
}
function cacheRoutingKeyOf(body) {
  if (body === null || typeof body !== "object") return void 0;
  const raw = body[CACHE_ROUTING_KEY_FIELD];
  return typeof raw === "string" && raw.length > 0 ? raw : void 0;
}
function reasoningEffortOf(body) {
  if (body === null || typeof body !== "object") return void 0;
  const rec = body;
  const primary = rec["reasoning_effort"];
  if (typeof primary === "string" && primary.length > 0) return primary;
  const alias = rec["reasoningEffort"];
  if (typeof alias === "string" && alias.length > 0) return alias;
  return void 0;
}

// src/components/api-interface/stream.ts
function sseEventFrame(event, data) {
  return Buffer.from(`event: ${event}
data: ${JSON.stringify(data)}

`, "utf-8");
}
async function forwardSseStream(res, upstream, req, signal, codec, onStreamResult) {
  const t0 = Date.now();
  let firstChunkMs;
  let usage;
  let headSent = false;
  const iterator = upstream.stream(req)[Symbol.asyncIterator]();
  const writeHead = () => {
    headSent = true;
    res.writeHead(200, SSE_RESPONSE_HEADERS);
    for (const frame of codec.open()) res.write(frame);
  };
  try {
    for (; ; ) {
      if (signal.aborted) {
        onStreamResult?.("client_disconnected", usage, firstChunkMs, Date.now() - t0);
        return;
      }
      const next = await iterator.next();
      if (next.done) break;
      if (!headSent) {
        firstChunkMs = Date.now() - t0;
        writeHead();
      }
      const chunk = next.value;
      if (chunk && typeof chunk === "object" && "usage" in chunk && chunk.usage) {
        usage = chunk.usage;
      }
      for (const frame of codec.encode(chunk)) res.write(frame);
    }
    if (!headSent) {
      writeHead();
    }
    for (const frame of codec.close()) res.write(frame);
    res.end();
    onStreamResult?.("ok", usage, firstChunkMs, Date.now() - t0);
  } catch (exc) {
    if (signal.aborted) {
      onStreamResult?.("client_disconnected", usage, firstChunkMs, Date.now() - t0);
      return;
    }
    if (headSent) {
      onStreamResult?.("failed_after_start", usage, firstChunkMs, Date.now() - t0);
      try {
        res.end();
      } catch {
      }
      return;
    }
    try {
      await iterator.return?.();
    } catch {
    }
    throw exc;
  }
}
function chatSseCodec() {
  return {
    open: () => [],
    encode: (chunk) => [ssePackChunk(chunk)],
    close: () => [ssePackDone()]
  };
}
async function forwardStream(res, upstream, req, signal, onStreamResult) {
  return forwardSseStream(res, upstream, req, signal, chatSseCodec(), onStreamResult);
}

// src/components/api-interface/chat.ts
function toUpstreamRequest(body, stream) {
  const mtClient = body.max_tokens || body.max_completion_tokens;
  const fieldReport = classifyRequestFields(body);
  const reasoningEffort = reasoningEffortOf(body);
  return {
    model: body.model,
    messages: body.messages ?? [],
    stream,
    temperature: body.temperature,
    // 首档先按客户端原值填;真正的钳制在网关注入侧(那时才知道当轮成员是谁、
    // 上限多少)—— 见 `gateway-upstream.ts` 的 `clampMaxTokens`。
    max_tokens: mtClient,
    // 客户端**原始**意图另存一份:换档重试时必须从这里重算,不能拿上一轮
    // 已经钳过的 `max_tokens` 继续 min。
    maxTokensClient: mtClient,
    top_p: body.top_p,
    stop: body.stop,
    tools: body.tools,
    tool_choice: body.tool_choice,
    ...reasoningEffort === void 0 ? {} : { reasoning_effort: reasoningEffort },
    // 缓存路由键(billion-context):网关拿它做端点亲和,**不进上游 body**。
    prompt_cache_key: cacheRoutingKeyOf(body),
    // 丢弃清单(仅记录用;对请求结果无影响)。
    discarded_fields: fieldReport.discarded.length > 0 ? fieldReport.discarded : void 0,
    extra: {}
  };
}
function logFieldReport(deps, report, model) {
  if (report.consumed.length > 0) {
    deps.logger?.info?.(
      `[gateway] 内部键 model=${model}: ${report.consumed.join(", ")}`
    );
  }
  if (report.discarded.length > 0) {
    deps.logger?.warn?.(
      `[gateway] 丢弃无法处理的请求字段 model=${model}: ${report.discarded.join(", ")}`
    );
  }
}
function fireRequestDone(deps, info) {
  if (!deps.onRequestDone) return;
  try {
    deps.onRequestDone(info);
  } catch (exc) {
    deps.logger?.error?.("[gateway] onRequestDone 挂钩抛错", exc);
  }
}
async function runFailureHook(deps, exc) {
  if (!deps.onFailure) return;
  try {
    await deps.onFailure(exc);
  } catch (hookError) {
    deps.logger?.error?.("[gateway] onFailure 挂钩抛错(已忽略,不掩盖原错误)", hookError);
  }
}
function doneFromError(exc, latencyMs) {
  if (exc instanceof UpstreamError) {
    return { ok: false, status: exc.httpStatus, error: exc.detail, error_kind: exc.kind, latency_ms: latencyMs };
  }
  if (exc instanceof GatewayHttpError) {
    let text;
    try {
      text = JSON.stringify(exc.body);
    } catch {
      text = String(exc.body);
    }
    return { ok: false, status: exc.status, error: text, error_kind: null, latency_ms: latencyMs };
  }
  const message = exc instanceof Error ? exc.message : String(exc);
  return { ok: false, status: 500, error: message, error_kind: null, latency_ms: latencyMs };
}
function usageToTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const u = usage;
  const details = u.prompt_tokens_details ?? {};
  const num = (v) => {
    if (v === void 0 || v === null) return void 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : void 0;
  };
  return {
    prompt_tokens: num(u.prompt_tokens) ?? 0,
    cached_tokens: num(details.cached_tokens) ?? 0,
    completion_tokens: num(u.completion_tokens) ?? 0
  };
}
async function handleChatCompletions(req, res, deps) {
  const bodyRaw = await readJsonBody(req);
  const body = bodyRaw ?? {};
  const model = String(body.model ?? "").trim();
  if (!model) {
    throw new GatewayHttpError(400, { detail: "缺少 model" });
  }
  const stream = Boolean(body.stream);
  if (deps.beforeResolve) await deps.beforeResolve();
  if (deps.guard?.(model, req, res)) return;
  const upstream = deps.resolveUpstream(model);
  if (!upstream) {
    throw new GatewayHttpError(404, { detail: `未知模型: ${model}` });
  }
  const signal = clientDisconnectSignal(req, res);
  const fieldReport = classifyRequestFields(body);
  const upstreamReq = toUpstreamRequest(body, stream);
  logFieldReport(deps, fieldReport, model);
  const sessionId = deps.deriveSessionId?.(body);
  if (sessionId !== void 0) (upstreamReq.extra ??= {}).session_id = sessionId;
  upstreamReq.clientSignal = signal;
  const t0 = Date.now();
  if (stream) {
    try {
      await forwardStream(res, upstream, upstreamReq, signal, (outcome, usage, firstChunkMs, totalMs) => {
        if (outcome !== "ok") {
          deps.logger?.warn?.(
            `[gateway] stream ${outcome} model=${model} ttft=${firstChunkMs ?? "-"}ms total=${totalMs}ms`
          );
        }
        const ok = outcome === "ok";
        fireRequestDone(deps, {
          model,
          stream: true,
          ok,
          status: outcome === "client_disconnected" ? 0 : 200,
          error: ok ? null : outcome === "client_disconnected" ? "客户端断开" : "流式传输中断(首块后失败)",
          error_kind: null,
          latency_ms: totalMs,
          ttft_ms: firstChunkMs ?? null,
          usage: usageToTokens(usage),
          session_id: sessionId ?? null,
          prompt_cache_key: cacheRoutingKeyOf(body),
          discarded_fields: fieldReport.discarded.length > 0 ? fieldReport.discarded : null,
          request: body
        });
      });
    } catch (exc) {
      fireRequestDone(deps, {
        model,
        stream: true,
        ...doneFromError(exc, Date.now() - t0),
        ttft_ms: null,
        session_id: sessionId ?? null,
        prompt_cache_key: cacheRoutingKeyOf(body),
        discarded_fields: fieldReport.discarded.length > 0 ? fieldReport.discarded : null,
        request: body
      });
      await runFailureHook(deps, exc);
      throw exc;
    }
    return;
  }
  try {
    const payload = await upstream.complete(upstreamReq);
    sendJson(res, 200, payload);
    fireRequestDone(deps, {
      model,
      stream: false,
      ok: true,
      status: 200,
      error: null,
      error_kind: null,
      latency_ms: Date.now() - t0,
      ttft_ms: null,
      usage: usageToTokens(payload?.usage),
      session_id: sessionId ?? null,
      prompt_cache_key: cacheRoutingKeyOf(body),
      discarded_fields: fieldReport.discarded.length > 0 ? fieldReport.discarded : null,
      request: body
    });
  } catch (exc) {
    fireRequestDone(deps, {
      model,
      stream: false,
      ...doneFromError(exc, Date.now() - t0),
      ttft_ms: null,
      session_id: sessionId ?? null,
      prompt_cache_key: cacheRoutingKeyOf(body),
      discarded_fields: fieldReport.discarded.length > 0 ? fieldReport.discarded : null,
      request: body
    });
    await runFailureHook(deps, exc);
    throw exc;
  }
}

// src/components/api-interface/message.ts
var MESSAGES_PATH = "/v1/messages";
var KNOWN_FIELDS2 = /* @__PURE__ */ new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "temperature",
  "top_p",
  "stop_sequences",
  "tools",
  "tool_choice",
  "metadata",
  "thinking",
  "top_k",
  "service_tier",
  "container",
  "mcp_servers",
  "context_management",
  "output_config"
]);
function systemTextOf(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  const parts = [];
  for (const part of system) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part === null || typeof part !== "object") continue;
    const p = part;
    if (p["type"] === "text" && typeof p["text"] === "string") parts.push(p["text"]);
  }
  return parts.filter((t) => t !== "").join("\n\n");
}
function imageUrlOf(source) {
  if (source === null || typeof source !== "object") return null;
  const s = source;
  if (s["type"] === "base64" && typeof s["data"] === "string") {
    const media = typeof s["media_type"] === "string" && s["media_type"] !== "" ? s["media_type"] : "image/png";
    return `data:${media};base64,${s["data"]}`;
  }
  if (s["type"] === "url" && typeof s["url"] === "string" && s["url"] !== "") return s["url"];
  return null;
}
function textOfWire(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b["text"] === "string") parts.push(b["text"]);
  }
  return parts.join("\n");
}
function toolResultBlocksOf(content, discarded) {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (typeof part === "string") {
      out.push({ type: "text", text: part });
      continue;
    }
    if (part === null || typeof part !== "object") continue;
    const p = part;
    if (p["type"] === "text" && typeof p["text"] === "string") {
      out.push({ type: "text", text: p["text"] });
    } else if (p["type"] === "image") {
      const url = imageUrlOf(p["source"]);
      if (url !== null) out.push({ type: "image", url });
    } else if (typeof p["type"] === "string") {
      discarded.push(`tool_result.content.type=${p["type"]}`);
    }
  }
  return out;
}
function toolsOf(raw, discarded) {
  if (!Array.isArray(raw)) return {};
  const chat = [];
  const blocks = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const t = item;
    const name = t["name"];
    if (typeof name !== "string" || name === "") {
      discarded.push("tools[].name");
      continue;
    }
    const description = typeof t["description"] === "string" ? t["description"] : "";
    const schema = t["input_schema"] !== null && typeof t["input_schema"] === "object" && !Array.isArray(t["input_schema"]) ? t["input_schema"] : { type: "object", properties: {} };
    chat.push({ type: "function", function: { name, description, parameters: schema } });
    blocks.push({ name, description, parameters: schema });
  }
  return {
    ...chat.length > 0 ? { chat } : {},
    ...blocks.length > 0 ? { blocks } : {}
  };
}
function chatToolChoiceOf(raw) {
  if (raw === "auto" || raw === "any" || raw === "none") return raw;
  if (raw === null || typeof raw !== "object") return void 0;
  const t = raw;
  switch (t["type"]) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool": {
      const name = t["name"];
      if (typeof name === "string" && name !== "") {
        return { type: "function", function: { name } };
      }
      return void 0;
    }
    default:
      return void 0;
  }
}
function stopOf(raw) {
  if (typeof raw === "string") return raw === "" ? void 0 : [raw];
  if (!Array.isArray(raw)) return void 0;
  const seqs = raw.filter((s) => typeof s === "string" && s !== "");
  return seqs.length > 0 ? seqs : void 0;
}
function decodeMessage(item, discarded, index) {
  const role = item["role"] === "assistant" ? "assistant" : "user";
  const rawContent = item["content"];
  const parts = typeof rawContent === "string" ? [{ type: "text", text: rawContent }] : Array.isArray(rawContent) ? rawContent : [];
  const wire = [];
  const chatParts = [];
  const chatTextParts = [];
  const assistantTexts = [];
  const assistantThinking = [];
  const toolCalls = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const p = part;
    const type = p["type"];
    if (type === "text" && typeof p["text"] === "string") {
      wire.push({ type: "text", text: p["text"] });
      if (role === "assistant") assistantTexts.push(p["text"]);
      else {
        chatParts.push({ type: "text", text: p["text"] });
        chatTextParts.push(p["text"]);
      }
      continue;
    }
    if (type === "image") {
      const url = imageUrlOf(p["source"]);
      if (url !== null) {
        wire.push({ type: "image", url });
        if (role === "user") chatParts.push({ type: "image_url", image_url: { url } });
      } else {
        discarded.push(`messages[${index}].content.type=image(无法识别的 source)`);
      }
      continue;
    }
    if (type === "tool_use" && role === "assistant") {
      const id = typeof p["id"] === "string" ? p["id"] : "";
      const name = typeof p["name"] === "string" ? p["name"] : "";
      const input = p["input"] !== null && typeof p["input"] === "object" && !Array.isArray(p["input"]) ? p["input"] : {};
      wire.push({ type: "tool-call", id, name, arguments: JSON.stringify(input) });
      toolCalls.push({
        ...id !== "" ? { id } : {},
        type: "function",
        function: { name, arguments: JSON.stringify(input) }
      });
      continue;
    }
    if (type === "thinking" && role === "assistant" && typeof p["thinking"] === "string") {
      assistantThinking.push(p["thinking"]);
      wire.push({ type: "reasoning", text: p["thinking"] });
      continue;
    }
    if (type === "tool_result") continue;
    if (typeof type === "string") discarded.push(`messages[${index}].content.type=${type}`);
  }
  if (role === "assistant") {
    const text = assistantTexts.join("\n");
    const reasoning = assistantThinking.join("\n");
    const message2 = {
      role: "assistant",
      ...text !== "" ? { content: text } : {},
      ...reasoning !== "" ? { reasoning_content: reasoning } : {},
      ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
    };
    const blocks = wire.length > 0 ? wire : [{ type: "text", text: "" }];
    return { blocks, chat: message2 };
  }
  const content = chatParts.length === 0 ? void 0 : chatParts.every((p) => p.type === "text") ? chatTextParts.join("\n") : chatParts;
  const message = { role: "user", ...content !== void 0 ? { content } : {} };
  return { blocks: wire, chat: message };
}
function fromAnthropicRequest(body) {
  const discarded = [];
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS2.has(key)) discarded.push(`顶层字段 ${key}`);
  }
  const blockMessages = [];
  const chatMessages = [];
  const system = systemTextOf(body["system"]);
  if (system !== "") {
    chatMessages.push({ role: "system", content: system });
  }
  const rawMessages = body["messages"];
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  for (let i = 0; i < messages.length; i += 1) {
    const item = messages[i];
    if (item === null || typeof item !== "object") continue;
    const m = item;
    const contentParts = Array.isArray(m["content"]) ? m["content"] : typeof m["content"] === "string" ? [] : [];
    const toolResultParts = contentParts.filter(
      (p) => p !== null && typeof p === "object" && p["type"] === "tool_result"
    );
    for (const result of toolResultParts) {
      const toolCallId = typeof result["tool_use_id"] === "string" ? result["tool_use_id"] : "";
      const resultBlocks = toolResultBlocksOf(result["content"], discarded);
      blockMessages.push({ role: "tool", toolCallId, content: resultBlocks });
      chatMessages.push({ role: "tool", tool_call_id: toolCallId, content: textOfWire(resultBlocks) });
    }
    const decoded = decodeMessage(m, discarded, i);
    const onlyToolResults = m["role"] !== "assistant" && toolResultParts.length > 0 && decoded.blocks.length === 0;
    if (onlyToolResults) continue;
    blockMessages.push({ role: decoded.chat?.role === "assistant" ? "assistant" : "user", content: decoded.blocks });
    if (decoded.chat !== null) chatMessages.push(decoded.chat);
  }
  const tools = toolsOf(body["tools"], discarded);
  const toolChoice = chatToolChoiceOf(body["tool_choice"]);
  const stop = stopOf(body["stop_sequences"]);
  const maxTokensRaw = body["max_tokens"];
  const maxTokens = typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : void 0;
  const blocks = {
    ...system !== "" ? { system } : {},
    messages: blockMessages,
    ...tools.blocks !== void 0 ? { tools: tools.blocks } : {}
  };
  const chat = {
    model: typeof body["model"] === "string" ? body["model"] : "",
    messages: chatMessages,
    stream: Boolean(body["stream"]),
    ...maxTokens !== void 0 ? { max_tokens: maxTokens } : {},
    ...typeof body["temperature"] === "number" ? { temperature: body["temperature"] } : {},
    ...typeof body["top_p"] === "number" ? { top_p: body["top_p"] } : {},
    ...stop !== void 0 ? { stop } : {},
    ...tools.chat !== void 0 ? { tools: tools.chat } : {},
    ...toolChoice !== void 0 ? { tool_choice: toolChoice } : {},
    // `disable_parallel_tool_use` 是 OpenAI `parallel_tool_calls=false` 的同义意图。
    ...body["tool_choice"] !== null && typeof body["tool_choice"] === "object" && body["tool_choice"]["disable_parallel_tool_use"] === true ? { parallel_tool_calls: false } : {}
  };
  return { blocks, chat, stream: Boolean(body["stream"]), discarded };
}
function toMessagesUpstreamRequest(inbound, stream = inbound.stream) {
  const req = toUpstreamRequest(inbound.chat, stream);
  req.blocks = inbound.blocks;
  req.discarded_fields = inbound.discarded.length > 0 ? inbound.discarded : void 0;
  return req;
}
function anthropicUsageFrom(chatUsage) {
  const u = chatUsage !== null && typeof chatUsage === "object" ? chatUsage : {};
  const num = (v) => {
    if (v === void 0 || v === null) return void 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : void 0;
  };
  const prompt = num(u["prompt_tokens"]) ?? 0;
  const completion = num(u["completion_tokens"]) ?? 0;
  const details = u["prompt_tokens_details"] ?? {};
  const cacheRead = num(u["cache_read_input_tokens"]);
  const cacheWrite = num(u["cache_creation_input_tokens"]);
  if (cacheRead !== void 0 || cacheWrite !== void 0) {
    const read = cacheRead ?? 0;
    const write = cacheWrite ?? 0;
    return {
      input_tokens: Math.max(0, prompt - read - write),
      output_tokens: completion,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write
    };
  }
  const cached = num(details["cached_tokens"]) ?? 0;
  if (cached > 0) {
    return {
      input_tokens: Math.max(0, prompt - cached),
      output_tokens: completion,
      cache_read_input_tokens: cached
    };
  }
  return { input_tokens: prompt, output_tokens: completion };
}
function stopReasonOf(finishReason) {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    // "stop" / null / 未知 → 正常收尾；`stop_sequence` 具体命中了哪条我们不知道。
    default:
      return "end_turn";
  }
}
function parseToolInput(argumentsRaw) {
  if (argumentsRaw !== null && typeof argumentsRaw === "object" && !Array.isArray(argumentsRaw)) {
    return argumentsRaw;
  }
  if (typeof argumentsRaw !== "string" || argumentsRaw.trim() === "") return {};
  try {
    const parsed = JSON.parse(argumentsRaw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return { _raw: argumentsRaw };
  }
  return {};
}
function toAnthropicMessage(payload, meta) {
  const choice = payload.choices?.[0];
  const message = choice?.message;
  const content = [];
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  if (reasoning.trim() !== "") content.push({ type: "thinking", thinking: reasoning });
  const text = typeof message?.content === "string" ? message.content : "";
  if (text !== "") content.push({ type: "text", text });
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  calls.forEach((rawCall, i) => {
    if (rawCall === null || typeof rawCall !== "object") return;
    const call = rawCall;
    const fn = call["function"] !== null && typeof call["function"] === "object" ? call["function"] : {};
    const id = typeof call["id"] === "string" && call["id"] !== "" ? call["id"] : `toolu_${meta.id}_${i}`;
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    content.push({ type: "tool_use", id, name, input: parseToolInput(fn["arguments"]) });
  });
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: meta.id,
    type: "message",
    role: "assistant",
    model: meta.model,
    content,
    stop_reason: stopReasonOf(choice?.finish_reason),
    stop_sequence: null,
    usage: anthropicUsageFrom(payload.usage)
  };
}
function newMessageId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
function createAnthropicSseCodec(meta) {
  let nextIndex = 0;
  let openKind = null;
  let openIndex = -1;
  let openToolIndex;
  let finishReason = null;
  let usage = null;
  function closeOpen() {
    if (openKind === null) return [];
    const frame = sseEventFrame("content_block_stop", {
      type: "content_block_stop",
      index: openIndex
    });
    openKind = null;
    openToolIndex = void 0;
    return [frame];
  }
  function openBlock(kind, contentBlock) {
    const out = closeOpen();
    openIndex = nextIndex;
    nextIndex += 1;
    openKind = kind;
    out.push(
      sseEventFrame("content_block_start", {
        type: "content_block_start",
        index: openIndex,
        content_block: contentBlock
      })
    );
    return out;
  }
  return {
    open() {
      return [
        sseEventFrame("message_start", {
          type: "message_start",
          message: {
            id: meta.id,
            type: "message",
            role: "assistant",
            content: [],
            model: meta.model,
            stop_reason: null,
            stop_sequence: null,
            // 输入 token 在流里出现之前只能给 0（Anthropic 也是先占位再在
            // message_delta 里给准数）；不捏造缓存字段。
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        })
      ];
    },
    encode(chunk) {
      if (chunk && typeof chunk === "object" && chunk.usage) usage = chunk.usage;
      const out = [];
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;
      if (choice && choice.finish_reason !== null && choice.finish_reason !== void 0) {
        finishReason = choice.finish_reason;
      }
      if (delta === void 0 || delta === null) return out;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
        if (openKind !== "thinking") out.push(...openBlock("thinking", { type: "thinking", thinking: "" }));
        out.push(
          sseEventFrame("content_block_delta", {
            type: "content_block_delta",
            index: openIndex,
            delta: { type: "thinking_delta", thinking: delta.reasoning_content }
          })
        );
      }
      if (typeof delta.content === "string" && delta.content !== "") {
        if (openKind !== "text") out.push(...openBlock("text", { type: "text", text: "" }));
        out.push(
          sseEventFrame("content_block_delta", {
            type: "content_block_delta",
            index: openIndex,
            delta: { type: "text_delta", text: delta.content }
          })
        );
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (call === null || typeof call !== "object") continue;
          const toolIndex = typeof call.index === "number" ? call.index : 0;
          if (openKind !== "tool_use" || openToolIndex !== toolIndex) {
            const id = typeof call.id === "string" && call.id !== "" ? call.id : `toolu_${meta.id}_${toolIndex}`;
            const name = call.function !== null && typeof call.function === "object" && typeof call.function.name === "string" ? call.function.name : "";
            out.push(...openBlock("tool_use", { type: "tool_use", id, name, input: {} }));
            openToolIndex = toolIndex;
          }
          const args = call.function !== null && typeof call.function === "object" ? call.function.arguments : void 0;
          if (typeof args === "string" && args !== "") {
            out.push(
              sseEventFrame("content_block_delta", {
                type: "content_block_delta",
                index: openIndex,
                delta: { type: "input_json_delta", partial_json: args }
              })
            );
          }
        }
      }
      return out;
    },
    close() {
      const out = closeOpen();
      out.push(
        sseEventFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReasonOf(finishReason), stop_sequence: null },
          // ⚠️ 这里带的是**本流最终**口径；input/output 一起给，缓存两格有才给。
          usage: anthropicUsageFrom(usage)
        })
      );
      out.push(sseEventFrame("message_stop", { type: "message_stop" }));
      return out;
    }
  };
}
async function handleMessages(req, res, deps) {
  const bodyRaw = await readJsonBody(req);
  const body = bodyRaw ?? {};
  const model = String(body["model"] ?? "").trim();
  if (!model) {
    throw new GatewayHttpError(400, { detail: "缺少 model" });
  }
  const inbound = fromAnthropicRequest({ ...body, model });
  const stream = inbound.stream;
  if (deps.beforeResolve) await deps.beforeResolve();
  if (deps.guard?.(model, req, res)) return;
  const upstream = deps.resolveUpstream(model);
  if (!upstream) {
    throw new GatewayHttpError(404, { detail: `未知模型: ${model}` });
  }
  if (inbound.discarded.length > 0) {
    deps.logger?.warn?.(
      `[gateway] /v1/messages 丢弃无法处理的请求字段 model=${model}: ${inbound.discarded.join(", ")}`
    );
  }
  const signal = clientDisconnectSignal(req, res);
  const upstreamReq = toMessagesUpstreamRequest(inbound, stream);
  const sessionId = deps.deriveSessionId?.(inbound.chat);
  if (sessionId !== void 0) (upstreamReq.extra ??= {}).session_id = sessionId;
  upstreamReq.clientSignal = signal;
  const messageId = (deps.newMessageId ?? newMessageId)();
  const t0 = Date.now();
  const doneBase = {
    model,
    stream,
    session_id: sessionId ?? null,
    prompt_cache_key: cacheRoutingKeyOf(inbound.chat),
    discarded_fields: inbound.discarded.length > 0 ? inbound.discarded : null,
    request: body
  };
  if (stream) {
    const codec = createAnthropicSseCodec({ id: messageId, model });
    try {
      await forwardSseStream(res, upstream, upstreamReq, signal, codec, (outcome, usage, firstChunkMs, totalMs) => {
        if (outcome !== "ok") {
          deps.logger?.warn?.(
            `[gateway] messages stream ${outcome} model=${model} ttft=${firstChunkMs ?? "-"}ms total=${totalMs}ms`
          );
        }
        const ok = outcome === "ok";
        fireRequestDone(deps, {
          ...doneBase,
          stream: true,
          ok,
          status: outcome === "client_disconnected" ? 0 : 200,
          error: ok ? null : outcome === "client_disconnected" ? "客户端断开" : "流式传输中断(首块后失败)",
          error_kind: null,
          latency_ms: totalMs,
          ttft_ms: firstChunkMs ?? null,
          usage: usageToTokens(usage)
        });
      });
    } catch (exc) {
      fireRequestDone(deps, {
        ...doneBase,
        stream: true,
        ...doneFromError(exc, Date.now() - t0),
        ttft_ms: null
      });
      await runFailureHook(deps, exc);
      throw exc;
    }
    return;
  }
  try {
    const payload = await upstream.complete(upstreamReq);
    sendJson(res, 200, toAnthropicMessage(payload, { id: messageId, model }));
    fireRequestDone(deps, {
      ...doneBase,
      stream: false,
      ok: true,
      status: 200,
      error: null,
      error_kind: null,
      latency_ms: Date.now() - t0,
      ttft_ms: null,
      usage: usageToTokens(payload.usage)
    });
  } catch (exc) {
    fireRequestDone(deps, {
      ...doneBase,
      stream: false,
      ...doneFromError(exc, Date.now() - t0),
      ttft_ms: null
    });
    await runFailureHook(deps, exc);
    throw exc;
  }
}

// src/components/api-interface/index.ts
var CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
function applyApiInterface(deps, mount) {
  const routes = [
    {
      method: "POST",
      path: CHAT_COMPLETIONS_PATH,
      handle: (req, res) => handleChatCompletions(req, res, deps)
    },
    {
      method: "POST",
      path: MESSAGES_PATH,
      handle: (req, res) => handleMessages(req, res, deps)
    }
  ];
  const byPath = new Map(routes.map((route) => [route.path, route]));
  const api = {
    routes,
    routeOf: (path) => byPath.get(path.replace(/\/+$/, "") || "/"),
    mount(register) {
      for (const route of routes) register(route);
    }
  };
  if (mount) api.mount(mount);
  return api;
}

// core/gateway/server.ts
import { createServer } from "node:http";

export {
  UpstreamErrorKind,
  RAW_BODY_MAX,
  UpstreamError,
  EnvKeyProvider,
  requireKey,
  BUSY_DETAIL,
  GatewayHttpError,
  upstreamErrorToHttp,
  allBusyError,
  clientDisconnectSignal,
  CACHE_ROUTING_KEY_FIELD,
  classifyRequestFields,
  cacheRoutingKeyOf,
  reasoningEffortOf,
  forwardStream,
  applyApiInterface
};
//# sourceMappingURL=chunk-7OUDRSRP.js.map
