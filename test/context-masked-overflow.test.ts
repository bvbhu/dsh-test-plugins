/**
 * 「上游把装不下说成模型调用失败」的识别与文案（2026-11-26 tokenrhythm/egg-alpha-003）。
 *
 * 生产故障：上游的 prompt 窗口 ≈ 357K tokens，越线后它**不回**
 * `context_length_exceeded`，而是回 400
 * 「模型 egg-alpha-003 调用失败，请提供 traceId 联系管理员核查」。
 *
 * 后果有两条：
 * ① 用户被那句话送去联系厂商，而真相是「你这请求太长，/compact 一下」；
 * ② 网关把它当成**上游故障**（`NON_OVERFLOW_PATTERNS` 里点名否决），于是
 *    既不学上限、也不说真话，还给端点记一次失败+冷却 —— 端点其实没做错任何事。
 *
 * 现在的口径：**话术像 + 请求确实贴着窗口**才算伪装超限；小请求上的同款
 * 文案仍然是上游故障（该换档，不该让用户去 /compact）。
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  describeMaskedOverflow,
  effectiveWindowTokens,
  estimateRequestTokens,
  estimateToolsTokens,
  isContextOverflow,
  isMaskedOverflow,
  mentionsMaskedOverflow,
  noteContextOverflow,
  notePromptUsage,
  promptScale,
  resetObservedCeilings,
  resetPromptScales,
} from "../src/gateway-upstream-context.js";

const MASKED_ERR = "请求错误:模型 egg-alpha-003 调用失败，请提供 traceId 联系管理员核查";
const BILI_PREFLIGHT =
  '{"error":{"type":"server_error","code":"preflight_compress_failed","message":"the summarization call was rejected by the upstream (HTTP 403): 模型 egg-alpha-004 调用失败","retryable":false}}';

/** 2026-11-26 实测出的 egg-alpha-003 窗口（库里已改成 360,000）。 */
const WINDOW = 360_000;

describe("isMaskedOverflow: 伪装成调用失败的超限", () => {
  it("话术像 + 请求贴着窗口 → 是超限", () => {
    expect(isMaskedOverflow(MASKED_ERR, "bad_request", 355_000, WINDOW)).toBe(true);
    expect(isMaskedOverflow(MASKED_ERR, "invalid_request", 355_000, WINDOW)).toBe(true);
  });

  it("话术像 + 请求远在窗口内 → 不是超限（那是上游故障，该换档）", () => {
    expect(isMaskedOverflow(MASKED_ERR, "bad_request", 284_474, WINDOW)).toBe(false);
    expect(isMaskedOverflow(MASKED_ERR, "bad_request", 30_000, WINDOW)).toBe(false);
  });

  it("窗口未知 → 不判（保守按上游故障处理）", () => {
    expect(isMaskedOverflow(MASKED_ERR, "bad_request", 355_000, null)).toBe(false);
    expect(isMaskedOverflow(MASKED_ERR, "bad_request", 355_000, undefined)).toBe(false);
    expect(isMaskedOverflow(MASKED_ERR, "bad_request", 355_000, 0)).toBe(false);
  });

  it("不是 400 → 不判", () => {
    expect(isMaskedOverflow(MASKED_ERR, "upstream", 355_000, WINDOW)).toBe(false);
    expect(isMaskedOverflow(MASKED_ERR, "rate_limit", 355_000, WINDOW)).toBe(false);
  });

  it("话术不像 → 不判", () => {
    expect(isMaskedOverflow("context window exceeded", "bad_request", 355_000, WINDOW)).toBe(false);
    expect(isMaskedOverflow(BILI_PREFLIGHT, "upstream", 355_000, WINDOW)).toBe(false);
  });

  it("mentionsMaskedOverflow 只认那套话术", () => {
    expect(mentionsMaskedOverflow(MASKED_ERR)).toBe(true);
    expect(mentionsMaskedOverflow("上游: MODEL_CALL_FAILED trace_123")).toBe(true);
    expect(mentionsMaskedOverflow("maximum context length exceeded")).toBe(false);
  });
});

