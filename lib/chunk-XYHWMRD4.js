import {
  GatewayHttpError,
  reasoningEffortOf
} from "./chunk-7OUDRSRP.js";

// src/wire.ts
var MAX_BODY_BYTES = 64 * 1024 * 1024;
async function readJsonBody(req, limitBytes = MAX_BODY_BYTES) {
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
function writeJson(res, status, body, headers, rawBody) {
  const payload = rawBody !== void 0 ? Buffer.from(rawBody, "utf8") : Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    ...headers
  });
  res.end(payload);
}
function toUpstreamRequest(body, stream) {
  const mtClient = body.max_tokens || body.max_completion_tokens;
  const reasoningEffort = reasoningEffortOf(body);
  return {
    model: String(body.model ?? ""),
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream,
    temperature: body.temperature,
    max_tokens: mtClient,
    maxTokensClient: mtClient,
    top_p: body.top_p,
    stop: body.stop,
    tools: body.tools,
    tool_choice: body.tool_choice,
    ...reasoningEffort === void 0 ? {} : { reasoning_effort: reasoningEffort },
    extra: {}
  };
}

export {
  readJsonBody,
  writeJson,
  toUpstreamRequest
};
//# sourceMappingURL=chunk-XYHWMRD4.js.map
