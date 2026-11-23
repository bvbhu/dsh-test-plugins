/**
 * Anthropic Messages 语义 —— 请求解码 + SSE/JSON 编码。
 *
 * ## 为什么需要「入站解码」
 *
 * `core/wire/anthropic.ts` 只有**出站**方向（chat / blocks → Messages），
 * 之前网关只能接 OpenAI 形状的请求。`/v1/messages` 要接 Anthropic 客户端
 * （Claude Code、各类 SDK、以及只认 Messages 的自建服务），就得把
 *
 *     Anthropic 请求 JSON → BlockRequest（块投影）+ Chat IR（chat 兼容形状）
 *
 * 解出来。两条投影都从**同一份**解码结果生成，所以不存在第二套语义：
 *
 * - `blocks`：喂给 messages 族上游，走 `blocks → messages` 一次成型
 *   （见 `core/wire/index.ts` 的 `WireEncodeExtra.blocks`）；
 * - `chat`：喂给 chat 族上游与既有选路/统计逻辑（会话派生、上下文长度、
 *   请求明细都只看 chat IR）。
 *
 * 两者最终都塞进同一个 {@link UpstreamRequest} → router/scheduler/adapter，
 * **不另起一条内部链路**。
 *
 * ## 响应方向
 *
 * - 非流式：内部 `ChatCompletion` → Anthropic `{type:"message", …}`；
 * - 流式：内部 chunk → `message_start` / `content_block_*` / `message_delta` /
 *   `message_stop` 事件帧（帧骨架复用 `stream.ts`，与 chat 共用断开语义）。
 *
 * ## 口径说明（与 chat 侧对齐，不做二次发明）
 *
 * - 错误体一律沿用仓库约定 `{"detail": {error: {type, message}}}`（由外层错误
 *   出口写），消息端点没有自己的错误形状；
 * - 并发全忙仍是 `503` + `type:"capacity"`，语义不动；
 * - `max_tokens` 缺省**不拒绝**（与 chat 行为一致：不填交给上游/编解码器兜底）；
 * - `usage.input_tokens` 按 Anthropic 口径**不含缓存**：内部 chat usage 的
 *   `prompt_tokens` 是「新 + 缓存读 + 缓存写」，这里减回去，并把缓存两格按
 *   Anthropic 字段名带出；没有缓存拆分时按 `prompt_tokens_details.cached_tokens`
 *   走 OpenAI 口径回退（`cache_read_input_tokens`）。
 *
 * @module src/components/api-interface/message
 */

import { clientDisconnectSignal } from "@as-one/core/src/gateway/sse.js";
import { GatewayHttpError, readJsonBody, sendJson } from "@as-one/core/src/gateway/http.js";
import {
  type ChatCompletion,
  type ChatCompletionRequest,
  type ChatContentPart,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolDefinition,
  type UpstreamRequest,
} from "@as-one/core/src/gateway/types.js";
import type {
  BlockMessage,
  BlockRequest,
  WireBlock,
} from "@as-one/core/src/wire/anthropic.js";
import { cacheRoutingKeyOf } from "@as-one/core/src/gateway/request-fields.js";

import { doneFromError, fireRequestDone, runFailureHook, toUpstreamRequest, usageToTokens } from "./chat.js";
import { forwardSseStream, sseEventFrame, type SseStreamCodec } from "./stream.js";
import type { ApiHttpRequest, ApiHttpResponse, ApiInterfaceDeps } from "./types.js";

/** Anthropic Messages 端点的路径（路由表与宿主挂载共用）。 */
export const MESSAGES_PATH = "/v1/messages";

/**
 * 入站认识的顶层字段（其余一律丢弃并记录，**绝不因此拒绝请求** ——
 * 与 m09081 的「能处理就处理，不能处理就丢弃」同一条纪律）。
 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
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
  "output_config",
]);

// ---------------------------------------------------------------------------
// 请求解码：Anthropic Messages JSON → BlockRequest + Chat IR
// ---------------------------------------------------------------------------

/** 解码结果：块投影 + chat IR（同一份请求的两种视图）。 */
export interface AnthropicInbound {
  /** 块投影：messages 族上游 `blocks → messages` 一次成型。 */
  blocks: BlockRequest;
  /** chat IR：chat 族上游、会话派生、请求明细共用。 */
  chat: ChatCompletionRequest;
  /** 流式开关（真值判断，与 chat 同口径）。 */
  stream: boolean;
  /** 无法处理的顶层字段 / 内容块类型（仅记录，不拒绝请求）。 */
  discarded: string[];
}

