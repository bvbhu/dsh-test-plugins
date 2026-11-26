/**
 * `isContextOverflow` 的图片误判回归（2026-11-26）。
 *
 * 生产故障：sensenova 对坏图回 `{"code":"3","message":"invalid image base64
 * content"}`，kind=`bad_request`；请求本身 >128k token，旧逻辑的第二档启发式
 * 把它判成「上下文超窗」→ 不走换档、包装成「请求超出模型上下文窗口」，还被
 * DSH 包成 `MODEL_SWITCH_COMPACTION_FAILED`。
 *
 * 现在：文案明确指向图片/附件格式错误时，永远不算超窗。
 */

import { describe, expect, it } from "vitest";
import { isContextOverflow, mentionsNonOverflowFailure } from "../src/gateway-upstream-context.js";

const SEN_IMG_ERR =
  '请求错误 — 上游:{"error":{"message":"invalid image base64 content","type":"invalid_request_error","code":"3"}}';

describe("isContextOverflow: 图片错误不伪装成超窗", () => {
  it("invalid image base64 content + 55 万 token → 不是超窗", () => {
    expect(isContextOverflow(SEN_IMG_ERR, "bad_request", 550_000)).toBe(false);
  });

  it("image download failed → 不是超窗", () => {
    expect(
      isContextOverflow('{"error":{"message":"image download failed","code":"3"}}', "bad_request", 300_000),
    ).toBe(false);
  });

  it("mentionsNonOverflowFailure 认图片/附件类文案", () => {
    expect(mentionsNonOverflowFailure(SEN_IMG_ERR)).toBe(true);
    expect(mentionsNonOverflowFailure('{"message":"unsupported image format"}')).toBe(true);
    expect(mentionsNonOverflowFailure("maximum context length exceeded")).toBe(false);
  });
});

describe("isContextOverflow: 原有口径不变", () => {
  it("裸 code:3 的大请求仍按超窗处理（sensenova 旧形态）", () => {
    expect(isContextOverflow('请求错误 — 上游:{"code":"3"}', "bad_request", 300_000)).toBe(true);
  });

  it("明确 context 文案优先判定", () => {
    expect(isContextOverflow("maximum context length exceeded", "bad_request", 1_000)).toBe(true);
    expect(isContextOverflow("prompt is too long", "invalid_request", 1_000)).toBe(true);
  });

  it("小请求的 bad_request 不是超窗", () => {
    expect(isContextOverflow('{"code":"3"}', "bad_request", 1_000)).toBe(false);
  });
});
