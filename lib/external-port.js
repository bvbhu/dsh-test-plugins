import {
  readJsonBody,
  toUpstreamRequest,
  writeJson
} from "./chunk-XYHWMRD4.js";
import {
  GatewayHttpError,
  UpstreamError,
  applyApiInterface,
  cacheRoutingKeyOf,
  classifyRequestFields,
  clientDisconnectSignal,
  forwardStream,
  requireKey,
  upstreamErrorToHttp
} from "./chunk-7OUDRSRP.js";
import "./chunk-BJ7B4R26.js";

// core/gateway/session.ts
var HASH_LIMIT = 4e3;
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item !== null && typeof item === "object") {
        const text = item["text"];
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n");
  }
  return "";
}
function sha256Hex(text) {
  const nodeCrypto = globalThis.require;
  try {
    if (typeof nodeCrypto === "function") {
      const mod = nodeCrypto("node:crypto");
      if (mod?.createHash) {
        return mod.createHash("sha256").update(text, "utf-8").digest("hex");
      }
    }
  } catch {
  }
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c + i, 2246822507) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
function deriveSessionId(messages, limit = HASH_LIMIT) {
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (msg === null || typeof msg !== "object") continue;
    const role = msg["role"];
    if (String(role ?? "") !== "user") continue;
    const text = textOf(msg["content"]).trim();
    if (!text) continue;
    const digest = sha256Hex(text.slice(0, limit));
    return `lnx-${digest.slice(0, 32)}`;
  }
  return "";
}
function sessionIdOf(body, model = "") {
  if (body === null || typeof body !== "object") return void 0;
  const b = body;
  const meta = b["metadata"];
  if (meta !== null && typeof meta === "object") {
    const value = meta["session_id"] ?? meta["user"];
    if (value) return String(value);
  }
  for (const field of ["litellm_metadata", "user"]) {
    const holder = b[field];
    if (holder !== null && typeof holder === "object") {
      const value = holder["session_id"];
      if (value) return String(value);
    }
  }
  const derived = deriveSessionId(b["messages"]);
  if (derived === "") return void 0;
  return model ? `${model}:${derived}` : derived;
}

// core/connectors/workbuddy-breaker.ts
var WB_BREAKER_SETTING_KEY = "provider.workbuddy.breaker";
var WB_BAN_CODE = 11140;
function readWorkbuddyBreaker(db) {
  const row = db.setting.get(WB_BREAKER_SETTING_KEY);
  const raw = row?.v;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const rec = parsed;
    return {
      trippedAtMs: typeof rec["trippedAtMs"] === "number" ? rec["trippedAtMs"] : 0,
      reason: typeof rec["reason"] === "string" ? rec["reason"] : "",
      removedAccounts: typeof rec["removedAccounts"] === "number" ? rec["removedAccounts"] : 0
    };
  } catch {
    return null;
  }
}
function isWorkbuddyBreakerTripped(db) {
  return readWorkbuddyBreaker(db) !== null;
}
async function tripWorkbuddyBreaker(db, vault, provider, reason) {
  const creds = await vault.list(provider).catch(() => []);
  let removed = 0;
  const failed = [];
  for (const c of creds) {
    try {
      if (await vault.remove(provider, c.username)) removed += 1;
    } catch {
      failed.push(c.username);
    }
  }
  const state = {
    trippedAtMs: Date.now(),
    reason: reason.slice(0, 500),
    removedAccounts: removed
  };
  db.setting.set(WB_BREAKER_SETTING_KEY, JSON.stringify(state));
  return { state, removedAccounts: removed, failedAccounts: failed };
}
function isWorkbuddyBanMessage(message) {
  return message.includes(`code ${WB_BAN_CODE}`);
}

