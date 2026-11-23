/**
 * Anthropic Messages 入站/出站**语义单测**（不起网络）。
 *
 * 这里钉三件事：
 * 1. `fromAnthropicRequest` 的解码结果同时满足**块投影**（blocks）与 **chat IR**
 *    —— 两个视图必须来自同一份解码，否则 chat 族与 messages 族上游会看到不同的
 *    对话；
 * 2. 解码结果能被**已有的出站编码器**（`toAnthropicRequestFromBlocks`）还原成
 *    合法的 Messages 请求体 —— 这是「入站解码没有发明第二套语义」的机器证明；
 * 3. 流式事件帧的顺序/形状严格符合 Anthropic 客户端预期
 *    （`message_start → content_block_* → message_delta → message_stop`）。
 */

import { describe, expect, it } from "vitest";

import { parseSseEvents } from "@as-one/core/src/gateway/sse.js";
import type { ChatCompletion, ChatCompletionChunk } from "@as-one/core/src/gateway/types.js";
import { toAnthropicRequestFromBlocks } from "@as-one/core/src/wire/anthropic.js";

import {
  anthropicUsageFrom,
  createAnthropicSseCodec,
  fromAnthropicRequest,
  stopReasonOf,
  toAnthropicMessage,
  toMessagesUpstreamRequest,
} from "./message.js";

// ---------------------------------------------------------------------------
// 请求解码：Anthropic JSON → BlockRequest + chat IR
// ---------------------------------------------------------------------------

const REQUEST = {
  model: "deepseek-flash",
  system: [{ type: "text", text: "你是助手" }],
  max_tokens: 1024,
  temperature: 0.5,
  top_p: 0.9,
  stop_sequences: ["END"],
  stream: true,
  tools: [
    {
      name: "look",
      description: "看图",
      input_schema: { type: "object", properties: { url: { type: "string" } } },
    },
  ],
  tool_choice: { type: "tool", name: "look" },
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先看。" },
        { type: "text", text: "好的" },
        { type: "tool_use", id: "call_1", name: "look", input: { url: "u" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "看完了" }] }],
    },
  ],
  mystery_flag: 1,
} as const;

describe("fromAnthropicRequest：请求解码", () => {
  const inbound = fromAnthropicRequest(REQUEST as unknown as Record<string, unknown>);

  it("块投影：system / user(图) / assistant(思考+文本+工具) / tool_result", () => {
    expect(inbound.blocks.system).toBe("你是助手");
    expect(inbound.blocks.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

    expect(inbound.blocks.messages[0]!.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image", url: "data:image/png;base64,AAA" },
    ]);
    expect(inbound.blocks.messages[1]!.content).toEqual([
      { type: "reasoning", text: "先看。" },
      { type: "text", text: "好的" },
      { type: "tool-call", id: "call_1", name: "look", arguments: '{"url":"u"}' },
    ]);
    expect(inbound.blocks.messages[2]).toEqual({
      role: "tool",
      toolCallId: "call_1",
      content: [{ type: "text", text: "看完了" }],
    });
  });

  it("chat IR：同一份解码的 chat 形状（system → user → assistant → tool）", () => {
    expect(inbound.chat.model).toBe("deepseek-flash");
    expect(inbound.chat.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(inbound.chat.messages[0]).toEqual({ role: "system", content: "你是助手" });
    expect(inbound.chat.messages[1]!.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
    expect(inbound.chat.messages[2]).toMatchObject({
      role: "assistant",
      content: "好的",
      reasoning_content: "先看。",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "look", arguments: '{"url":"u"}' } }],
    });
    expect(inbound.chat.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "看完了" });
  });

  it("采样参数 / 工具选择 / 停止串原样落到 chat IR", () => {
    expect(inbound.chat.max_tokens).toBe(1024);
    expect(inbound.chat.temperature).toBe(0.5);
    expect(inbound.chat.top_p).toBe(0.9);
    expect(inbound.chat.stop).toEqual(["END"]);
    expect(inbound.chat.stream).toBe(true);
    expect(inbound.chat.tools?.[0]).toEqual({
      type: "function",
      function: {
        name: "look",
        description: "看图",
        parameters: { type: "object", properties: { url: { type: "string" } } },
      },
    });
    expect(inbound.chat.tool_choice).toEqual({ type: "function", function: { name: "look" } });
  });

  it("工具定义同时进块投影（messages 族上游不经过 chat 形状）", () => {
    expect(inbound.blocks.tools).toEqual([
      {
        name: "look",
        description: "看图",
        parameters: { type: "object", properties: { url: { type: "string" } } },
      },
    ]);
  });

  it("不认识的顶层字段只记录、不拒绝请求", () => {
    expect(inbound.discarded).toContain("顶层字段 mystery_flag");
  });

  it("tool_choice.any → required；auto → auto；disable_parallel_tool_use → parallel_tool_calls=false", () => {
    const any = fromAnthropicRequest({ model: "m", messages: [], tool_choice: { type: "any" } });
    expect(any.chat.tool_choice).toBe("required");
    const auto = fromAnthropicRequest({ model: "m", messages: [], tool_choice: { type: "auto" } });
    expect(auto.chat.tool_choice).toBe("auto");
    const noParallel = fromAnthropicRequest({
      model: "m",
      messages: [],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
    expect(noParallel.chat.parallel_tool_calls).toBe(false);
  });

  it("红acted_thinking / document 等内容块类型只记录、不拒绝", () => {
    const decoded = fromAnthropicRequest({
      model: "m",
      messages: [{ role: "user", content: [{ type: "document", source: {} }] }],
    });
    expect(decoded.discarded).toContain("messages[0].content.type=document");
    expect(decoded.blocks.messages[0]!.content).toEqual([]);
  });
});

