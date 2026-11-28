import {
  estimateMessagesTokens,
  estimateTextTokens,
  rerouteModel
} from "./chunk-KFOQD7F3.js";
import {
  BUSY_DETAIL,
  GatewayHttpError,
  UpstreamError
} from "./chunk-KJWR6LSK.js";

// src/compact-chunk.ts
function lineTokens(line) {
  return Math.max(1, estimateTextTokens(line));
}
function stage0Clean(lines) {
  const out = [];
  let last = "";
  for (const raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
    if (line.trim() === "" && (out.length === 0 || out[out.length - 1].trim() === "")) continue;
    if (line === last && line.trim() !== "") continue;
    out.push(line);
    last = line;
  }
  return out;
}
var TRIM_HEAD_CHARS = 900;
var TRIM_TAIL_CHARS = 300;
function trimToolOutputs(messages, limit) {
  if (!(limit > 0)) return { messages: [...messages], trimmedChars: 0 };
  let trimmed = 0;
  const out = messages.map((message) => {
    if (message.role !== "tool") return message;
    const content = message.content;
    if (typeof content !== "string") return message;
    if (content.length <= Math.max(limit, TRIM_HEAD_CHARS + TRIM_TAIL_CHARS)) return message;
    const head = content.slice(0, TRIM_HEAD_CHARS);
    const tail = content.slice(content.length - TRIM_TAIL_CHARS);
    const removed = content.length - head.length - tail.length;
    trimmed += removed;
    return {
      ...message,
      content: `${head}
…[As One:压缩时省略 ${removed} 字符工具输出]…
${tail}`
    };
  });
  return { messages: out, trimmedChars: trimmed };
}
function flattenMessages(messages) {
  const lines = [];
  for (const message of messages) {
    lines.push(`[${message.role}]`);
    const content = message.content;
    if (typeof content === "string") {
      lines.push(...content.split("\n"));
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "text") {
        lines.push(...String(part.text ?? "").split("\n"));
      } else if (part.type === "image_url") {
        const url = String(part.image_url?.url ?? "");
        const ref = url.startsWith("data:") ? `attachment:${url.slice(0, 64)}` : url || "attachment:unknown";
        lines.push(`[image: ${ref}]`);
      } else {
        lines.push(`[${String(part.type ?? "unknown")}]`);
      }
    }
  }
  return lines;
}
function digestBudgetFor(regionTokens, ceiling = 8192) {
  if (!(regionTokens > 0)) return 48;
  return Math.max(48, Math.min(ceiling, Math.floor(regionTokens * 0.25)));
}
function planCompactChunks(messages, options) {
  const trimmed = trimToolOutputs(messages, options.toolOutputChars ?? 1200);
  const lines = stage0Clean(flattenMessages(trimmed.messages));
  const ratio = options.chunkRatio ?? 0.8;
  const overlap = options.overlapRatio ?? 0.08;
  const coreBudget = Math.max(
    1,
    Math.floor(Math.max(0, options.inputBudgetTokens) * ratio)
  );
  const tokens = lines.map(lineTokens);
  const total = tokens.reduce((a, b) => a + b, 0);
  const digestBudget = options.digestBudgetTokens ?? digestBudgetFor(total);
  if (!(coreBudget > 0) || total <= coreBudget) {
    return {
      chunks: [
        {
          lines,
          capTokens: Math.max(48, Math.min(digestBudget, digestBudgetFor(total))),
          tokens: total
        }
      ],
      split: false,
      totalLines: lines.length,
      regionTokens: total,
      trimmedChars: trimmed.trimmedChars
    };
  }
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let used = 0;
    let end = start;
    while (end < lines.length && used + tokens[end] <= coreBudget) {
      used += tokens[end];
      end += 1;
    }
    if (end === start) {
      const line = lines[start] ?? "";
      const pieceChars = Math.max(512, Math.floor(coreBudget * 3));
      for (let from = 0; from < line.length; from += pieceChars) {
        const piece = line.slice(from, from + pieceChars);
        chunks.push({ lines: [piece], capTokens: 0, tokens: lineTokens(piece) });
      }
      start += 1;
      continue;
    }
    chunks.push({ lines: lines.slice(start, end), capTokens: 0, tokens: used });
    if (end >= lines.length) break;
    const back = Math.max(1, Math.floor((end - start) * overlap));
    start = Math.max(end - back, start + 1);
  }
  const weight = chunks.reduce((a, c) => a + c.lines.length, 0) || 1;
  for (const chunk of chunks) {
    const share = Math.floor(digestBudget * chunk.lines.length / weight);
    chunk.capTokens = Math.max(48, Math.min(share, Math.floor(chunk.tokens * 0.4)));
  }
  return {
    chunks,
    split: chunks.length > 1,
    totalLines: lines.length,
    regionTokens: total,
    trimmedChars: trimmed.trimmedChars
  };
}
function needsMerge(chunkCount, degenerate = false) {
  return chunkCount > 1 || degenerate;
}
function joinDigests(digests) {
  if (digests.length === 1) return digests[0] ?? "";
  return digests.map((digest, i) => `## 片段 ${i + 1}/${digests.length}
${digest}`).join("\n\n");
}
function cleanDigest(text) {
  const lines = stage0Clean(text.split("\n"));
  const seen = /* @__PURE__ */ new Map();
  const out = [];
  for (const line of lines) {
    const key = line.trim();
    if (key.length >= 40) {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 2) continue;
    }
    out.push(line);
  }
  const cleaned = out.join("\n").trim();
  return { text: cleaned, removedChars: Math.max(0, text.length - cleaned.length) };
}
function buildMergePrompt(digests) {
  const parts = digests.map(
    (digest, i) => `## 分块 ${i + 1}/${digests.length}
${digest}`
  );
  return [
    "把下列分块摘要**整理归并成一份**连贯的会话检查点。要求:",
    "1. 按主题重组,去掉跨块重复、同一句话的反复复制和任何机械重复的行;",
    "2. 删掉工具输出原文、逐行代码/日志罗列,以及摘要模型自己的分析过程与自言自语",
    "   (例如「Okay, I can see...」「让我查看...」),只保留结论;",
    "3. 保留精确文件路径、命令、错误原文、标识符、数值、提交号与未完成任务;",
    "4. 输出语言与会话主体一致(中文会话用中文);专有名词、路径、命令、错误原文一律不翻译;",
    "5. 用户明确否定、暂缓或要求人工确认的事项(如「不要推送」「先不测」「X 后续再做」)",
    "   必须逐字保留,并标明是「禁止/暂缓」而不是「待办」——这决定下一轮不能做什么;",
    "6. 按「已定案决策 → 当前状态 → 待办 → 关键事实」的顺序组织,可用简短小标题,",
    "   但不要为每一节凑内容;末尾用**一行**说明省略了哪些类别的内容(不要列举具体内容);",
    "7. 输出必须明显短于输入;不要复述本指令,不要输出额外解释、标题前缀或总结语。",
    "",
    ...parts
  ].join("\n");
}

