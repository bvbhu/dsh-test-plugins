/**
 * 对外 API 接口**端到端**测试（真实 node:http 临时端口，上游是内存 FakeUpstream，
 * 零真实网络调用 —— 与 `core/gateway/gateway.test.ts` 同一策略）。
 *
 * 覆盖：
 * - `applyApiInterface` 装配出的路由表（chat + messages 两个端点）；
 * - 新端点 `POST /v1/messages`：非流式信封、流式事件流、鉴权、错误码、
 *   工具调用映射、块投影是否递到上游；
 * - chat SSE **逐字节**回归：抽取 handler 之后输出必须与拆分前完全一致；
 * - 并发全忙（`allBusyError`）语义未变。
 */

import { describe, expect, it, vi } from "vitest";

import { allBusyError } from "@as-one/core/src/gateway/http.js";
import { startGateway } from "@as-one/core/src/gateway/server.js";
import { parseSseEvents } from "@as-one/core/src/gateway/sse.js";
import {
  UpstreamError,
  UpstreamErrorKind,
  type ChatCompletion,
  type ChatCompletionChunk,
  type GatewayOptions,
  type ModelEntry,
  type Upstream,
  type UpstreamRequest,
} from "@as-one/core/src/gateway/types.js";

import { applyApiInterface } from "./index.js";

// ---------------------------------------------------------------------------
// 内存 FakeUpstream
// ---------------------------------------------------------------------------

const KEY = "api-interface-key-0123456789";

const COMPLETION: ChatCompletion = {
  id: "cmpl-1",
  object: "chat.completion",
  created: 1,
  model: "deepseek-flash",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
};

