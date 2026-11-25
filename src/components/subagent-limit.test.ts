/**
 * subagent-limit 单测。
 *
 * 2026-11 用户定案改了语义：「子代理并发限制的设置项整体移除，只按模型的并发
 * 限制限制子代理（逻辑模型的并发取所有成员模型的并发之和）」 —— 所以
 * `capFor` / `readConfig` / `SUBAGENT_LIMIT_DEFAULTS` 都已退役，
 * 容量由 `SubagentCapOf` 回调给出。这里覆盖模型解析与错误构造。
 */
import { describe, it, expect } from "vitest";
import {
  applyDefaultModel,
  fallbackModelOf,
  limitError,
  resolveModel,
} from "./subagent-limit.js";

function execWith(args: unknown, parent?: unknown) {
  return {
    arguments: args,
    agent: parent === undefined ? undefined : { model: { current: () => parent } },
  };
}

describe("resolveModel", () => {
  it("参数 provider/model 优先", () => {
    const r = resolveModel(execWith({ provider: "as-one", model: "glm-flash" }, { provider: "as-one", model: "auto" }));
    expect(r).toMatchObject({ provider: "as-one", model: "glm-flash", source: "arguments" });
  });
  it("无参数时取父会话模型", () => {
    const r = resolveModel(execWith({}, { provider: "as-one", model: "auto" }));
    expect(r).toMatchObject({ provider: "as-one", model: "auto", source: "agent.model" });
  });
  it("只给 model 时 provider 为空", () => {
    const r = resolveModel(execWith({ model: "hy4free" }));
    expect(r).toMatchObject({ provider: undefined, model: "hy4free" });
  });
  it("都没有时兜底", () => {
    const r = resolveModel(execWith({}));
    expect(r.source).toBe("fallback");
  });
  it("current() 抛错不崩", () => {
    const r = resolveModel({
      arguments: {},
      agent: {
        model: {
          current: () => {
            throw new Error("x");
          },
        },
      },
    });
    expect(r.source).toBe("fallback");
  });
});

describe("applyDefaultModel", () => {
  const settings = (table: Record<string, string>) => (key: string) => table[key] ?? null;
  const resolveLogical = (name: string) =>
    name === "deepseek-flash" ? { provider: "trae", model: "deepseek-v4.1-flash" } : null;

  it("调用方显式指定模型时绝不覆盖", () => {
    const exec = execWith({ provider: "as-one", model: "auto" });
    expect(applyDefaultModel(exec, { getSetting: settings({ "subagent.default_model": "deepseek-flash" }), resolveLogical })).toBeNull();
    expect((exec.arguments as { model?: string }).model).toBe("auto");
  });

  it("没有显式模型时注入逻辑模型解析出的真实模型", () => {
    const exec = execWith({});
    const r = applyDefaultModel(exec, { getSetting: settings({ "subagent.default_model": "deepseek-flash" }), resolveLogical });
    expect(r).toEqual({ provider: "trae", model: "deepseek-v4.1-flash", source: "default" });
    expect(exec.arguments).toMatchObject({ provider: "trae", model: "deepseek-v4.1-flash" });
  });

  it("逻辑模型没有成员时保持原样", () => {
    const exec = execWith({});
    expect(applyDefaultModel(exec, { getSetting: settings({ "subagent.default_model": "missing" }), resolveLogical })).toBeNull();
    expect(exec.arguments).toEqual({});
  });

  it("直接写 provider/model 时不再走逻辑解析", () => {
    const exec = execWith({});
    const r = applyDefaultModel(exec, { getSetting: settings({ "subagent.default_model": "opencsg/deepseek-v4.1-flash-1017" }) });
    expect(r).toEqual({ provider: "opencsg", model: "deepseek-v4.1-flash-1017", source: "default" });
  });
});

describe("fallbackModelOf", () => {
  it("读 subagent.fallback_model，空值不兜底", () => {
    expect(fallbackModelOf((k) => (k === "subagent.fallback_model" ? "free" : null))).toBe("free");
    expect(fallbackModelOf((k) => (k === "subagent.fallback_model" ? "  " : null))).toBeUndefined();
    expect(fallbackModelOf(undefined)).toBeUndefined();
  });
});

describe("limitError 不可重试", () => {
  it("code 是 ABORTED，message 含上限信息", () => {
    const err = limitError({ provider: "as-one", model: "auto", source: "arguments" }, 2, 2);
    expect(err.code).toBe("ABORTED");
    expect(err.name).toBe("AbortedError");
    expect(err.message).toContain("as-one/auto");
    expect(err.message).toContain("2/2");
  });
});
