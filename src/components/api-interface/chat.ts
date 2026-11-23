/**
 * OpenAI Chat Completions 语义 —— 请求解码 + SSE/JSON 编码。
 *
 * 本文件是原 `core/gateway/server.ts` 里 `handleChatCompletions` 的**原样搬迁**：
 * 行为约束与拆分前完全一致（SSE 帧逐字节、错误体与状态码不变），只是把
 * 「注入依赖」从 `GatewayOptions` 换成组件的 {@link ApiInterfaceDeps}，
 * 并把选路前的异步钩子/请求前闸留给宿主注入。
 *
 * 请求路径顺序（app.py 模块 docstring「请求路径（顺序是用户定案，不可调换）」）：
 * 1. 鉴权（`requireKey` —— 由网关路由层在**委托之前**完成，本文件不管）；
 * 2. 解析对外模型名（缺 model → 400「缺少 model」；未知模型 → 404）；
 * 3. 调注入的 {@link Upstream}（路由核心通过注入接口，**不 import**
 *    router/scheduler —— 换档/亲和/并发由注入方实现）；
 * 4. 流式直出（只加 SSE 帧）；失败按注入方的重试语义换档。
 *
 * @module src/components/api-interface/chat
 */

import { clientDisconnectSignal } from "@as-one/core/src/gateway/sse.js";
import {
  cacheRoutingKeyOf,
  classifyRequestFields,
  reasoningEffortOf,
  type RequestFieldReport,
} from "@as-one/core/src/gateway/request-fields.js";
import { GatewayHttpError, readJsonBody, sendJson } from "@as-one/core/src/gateway/http.js";
import {
  UpstreamError,
  type ChatCompletionRequest,
  type RequestDoneInfo,
  type UpstreamRequest,
} from "@as-one/core/src/gateway/types.js";

import { forwardStream } from "./stream.js";
import type { ApiHttpRequest, ApiHttpResponse, ApiInterfaceDeps } from "./types.js";

// ---------------------------------------------------------------------------
// 请求 → 上游请求(`_build_request` / `UpstreamRequest.to_body` 的网关侧)
// ---------------------------------------------------------------------------

export function toUpstreamRequest(body: ChatCompletionRequest, stream: boolean): UpstreamRequest {
  // ⚠️ `max_completion_tokens` 是 OpenAI 的同义字段,一起收(决策 O1)。
  // 0 经 `||` 归 undefined —— 客户端显式发 0 视为「没带」。
  const mtClient = body.max_tokens || body.max_completion_tokens;
  // ⚠️ 字段分类(m09081):**能处理就处理,不能处理就丢弃,绝不拒绝请求**。
  // 这里只负责把结果挂到请求上;丢弃清单会一路传到请求明细里。
  const fieldReport = classifyRequestFields(body);
  // 思考强度:**只原样透传**(`reasoningEffort` 别名归一到 `reasoning_effort`)。
  // 网关不解释档位值;上游说不支持就丢掉重试(见 gateway-upstream 的
  // isReasoningEffortRejection)。**未指定时连键都不加**(用户 m09081:
  // 「其他未指定就不添加,让上游自行决定」)—— 填 undefined 与不填在 bodyFor
  // 里等价,但内部对象也不该凭空多一个键。
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
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    // 缓存路由键(billion-context):网关拿它做端点亲和,**不进上游 body**。
    prompt_cache_key: cacheRoutingKeyOf(body),
    // 丢弃清单(仅记录用;对请求结果无影响)。
    discarded_fields: fieldReport.discarded.length > 0 ? fieldReport.discarded : undefined,
    extra: {} as Record<string, unknown>,
  };
}

/**
 * 记录一次请求的**字段处置**:消费了哪些内部键、丢弃了哪些不认识的字段。
 *
 * ⚠️ 这是「不拒绝请求」原则的配套观测:客户端带了网关不认识的字段时,请求照常
 * 跑,但用户得能看到「哪些字段被丢了」—— 否则一个参数静默消失,排查成本极高。
 */