function chunk(delta: ChatCompletionChunk["choices"][number]["delta"], finish: string | null = null): ChatCompletionChunk {
  return {
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const TEXT_CHUNKS: ChatCompletionChunk[] = [
  chunk({ role: "assistant" }),
  chunk({ content: "He" }),
  chunk({ content: "llo" }),
  {
    ...chunk({}),
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
  },
  chunk({}, "stop"),
];

const TOOL_CHUNKS: ChatCompletionChunk[] = [
  chunk({ role: "assistant" }),
  chunk({ content: "先查" }),
  chunk({
    tool_calls: [
      { index: 0, id: "call_1", type: "function", function: { name: "look", arguments: '{"x":1}' } },
    ],
  }),
  chunk({}, "tool_calls"),
];

class FakeUpstream implements Upstream {
  requests: UpstreamRequest[] = [];
  chunks: ChatCompletionChunk[] = TEXT_CHUNKS;
  completion: ChatCompletion = COMPLETION;
  failBeforeStart?: Error;

  async *stream(req: UpstreamRequest): AsyncGenerator<ChatCompletionChunk> {
    this.requests.push(req);
    if (this.failBeforeStart) throw this.failBeforeStart;
    for (const c of this.chunks) yield c;
  }

  async complete(req: UpstreamRequest): Promise<ChatCompletion> {
    this.requests.push(req);
    if (this.failBeforeStart) throw this.failBeforeStart;
    return this.completion;
  }
}

const MODELS: ModelEntry[] = [
  { id: "deepseek-flash", object: "model", owned_by: "as-one", litenexus_kind: "logical" },
];

function makeOptions(
  upstream: FakeUpstream,
  resolve?: (model: string) => Upstream | undefined,
): GatewayOptions {
  return {
    keyProvider: { getKey: () => KEY, onMissingKeyWarning: vi.fn() },
    modelProvider: { listModels: () => MODELS },
    resolveUpstream:
      resolve ?? ((model) => (model === "deepseek-flash" ? upstream : undefined)),
  };
}

type Started = Awaited<ReturnType<typeof startGateway>>;

async function withServer(
  upstream: FakeUpstream,
  fn: (ctx: { baseUrl: string; upstream: FakeUpstream }) => Promise<void>,
  resolve?: (model: string) => Upstream | undefined,
): Promise<void> {
  const started: Started = await startGateway(makeOptions(upstream, resolve));
  try {
    await fn({ baseUrl: `http://127.0.0.1:${started.port}`, upstream });
  } finally {
    await started.close();
  }
}

function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
}

const AUTH = { authorization: `Bearer ${KEY}` };

/** 流式响应原文 → 每帧的 `event:` 列表（Anthropic 事件帧）。 */
function eventNames(text: string): Array<string | undefined> {
  return parseSseEvents(text).map((e) => e.event);
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

describe("applyApiInterface：装配", () => {
  it("路由表同时含 chat 与 messages，routeOf 按路径取、方法为 POST", () => {
    const api = applyApiInterface({ resolveUpstream: () => undefined });
    expect(api.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/chat/completions",
      "POST /v1/messages",
    ]);
    expect(api.routeOf("/v1/messages")?.path).toBe("/v1/messages");
    expect(api.routeOf("/v1/messages/")?.path).toBe("/v1/messages");
    expect(api.routeOf("/v1/nope")).toBeUndefined();
  });

  it("mount 把两个端点都交给注册器", () => {
    const mounted: string[] = [];
    applyApiInterface({ resolveUpstream: () => undefined }, (route) => mounted.push(route.path));
    expect(mounted).toEqual(["/v1/chat/completions", "/v1/messages"]);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/messages —— 非流式
// ---------------------------------------------------------------------------

describe("POST /v1/messages (non-stream)", () => {
  it("200 + Anthropic message 信封 + 上游收到 chat IR 与块投影", async () => {
    const upstream = new FakeUpstream();
    await withServer(upstream, async ({ baseUrl }) => {
      const resp = await post(
        baseUrl,
        "/v1/messages",
        {
          model: "deepseek-flash",
          system: "你是助手",
          max_tokens: 1024,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        },
        AUTH,
      );
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as Record<string, unknown>;
      expect(body["type"]).toBe("message");
      expect(body["role"]).toBe("assistant");
      expect(body["model"]).toBe("deepseek-flash");
      expect(String(body["id"])).toMatch(/^msg_/);
      expect(body["stop_reason"]).toBe("end_turn");
      expect(body["stop_sequence"]).toBeNull();
      expect(body["content"]).toEqual([{ type: "text", text: "Hello" }]);
      expect(body["usage"]).toEqual({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 2,
      });

      // 同一条内部链路：UpstreamRequest 同时带 chat 消息与块投影。
      const req = upstream.requests[0]!;
      expect(req.model).toBe("deepseek-flash");
      expect(req.stream).toBe(false);
      expect(req.max_tokens).toBe(1024);
      expect(req.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(req.blocks?.system).toBe("你是助手");
      expect(req.blocks!.messages[0]!.content).toEqual([{ type: "text", text: "hi" }]);
    });
  });

  it("工具调用：finish_reason=tool_calls → stop_reason=tool_use + tool_use 块", async () => {
    const upstream = new FakeUpstream();
    upstream.completion = {
      ...COMPLETION,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_9", type: "function", function: { name: "look", arguments: '{"q":1}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    await withServer(upstream, async ({ baseUrl }) => {
      const resp = await post(
        baseUrl,
        "/v1/messages",
        { model: "deepseek-flash", max_tokens: 64, messages: [{ role: "user", content: "查" }] },
        AUTH,
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body["stop_reason"]).toBe("tool_use");
      expect(body["content"]).toEqual([{ type: "tool_use", id: "call_9", name: "look", input: { q: 1 } }]);
    });
  });

  it("Anthropic 工具定义映射到上游 chat 工具（同名同 schema）", async () => {
    const upstream = new FakeUpstream();
    await withServer(upstream, async ({ baseUrl }) => {
      await post(
        baseUrl,
        "/v1/messages",
        {
          model: "deepseek-flash",
          max_tokens: 64,
          tools: [
            { name: "look", description: "看图", input_schema: { type: "object", properties: { u: { type: "string" } } } },
          ],
          messages: [{ role: "user", content: "hi" }],
        },
        AUTH,
      );
      const req = upstream.requests[0]!;
      expect(req.tools?.[0]).toEqual({
        type: "function",
        function: {
          name: "look",
          description: "看图",
          parameters: { type: "object", properties: { u: { type: "string" } } },
        },
      });
      expect(req.blocks?.tools?.[0]?.name).toBe("look");
    });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/messages —— 流式
// ---------------------------------------------------------------------------

describe("POST /v1/messages (stream)", () => {
  it("200 + text/event-stream，事件顺序与文本增量符合 Anthropic 约定", async () => {
    const upstream = new FakeUpstream();
    await withServer(upstream, async ({ baseUrl }) => {
      const resp = await post(
        baseUrl,
        "/v1/messages",
        { model: "deepseek-flash", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
        AUTH,
      );
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/event-stream");
      expect(resp.headers.get("cache-control")).toBe("no-cache");

      const text = await resp.text();
      // ⚠️ Anthropic 流没有 [DONE] 哨兵。
      expect(text).not.toContain("[DONE]");

      const events = parseSseEvents(text);
      expect(events[0]?.event).toBe("message_start");
      expect(events.at(-1)?.event).toBe("message_stop");
      expect(eventNames(text)).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);

      const deltas = events
        .filter((e) => e.event === "content_block_delta")
        .map((e) => JSON.parse(e.data!) as Record<string, unknown>);
      expect(deltas.map((d) => (d["delta"] as Record<string, unknown>)["text"]).join("")).toBe("Hello");

      const messageDelta = events.find((e) => e.event === "message_delta");
      expect(JSON.parse(messageDelta!.data!)).toMatchObject({
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 2 },
      });

      // 上游确实按流式请求（stream=true）
      expect(upstream.requests[0]!.stream).toBe(true);
    });
  });

  it("工具调用流：tool_use 块 + input_json_delta + stop_reason=tool_use", async () => {
    const upstream = new FakeUpstream();
    upstream.chunks = TOOL_CHUNKS;
    await withServer(upstream, async ({ baseUrl }) => {
      const resp = await post(
        baseUrl,
        "/v1/messages",
        { model: "deepseek-flash", max_tokens: 64, stream: true, messages: [{ role: "user", content: "查" }] },
        AUTH,
      );
      const text = await resp.text();
      const events = parseSseEvents(text);
      const starts = events
        .filter((e) => e.event === "content_block_start")
        .map((e) => JSON.parse(e.data!) as Record<string, unknown>);
      expect(starts.map((s) => (s["content_block"] as Record<string, unknown>)["type"])).toEqual([
        "text",
        "tool_use",
      ]);

      const deltaTypes = events
        .filter((e) => e.event === "content_block_delta")
        .map((e) => (JSON.parse(e.data!)["delta"] as Record<string, unknown>)["type"]);
      expect(deltaTypes).toContain("input_json_delta");

      const messageDelta = events.find((e) => e.event === "message_delta");
      expect(JSON.parse(messageDelta!.data!)).toMatchObject({ delta: { stop_reason: "tool_use" } });
    });
  });
});

// ---------------------------------------------------------------------------
// 错误路径：与 chat 同一套鉴权/状态码/错误体
// ---------------------------------------------------------------------------

describe("POST /v1/messages —— 错误路径", () => {
  it("无 key → 401，且没打到上游", async () => {
    const upstream = new FakeUpstream();
    await withServer(upstream, async ({ baseUrl }) => {
      const resp = await post(baseUrl, "/v1/messages", { model: "deepseek-flash", messages: [] });
      expect(resp.status).toBe(401);
      expect(((await resp.json()) as { detail: string }).detail).toBe("缺少或错误的网关 key");
      expect(upstream.requests).toHaveLength(0);
    });
  });

  it("缺 model → 400「缺少 model」；未知模型 → 404", async () => {
    await withServer(new FakeUpstream(), async ({ baseUrl }) => {
      const missing = await post(baseUrl, "/v1/messages", { messages: [] }, AUTH);
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { detail: string }).detail).toBe("缺少 model");

      const unknown = await post(baseUrl, "/v1/messages", { model: "ghost", messages: [] }, AUTH);
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { detail: string }).detail).toBe("未知模型: ghost");
    });
  });

  it("GET /v1/messages → 405；坏 JSON → 400", async () => {
    await withServer(new FakeUpstream(), async ({ baseUrl }) => {
      const wrongMethod = await fetch(`${baseUrl}/v1/messages`, {
        headers: AUTH,
        signal: AbortSignal.timeout(5_000),
      });
      expect(wrongMethod.status).toBe(405);

      const bad = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "{not json",
        signal: AbortSignal.timeout(5_000),
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { detail: string }).detail).toBe("请求体不是合法 JSON");
    });
  });

  it("上游 429 → 429 + Retry-After + detail.error（与 chat 同形状）", async () => {
    const upstream = new FakeUpstream();
    upstream.failBeforeStart = new UpstreamError(UpstreamErrorKind.RateLimit, "配额耗尽", { retryAfter: 12 });
    await withServer(upstream, async ({ baseUrl }) => {
      const resp = await post(
        baseUrl,
        "/v1/messages",
        { model: "deepseek-flash", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
        AUTH,
      );
      expect(resp.status).toBe(429);
      expect(resp.headers.get("retry-after")).toBe("12");
      const body = (await resp.json()) as { detail: { error: { type: string; message: string } } };
      expect(body.detail.error.type).toBe("rate_limit");
      expect(body.detail.error.message).toContain("配额耗尽");
      expect((body as { error?: unknown }).error).toBeUndefined();
    });
  });

  it("并发全忙（allBusyError）→ 503 capacity，语义与 chat 完全一致", async () => {
    const busy = () => {
      throw allBusyError();
    };
    await withServer(
      new FakeUpstream(),
      async ({ baseUrl }) => {
        for (const path of ["/v1/messages", "/v1/chat/completions"]) {
          const resp = await post(
            baseUrl,
            path,
            { model: "deepseek-flash", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
            AUTH,
          );
          expect(resp.status).toBe(503);
          const body = (await resp.json()) as { detail: { error: { type: string; message: string } } };
          expect(body.detail.error.type).toBe("capacity");
          expect(body.detail.error.message).toContain("并发已满");
          expect(resp.headers.get("retry-after")).toBeNull();
        }
      },
      busy,
    );
  });
});

// ---------------------------------------------------------------------------
// chat SSE 逐字节回归（行为不变的机器证据）
// ---------------------------------------------------------------------------

describe("chat SSE 逐字节回归（抽取 handler 后）", () => {
  it("每一帧都是 `data: {json}\\n\\n`，结尾恰好 `data: [DONE]\\n\\n`", async () => {
    const upstream = new FakeUpstream();
    upstream.chunks = [chunk({ role: "assistant" }), chunk({ content: "你好" }), chunk({}, "stop")];
    await withServer(upstream, async ({ baseUrl }) => {
      const resp = await post(
        baseUrl,
        "/v1/chat/completions",
        { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], stream: true },
        AUTH,
      );
      expect(resp.status).toBe(200);
      const expected =
        upstream.chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
      // 逐字节：UTF-8 原文（中文不转义）、帧分隔、[DONE] 收尾。
      expect(await resp.text()).toBe(expected);
    });
  });

  it("非流式 chat 响应体与上游 chat.completion 逐字节一致", async () => {
    const upstream = new FakeUpstream();
    await withServer(upstream, async ({ baseUrl }) => {
      const resp = await post(
        baseUrl,
        "/v1/chat/completions",
        { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] },
        AUTH,
      );
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe(JSON.stringify(COMPLETION));
    });
  });
});

// ---------------------------------------------------------------------------
// chat 端点的既有字段语义（抽取后仍走同一份实现）
// ---------------------------------------------------------------------------

describe("chat 端点字段语义未变", () => {
  it("prompt_cache_key 进专用内部键，不进 extra；未知字段被记录但不拒绝", async () => {
    const upstream = new FakeUpstream();
    const seen: Array<Record<string, unknown>> = [];
    const options: GatewayOptions = {
      ...makeOptions(upstream),
      onRequestDone: (info) => seen.push(info as unknown as Record<string, unknown>),
    };
    const started = await startGateway(options);
    try {
      const resp = await post(
        `http://127.0.0.1:${started.port}`,
        "/v1/chat/completions",
        {
          model: "deepseek-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          prompt_cache_key: "pc-1",
          mystery: 1,
        },
        AUTH,
      );
      expect(resp.status).toBe(200);
      await resp.text();
      const req = upstream.requests[0]!;
      expect(req.prompt_cache_key).toBe("pc-1");
      expect((req.extra as Record<string, unknown> | undefined)?.prompt_cache_key).toBeUndefined();
      const info = seen[0]!;
      expect(info["prompt_cache_key"]).toBe("pc-1");
      expect(info["discarded_fields"]).toEqual(["mystery"]);
    } finally {
      await started.close();
    }
  });
});
