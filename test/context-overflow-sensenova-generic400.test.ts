/**
 * 泛化 400 的「超窗」误判回归（2026-11-28 sensenova/deepseek-flash）。
 *
 * 生产故障：sensenova 对 strict-schema 的参数/字段错误回 400
 * `{"error":{"message":"inference request is invalid",
 *   "type":"invalid_request_error","code":"InvalidParameter"}}`。
 * 请求本身 338K tokens，而该模型真实窗口 1,048,576（实测 1.02M 仍 200），
 * 旧兜底判据只看「bad_request + 绝对长度 ≥128K」，于是 338K 被扣上
 * 「请求超出模型上下文窗口，请 /compact」的帽子 —— 方向完全错。
 *
 * 现在的口径：窗口已知时按**占比**判（≥90% 才算超窗），绝对长度兜底只用于
 * 拿不到窗口声明的场合。
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  effectiveWindowTokens,
  isContextOverflow,
  resetObservedCeilings,
  resetPromptScales,
} from "../src/gateway-upstream-context.js";

/** 2026-11-28 生产实测原文（sensenova/deepseek-flash）。 */
const SEN_INVALID_PARAM =
  '请求错误 — 上游:{"error":{"message":"inference request is invalid","type":"invalid_request_error","code":"InvalidParameter"}}';

/** 该模型的真实窗口（库里 max_input_tokens=1048576，实测吻合）。 */
const SEN_WINDOW = 1_048_576;

describe("isContextOverflow: 大窗口模型的泛化 400 不再误判超窗", () => {
  beforeEach(() => {
    resetObservedCeilings();
    resetPromptScales();
  });

  it("338K / 1M 窗口的参数错误 → 不是超窗（这正是生产事故）", () => {
    expect(isContextOverflow(SEN_INVALID_PARAM, "bad_request", 338_086, SEN_WINDOW)).toBe(false);
  });

  it("同样文案 + 真的越过窗口 → 仍是超窗", () => {
    expect(isContextOverflow(SEN_INVALID_PARAM, "bad_request", 1_080_000, SEN_WINDOW)).toBe(true);
  });

  it("贴着窗口 95% → 超窗（留 chat template 余量后仍判真）", () => {
    expect(isContextOverflow(SEN_INVALID_PARAM, "bad_request", 1_000_000, SEN_WINDOW)).toBe(true);
  });

  it("拿不到窗口 → 退回绝对长度兜底（旧口径不变）", () => {
    expect(isContextOverflow(SEN_INVALID_PARAM, "bad_request", 338_086)).toBe(true);
    expect(isContextOverflow(SEN_INVALID_PARAM, "bad_request", 1_000)).toBe(false);
  });

  it("明确 context 文案优先于占比判据", () => {
    expect(isContextOverflow("maximum context length exceeded", "bad_request", 1_000, SEN_WINDOW)).toBe(
      true,
    );
  });

  it("effectiveWindowTokens 用声明值 1M（没实测压低时）", () => {
    expect(effectiveWindowTokens(SEN_WINDOW, "sensenova/deepseek-flash")).toBe(SEN_WINDOW);
  });
});