/** `system` 既可以是串，也可以是文本块数组（含 `cache_control`）。 */
function systemTextOf(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  const parts: string[] = [];
  for (const part of system) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part === null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p["type"] === "text" && typeof p["text"] === "string") parts.push(p["text"]);
  }
  return parts.filter((t) => t !== "").join("\n\n");
}

/** Anthropic 图片 `source` → data URL / http(s) URL（块与 chat 两边共用）。 */
function imageUrlOf(source: unknown): string | null {
  if (source === null || typeof source !== "object") return null;
  const s = source as Record<string, unknown>;
  if (s["type"] === "base64" && typeof s["data"] === "string") {
    const media =
      typeof s["media_type"] === "string" && s["media_type"] !== "" ? s["media_type"] : "image/png";
    return `data:${media};base64,${s["data"]}`;
  }
  if (s["type"] === "url" && typeof s["url"] === "string" && s["url"] !== "") return s["url"];
  return null;
}

/** 纯文本拼接（块视图里 text 块按 `\n` 连，与 `textFromBlocks` 同口径）。 */
function textOfWire(blocks: readonly WireBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b["text"] === "string") parts.push(b["text"]);
  }
  return parts.join("\n");
}

/** `tool_result.content` 既可以是串，也可以是文本/图片块数组。 */
function toolResultBlocksOf(content: unknown, discarded: string[]): WireBlock[] {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const out: WireBlock[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      out.push({ type: "text", text: part });
      continue;
    }
    if (part === null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
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

/** Anthropic 工具定义 → chat 工具 + 块请求工具（两条视图的同一份来源）。 */
function toolsOf(raw: unknown, discarded: string[]): {
  chat?: ChatToolDefinition[];
  blocks?: NonNullable<BlockRequest["tools"]>;
} {
  if (!Array.isArray(raw)) return {};
  const chat: ChatToolDefinition[] = [];
  const blocks: NonNullable<BlockRequest["tools"]> = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const name = t["name"];
    if (typeof name !== "string" || name === "") {
      discarded.push("tools[].name");
      continue;
    }
    const description = typeof t["description"] === "string" ? t["description"] : "";
    const schema =
      t["input_schema"] !== null && typeof t["input_schema"] === "object" && !Array.isArray(t["input_schema"])
        ? (t["input_schema"] as Record<string, unknown>)
        : { type: "object", properties: {} };
    chat.push({ type: "function", function: { name, description, parameters: schema } });
    blocks.push({ name, description, parameters: schema });
  }
  return {
    ...(chat.length > 0 ? { chat } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
  };
}

/**
 * Anthropic `tool_choice` → chat `tool_choice`。
 *
 * - `auto` → `auto`；`any` → `required`；`none` → `none`；
 * - `{type:"tool", name}` → `{type:"function", function:{name}}`；
 * - 认不出的形状 → `undefined`（不发明语义，交给上游默认）。
 */
function chatToolChoiceOf(raw: unknown): unknown {
  if (raw === "auto" || raw === "any" || raw === "none") return raw;
  if (raw === null || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
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
      return undefined;
    }
    default:
      return undefined;
  }
}

/** `stop_sequences`（Anthropic）→ `stop`（OpenAI，两种形状都收）。 */
function stopOf(raw: unknown): string[] | undefined {
  if (typeof raw === "string") return raw === "" ? undefined : [raw];
  if (!Array.isArray(raw)) return undefined;
  const seqs = raw.filter((s): s is string => typeof s === "string" && s !== "");
  return seqs.length > 0 ? seqs : undefined;
}

/**
 * 解码一条 Anthropic 消息（user / assistant）。
 *
 * ⚠️ `tool_result` 块会拆成独立的 `role:"tool"` 块消息 ——
 * `toAnthropicRequestFromBlocks` 正是按这个形状重建 `tool_result`，
 * 两边合起来才是 Messages 语义。
 */
function decodeMessage(
  item: Record<string, unknown>,
  discarded: string[],
  index: number,
): { blocks: WireBlock[]; chat: ChatMessage | null } {
  const role = item["role"] === "assistant" ? "assistant" : "user";
  const rawContent = item["content"];
  const parts: unknown[] =
    typeof rawContent === "string" ? [{ type: "text", text: rawContent }] : Array.isArray(rawContent) ? rawContent : [];

  const wire: WireBlock[] = [];
  const chatParts: ChatContentPart[] = [];
  const chatTextParts: string[] = [];
  const assistantTexts: string[] = [];
  const assistantThinking: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
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
      const input =
        p["input"] !== null && typeof p["input"] === "object" && !Array.isArray(p["input"])
          ? (p["input"] as Record<string, unknown>)
          : {};
      wire.push({ type: "tool-call", id, name, arguments: JSON.stringify(input) });
      toolCalls.push({
        ...(id !== "" ? { id } : {}),
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      });
      continue;
    }
    if (type === "thinking" && role === "assistant" && typeof p["thinking"] === "string") {
      assistantThinking.push(p["thinking"]);
      wire.push({ type: "reasoning", text: p["thinking"] });
      continue;
    }
    // tool_result 由 fromAnthropicRequest 单独拆成 role:"tool" 块消息，
    // 这里不能当「不认识的内容类型」丢掉。
    if (type === "tool_result") continue;
    // redacted_thinking / document / server_tool_use 等：没有对应语义，丢弃并记录。
    if (typeof type === "string") discarded.push(`messages[${index}].content.type=${type}`);
  }

  if (role === "assistant") {
    const text = assistantTexts.join("\n");
    const reasoning = assistantThinking.join("\n");
    const message: ChatMessage = {
      role: "assistant",
      ...(text !== "" ? { content: text } : {}),
      ...(reasoning !== "" ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    const blocks: WireBlock[] = wire.length > 0 ? wire : [{ type: "text", text: "" }];
    return { blocks, chat: message };
  }

  const content: ChatMessage["content"] =
    chatParts.length === 0
      ? undefined
      : chatParts.every((p) => p.type === "text")
        ? chatTextParts.join("\n")
        : chatParts;
  const message: ChatMessage = { role: "user", ...(content !== undefined ? { content } : {}) };
  return { blocks: wire, chat: message };
}

/**
 * Anthropic 请求体 → 块投影 + chat IR。
 *
 * 只读、不改入参；不认识的东西进 `discarded`（**不抛错**）。
 */
export function fromAnthropicRequest(body: Record<string, unknown>): AnthropicInbound {
  const discarded: string[] = [];

  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) discarded.push(`顶层字段 ${key}`);
  }

  const blockMessages: BlockMessage[] = [];
  const chatMessages: ChatMessage[] = [];
  const system = systemTextOf(body["system"]);
  if (system !== "") {
    chatMessages.push({ role: "system", content: system });
  }

  const rawMessages = body["messages"];
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  for (let i = 0; i < messages.length; i += 1) {
    const item = messages[i];
    if (item === null || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;

    // tool_result 块拆成独立的 role:"tool" 块消息（见 decodeMessage 注释）。
    const contentParts = Array.isArray(m["content"])
      ? m["content"]
      : typeof m["content"] === "string"
        ? []
        : [];
    const toolResultParts = contentParts.filter(
      (p): p is Record<string, unknown> =>
        p !== null && typeof p === "object" && (p as Record<string, unknown>)["type"] === "tool_result",
    );
    for (const result of toolResultParts) {
      const toolCallId = typeof result["tool_use_id"] === "string" ? result["tool_use_id"] : "";
      const resultBlocks = toolResultBlocksOf(result["content"], discarded);
      blockMessages.push({ role: "tool", toolCallId, content: resultBlocks });
      chatMessages.push({ role: "tool", tool_call_id: toolCallId, content: textOfWire(resultBlocks) });
    }

    const decoded = decodeMessage(m, discarded, i);
    // 只有 tool_result 的 user 消息不再额外产出空文本消息。
    const onlyToolResults =
      m["role"] !== "assistant" && toolResultParts.length > 0 && decoded.blocks.length === 0;
    if (onlyToolResults) continue;
    blockMessages.push({ role: decoded.chat?.role === "assistant" ? "assistant" : "user", content: decoded.blocks });
    if (decoded.chat !== null) chatMessages.push(decoded.chat);
  }

  const tools = toolsOf(body["tools"], discarded);
  const toolChoice = chatToolChoiceOf(body["tool_choice"]);
  const stop = stopOf(body["stop_sequences"]);
  const maxTokensRaw = body["max_tokens"];
  const maxTokens =
    typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
      ? Math.floor(maxTokensRaw)
      : undefined;

  const blocks: BlockRequest = {
    ...(system !== "" ? { system } : {}),
    messages: blockMessages,
    ...(tools.blocks !== undefined ? { tools: tools.blocks } : {}),
  };

  const chat: ChatCompletionRequest = {
    model: typeof body["model"] === "string" ? body["model"] : "",
    messages: chatMessages,
    stream: Boolean(body["stream"]),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(typeof body["temperature"] === "number" ? { temperature: body["temperature"] } : {}),
    ...(typeof body["top_p"] === "number" ? { top_p: body["top_p"] } : {}),
    ...(stop !== undefined ? { stop } : {}),
    ...(tools.chat !== undefined ? { tools: tools.chat } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    // `disable_parallel_tool_use` 是 OpenAI `parallel_tool_calls=false` 的同义意图。
    ...(body["tool_choice"] !== null &&
    typeof body["tool_choice"] === "object" &&
    (body["tool_choice"] as Record<string, unknown>)["disable_parallel_tool_use"] === true
      ? { parallel_tool_calls: false }
      : {}),
  };

  return { blocks, chat, stream: Boolean(body["stream"]), discarded };
}

/**
 * 解码结果 → 内部 `UpstreamRequest`（chat 与 messages 两个族共用）。
 *
 * `blocks` 是 messages 族上游的**一次成型**投影；chat 族上游只读 `messages`，
 * `bodyFor` 的白名单构造不会把 `blocks` 写进报文体。
 */
export function toMessagesUpstreamRequest(inbound: AnthropicInbound, stream = inbound.stream): UpstreamRequest {
  const req = toUpstreamRequest(inbound.chat, stream);
  req.blocks = inbound.blocks;
  req.discarded_fields = inbound.discarded.length > 0 ? inbound.discarded : undefined;
  return req;
}

// ---------------------------------------------------------------------------
// usage / stop_reason 映射
// ---------------------------------------------------------------------------

/** Anthropic Messages 的 usage 形状。 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * 内部 chat usage → Anthropic usage。
 *
 * ⚠️ Anthropic 的 `input_tokens` **不含**缓存命中/写入；内部 `prompt_tokens`
 * 是三者之和（见 `core/wire/anthropic.ts` 的 `anthropicUsageOf`）。所以这里
 * 只有在拿得到缓存拆分时才减回去，减完不小于 0。
 */
export function anthropicUsageFrom(chatUsage: unknown): AnthropicUsage {
  const u = chatUsage !== null && typeof chatUsage === "object" ? (chatUsage as Record<string, unknown>) : {};
  const num = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : undefined;
  };
  const prompt = num(u["prompt_tokens"]) ?? 0;
  const completion = num(u["completion_tokens"]) ?? 0;
  const details = (u["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  const cacheRead = num(u["cache_read_input_tokens"]);
  const cacheWrite = num(u["cache_creation_input_tokens"]);
  if (cacheRead !== undefined || cacheWrite !== undefined) {
    const read = cacheRead ?? 0;
    const write = cacheWrite ?? 0;
    return {
      input_tokens: Math.max(0, prompt - read - write),
      output_tokens: completion,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
    };
  }
  const cached = num(details["cached_tokens"]) ?? 0;
  if (cached > 0) {
    return {
      input_tokens: Math.max(0, prompt - cached),
      output_tokens: completion,
      cache_read_input_tokens: cached,
    };
  }
  return { input_tokens: prompt, output_tokens: completion };
}

/** 内部 finish_reason → Anthropic `stop_reason`。 */
export function stopReasonOf(finishReason: unknown): string {
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

// ---------------------------------------------------------------------------
// 非流式：ChatCompletion → Anthropic message
// ---------------------------------------------------------------------------

/** Anthropic 内容块（只声明公共字段，类型串由语义决定）。 */
export interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

/** Anthropic 非流式响应体。 */
export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** 上游工具参数（JSON 串）→ Anthropic `input` 对象。 */
function parseToolInput(argumentsRaw: unknown): Record<string, unknown> {
  if (argumentsRaw !== null && typeof argumentsRaw === "object" && !Array.isArray(argumentsRaw)) {
    return argumentsRaw as Record<string, unknown>;
  }
  if (typeof argumentsRaw !== "string" || argumentsRaw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(argumentsRaw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 上游给了坏 JSON：保留一个可诊断的占位，别让调用凭空消失。
    return { _raw: argumentsRaw };
  }
  return {};
}

/**
 * 内部完整回复 → Anthropic `message` 对象。
 *
 * 块顺序按 Anthropic 惯例：`thinking` → `text` → `tool_use`。
 * 工具 id 缺失时补 `toolu_<messageId>_<n>`（客户端要拿它回传 tool_result）。
 */
export function toAnthropicMessage(
  payload: ChatCompletion,
  meta: { id: string; model: string },
): AnthropicMessage {
  const choice = payload.choices?.[0];
  const message = choice?.message as
    | {
        content?: unknown;
        reasoning_content?: unknown;
        tool_calls?: unknown;
      }
    | undefined;

  const content: AnthropicContentBlock[] = [];
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  if (reasoning.trim() !== "") content.push({ type: "thinking", thinking: reasoning });

  const text = typeof message?.content === "string" ? message.content : "";
  if (text !== "") content.push({ type: "text", text });

  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  calls.forEach((rawCall, i) => {
    if (rawCall === null || typeof rawCall !== "object") return;
    const call = rawCall as Record<string, unknown>;
    const fn = call["function"] !== null && typeof call["function"] === "object"
      ? (call["function"] as Record<string, unknown>)
      : {};
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
    usage: anthropicUsageFrom(payload.usage),
  };
}

// ---------------------------------------------------------------------------
// 流式：内部 chunk → Anthropic 事件帧
// ---------------------------------------------------------------------------

/** 响应 id 生成（`msg_…`；测试注入定值，生产不参与路由）。 */
export function newMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Anthropic 流式编码器。
 *
 * 输出顺序（Anthropic 客户端的硬要求）：
 *
 *     message_start
 *     → content_block_start / content_block_delta … / content_block_stop（可多块）
 *     → message_delta（带 stop_reason + usage）
 *     → message_stop
 *
 * `thinking` / `tool_use` 块按需出现：思考走 `thinking_delta`，工具调用先
 * `content_block_start(tool_use)` 再用 `input_json_delta` 把上游的参数分片原样透出
 * （整段一次到齐也可以，`partial_json` 本来就是累积语义）。
 */
export function createAnthropicSseCodec(meta: { id: string; model: string }): SseStreamCodec {
  let nextIndex = 0;
  let openKind: "text" | "thinking" | "tool_use" | null = null;
  let openIndex = -1;
  let openToolIndex: number | undefined;
  let finishReason: unknown = null;
  let usage: unknown = null;

  function closeOpen(): Uint8Array[] {
    if (openKind === null) return [];
    const frame = sseEventFrame("content_block_stop", {
      type: "content_block_stop",
      index: openIndex,
    });
    openKind = null;
    openToolIndex = undefined;
    return [frame];
  }

  function openBlock(kind: "text" | "thinking" | "tool_use", contentBlock: AnthropicContentBlock): Uint8Array[] {
    const out = closeOpen();
    openIndex = nextIndex;
    nextIndex += 1;
    openKind = kind;
    out.push(
      sseEventFrame("content_block_start", {
        type: "content_block_start",
        index: openIndex,
        content_block: contentBlock,
      }),
    );
    return out;
  }

  return {
    open(): Uint8Array[] {
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
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      ];
    },

    encode(chunk): Uint8Array[] {
      if (chunk && typeof chunk === "object" && chunk.usage) usage = chunk.usage;
      const out: Uint8Array[] = [];
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;
      if (choice && choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason;
      }
      if (delta === undefined || delta === null) return out;

      if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
        if (openKind !== "thinking") out.push(...openBlock("thinking", { type: "thinking", thinking: "" }));
        out.push(
          sseEventFrame("content_block_delta", {
            type: "content_block_delta",
            index: openIndex,
            delta: { type: "thinking_delta", thinking: delta.reasoning_content },
          }),
        );
      }

      if (typeof delta.content === "string" && delta.content !== "") {
        if (openKind !== "text") out.push(...openBlock("text", { type: "text", text: "" }));
        out.push(
          sseEventFrame("content_block_delta", {
            type: "content_block_delta",
            index: openIndex,
            delta: { type: "text_delta", text: delta.content },
          }),
        );
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (call === null || typeof call !== "object") continue;
          const toolIndex = typeof call.index === "number" ? call.index : 0;
          if (openKind !== "tool_use" || openToolIndex !== toolIndex) {
            const id = typeof call.id === "string" && call.id !== "" ? call.id : `toolu_${meta.id}_${toolIndex}`;
            const name =
              call.function !== null && typeof call.function === "object" && typeof call.function.name === "string"
                ? call.function.name
                : "";
            out.push(...openBlock("tool_use", { type: "tool_use", id, name, input: {} }));
            openToolIndex = toolIndex;
          }
          const args =
            call.function !== null && typeof call.function === "object" ? call.function.arguments : undefined;
          if (typeof args === "string" && args !== "") {
            out.push(
              sseEventFrame("content_block_delta", {
                type: "content_block_delta",
                index: openIndex,
                delta: { type: "input_json_delta", partial_json: args },
              }),
            );
          }
        }
      }

      return out;
    },

    close(): Uint8Array[] {
      const out = closeOpen();
      out.push(
        sseEventFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReasonOf(finishReason), stop_sequence: null },
          // ⚠️ 这里带的是**本流最终**口径；input/output 一起给，缓存两格有才给。
          usage: anthropicUsageFrom(usage),
        }),
      );
      out.push(sseEventFrame("message_stop", { type: "message_stop" }));
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

/**
 * `POST /v1/messages` 的处理逻辑。
 *
 * 鉴权与路由由网关/宿主在**委托之前**完成（与 `/v1/chat/completions` 同一套
 * `requireKey`）；本函数只做解码 → 选路 → 编码，失败原样上抛，由外层统一错误
 * 出口映射成 `{"detail": {error: {type, message}}}`。
 */
export async function handleMessages(
  req: ApiHttpRequest,
  res: ApiHttpResponse,
  deps: ApiInterfaceDeps,
): Promise<void> {
  const bodyRaw = await readJsonBody(req);
  const body = (bodyRaw ?? {}) as Record<string, unknown>;
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
      `[gateway] /v1/messages 丢弃无法处理的请求字段 model=${model}: ${inbound.discarded.join(", ")}`,
    );
  }

  const signal = clientDisconnectSignal(req, res);
  const upstreamReq = toMessagesUpstreamRequest(inbound, stream);
  const sessionId = deps.deriveSessionId?.(inbound.chat);
  if (sessionId !== undefined) (upstreamReq.extra ??= {}).session_id = sessionId;
  upstreamReq.clientSignal = signal;

  const messageId = (deps.newMessageId ?? newMessageId)();
  const t0 = Date.now();
  const doneBase = {
    model,
    stream,
    session_id: sessionId ?? null,
    prompt_cache_key: cacheRoutingKeyOf(inbound.chat),
    discarded_fields: inbound.discarded.length > 0 ? inbound.discarded : null,
    request: body,
  };

  if (stream) {
    const codec = createAnthropicSseCodec({ id: messageId, model });
    try {
      await forwardSseStream(res, upstream, upstreamReq, signal, codec, (outcome, usage, firstChunkMs, totalMs) => {
        if (outcome !== "ok") {
          deps.logger?.warn?.(
            `[gateway] messages stream ${outcome} model=${model} ttft=${firstChunkMs ?? "-"}ms total=${totalMs}ms`,
          );
        }
        const ok = outcome === "ok";
        fireRequestDone(deps, {
          ...doneBase,
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
        });
      });
    } catch (exc) {
      fireRequestDone(deps, {
        ...doneBase,
        stream: true,
        ...doneFromError(exc, Date.now() - t0),
        ttft_ms: null,
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
      usage: usageToTokens(payload.usage),
    });
  } catch (exc) {
    fireRequestDone(deps, {
      ...doneBase,
      stream: false,
      ...doneFromError(exc, Date.now() - t0),
      ttft_ms: null,
    });
    await runFailureHook(deps, exc);
    throw exc;
  }
}
