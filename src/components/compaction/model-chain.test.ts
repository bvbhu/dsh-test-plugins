/**
 * ModelChain 容量解析单测（2026-11 改进：容量真值口）。
 *
 * 盯住 `resolveRouteCapacities` 的三条纪律：
 *   1. 注入的真值优先（窗口报小会多切一刀、报大会在上游吃 400）；
 *   2. 查不到 / 非法值逐字段退回默认（不因一条坏数据打断整批压缩）；
 *   3. 路由键以模型条目自己的 `key` 为准（逻辑模型成员允许自定义键）。
 */

import { describe, expect, it } from "vitest";
import { resolveRouteCapacities } from "./model-chain.js";
import { DEFAULT_CONTEXT_WINDOW } from "./budget.js";
import { DEFAULT_MAX_TOKENS } from "./summarize.js";

const routes = [
  { key: "sensenova/deepseek-v4-flash", provider: "sensenova", model: "deepseek-v4-flash" },
  { provider: "trae", model: "small" },
];

describe("resolveRouteCapacities", () => {
  it("注入的真值按路由逐条生效", () => {
    const capacities = resolveRouteCapacities(routes, (provider, model) => {
      if (provider === "sensenova") return { contextWindow: 1_000_000, maxTokens: 64_000 };
      if (model === "small") return { contextWindow: 32_000, maxTokens: 4_096 };
      return null;
    });

    expect(capacities.get("sensenova/deepseek-v4-flash")).toEqual({
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    // 没有显式 key 的条目按 provider/model 拼键。
    expect(capacities.get("trae/small")).toEqual({ contextWindow: 32_000, maxTokens: 4_096 });
  });

  it("查不到（capacityOf 返回 null 或未注入）退回保守默认", () => {
    const capacities = resolveRouteCapacities(routes, () => null);
    expect(capacities.get("sensenova/deepseek-v4-flash")).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    expect(capacities.get("trae/small")).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });

    const withoutHook = resolveRouteCapacities(routes);
    expect(withoutHook.get("trae/small")).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  });

  it("非法值逐字段回落（0 / 负数 / 小数 / NaN 不用）", () => {
    const capacities = resolveRouteCapacities(routes, () => ({
      contextWindow: 0,
      maxTokens: Number.NaN,
    }));
    expect(capacities.get("trae/small")).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });

    const partial = resolveRouteCapacities(routes, () => ({
      contextWindow: 262_144,
      maxTokens: 0,
    }));
    expect(partial.get("trae/small")).toEqual({
      contextWindow: 262_144,
      maxTokens: DEFAULT_MAX_TOKENS,
    });

    const fractional = resolveRouteCapacities(routes, () => ({
      contextWindow: 1.5,
      maxTokens: -1,
    }));
    expect(fractional.get("trae/small")).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  });
});