export function logFieldReport(
  deps: ApiInterfaceDeps,
  report: RequestFieldReport,
  model: string,
): void {
  if (report.consumed.length > 0) {
    deps.logger?.info?.(
      `[gateway] 内部键 model=${model}: ${report.consumed.join(", ")}`,
    );
  }
  if (report.discarded.length > 0) {
    deps.logger?.warn?.(
      `[gateway] 丢弃无法处理的请求字段 model=${model}: ${report.discarded.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 请求完成记账(请求日志的网关侧入口)
// ---------------------------------------------------------------------------

/**
 * 触发 onRequestDone 挂钩。挂钩抛错不得影响已发出的响应/请求流程:
 * 记账失败是观测问题,不是请求问题 —— 内部吞掉并走 logger.error。
 */
export function fireRequestDone(deps: ApiInterfaceDeps, info: RequestDoneInfo): void {
  if (!deps.onRequestDone) return;
  try {
    deps.onRequestDone(info);
  } catch (exc) {
    deps.logger?.error?.("[gateway] onRequestDone 挂钩抛错", exc);
  }
}

/**
 * 失败钩子的安全调用：宿主用它做渠道熔断，它自己失败不能把原错误盖成 500。
 * （与 {@link fireRequestDone} 同一条纪律：观测/补救路径不得影响请求语义。）
 */
export async function runFailureHook(deps: ApiInterfaceDeps, exc: unknown): Promise<void> {
  if (!deps.onFailure) return;
  try {
    await deps.onFailure(exc);
  } catch (hookError) {
    deps.logger?.error?.("[gateway] onFailure 挂钩抛错(已忽略,不掩盖原错误)", hookError);
  }
}

/** 失败路径定型(exc → ok/status/error/error_kind)。 */
export function doneFromError(
  exc: unknown,
  latencyMs: number,
): Pick<RequestDoneInfo, "ok" | "status" | "error" | "error_kind" | "latency_ms"> {
  if (exc instanceof UpstreamError) {
    return { ok: false, status: exc.httpStatus, error: exc.detail, error_kind: exc.kind, latency_ms: latencyMs };
  }
  if (exc instanceof GatewayHttpError) {
    let text: string;
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

/**
 * 流式(或普通)usage → 三键:cached=prompt_tokens_details.cached_tokens。
 * usage 缺失 → null(逐 token 字段不得捏造 0)。
 */
export function usageToTokens(usage: unknown): RequestDoneInfo["usage"] {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    prompt_tokens: num(u.prompt_tokens) ?? 0,
    cached_tokens: num(details.cached_tokens) ?? 0,
    completion_tokens: num(u.completion_tokens) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

/**
 * `POST /v1/chat/completions` 的处理逻辑（原 `server.ts` 内联版本）。
 *
 * @param deps 组件注入依赖（选路/会话派生/日志/记账）
 */
export async function handleChatCompletions(
  req: ApiHttpRequest,
  res: ApiHttpResponse,
  deps: ApiInterfaceDeps,
): Promise<void> {
  const bodyRaw = await readJsonBody(req);
  const body = (bodyRaw ?? {}) as ChatCompletionRequest;
  const model = String(body.model ?? "").trim();
  if (!model) {
    throw new GatewayHttpError(400, { detail: "缺少 model" });
  }
  const stream = Boolean(body.stream);

  // 宿主钩子（额度预热）与渠道级熔断：核心网关不注入 = 完全保持旧行为。
  if (deps.beforeResolve) await deps.beforeResolve();
  if (deps.guard?.(model, req, res)) return;

  const upstream = deps.resolveUpstream(model);
  if (!upstream) {
    // 未知模型 404(含真实模型直连 404;`_model_exists` 判据:
    // 逻辑模型与真实模型都算 —— 这里由注入方的 resolveUpstream 决定存在性)
    throw new GatewayHttpError(404, { detail: `未知模型: ${model}` });
  }

  const signal = clientDisconnectSignal(req, res);
  const fieldReport = classifyRequestFields(body);
  const upstreamReq = toUpstreamRequest(body, stream);
  logFieldReport(deps, fieldReport, model);

  // 会话 id:上游适配器读 req.extra.session_id 做会话亲和(gateway-upstream
  // sessionOf 同款),bodyFor 会摘除该键 → 必不透传给上游。
  const sessionId = deps.deriveSessionId?.(body);
  if (sessionId !== undefined) (upstreamReq.extra ??= {}).session_id = sessionId;

  // 客户端断开信号交给上游:让它 abort 自己的 fetch,流生成器因此抛错退出,
  // catch 里的 router.finish 会归还并发槽位。不做这一步,槽位要等到租期
  // (inflight-ledger 600s)被 purge 扫掉 —— 客户端一断开,该档位就卡死。
  upstreamReq.clientSignal = signal;

  const t0 = Date.now();
  if (stream) {
    try {
      await forwardStream(res, upstream, upstreamReq, signal, (outcome, usage, firstChunkMs, totalMs) => {
        if (outcome !== "ok") {
          deps.logger?.warn?.(
            `[gateway] stream ${outcome} model=${model} ttft=${firstChunkMs ?? "-"}ms total=${totalMs}ms`,
          );
        }
        const ok = outcome === "ok";
        fireRequestDone(deps, {
          model,
          stream: true,
          ok,
          status: outcome === "client_disconnected" ? 0 : 200,
          error: ok
            ? null
            : outcome === "client_disconnected"
              ? "客户端断开"
              : "流式传输中断(首块后失败)",
          error_kind: null,
          latency_ms: totalMs,
          ttft_ms: firstChunkMs ?? null,
          usage: usageToTokens(usage),
          session_id: sessionId ?? null,
          prompt_cache_key: cacheRoutingKeyOf(body),
          discarded_fields: fieldReport.discarded.length > 0 ? fieldReport.discarded : null,
          request: body,
        });
      });
    } catch (exc) {
      // 首块前失败:响应未发,错误交外层统一出口;请求日志仍要记一笔。
      fireRequestDone(deps, {
        model,
        stream: true,
        ...doneFromError(exc, Date.now() - t0),
        ttft_ms: null,
        session_id: sessionId ?? null,
        prompt_cache_key: cacheRoutingKeyOf(body),
        discarded_fields: fieldReport.discarded.length > 0 ? fieldReport.discarded : null,
        request: body,
      });
      await runFailureHook(deps, exc);
      throw exc;
    }
    return;
  }

  // 非流式:可以在任何时刻换号(响应还没发出去)—— 换档语义在注入方。
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
      usage: usageToTokens((payload as { usage?: unknown } | null | undefined)?.usage),
      session_id: sessionId ?? null,
      prompt_cache_key: cacheRoutingKeyOf(body),
      discarded_fields: fieldReport.discarded.length > 0 ? fieldReport.discarded : null,
      request: body,
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
      request: body,
    });
    await runFailureHook(deps, exc);
    throw exc;
  }
}