// src/llm-adapter.ts
var AS_ONE_PROVIDER = "as-one";
var AS_ONE_PROVIDER_NAME = "As One · 合一";
var AsOneLlmError = class extends Error {
  code;
  failure;
  constructor(message, code, extra = {}) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    const failure = { message, code };
    if (typeof extra.status === "number" && Number.isInteger(extra.status) && extra.status >= 100 && extra.status <= 599) {
      failure.status = extra.status;
    }
    if (typeof extra.providerRetryAfterMs === "number" && Number.isFinite(extra.providerRetryAfterMs) && extra.providerRetryAfterMs > 0) {
      failure.providerRetryAfterMs = extra.providerRetryAfterMs;
    }
    if (typeof extra.requestId === "string" && extra.requestId.length > 0) {
      failure.requestId = extra.requestId;
    }
    this.failure = Object.freeze(failure);
  }
};
var KIND_TO_CODE = {
  rate_limit: "RATE_LIMIT",
  auth: "AUTH",
  auth_challenge: "AUTH",
  bad_request: "INVALID_REQUEST",
  timeout: "TIMEOUT",
  connection: "TRANSPORT",
  upstream: "SERVER",
  already_streaming: "INVALID_REQUEST"
};
var CAPACITY_CODE = "CAPACITY";
function capacityFailureOf(err) {
  const detail = err.body?.detail;
  if (typeof detail !== "object" || detail === null) return void 0;
  const inner = detail.error;
  if (typeof inner !== "object" || inner === null) return void 0;
  if (inner.type !== "capacity") return void 0;
  const message = inner.message;
  return {
    message: typeof message === "string" && message.length > 0 ? message : BUSY_DETAIL,
    status: err.status
  };
}
function toLlmError(err, fallbackMessage) {
  if (err instanceof AsOneLlmError) return err;
  if (err instanceof GatewayHttpError) {
    const capacity = capacityFailureOf(err);
    if (capacity !== void 0) {
      return new AsOneLlmError(capacity.message, CAPACITY_CODE, { status: capacity.status });
    }
  }
  if (err instanceof UpstreamError) {
    const code = KIND_TO_CODE[err.kind] ?? "SERVER";
    const status = typeof err.statusCode === "number" ? err.statusCode : void 0;
    const message2 = err.raw?.text?.trim() || err.detail || err.kind;
    return new AsOneLlmError(message2, code, {
      status,
      providerRetryAfterMs: typeof err.retryAfter === "number" ? Math.round(err.retryAfter * 1e3) : void 0
    });
  }
  const message = err instanceof Error && err.message ? err.message : fallbackMessage;
  return new AsOneLlmError(message, "SERVER");
}
function positiveInt(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : void 0;
}
var EFFORT_LABELS = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max"
};
var UNKNOWN_CONTEXT_WINDOW = 128e3;
function fallbackContextWindow(maxOutputTokens) {
  return Math.max(UNKNOWN_CONTEXT_WINDOW, (maxOutputTokens ?? 0) * 2);
}
function modelInfoOf(entry, provider = AS_ONE_PROVIDER) {
  const info = {
    provider,
    id: entry.id,
    // 选择器上显示的就是这个字段(宿主 buildModelCatalog 取 model.name)。
    // 优先用清单算好的 `display_name` —— 它是**整张表**去重后的名字;裸 `name`
    // 单独看没问题,摆在一起会和逻辑模型撞车(用户 m44638)。
    name: entry.display_name ?? entry.name ?? entry.id,
    description: entry.litenexus_kind === "logical" ? `逻辑模型 · 由 ${entry.owned_by} 调度` : `真实模型 · ${entry.owned_by}`,
    // **所有** as-one 路由都声明 `image`:这里声明的是「这个路由**接受**图片附件」,
    // 不是「上游模型自己看得见图」。
    //
    // ⚠️ 为什么不能按 `supports_vision` 声明(2026-11-02「模型读不了图」):
    //  宿主按 `inputModalities` 决定要不要把图片交给模型 —— 不声明 image 时它会
    //  把整块图**替换成** `[image omitted because this model accepts text only;
    //  attachment sha256:…]`(`projectImagesForTextModel`),`read_image` 工具
    //  更是直接拒绝执行。于是 as-one 的图像桥**永远收不到图**:上游是文本模型
    //  没错,但网关本来会把图转成文字证据(见 core/gateway/image-bridge.ts),
    //  这条能力被客户端那一行声明直接掐死,用户看到的就是「模型不能读图」。
    //
    //  分工是清楚的:
    //  · 上游自己有视觉(链上有 `supportsVision` 端点)→ 网关**透传**图片,原生读;
    //  · 上游看不见图 → 网关**桥接**:逐张转成文字证据塞回原位,再发给文本模型。
    //  两条路都不需要客户端先替网关做决定。
    inputModalities: ["text", "image"],
    systemPromptUpdate: "in-history",
    toolUpdate: "in-history"
  };
  const out = positiveInt(entry.max_output_tokens);
  const ctx = positiveInt(entry.max_input_tokens) ?? fallbackContextWindow(out);
  info.context = { contextWindow: ctx };
  if (out !== void 0) info.defaultMaxTokens = out;
  const efforts = Array.isArray(entry.reasoning_efforts) ? entry.reasoning_efforts : [];
  if (efforts.length > 0) {
    const list = efforts.filter((e) => typeof e === "string" && e.length > 0).map((id) => ({ id, name: EFFORT_LABELS[id] ?? id }));
    if (entry.reasoning_allows_off === true) list.push({ id: "off", name: EFFORT_LABELS.off });
    if (list.length > 0) info.reasoning = { efforts: list };
  }
  return info;
}
function blockText(block) {
  if (block.type === "text" || block.type === "reasoning") {
    const t = block.text;
    return typeof t === "string" ? t : "";
  }
  return "";
}
function messageText(message) {
  return (message.content ?? []).filter((b) => b.type === "text").map(blockText).filter((s) => s.length > 0).join("\n");
}
function imageUrlOf(block) {
  const b = block;
  const str = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  const direct = str(b["url"]) ?? str(b["src"]) ?? str(b["data_url"]) ?? str(b["image_url"]);
  if (direct !== null) {
    if (direct.startsWith("data:") || /^https?:\/\//i.test(direct)) return direct;
  }
  for (const key of ["image_url", "source", "image"]) {
    const obj = b[key];
    if (typeof obj !== "object" || obj === null) continue;
    const inner = obj;
    const found = str(inner["url"]) ?? str(inner["data_url"]) ?? str(inner["data"]);
    if (found !== null) {
      if (found.startsWith("data:") || /^https?:\/\//i.test(found)) return found;
      return `data:image/png;base64,${found}`;
    }
  }
  const raw = str(b["data"]);
  if (raw !== null) {
    if (raw.startsWith("data:") || /^https?:\/\//i.test(raw)) return raw;
    return `data:image/png;base64,${raw}`;
  }
  const att = b["attachment"];
  if (typeof att === "object" && att !== null) {
    const inner = att;
    const found = str(inner["url"]) ?? str(inner["data_url"]) ?? str(inner["dataUrl"]) ?? str(inner["data"]);
    if (found !== null) {
      if (found.startsWith("data:") || /^https?:\/\//i.test(found)) return found;
      if (found.length >= 64) return `data:image/png;base64,${found}`;
    }
  }
  return null;
}
async function attachmentImageUrl(block, attachments, targetOf, cache, signal) {
  const ref = block.attachment;
  if (ref === void 0 || typeof ref.attachmentId !== "string" || ref.attachmentId === "") {
    const shape = Object.entries(block).map(([k, v]) => {
      if (k === "attachment" && typeof v === "object" && v !== null) {
        const keys = Object.keys(v).join("|");
        return `attachment{${keys}}`;
      }
      return `${k}:${v === null ? "null" : typeof v}`;
    }).join(", ");
    console.warn(`[as-one] 图片块形状不认识(既无 url 也无 attachmentId):{${shape}}`);
    return null;
  }
  const hit = cache.get(ref.attachmentId);
  if (hit !== void 0) return hit;
  try {
    const full = {
      attachmentId: ref.attachmentId,
      mediaType: typeof ref.mediaType === "string" && ref.mediaType !== "" ? ref.mediaType : "image/png",
      bytes: typeof ref.bytes === "number" && ref.bytes > 0 ? ref.bytes : 0,
      width: typeof ref.width === "number" && ref.width > 0 ? ref.width : 0,
      height: typeof ref.height === "number" && ref.height > 0 ? ref.height : 0
    };
    const version = await attachments.readImageRequest(full, targetOf(full), signal);
    const mediaType = typeof version.mediaType === "string" && version.mediaType !== "" ? version.mediaType : full.mediaType;
    const url = `data:${mediaType};base64,${Buffer.from(version.data).toString("base64")}`;
    cache.set(ref.attachmentId, url);
    return url;
  } catch (err) {
    console.warn(
      `[as-one] 图片附件读取失败(attachmentId=${ref.attachmentId.slice(0, 12)}…): ${err instanceof Error ? err.message : String(err)}`
    );
    cache.set(ref.attachmentId, null);
    return null;
  }
}
function imageUnreadableBlock(reason) {
  return {
    type: "text",
    text: `[图片: 附件未能读取(${reason})。这张图本轮不可见。]`
  };
}
async function resolveImagesInMessages(messages, attachments, targetOf, signal) {
  const anyImage = messages.some((m) => (m.content ?? []).some((b) => b.type === "image"));
  if (!anyImage) return messages;
  const cache = /* @__PURE__ */ new Map();
  const out = [];
  for (const message of messages) {
    const blocks = message.content ?? [];
    if (!blocks.some((b) => b.type === "image")) {
      out.push(message);
      continue;
    }
    const next = [];
    for (const block of blocks) {
      if (block.type !== "image") {
        next.push(block);
        continue;
      }
      if (imageUrlOf(block) !== null) {
        next.push(block);
        continue;
      }
      if (attachments === void 0) {
        next.push(imageUnreadableBlock("当前宿主没有附件服务"));
        console.warn("[as-one] 图片附件未解析:宿主没有 attachments 服务(resolveAttachments 返回 undefined)");
        continue;
      }
      const url = await attachmentImageUrl(block, attachments, targetOf, cache, signal);
      if (url === null) {
        next.push(imageUnreadableBlock("附件读取失败"));
        continue;
      }
      next.push({ ...block, url });
    }
    out.push({ ...message, content: next });
  }
  return out;
}
function userContentOf(message) {
  const parts = [];
  for (const block of message.content ?? []) {
    if (block.type === "text") {
      const text = blockText(block);
      if (text !== "") parts.push({ type: "text", text });
      continue;
    }
    const url = imageUrlOf(block);
    if (url !== null) parts.push({ type: "image_url", image_url: { url } });
  }
  const hasImage = parts.some((p) => p.type === "image_url");
  if (!hasImage) {
    const text = messageText(message);
    return text;
  }
  return parts;
}
function toChatMessages(options) {
  const systemParts = [];
  if (typeof options.system === "string" && options.system.trim()) systemParts.push(options.system);
  const messages = [];
  for (const message of options.messages ?? []) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = messageText(message);
        if (text) systemParts.push(text);
        break;
      }
      case "assistant": {
        const text = messageText(message);
        const reasoning = (message.content ?? []).filter((b) => b.type === "reasoning").map((b) => blockText(b)).join("");
        const toolCalls = (message.content ?? []).filter((b) => b.type === "tool-call").map((b) => ({
          id: String(b.id ?? ""),
          type: "function",
          function: {
            name: String(b.name ?? ""),
            arguments: String(b.arguments ?? "")
          }
        })).filter((tc) => tc.id !== "" || tc.function.name !== "");
        messages.push({
          role: "assistant",
          // 只有 tool_calls 没有正文时给空串:`ChatMessageContent` 不收 null,
          // 而上游对 `content: ""` + `tool_calls` 的接受度比 null 更好。
          content: text,
          ...reasoning ? { reasoning_content: reasoning } : {},
          ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
        });
        break;
      }
      case "tool": {
        const parts = [];
        const toolText = messageText(message);
        if (toolText !== "") parts.push({ type: "text", text: toolText });
        for (const block of message.content ?? []) {
          if (block.type !== "image") continue;
          const url = imageUrlOf(block);
          if (url !== null) parts.push({ type: "image_url", image_url: { url } });
        }
        messages.push({
          role: "tool",
          // 无图时保持纯字符串(历史消息的最小形状不变)。
          content: parts.some((p) => p.type === "image_url") ? parts : toolText,
          tool_call_id: message.toolCallId ?? ""
        });
        break;
      }
      default: {
        messages.push({ role: "user", content: userContentOf(message) });
      }
    }
  }
  if (systemParts.length > 0) messages.unshift({ role: "system", content: systemParts.join("\n\n") });
  return messages;
}
function toWireBlocks(options) {
  const messages = [];
  for (const message of options.messages ?? []) {
    const content = [];
    if (message.role === "tool") {
      const text = messageText(message);
      if (text !== "") content.push({ type: "text", text });
      for (const block of message.content ?? []) {
        if (block.type !== "image") continue;
        const url = imageUrlOf(block);
        if (url !== null) content.push({ type: "image", url });
      }
      messages.push({
        role: "tool",
        content,
        ...message.toolCallId !== void 0 && message.toolCallId !== "" ? { toolCallId: message.toolCallId } : {}
      });
      continue;
    }
    for (const block of message.content ?? []) {
      if (block.type === "text" || block.type === "reasoning") {
        const text = blockText(block);
        if (text !== "") content.push({ type: block.type, text });
      } else if (block.type === "image") {
        const url = imageUrlOf(block);
        if (url !== null) content.push({ type: "image", url });
      } else if (block.type === "tool-call") {
        const call = block;
        content.push({
          type: "tool-call",
          id: String(call.id ?? ""),
          name: String(call.name ?? ""),
          arguments: String(call.arguments ?? "")
        });
      }
    }
    messages.push({ role: message.role, content });
  }
  const tools = (options.tools ?? []).filter((t) => typeof t?.name === "string" && t.name.length > 0).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return {
    ...typeof options.system === "string" && options.system.trim() !== "" ? { system: options.system } : {},
    messages,
    ...tools.length > 0 ? { tools } : {}
  };
}
function toChatTools(options) {
  const tools = options.tools;
  if (!Array.isArray(tools) || tools.length === 0) return void 0;
  return tools.filter((t) => typeof t?.name === "string" && t.name.length > 0).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}
function toUpstreamRequestFromOptions(options) {
  const maxTokens = positiveInt(options.maxTokens);
  return {
    model: options.model,
    messages: toChatMessages(options),
    // 块投影：Messages 线族据此「blocks → messages」一次落地（chat 族不读它）。
    blocks: toWireBlocks(options),
    stream: true,
    temperature: options.temperature,
    max_tokens: maxTokens,
    maxTokensClient: maxTokens,
    stop: Array.isArray(options.stop) && options.stop.length > 0 ? options.stop : void 0,
    tools: toChatTools(options),
    ...options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {},
    // 会话亲和:宿主每个会话给一个 sessionId,与 /v1 路由侧的 session_id 同义。
    prompt_cache_key: options.sessionId,
    extra: { session_id: options.sessionId },
    clientSignal: options.signal
  };
}
function usageFromOpenAI(usage) {
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const details = usage.prompt_tokens_details ?? {};
  const completionDetails = usage.completion_tokens_details ?? {};
  const promptTokens = num(usage.prompt_tokens);
  const outputTokens = num(usage.completion_tokens);
  const explicitRead = typeof usage.cache_read_input_tokens === "number" ? num(usage.cache_read_input_tokens) : void 0;
  const explicitWrite = typeof usage.cache_creation_input_tokens === "number" ? num(usage.cache_creation_input_tokens) : void 0;
  const cacheReadTokens = explicitRead ?? num(details.cached_tokens);
  const cacheWriteTokens = explicitWrite ?? 0;
  const inputTokens = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const out = {
    inputTokens,
    outputTokens,
    totalTokens: num(usage.total_tokens) || promptTokens + outputTokens
  };
  if (cacheReadTokens > 0) out.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens > 0) out.cacheWriteTokens = cacheWriteTokens;
  const reasoningTokens = num(completionDetails.reasoning_tokens);
  if (reasoningTokens > 0) out.reasoningTokens = reasoningTokens;
  return out;
}
function finishKindOf(reason) {
  if (reason === "length") return "max-tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool-calls";
  return "stop";
}
function abortSignalPromise(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}
async function* translateStream(source, modelName, signal) {
  const blocks = /* @__PURE__ */ new Map();
  const order = [];
  let usage;
  let finishReason = null;
  let toolSeq = 0;
  const openBlock = function* (key, type) {
    const existing = blocks.get(key);
    if (existing) return;
    const block = { index: order.length, type, text: "" };
    blocks.set(key, block);
    order.push(block);
    yield { type: "block-start", index: block.index, blockType: type };
  };
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (; ; ) {
      const next = signal === void 0 ? iterator.next() : Promise.race([iterator.next(), abortSignalPromise(signal)]);
      const { done, value: chunk } = await next;
      if (done) break;
      if (chunk.usage) usage = usageFromOpenAI(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        yield* openBlock("reasoning", "reasoning");
        const block = blocks.get("reasoning");
        block.text += delta.reasoning_content;
        yield { type: "reasoning-delta", index: block.index, text: delta.reasoning_content };
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield* openBlock("text", "text");
        const block = blocks.get("text");
        block.text += delta.content;
        yield { type: "text-delta", index: block.index, text: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        const slot = typeof call.index === "number" ? call.index : toolSeq++;
        const key = `tool:${slot}`;
        let block = blocks.get(key);
        if (!block) {
          yield* openBlock(key, "tool-call");
          block = blocks.get(key);
        }
        const id = call.id ?? "";
        const name = call.function?.name ?? "";
        const args = call.function?.arguments ?? "";
        if (id) block.toolCallId = id;
        if (name) block.toolName = name;
        block.text += args;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: block.toolCallId ?? `call-${block.index}`,
          ...block.toolName ? { name: block.toolName } : {},
          argumentsDelta: args
        };
      }
    }
  } catch (err) {
    for (const block of order) yield blockEndOf(block);
    throw toLlmError(err, `As One 上游流中断(${modelName})`);
  }
  for (const block of order) yield blockEndOf(block);
  const kind = finishKindOf(finishReason);
  if (order.length === 0 && kind === "stop") {
    throw new AsOneLlmError(`As One 未返回任何内容(${modelName})`, "EMPTY_RESPONSE");
  }
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: { kind } };
}
function blockEndOf(block) {
  const content = block.type === "tool-call" ? {
    type: "tool-call",
    id: block.toolCallId ?? `call-${block.index}`,
    name: block.toolName ?? "",
    arguments: block.text
  } : { type: block.type, text: block.text };
  return { type: "block-end", index: block.index, block: content };
}
var COMPACT_BUDGET_RATIO = 0.5;
var COMPACT_BUDGET_MIN = 16e3;
var COMPACT_BUDGET_MAX = 16e4;
var COMPACT_BUDGET_FALLBACK = 48e3;
var COMPACT_CONCURRENCY = 3;
var COMPACT_CONCURRENCY_MAX = 6;
var COMPACT_MERGE_TOKENS = 4096;
var COMPACT_CHUNK_PROMPT = "把下列会话片段压缩成简洁要点。只输出要点本身:保留精确文件路径、命令、错误原文、标识符、数值与提交号;不要输出你的分析过程、推理或自言自语,不要复述工具输出原文或逐行代码,不要重复同一句话,不要输出额外解释。输出语言与会话主体保持一致(中文会话用中文),专有名词、路径、命令、错误原文一律不翻译;用户明确否定、暂缓或要求人工确认的事项必须逐字保留,并标明是「禁止/暂缓」而非「待办」(这决定下一轮不能做什么)。\n\n";
function compactInputBudget(windowTokens) {
  if (!(typeof windowTokens === "number") || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return COMPACT_BUDGET_FALLBACK;
  }
  return Math.max(
    COMPACT_BUDGET_MIN,
    Math.min(COMPACT_BUDGET_MAX, Math.floor(windowTokens * COMPACT_BUDGET_RATIO))
  );
}
async function eachLimit(items, limit, run) {
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  let cursor = 0;
  const worker = async () => {
    for (; ; ) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
}
var sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function splitLinesInHalf(lines) {
  if (lines.length >= 2) {
    const mid2 = Math.ceil(lines.length / 2);
    return [lines.slice(0, mid2), lines.slice(mid2)];
  }
  const line = lines[0] ?? "";
  if (line.length < 512) return null;
  const mid = Math.floor(line.length / 2);
  return [[line.slice(0, mid)], [line.slice(mid)]];
}
function abortedNow(signal) {
  return signal?.aborted === true;
}
var AsOneLlmAdapter = class {
  constructor(rt, opts = {}) {
    this.rt = rt;
    this.provider = opts.provider ?? AS_ONE_PROVIDER;
    this.providerName = opts.providerName ?? AS_ONE_PROVIDER_NAME;
    this.resolveAttachments = opts.resolveAttachments;
    this.reroutes = opts.reroutes ?? (() => ({}));
    this.subagentFallback = opts.subagentFallback;
    this.warmup = opts.warmup;
  }
  rt;
  provider;
  providerName;
  resolveAttachments;
  reroutes;
  subagentFallback;
  warmup;
  /**
   * 等一次额度预热（启动后首个请求先刷新到期时间，再 `resolveUpstream`）。
   *
   * ⚠️ **位置关键**：必须在 `rt.resolveUpstream()` 之前 —— 那一步内部就是
   * `scheduler.chain()`，due-first 的到期排序就在那一刻算。晚一步就等于
   * 「用空快照排完再刷」。
   *
   * 门自己吞掉「刷新失败」并放行（预热是优化，不是可用性前提）；这里只兜住
   * 门实现被替换成会抛的版本，避免把一次预热异常升级成「模型不可用」。
   */
  async awaitWarmup() {
    if (this.warmup === void 0) return;
    try {
      await this.warmup.wait();
    } catch (err) {
      console.warn("[as-one] 额度预热等待失败，已放行请求", err);
    }
  }
  /** `id` 必须**逐字**等于注册时的 provider,否则宿主判 `INVALID_ADAPTER`。 */
  providerInfo(provider) {
    return { id: provider, name: this.providerName };
  }
  /** 退避策略交给宿主默认(`{mode:"normal", maxRetries:5, …}`)。 */
  providerRetryPolicy() {
    return void 0;
  }
  /**
   * 本路由的**图片计价**声明 —— 宿主 token meter 每次测量都同步调它。
   *
   * ⚠️ **这个方法不写就整条链路崩**:宿主调用处是
   * `this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)`,
   * 可选链只护前面的 `get()`;方法本身不存在时抛的是
   * `TypeError: ... imageRequestPricing is not a function`,而且发生在**计量
   * 阶段** —— 用户看到的是"请求发不出去",日志里却在 llm runtime 深处。
   * 宿主基类 `LlmAdapter` 给了默认实现(`return undefined`),但本 adapter 是
   * 普通类、不继承宿主基类(宿主只有 .js 没有 .d.ts),默认实现落不到这里。
   *
   * 为什么返回 `undefined` 而不是一套单价:As One 的上游计费口径各不相同
   * (按次 / 按图块 / 按 token),拿不出一份对所有渠道都成立的视觉 token 换算;
   * 声明一个假单价会让宿主算出一个理直气壮的错数,比"不声明、由计量方回落
   * 中性估算"更糟。
   */
  imageRequestPricing(_provider, _model) {
    return void 0;
  }
  /**
   * 本路由发出去的图片尺寸/字节目标。
   *
   * As One **不做二次缩放**:图片原样透传给上游连接器(`toChatMessages` 把图片
   * 块转成 `image_url` 分段),要不要压缩由各连接器自己决定。所以这里原样回传
   * 宿主给的宽/高/字节数 —— 与宿主基类默认实现同义,但必须**显式存在**:
   * `ctx.llm.imageRequestTarget()` 的调用处同样会对 `undefined` 抛
   * `is not a function`。
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }
  async listModels() {
    const entries = await this.rt.listModels();
    return entries.map((entry) => {
      const info = modelInfoOf(entry, this.provider);
      return {
        provider: this.provider,
        id: info.id,
        name: info.name,
        description: info.description,
        inputModalities: info.inputModalities
      };
    });
  }
  async resolveModel(provider, model) {
    const entry = this.rt.resolveModelEntry(model);
    if (!entry) {
      throw new AsOneLlmError(`As One 没有这个模型:${model}`, "INVALID_REQUEST", { status: 404 });
    }
    return modelInfoOf(entry, provider || this.provider);
  }
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model);
    if (signal?.aborted) throw abortError();
    return {
      model: resolved,
      stream: (options) => this.stream(options)
    };
  }
  /**
   * 重路由的辅助请求不读图片像素,只留**可寻址**占位(块数不变)。
   *
   * 为什么不是"删掉图块":删块会缩短块序列,同一条历史在不同轮次产出不同
   * 字节;而占位文本只由附件 id / 文件名决定,同图恒同字节。位置信息也保住了
   * —— 模型仍然知道"这里原本有一张图"。
   */
  placeholderImages(messages) {
    return messages.map((message) => ({
      ...message,
      content: (message.content ?? []).map((block) => {
        if (block.type !== "image") return block;
        const att = block.attachment;
        const ref = att?.attachmentId ?? att?.name ?? "unknown";
        return { type: "text", text: `[image: ${ref}]` };
      })
    }));
  }
  /**
    * 分块摘要 →（必要时）单级归并 → 合成宿主认得的块流(只借用压缩算法)。
    *
    * 2026-11-14 提速重做,五件事:
    * 1. **块预算按目标模型窗口算**(`compactInputBudget`),不再写死 24k;
    * 2. **块并行**(`COMPACT_CONCURRENCY` 路),每块独立会话号,免得同一条亲和
    *    pin 把并发挤成串行(`concurrency=1` 的端点会直接 `all_busy`);
  * 3. **片段必由模型整理归并**(`needsMerge`,2026-11-15 用户定案):压出多个
  *    片段就再让模型重读全部片段、按主题重组去噪,交出一份连贯检查点;
  *    生成退化的长重复行先用 `cleanDigest` 确定性压掉,拼块只作为归并失败
  *    时的降级。归并输出预算按摘要总预算现算,避免小区域写出超长摘要;
    * 4. **单块失败不拖垮整次**:重试一次(限流退避),仍失败就跳过 —— 只要还有
    *    一块成功,就还能交出一份能用的检查点;
    * 5. **会话模型兜底**(`fallbackModel`,2026-11-14 用户定案):压缩车道重试
    *    无门时,块最后落到会话正在用的模型上再试一次 —— 换档前后的真实模型
    *    都在会话逻辑模型的池子里,回落逻辑模型即全覆盖;窗口由会话模型自己的
    *    真实成员把关(块体量照传 `minInputTokens`,装不下的成员路由不选)。
    */
  async *compactStream(upstream, request, model, fallbackModel) {
    const started = Date.now();
    const windows = await this.windowsOf(model);
    const budget = compactInputBudget(windows.max ?? windows.min);
    const plan = planCompactChunks(request.messages, { inputBudgetTokens: budget });
    const baseSession = String(request.extra?.session_id ?? request.prompt_cache_key ?? "anon");
    const width = plan.chunks.length >= 12 ? COMPACT_CONCURRENCY_MAX : COMPACT_CONCURRENCY;
    const concurrency = Math.max(1, Math.min(width, plan.chunks.length));
    const digests = new Array(plan.chunks.length).fill("");
    let failed = 0;
    let fallbackUses = 0;
    let slotSeq = 0;
    const runChunk = async (lines, capTokens, depth, constrain) => {
      const slot = slotSeq;
      slotSeq += 1;
      const promptChars = COMPACT_CHUNK_PROMPT.length + lines.join("\n").length;
      let constrainThis = constrain;
      let fallbackTried = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const body = {
          ...request,
          stream: false,
          messages: [{ role: "user", content: COMPACT_CHUNK_PROMPT + lines.join("\n") }],
          max_tokens: Math.max(48, Math.floor(capTokens / (depth + 1))),
          tools: void 0,
          // 选路门槛:这块报文体量多少,就只让装得下它的真实模型参与。
          // 按「字符数 / 3」高估一点(中文 1 token ≈ 1 字),宁可多排除一台。
          minInputTokens: constrainThis ? Math.max(1024, Math.ceil(promptChars / 3)) : void 0,
          // 每块一条独立的亲和键:同一条键会把并发请求排到同一个凭据上,
          // 那个凭据 `concurrency=1` 时后续请求直接 `all_busy`。
          prompt_cache_key: `${baseSession}#${slot}`,
          extra: { ...request.extra ?? {}, session_id: `${baseSession}#${slot}` }
        };
        if (abortedNow(request.clientSignal)) return "";
        try {
          const result = await upstream.complete(body);
          const text = result.choices?.[0]?.message?.content;
          return typeof text === "string" ? text : "";
        } catch (err) {
          if (abortedNow(request.clientSignal)) return "";
          const kind = err instanceof UpstreamError ? err.kind : "server";
          if (kind === "rate_limit" && attempt < 3) {
            await sleepMs(attempt === 1 ? 2e3 : 5e3);
            continue;
          }
          if (attempt === 1) {
            await sleepMs(300);
            constrainThis = false;
            continue;
          }
          if (!fallbackTried) {
            fallbackTried = true;
            const rescued = await this.completeOnFallback(
              fallbackModel,
              body,
              Math.max(1024, Math.ceil(promptChars / 3))
            );
            if (rescued !== void 0) {
              fallbackUses += 1;
              return rescued;
            }
          }
          const worthSplitting = kind === "bad_request";
          if (!worthSplitting || depth >= 2) {
            failed += 1;
            console.warn(
              `[as-one] compact 分块失败(重试后放弃,这块内容不在摘要里):${err instanceof Error ? err.message : String(err)}`
            );
            return "";
          }
          const halves = splitLinesInHalf(lines);
          if (halves === null) {
            failed += 1;
            console.warn(
              `[as-one] compact 分块失败(单行且无法再切,跳过):${err instanceof Error ? err.message : String(err)}`
            );
            return "";
          }
          const halfCap = Math.max(48, Math.floor(capTokens / 2));
          const [a, b] = await Promise.all([
            runChunk(halves[0], halfCap, depth + 1, true),
            runChunk(halves[1], halfCap, depth + 1, true)
          ]);
          return [a, b].filter((part) => part.trim() !== "").join("\n\n");
        }
      }
      return "";
    };
    await eachLimit(plan.chunks, concurrency, async (chunk, index) => {
      digests[index] = await runChunk(chunk.lines, chunk.capTokens, 0, true);
    });
    const rawKept = digests.filter((d) => d.trim() !== "");
    let removedChars = 0;
    const kept = rawKept.map((d) => {
      const cleaned = cleanDigest(d);
      removedChars += cleaned.removedChars;
      return cleaned.text;
    }).filter((d) => d.trim() !== "");
    const rawChars = rawKept.reduce((a, d) => a + d.length, 0) || 1;
    const degenerate = removedChars > rawChars * 0.2;
    let summary = joinDigests(kept);
    let merged = false;
    let mergeNeeded = false;
    if (needsMerge(kept.length, degenerate) && !abortedNow(request.clientSignal)) {
      mergeNeeded = true;
      const digestCapTotal = plan.chunks.reduce((a, c) => a + c.capTokens, 0);
      const mergeOut = Math.max(
        256,
        Math.min(COMPACT_MERGE_TOKENS, Math.floor(digestCapTotal * 0.9))
      );
      const mergePrompt = buildMergePrompt(kept);
      try {
        const result = await upstream.complete({
          ...request,
          stream: false,
          messages: [{ role: "user", content: mergePrompt }],
          max_tokens: mergeOut,
          tools: void 0,
          // 归并也按真实模型窗口选路:装不下整理后全部片段的成员不参与。
          minInputTokens: Math.max(1024, Math.ceil(mergePrompt.length / 3)),
          prompt_cache_key: `${baseSession}#merge`,
          extra: { ...request.extra ?? {}, session_id: `${baseSession}#merge` }
        });
        const text = result.choices?.[0]?.message?.content;
        if (typeof text === "string" && text.trim() && text.length < kept.join("\n").length * 1.2) {
          summary = text;
          merged = true;
        }
      } catch (err) {
        console.warn(
          `[as-one] compact 归并失败,改用分块拼接:${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (!summary.trim()) throw new AsOneLlmError("compact 摘要为空", "SERVER");
    console.info(
      `[as-one] compact model=${model} 窗口=${windows.min ?? "?"}/${windows.max ?? "?"} 预算=${budget} 块=${plan.chunks.length}(并发 ${concurrency},失败 ${failed},兜底 ${fallbackUses}) 区域≈${plan.regionTokens}tok 截断=${plan.trimmedChars}字符 去重=${removedChars}字符 归并=${merged ? "是" : mergeNeeded ? "失败降级" : "否"} 耗时=${Date.now() - started}ms`
    );
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: summary };
    yield { type: "block-end", index: 0, block: { type: "text", text: summary } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  /**
   * 会话模型兜底:压缩车道救不回来的块,拿到会话正在用的模型上试最后一次。
   *
   * 「按真实模型分配窗口」在这里落地 —— 兜底不是无脑转发:
   * - 会话模型装不下这块(估算体量超过池子里**最大**成员的窗口)→ 直接不试,
   *   省一次注定 400 的往返,交给减半重试;
   * - 装得下 → `minInputTokens` 照传,池子里装不下的真实成员路由不会选,
   *   选中的那台就是「窗口装得下这块的真实模型」。
   *
   * 失败一律返回 `undefined`(调用方继续走减半/放弃),兜底绝不放大故障。
   */
  async completeOnFallback(model, body, minInputTokens) {
    if (model === void 0) return void 0;
    const windows = await this.windowsOf(model);
    if (windows.max !== void 0 && minInputTokens > windows.max) return void 0;
    await this.awaitWarmup();
    const fbUpstream = this.rt.resolveUpstream(model);
    if (!fbUpstream) {
      console.warn(`[as-one] compact 会话模型兜底不可用(库里没有 ${model})`);
      return void 0;
    }
    try {
      const result = await fbUpstream.complete({ ...body, model, minInputTokens });
      const text = result.choices?.[0]?.message?.content;
      return typeof text === "string" && text.trim() !== "" ? text : void 0;
    } catch (err) {
      console.warn(
        `[as-one] compact 会话模型兜底失败(${model}):${err instanceof Error ? err.message : String(err)}`
      );
      return void 0;
    }
  }
  /**
   * 目标模型的窗口,两个口径一起给:
   *
   * - `min` —— 逻辑模型**成员里最小**的那个窗口(保证任何一次选路都装得下);
   * - `max` —— **成员里最大**的那个(压缩分块用它切块,再由请求上的
   *   `minInputTokens` 让选路避开装不下的成员)。
   *
   * 真实模型两者同值。两个都拿不到 → `undefined`,预算走保守兜底。
   */
  async windowsOf(model) {
    try {
      const entries = await this.rt.listModels();
      const entry = entries.find((e) => e.id === model);
      if (!entry) return {};
      const min = positiveInt(entry.max_input_tokens);
      const max = positiveInt(entry.max_member_input_tokens) ?? min;
      return { min, max };
    } catch {
      return {};
    }
  }
  /** 唯一的抽象:产出**语法合法**的块流。 */
  async *stream(options) {
    await this.awaitWarmup();
    const target = rerouteModel(this.reroutes(), options.purpose);
    let rerouted = target !== void 0;
    let model = target ?? options.model;
    let upstream = this.rt.resolveUpstream(model);
    if (!upstream && rerouted) {
      console.warn(`[as-one] 重路由目标不可用(${options.purpose}: ${model}),回落 ${options.model}`);
      rerouted = false;
      model = options.model;
      upstream = this.rt.resolveUpstream(model);
    }
    if (!upstream) {
      throw new AsOneLlmError(`As One 未知模型:${model}`, "INVALID_REQUEST", { status: 404 });
    }
    const resolvedMessages = rerouted ? this.placeholderImages(options.messages ?? []) : await resolveImagesInMessages(
      options.messages ?? [],
      this.resolveAttachments?.(),
      (ref) => this.imageRequestTarget(this.provider, model, ref),
      options.signal
    );
    const sessionId = rerouted ? `${options.sessionId ?? "anon"}:${String(options.purpose)}` : options.sessionId;
    let request = toUpstreamRequestFromOptions({
      ...options,
      model,
      messages: resolvedMessages,
      provider: this.provider,
      sessionId,
      tools: rerouted ? void 0 : options.tools
    });
    if (options.purpose === "compaction") {
      if (rerouted) {
        yield* this.compactStream(
          upstream,
          request,
          model,
          options.model === model ? void 0 : options.model
        );
        return;
      }
      const window = (await this.windowsOf(model)).min;
      if (window !== void 0 && estimateMessagesTokens(request.messages) > window - 1024) {
        console.warn(
          `[as-one] compact 请求装不下目标窗口(窗口 ${window}),改走分块摘要`
        );
        yield* this.compactStream(upstream, request, model);
        return;
      }
    }
    const t0 = Date.now();
    let firstChunkMs;
    let seen;
    let ok = false;
    let failure;
    let yieldedAny = false;
    let triedFallback = false;
    try {
      for (; ; ) {
        try {
          for await (const chunk of translateStream(upstream.stream(request), model, options.signal)) {
            if (chunk.type !== "usage" && chunk.type !== "finish") yieldedAny = true;
            if (firstChunkMs === void 0 && chunk.type !== "usage" && chunk.type !== "finish") {
              firstChunkMs = Date.now() - t0;
            }
            if (chunk.type === "usage") seen = chunk.usage;
            yield chunk;
          }
          ok = true;
          break;
        } catch (err) {
          const current = err instanceof AsOneLlmError ? err : toLlmError(err, `As One 调用失败(${model})`);
          if (!yieldedAny && !triedFallback && current.code === CAPACITY_CODE) {
            const fallback = this.subagentFallback?.(options.sessionId, model);
            if (fallback !== void 0 && fallback !== model) {
              const fallbackUpstream = this.rt.resolveUpstream(fallback);
              if (fallbackUpstream !== void 0) {
                triedFallback = true;
                model = fallback;
                upstream = fallbackUpstream;
                request = toUpstreamRequestFromOptions({
                  ...options,
                  model,
                  messages: resolvedMessages,
                  provider: this.provider,
                  sessionId,
                  tools: rerouted ? void 0 : options.tools
                });
                firstChunkMs = void 0;
                continue;
              }
            }
          }
          failure = current;
          throw current;
        }
      }
    } finally {
      const aborted = options.signal?.aborted === true;
      this.record(model, ok, failure, aborted, t0, firstChunkMs, seen, request);
    }
  }
  /** 统计挂钩失败绝不能影响已经发出的响应。 */
  record(model, ok, failure, aborted, t0, firstChunkMs, usage, request) {
    try {
      this.rt.onRequestDone({
        model,
        stream: true,
        ok,
        status: ok ? 200 : aborted ? 0 : failure?.failure.status ?? 500,
        error: ok ? null : failure?.message ?? "调用失败",
        error_kind: ok ? null : aborted ? "connection" : kindOfFailure(failure) ?? "upstream",
        latency_ms: Math.round(Date.now() - t0),
        ttft_ms: firstChunkMs === void 0 ? null : Math.round(firstChunkMs),
        usage: usage ? {
          // ⚠️ 面板/日志的 `prompt_tokens` 是 OpenAI 口径(**含**缓存),
          // 而宿主 usage 的 `inputTokens` 是未缓存量 —— 这里必须加回来,
          // 否则网关自己的统计会把 cached 记成「大于 prompt」。
          prompt_tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0),
          cached_tokens: usage.cacheReadTokens ?? 0,
          completion_tokens: usage.outputTokens
        } : null,
        session_id: typeof request.extra?.session_id === "string" ? request.extra.session_id : null,
        prompt_cache_key: request.prompt_cache_key ?? null,
        discarded_fields: null,
        request: { model: request.model, messages: request.messages, stream: true }
      });
    } catch {
    }
  }
};
function kindOfFailure(failure) {
  switch (failure?.code) {
    case "RATE_LIMIT":
      return "rate_limit";
    case "AUTH":
      return "auth";
    case "INVALID_REQUEST":
      return "bad_request";
    case "TIMEOUT":
      return "timeout";
    case "TRANSPORT":
      return "connection";
    case "SERVER":
      return "upstream";
    default:
      return null;
  }
}
function abortError() {
  return new AsOneLlmError("调用已取消", "ABORTED");
}

export {
  AS_ONE_PROVIDER,
  AsOneLlmAdapter
};
//# sourceMappingURL=chunk-ZPK4MQNY.js.map
