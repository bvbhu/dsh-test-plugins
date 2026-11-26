/**
 * 出站身份文本改写：qoder 与 workbuddy 两个渠道（2026-11-26 用户定案）。
 *
 * 背景：qoder 的 `10605` 与 workbuddy 的 `11128` 都会命中宿主身份句/品牌短语，
 * 且命中后重试无效。处置是**出站前整段重写**（同一张 `HOST_IDENTITY_REWRITES`
 * 表），发出去的报文里不存在宿主身份句；user / tool 原文不动。
 *
 * 这里钉三件事：
 *   1. qoder 的 `bodyForProtocol` 真的改写了 system 与 assistant 文本；
 *   2. user 消息（用户自己的文字）保持原样；
 *   3. workbuddy 路径行为不变。
 */

import { describe, expect, it } from "vitest";
import { rewriteHostIdentityText } from "@as-one/core/src/connectors/workbuddy-gate.js";
import { bodyForProtocol } from "../src/gateway-upstream-body.js";
import type { UpstreamRequest } from "@as-one/core/src/gateway/types.js";

const DSH_SYSTEM = [
  "You are an AI agent powered by DeepSeek Harness.",
  "The runtime context names the DeepSeek Harness implementation checkout.",
  "You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:1.",
  "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.",
].join("\n\n");

function request(model: string): UpstreamRequest {
  return {
    model,
    stream: false,
    messages: [
      { role: "system", content: DSH_SYSTEM },
      { role: "user", content: "把 DeepSeek Harness 的请求日志给我" },
      { role: "assistant", content: "好的，DeepSeek Harness 的日志在 logs/ 下。" },
    ],
  } as unknown as UpstreamRequest;
}

const messagesOf = (body: Record<string, unknown>) =>
  body.messages as Array<{ role: string; content: unknown }>;

describe("qoder 出站改写（2026-11-26）", () => {
  it("system 与 assistant 里的宿主身份句被整段重写，user 原文不动", () => {
    const body = bodyForProtocol("qoder", "qoder", request("dfmodel"), {});
    const messages = messagesOf(body);
    const system = String(messages[0]?.content ?? "");
    const assistant = String(messages[2]?.content ?? "");

    expect(system.toLowerCase()).not.toContain("deepseek harness");
    expect(system).not.toContain("You are an AI agent powered by");
    expect(system.toLowerCase()).not.toContain("tokens prefixed with @ are paths the user explicitly referenced.");
    expect(assistant.toLowerCase()).not.toContain("deepseek harness");
    // 用户自己的文字不动 —— 改写只针对宿主身份文本
    expect(String(messages[1]?.content)).toContain("DeepSeek Harness");
  });

  it("改写幂等：同一段文本重写两次不再变化", () => {
    const once = rewriteHostIdentityText(DSH_SYSTEM);
    expect(rewriteHostIdentityText(once)).toBe(once);
    expect(once.toLowerCase()).not.toContain("deepseek harness");
  });

  it("workbuddy 路径保持原有改写行为", () => {
    const body = bodyForProtocol("workbuddy", "workbuddy", request("hy4flash-free"), {});
    const messages = messagesOf(body);
    const scanned = [String(messages[0]?.content ?? ""), String(messages[2]?.content ?? "")].join("\n");
    expect(scanned.toLowerCase()).not.toContain("deepseek harness");
    expect(scanned.toLowerCase()).not.toContain("you are an ai agent powered by");
    // 用户原文照旧不动（只有 system / assistant 被洗）
    expect(String(messages[1]?.content)).toContain("DeepSeek Harness");
  });

  it("不会产生 the the 病句（DSH 的 runtime context 句）", () => {
    const out = rewriteHostIdentityText(
      "The runtime context names the DeepSeek Harness implementation checkout.",
    );
    expect(out.toLowerCase()).not.toContain("deepseek harness");
    expect(out).not.toContain("the the");
    expect(out).toContain("names the deployment assistant implementation checkout");
  });
});