describe("isContextOverflow: 伪装超限优先于「明确否决」", () => {
  it("窗口已知 + 贴着窗口 → 判成超窗（不再被否决表吞掉）", () => {
    expect(isContextOverflow(MASKED_ERR, "bad_request", 355_000, WINDOW)).toBe(true);
  });

  it("窗口未知 → 维持原口径：不是超窗（上游故障）", () => {
    expect(isContextOverflow(MASKED_ERR, "bad_request", 355_000)).toBe(false);
  });

  it("窗口已知但请求远在窗口内 → 维持原口径：不是超窗", () => {
    expect(isContextOverflow(MASKED_ERR, "bad_request", 284_474, WINDOW)).toBe(false);
  });
});

describe("describeMaskedOverflow: 诚实文案", () => {
  it("说清是请求太大、给出估算与窗口、点明措辞误导、给出下一步", () => {
    const text = describeMaskedOverflow(355_000, WINDOW);
    expect(text).toContain("355000");
    expect(text).toContain("360000");
    expect(text).toContain("/compact");
    expect(text).toContain("误导");
  });

  it("窗口未知时也不编造数字", () => {
    const text = describeMaskedOverflow(355_000, null);
    expect(text).toContain("窗口未知");
    expect(text).not.toContain("360000");
  });
});

describe("工具定义也要算进 prompt token", () => {
  it("estimateToolsTokens 量工具定义数组", () => {
    const tools = [{ type: "function", function: { name: "a", description: "x".repeat(5000) } }];
    expect(estimateToolsTokens(tools)).toBeGreaterThan(1000);
    expect(estimateToolsTokens([])).toBe(0);
    expect(estimateToolsTokens(undefined)).toBe(0);
  });

  it("estimateRequestTokens = messages + 工具定义", () => {
    const messages = [{ role: "user" as const, content: "你好，世界" }];
    const tools = [{ type: "function", function: { name: "a", description: "x".repeat(5000) } }];
    expect(estimateRequestTokens(messages, tools)).toBe(
      estimateRequestTokens(messages, undefined) + estimateToolsTokens(tools),
    );
  });
});

describe("按上游 usage 校准估算比例", () => {
  beforeEach(() => {
    resetPromptScales();
    resetObservedCeilings();
  });

  it("没校准过时比例是 1", () => {
    expect(promptScale("ep-1")).toBe(1);
  });

  it("上游报的比估的多 → 比例被记住（宁可高估）", () => {
    notePromptUsage("ep-1", 100_000, 109_000);
    expect(promptScale("ep-1")).toBeCloseTo(1.09, 5);
  });

  it("取见过的最大值，不被后来的小比例拉低", () => {
    notePromptUsage("ep-1", 100_000, 109_000);
    notePromptUsage("ep-1", 100_000, 95_000);
    expect(promptScale("ep-1")).toBeCloseTo(1.09, 5);
  });

  it("离谱样本被夹在 [0.5, 4]", () => {
    notePromptUsage("ep-2", 1_000, 100_000);
    expect(promptScale("ep-2")).toBe(4);
    notePromptUsage("ep-3", 1_000, 1);
    expect(promptScale("ep-3")).toBe(0.5);
  });
});

describe("effectiveWindowTokens: 声明值与实测值取小", () => {
  beforeEach(() => {
    resetObservedCeilings();
    resetPromptScales();
  });

  it("只有声明值时用它", () => {
    expect(effectiveWindowTokens(360_000)).toBe(360_000);
  });

  it("声明 1M 而实测 25 万 → 信实测", () => {
    noteContextOverflow("ep-1", 260_000);
    expect(effectiveWindowTokens(1_000_000, "ep-1")).toBe(247_000);
  });

  it("两者都没有 → null（不知道窗口就别瞎猜）", () => {
    expect(effectiveWindowTokens(null)).toBeNull();
    expect(effectiveWindowTokens(0)).toBeNull();
  });
});