describe("toMessagesUpstreamRequest：收敛到同一条内部链路", () => {
  const inbound = fromAnthropicRequest(REQUEST as unknown as Record<string, unknown>);
  const req = toMessagesUpstreamRequest(inbound);

  it("同一个 UpstreamRequest 带上块投影与 chat 消息", () => {
    expect(req.model).toBe("deepseek-flash");
    expect(req.stream).toBe(true);
    expect(req.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(req.blocks).toBe(inbound.blocks);
    expect(req.max_tokens).toBe(1024);
    expect(req.maxTokensClient).toBe(1024);
    expect(req.discarded_fields).toContain("顶层字段 mystery_flag");
  });

  it("解码结果能被既有出站编码器还原成合法 Messages 请求（无第二套语义）", () => {
    const out = toAnthropicRequestFromBlocks(inbound.blocks, "upstream-model", undefined, undefined, 1024);
    expect(out["system"]).toBe("你是助手");
    const messages = out["messages"] as Array<Record<string, unknown>>;
    expect(messages.map((m) => m["role"])).toEqual(["user", "assistant", "user"]);
    expect(messages[0]!["content"]).toEqual([
      { type: "text", text: "看图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
    ]);
    expect(messages[2]!["content"]).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "看完了" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// usage / stop_reason
// ---------------------------------------------------------------------------

describe("anthropicUsageFrom：input_tokens 不含缓存", () => {
  it("有缓存拆分时反算 input_tokens（prompt = 新 + 读 + 写）", () => {
    expect(
      anthropicUsageFrom({
        prompt_tokens: 100,
        completion_tokens: 20,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 10,
      }),
    ).toEqual({
      input_tokens: 20,
      output_tokens: 20,
      cache_read_input_tokens: 70,
      cache_creation_input_tokens: 10,
    });
  });

  it("只有 OpenAI 的 cached_tokens 时按 cache_read 回退", () => {
    expect(
      anthropicUsageFrom({
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual({ input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4 });
  });

  it("没有缓存信息时原样给 prompt_tokens；usage 缺失全 0（不捏造缓存字段）", () => {
    expect(anthropicUsageFrom({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({
      input_tokens: 10,
      output_tokens: 2,
    });
    expect(anthropicUsageFrom(null)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("stopReasonOf：finish_reason → Anthropic stop_reason", () => {
  it.each([
    ["stop", "end_turn"],
    [null, "end_turn"],
    [undefined, "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["function_call", "tool_use"],
    ["content_filter", "refusal"],
  ])("%s → %s", (finish, expected) => {
    expect(stopReasonOf(finish)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 非流式响应
// ---------------------------------------------------------------------------

const COMPLETION: ChatCompletion = {
  id: "cmpl-1",
  object: "chat.completion",
  created: 1,
  model: "deepseek-flash",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "答案",
        reasoning_content: "先想。",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "look", arguments: '{"x":1}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 4 },
  },
};

describe("toAnthropicMessage：非流式响应", () => {
  const message = toAnthropicMessage(COMPLETION, { id: "msg_test", model: "deepseek-flash" });

  it("Anthropic 信封字段齐全", () => {
    expect(message).toMatchObject({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "deepseek-flash",
      stop_reason: "tool_use",
      stop_sequence: null,
    });
  });

  it("内容块顺序：thinking → text → tool_use，参数是解析后的对象", () => {
    expect(message.content).toEqual([
      { type: "thinking", thinking: "先想。" },
      { type: "text", text: "答案" },
      { type: "tool_use", id: "call_1", name: "look", input: { x: 1 } },
    ]);
  });

  it("usage 按 Anthropic 口径（input 不含缓存）", () => {
    expect(message.usage).toEqual({
      input_tokens: 6,
      output_tokens: 2,
      cache_read_input_tokens: 4,
    });
  });

  it("工具 id 缺失时补 toolu_<messageId>_<n>；坏 JSON 参数保留 _raw 占位", () => {
    const payload: ChatCompletion = {
      ...COMPLETION,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ type: "function", function: { name: "look", arguments: "{bad" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const content = toAnthropicMessage(payload, { id: "msg_x", model: "m" }).content;
    const tool = content.find((b) => b.type === "tool_use") as Record<string, unknown> | undefined;
    expect(tool?.["id"]).toBe("toolu_msg_x_0");
    expect(tool?.["input"]).toEqual({ _raw: "{bad" });
  });

  it("空回复也至少有一个文本块（客户端不必处理空 content）", () => {
    const empty: ChatCompletion = {
      ...COMPLETION,
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    };
    expect(toAnthropicMessage(empty, { id: "m", model: "m" }).content).toEqual([{ type: "text", text: "" }]);
  });
});

// ---------------------------------------------------------------------------
// 流式编码
// ---------------------------------------------------------------------------

function chunk(delta: ChatCompletionChunk["choices"][number]["delta"], finish: string | null = null): ChatCompletionChunk {
  return {
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function eventsOf(frames: Uint8Array[]): Array<{ event?: string; data?: string }> {
  return parseSseEvents(Buffer.concat(frames.map((f) => Buffer.from(f))).toString("utf8"));
}

describe("createAnthropicSseCodec：流式事件帧", () => {
  it("文本流：message_start → 文本块 → message_delta → message_stop（无 [DONE]）", () => {
    const codec = createAnthropicSseCodec({ id: "msg_test", model: "deepseek-flash" });
    const frames: Uint8Array[] = [...codec.open()];
    frames.push(...codec.encode(chunk({ role: "assistant" })));
    frames.push(...codec.encode(chunk({ content: "你" })));
    frames.push(...codec.encode(chunk({ content: "好" })));
    frames.push(...codec.encode({ ...chunk({}), usage: COMPLETION.usage } as ChatCompletionChunk));
    frames.push(...codec.encode(chunk({}, "stop")));
    frames.push(...codec.close());

    const text = Buffer.concat(frames.map((f) => Buffer.from(f))).toString("utf8");
    // ⚠️ Anthropic 客户端按 event: 字段分派；绝不能出现 chat 的 [DONE]。
    expect(text).not.toContain("[DONE]");
    expect(text).toContain("event: message_start\ndata: ");

    const events = eventsOf(frames);
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const start = JSON.parse(events[0]!.data!) as Record<string, unknown>;
    expect(start).toMatchObject({
      type: "message_start",
      message: { id: "msg_test", type: "message", role: "assistant", model: "deepseek-flash" },
    });
    expect((start["message"] as Record<string, unknown>)["usage"]).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    });

    const deltas = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => JSON.parse(e.data!) as Record<string, unknown>);
    expect(deltas.map((d) => (d["delta"] as Record<string, unknown>)["text"]).join("")).toBe("你好");
    // 同一块的增量共享同一个 index
    expect(new Set(deltas.map((d) => d["index"])).size).toBe(1);

    const stop = JSON.parse(events[5]!.data!) as Record<string, unknown>;
    expect(stop).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4 },
    });
    expect(JSON.parse(events[6]!.data!)).toEqual({ type: "message_stop" });
  });

  it("思考 + 工具调用：thinking / text / tool_use 三块按需出现，参数走 input_json_delta", () => {
    const codec = createAnthropicSseCodec({ id: "msg_t", model: "m" });
    const frames: Uint8Array[] = [...codec.open()];
    frames.push(...codec.encode(chunk({ reasoning_content: "先想。" })));
    frames.push(...codec.encode(chunk({ content: "答案" })));
    frames.push(
      ...codec.encode(
        chunk({
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "look", arguments: '{"x":1}' } },
          ],
        }),
      ),
    );
    frames.push(...codec.encode(chunk({}, "tool_calls")));
    frames.push(...codec.close());

    const events = eventsOf(frames);
    const starts = events
      .filter((e) => e.event === "content_block_start")
      .map((e) => JSON.parse(e.data!) as Record<string, unknown>);
    expect(starts.map((s) => (s["content_block"] as Record<string, unknown>)["type"])).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
    expect(starts.map((s) => s["index"])).toEqual([0, 1, 2]);

    const deltas = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => JSON.parse(e.data!) as Record<string, unknown>);
    expect(deltas.map((d) => (d["delta"] as Record<string, unknown>)["type"])).toEqual([
      "thinking_delta",
      "text_delta",
      "input_json_delta",
    ]);
    expect((deltas[2]!["delta"] as Record<string, unknown>)["partial_json"]).toBe('{"x":1}');

    // 每个开的块都有对应的 content_block_stop（数量 = 块数）
    expect(events.filter((e) => e.event === "content_block_stop")).toHaveLength(3);
    const messageDelta = events.find((e) => e.event === "message_delta");
    expect(JSON.parse(messageDelta!.data!)).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  it("空流：仍然给出完整的 message_start / message_delta / message_stop", () => {
    const codec = createAnthropicSseCodec({ id: "msg_empty", model: "m" });
    const events = eventsOf([...codec.open(), ...codec.close()]);
    expect(events.map((e) => e.event)).toEqual(["message_start", "message_delta", "message_stop"]);
    expect(JSON.parse(events[1]!.data!)).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });
});