// src/routes.ts
function usageOf(usage) {
  if (!usage) return null;
  const details = usage.prompt_tokens_details ?? {};
  const num = (v) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    prompt_tokens: num(usage.prompt_tokens),
    cached_tokens: num(details.cached_tokens),
    completion_tokens: num(usage.completion_tokens)
  };
}
function buildGatewayRoutes(rt, opts = {}) {
  const logger = opts.logger ?? console;
  const awaitWarmup = async () => {
    if (!opts.warmup) return;
    try {
      const outcome = await opts.warmup.wait();
      if (outcome && outcome.ok === false && !outcome.timedOut) {
        logger.warn?.(
          `[as-one] 额度刷新失败，本轮按降级快照选路（到期排序不可用）：${outcome.error ?? "未知原因"}`
        );
      }
    } catch (err) {
      logger.error?.("[as-one] 额度预热未完成，拒绝按未刷新快照选路", err);
      throw err;
    }
  };
  const authGuard = (req, res) => {
    const denied = requireKey(req, rt.keyProvider);
    if (denied) {
      writeJson(res, denied.status, denied.body);
      return true;
    }
    return false;
  };
  const done = (info) => {
    try {
      rt.onRequestDone(info);
    } catch (err) {
      logger.error?.("[as-one] onRequestDone failed", err);
    }
  };
  const modelIncludesWorkbuddyMember = (modelId) => {
    try {
      const chain = rt.scheduler.chain(modelId);
      return chain.some((item) => item.endpoint.provider === "workbuddy");
    } catch {
      return false;
    }
  };
  const tripBreakerQuietly = async (reason) => {
    try {
      const r = await tripWorkbuddyBreaker(rt.db, rt.vault, "workbuddy", reason);
      logger.warn?.(
        `[as-one] WorkBuddy 11140 → 已彻底熔断:删除 ${r.removedAccounts} 个凭据` + (r.failedAccounts.length > 0 ? `,${r.failedAccounts.length} 个删除失败(见凭据列表)` : "") + "。恢复需人工清除熔断标记并重新导入账号。"
      );
      try {
        rt.syncRegistry();
      } catch {
      }
    } catch (err) {
      logger.error?.("[as-one] WorkBuddy 熔断失败(凭据可能未删除)", err);
    }
  };
  const rejectIfBreakerTripped = (res) => {
    if (!isWorkbuddyBreakerTripped(rt.db)) return false;
    const state = readWorkbuddyBreaker(rt.db);
    writeJson(res, 503, {
      error: {
        type: "service_unavailable",
        code: "workbuddy_channel_broken",
        message: "WorkBuddy 渠道因上游 11140(账号异常行为)已彻底熔断,凭据已删除。需人工恢复:清除熔断标记后重新从 WorkBuddy 客户端导入账号。",
        tripped_at_ms: state?.trippedAtMs ?? null,
        reason: state?.reason ?? null
      }
    });
    return true;
  };
  const api = applyApiInterface({
    resolveUpstream: (model) => rt.resolveUpstream(model),
    // 会话派生沿用宿主口径：Anthropic 的 messages 里 `content[].text` 与 chat 的
    // 文本块对 `sessionIdOf` 同形，所以两种入站共享同一个派生结果。
    deriveSessionId: (body) => sessionIdOf(body, String(body.model ?? "")) ?? void 0,
    // 额度预热：必须在 resolveUpstream（内部就是 scheduler.chain()）之前完成。
    beforeResolve: awaitWarmup,
    // 渠道级熔断：与 chat 路由同一判据（模型前缀 + 逻辑模型成员）。
    guard: (model, _req, res) => (model.startsWith("workbuddy/") || modelIncludesWorkbuddyMember(model)) && rejectIfBreakerTripped(res),
    // 上游报「账号异常行为」时与 chat 路由一样彻底熔断该渠道。
    onFailure: async (exc) => {
      if (exc instanceof UpstreamError && isWorkbuddyBanMessage(exc.message)) {
        await tripBreakerQuietly(exc.message);
      }
    },
    logger,
    onRequestDone: done
  });
  const messagesRoute = api.routeOf("/v1/messages");
  if (messagesRoute === void 0) {
    throw new Error("[as-one] api-interface 未装配 /v1/messages 路由");
  }
  return [
    {
      kind: "exact",
      path: "/v1/models",
      handler: async (req, res) => {
        const nreq = req;
        const nres = res;
        if ((nreq.method ?? "GET").toUpperCase() !== "GET") {
          writeJson(nres, 405, { detail: `Method Not Allowed: ${nreq.method} GET` });
          return;
        }
        if (authGuard(nreq, nres)) return;
        writeJson(nres, 200, { object: "list", data: await rt.listModels() });
      }
    },
    {
      kind: "exact",
      path: "/v1/chat/completions",
      handler: async (req, res) => {
        const nreq = req;
        const nres = res;
        let model = "";
        let stream = false;
        let sessionId = null;
        let cacheKey = null;
        let discarded = null;
        let body = {};
        const t0 = Date.now();
        try {
          if ((nreq.method ?? "POST").toUpperCase() !== "POST") {
            writeJson(nres, 405, { detail: `Method Not Allowed: ${nreq.method} POST` });
            return;
          }
          if (authGuard(nreq, nres)) return;
          body = await readJsonBody(req);
          model = String(body.model ?? "").trim();
          if (!model) throw new GatewayHttpError(400, { detail: "缺少 model" });
          stream = Boolean(body.stream);
          sessionId = sessionIdOf(body, model) ?? null;
          cacheKey = cacheRoutingKeyOf(body) ?? null;
          const fields = classifyRequestFields(body);
          discarded = fields.discarded.length > 0 ? fields.discarded : null;
          await awaitWarmup();
          {
            const touchesWorkbuddy = model.startsWith("workbuddy/") || modelIncludesWorkbuddyMember(model);
            if (touchesWorkbuddy && rejectIfBreakerTripped(nres)) return;
          }
          const upstream = rt.resolveUpstream(model);
          if (!upstream) throw new GatewayHttpError(404, { detail: `未知模型: ${model}` });
          const signal = clientDisconnectSignal(nreq, nres);
          const upstreamReq = toUpstreamRequest(body, stream);
          upstreamReq.prompt_cache_key = cacheKey ?? void 0;
          upstreamReq.discarded_fields = discarded ?? void 0;
          upstreamReq.extra = { ...upstreamReq.extra ?? {}, session_id: sessionId ?? void 0 };
          if (stream) {
            await forwardStream(
              nres,
              upstream,
              upstreamReq,
              signal,
              (outcome, usage, firstChunkMs, totalMs2) => {
                if (outcome !== "ok") {
                  logger.warn?.(
                    `[as-one] stream ${outcome} model=${model} ttft=${firstChunkMs ?? "-"}ms total=${totalMs2}ms`
                  );
                }
                done({
                  model,
                  stream: true,
                  // 已发字节后失败:状态码仍是 200(客户端拿到的是断流);
                  // 客户端断开(未发响应)= 0,与 core 口径一致。
                  ok: outcome === "ok",
                  status: outcome === "client_disconnected" ? 0 : 200,
                  error: outcome === "ok" ? null : outcome === "client_disconnected" ? "客户端断开" : "流式传输中断",
                  error_kind: outcome === "ok" ? null : outcome === "client_disconnected" ? "connection" : "timeout",
                  latency_ms: Math.round(totalMs2),
                  ttft_ms: firstChunkMs === void 0 ? null : Math.round(firstChunkMs),
                  usage: usageOf(usage),
                  session_id: sessionId,
                  prompt_cache_key: cacheKey,
                  discarded_fields: discarded,
                  request: body
                });
              }
            );
            return;
          }
          const payload = await upstream.complete(upstreamReq);
          const totalMs = Date.now() - t0;
          writeJson(nres, 200, payload);
          done({
            model,
            stream: false,
            ok: true,
            status: 200,
            error: null,
            error_kind: null,
            latency_ms: totalMs,
            ttft_ms: null,
            usage: usageOf(payload.usage),
            session_id: sessionId,
            prompt_cache_key: cacheKey,
            discarded_fields: discarded,
            request: body
          });
        } catch (exc) {
          if (exc instanceof UpstreamError && isWorkbuddyBanMessage(exc.message)) {
            await tripBreakerQuietly(exc.message);
          }
          const mapped = exc instanceof GatewayHttpError ? exc : exc instanceof UpstreamError ? upstreamErrorToHttp(exc) : null;
          if (mapped) {
            writeJson(nres, mapped.status, mapped.body, mapped.headers, mapped.rawBody);
          } else {
            logger.error?.("[as-one] chat completions internal error", exc);
            writeJson(nres, 500, { detail: "Internal Server Error" });
          }
          done({
            model,
            stream,
            ok: false,
            status: mapped ? mapped.status : 500,
            error: exc instanceof Error ? exc.message : String(exc),
            error_kind: exc instanceof UpstreamError ? exc.kind : null,
            latency_ms: Date.now() - t0,
            ttft_ms: null,
            usage: null,
            session_id: sessionId,
            prompt_cache_key: cacheKey,
            discarded_fields: discarded,
            request: body
          });
        }
      }
    },
    {
      kind: "exact",
      path: "/v1/messages",
      /**
       * Anthropic Messages 入站（组件 `api-interface/message.ts`）。
       *
       * 鉴权与 chat 同一套（`authGuard` → `requireKey`）；错误体沿用仓库约定
       * `{"detail": {error: {type, message}}}`。流式事件与断开语义由组件负责，
       * 这里只管宿主面的方法判定与错误出口。
       */
      handler: async (req, res) => {
        const nreq = req;
        const nres = res;
        if ((nreq.method ?? "POST").toUpperCase() !== "POST") {
          writeJson(nres, 405, { detail: `Method Not Allowed: ${nreq.method} POST` });
          return;
        }
        if (authGuard(nreq, nres)) return;
        try {
          await messagesRoute.handle(nreq, nres);
        } catch (exc) {
          const mapped = exc instanceof GatewayHttpError ? exc : exc instanceof UpstreamError ? upstreamErrorToHttp(exc) : null;
          if (mapped) {
            writeJson(nres, mapped.status, mapped.body, mapped.headers, mapped.rawBody);
          } else {
            logger.error?.("[as-one] messages internal error", exc);
            writeJson(nres, 500, { detail: "Internal Server Error" });
          }
        }
      }
    }
  ];
}

// src/external-port-row.ts
var name = "@bvbhu/as-one/external-port";
var inject = ["webServer", "asOneCore"];
function apply(ctx) {
  const core = ctx.get("asOneCore");
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, external port row skipped");
    return;
  }
  ctx.effect(
    () => {
      const gatewayRoutes = buildGatewayRoutes(core.runtime, {
        logger: ctx.logger,
        warmup: core.warmup
      });
      const disposers = [];
      for (const route of gatewayRoutes) {
        try {
          disposers.push(ctx.webServer.register(route));
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] register route ${route.path} failed:`, err);
        }
      }
      ctx.logger?.info?.(
        `[as-one] mounted ${gatewayRoutes.length} gateway route(s)`
      );
      return () => {
        for (const dispose of disposers) dispose();
      };
    },
    "@bvbhu/as-one/external-port: /v1 gateway routes"
  );
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=external-port.js.map
