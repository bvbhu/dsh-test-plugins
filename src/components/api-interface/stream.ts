/**
 * SSE 写出的公共工具 —— chat 与 message 两个语义共用**同一套流式骨架**。
 *
 * ## 为什么抽这一层
 *
 * 「首块之前失败可以改状态码、首块之后只能让流断掉」这套惰性响应头语义
 * （见 `forwardStream` 的长注释）是**唯一**的流式正确性来源。如果 Messages
 * 自己再写一条循环，就必然要复制客户端断开、usage 收集、失败分类这些细节 ——
 * 两份实现迟早分叉，而分叉的表现是「某一种 API 在断开时泄漏并发槽位」。
 *
 * 所以这里把循环固定成一份，只把**编码差异**交给 {@link SseStreamCodec}：
 *
 * | 语义 | open() | encode(chunk) | close() |
 * | --- | --- | --- | --- |
 * | OpenAI chat | `[]` | `data: {chunk}\\n\\n` | `data: [DONE]\\n\\n` |
 * | Anthropic messages | `message_start` | `content_block_*` 事件帧 | `message_delta` + `message_stop` |
 *
 * @module src/components/api-interface/stream
 */

import type { ServerResponse } from "node:http";

import {
  SSE_RESPONSE_HEADERS,
  ssePackChunk,
  ssePackDone,
} from "@as-one/core/src/gateway/sse.js";
import type {
  ChatCompletionChunk,
  Upstream,
  UpstreamRequest,
} from "@as-one/core/src/gateway/types.js";

/** 流式结局（与 `forwardStream` 注入方回调同口径）。 */
export type StreamOutcome = "ok" | "client_disconnected" | "failed_after_start";

/** 流式结果回调（注入方记账用）。 */
export type OnStreamResult = (
  outcome: StreamOutcome,
  usage: Record<string, unknown> | undefined,
  firstChunkMs: number | undefined,
  totalMs: number,
) => void;

/**
 * 流式编码器：一个请求一个实例（可含内部状态：块索引、usage、stop_reason）。
 *
 * - `open()` 在响应头写出后、首块前调用一次；
 * - `encode()` 每个上游 chunk 调用一次，返回要写出的帧（可空）；
 * - `close()` 只在**正常收尾**调用（客户端断开 / 已开流后失败都不调）。
 */
export interface SseStreamCodec {
  open(): Uint8Array[];
  encode(chunk: ChatCompletionChunk): Uint8Array[];
  close(): Uint8Array[];
}

/**
 * Anthropic 风格的事件帧：`event: <name>\ndata: <json>\n\n`。
 *
 * ⚠️ 与 chat 的 `data: …\n\n` 不同：Anthropic 客户端按 `event:` 字段分派，
 * 缺了它整条流会被当成未知事件。
 */
export function sseEventFrame(event: string, data: unknown): Uint8Array {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, "utf-8");
}

/**
 * 通用流式转发：惰性响应头 + SSE 帧直写 + 断开/失败语义。
 *
 * ⚠️ **已发字节后失败不改状态码**（test_stream_interrupt 的真 bug 教训）：
 * 让流断在那里 —— 这是开流之后唯一诚实的信号。客户端断开（AbortSignal /
 * res close）→ 停止消费上游，记 `ok=false`。
 */
export async function forwardSseStream(
  res: ServerResponse,
  upstream: Upstream,
  req: UpstreamRequest,
  signal: AbortSignal,
  codec: SseStreamCodec,
  onStreamResult?: OnStreamResult,
): Promise<void> {
  const t0 = Date.now();
  let firstChunkMs: number | undefined;
  let usage: Record<string, unknown> | undefined;
  let headSent = false;
  const iterator = upstream.stream(req)[Symbol.asyncIterator]();

  const writeHead = (): void => {
    headSent = true;
    res.writeHead(200, SSE_RESPONSE_HEADERS);
    for (const frame of codec.open()) res.write(frame);
  };

  try {
    // 手动迭代:首块之前抛错时响应头还没发,可以把错误映射成正确的状态码;
    // 首块之后抛错 = 已开流,只能让流断在那里(lazy head)。
    for (;;) {
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
      const chunk = next.value as ChatCompletionChunk;
      if (chunk && typeof chunk === "object" && "usage" in chunk && chunk.usage) {
        usage = chunk.usage as unknown as Record<string, unknown>;
      }
      for (const frame of codec.encode(chunk)) res.write(frame);
    }
    if (!headSent) {
      // 空流:仍以 200 + 收尾帧结束(与「上游没吐块但没报错」一致)
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
      // 已发字节:状态码改不了,让流断在这里(app.py:2073-2093 的语义)。
      onStreamResult?.("failed_after_start", usage, firstChunkMs, Date.now() - t0);
      try {
        res.end();
      } catch {
        // 对端可能已经关了
      }
      return;
    }
    try {
      await iterator.return?.();
    } catch {
      // 上游生成器收尾失败不掩盖原错误
    }
    throw exc; // 未发字节:交给外层统一错误出口(换档/错误映射是注入方的事)
  }
}

/** OpenAI chat 语义的编码器：逐块 `data: {json}\n\n`，收尾 `[DONE]`。 */
export function chatSseCodec(): SseStreamCodec {
  return {
    open: () => [],
    encode: (chunk) => [ssePackChunk(chunk)],
    close: () => [ssePackDone()],
  };
}

/**
 * 流式转发（OpenAI chat 语义）—— 行为与拆分前 `server.ts` 的 `forwardStream`
 * **逐字节一致**：同样的 SSE 帧、同样的惰性响应头、同样的结尾 `[DONE]`。
 *
 * 保留这个具名导出是因为宿主路由（`src/routes.ts`）与既有测试都按它调用；
 * 内部实现已收敛到 {@link forwardSseStream}。
 */
export async function forwardStream(
  res: ServerResponse,
  upstream: Upstream,
  req: Parameters<Upstream["stream"]>[0],
  signal: AbortSignal,
  onStreamResult?: OnStreamResult,
): Promise<void> {
  return forwardSseStream(res, upstream, req, signal, chatSseCodec(), onStreamResult);
}
