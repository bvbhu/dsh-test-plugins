/**
 * 子代理会话模型切换的单测。
 *
 * 场景:`sessionController.selectModel()` 会对 `origin==='subagent'` 的会话
 * 抛 `session "..." is owned by subagent routing`;root `ctx.agents.get()` 又
 * 拿不到注册在 child scope 的子 Agent。我们的 host 中转改为从 host SessionStore
 * (`ctx.get('sessions')`)拿 child Session,直接 `append('model/selection', ...)`
 * —— 这正是 `AgentModel.select()` 的底层实现,且 core/session 的 append 无
 * subagent 守卫。
 *
 * 锁住三件事:
 *   1) 优先走 agent/created 缓存的 child Session(origin==='subagent' 的 child
 *      Session 在 root sessions store 查不到),再回退 sessions.get();
 *      写 'model/selection',不调 sessionController.selectModel(),不依赖 agents.get();
 *   2) 保留可用性校验(provider/model 不在目录里要抛错,且**不**写选择);
 *   3) 保留默认保存(agentDefaultModel.saveSelection),失败不影响主流程。
 */

import { describe, expect, it, vi } from "vitest";
import type { Context } from "../src/context-types.js";
import { subagentModelDepsOf } from "../src/subagent-model-api.js";

function ctxWith(services: Record<string, unknown>): Context {
  const logger = { warn: vi.fn() };
  const ctx = {
    logger,
    get(name: string) {
      return services[name];
    },
  } as unknown as Context;
  return ctx;
}

/** 带 Cordis `ctx.on` 的假 ctx,可模拟 agent/created / agent/disposed 事件。 */
function ctxWithEvents(services: Record<string, unknown>) {
  const logger = { warn: vi.fn() };
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const ctx = {
    logger,
    get(name: string) {
      return services[name];
    },
    on(name: string, listener: (payload: unknown) => void) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => undefined;
    },
  } as unknown as Context;
  return {
    ctx,
    emit(name: string, payload: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },
  };
}

function liveSession(over: { append?: ReturnType<typeof vi.fn>; header?: Record<string, unknown> } = {}) {
  return {
    header: over.header,
    append: over.append ?? vi.fn(),
  };
}

function llm(over: Partial<{
  listProviders: () => readonly { id: string }[];
  listModels: (p: string) => Promise<readonly { id: string }[]>;
  resolveCallConfig: (c: unknown) => Promise<unknown>;
}> = {}) {
  return {
    listProviders: over.listProviders ?? (() => [{ id: "deepseek-account" }]),
    listModels: over.listModels ?? (async () => [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }]),
    resolveCallConfig: over.resolveCallConfig ?? (async () => ({})),
  };
}

describe("subagentModelDepsOf.selectModel(绕过 subagent 守卫)", () => {
  it("用 sessions.get().append('model/selection') 写选择,不碰 selectModel()/agents.get()", async () => {
    const session = liveSession();
    const selectModel = vi.fn();
    const agentsGet = vi.fn();
    const defaults = { saveSelection: vi.fn().mockResolvedValue(undefined) };
    const ctx = ctxWith({
      sessions: { get: (id: string) => (id === "child-1" ? session : undefined), flush: async () => true },
      agents: { get: agentsGet },
      llm: llm(),
      agentDefaultModel: defaults,
      sessionController: { modelCatalog: vi.fn(), selectModel },
    });

    const deps = subagentModelDepsOf(ctx);
    const value = await deps.selectModel({
      sessionId: "child-1",
      provider: "deepseek-account",
      model: "deepseek-flash",
      reasoningEffort: "high",
    });

    expect(session.append).toHaveBeenCalledTimes(1);
    expect(session.append).toHaveBeenCalledWith("model/selection", {
      provider: "deepseek-account",
      model: "deepseek-flash",
      reasoningEffort: "high",
    });
    expect(selectModel).not.toHaveBeenCalled();
    expect(agentsGet).not.toHaveBeenCalled();
    expect(defaults.saveSelection).toHaveBeenCalledWith({
      provider: "deepseek-account",
      model: "deepseek-flash",
      reasoningEffort: "high",
    });
    expect(value.selected.provider).toBe("deepseek-account");
  });

  it("child Session 只能在 agent/created 缓存里拿到 → 从缓存写,不查 root sessions", async () => {
    const session = liveSession();
    const sessionsGet = vi.fn(() => undefined); // root store 查不到 child
    const harness = ctxWithEvents({
      sessions: { get: sessionsGet, flush: async () => true },
      llm: llm(),
    });
    const deps = subagentModelDepsOf(harness.ctx);
    // 模拟子代理 publication:root sessions store 里没有,只有事件带上 child.session。
    harness.emit("agent/created", {
      agent: { id: "child-2", session: { ...session, id: "child-2" } },
    });

    await deps.selectModel({ sessionId: "child-2", provider: "deepseek-account", model: "deepseek-flash" });

    expect(session.append).toHaveBeenCalledWith("model/selection", {
      provider: "deepseek-account",
      model: "deepseek-flash",
    });
    expect(sessionsGet).not.toHaveBeenCalled(); // 缓存命中,完全不查 root store
  });

  it("agent/disposed 后缓存失效 → 抛错", async () => {
    const session = liveSession();
    const harness = ctxWithEvents({ sessions: { get: () => undefined }, llm: llm() });
    const deps = subagentModelDepsOf(harness.ctx);
    harness.emit("agent/created", { agent: { id: "gone", session: { ...session, id: "gone" } } });
    harness.emit("agent/disposed", { agent: { id: "gone" } });

    await expect(
      deps.selectModel({ sessionId: "gone", provider: "deepseek-account", model: "deepseek-flash" }),
    ).rejects.toThrow(/没有 live Session/);
  });

  it("provider 不在目录 → 抛错且不写选择", async () => {
    const session = liveSession();
    const ctx = ctxWith({
      sessions: { get: () => session },
      llm: llm({ listProviders: () => [{ id: "as-one" }] }),
    });
    const deps = subagentModelDepsOf(ctx);

    await expect(
      deps.selectModel({ sessionId: "child-1", provider: "deepseek-account", model: "deepseek-flash" }),
    ).rejects.toThrow(/provider=deepseek-account 不可用/);
    expect(session.append).not.toHaveBeenCalled();
  });

  it("model 不在目录 → 抛错且不写选择", async () => {
    const session = liveSession();
    const ctx = ctxWith({
      sessions: { get: () => session },
      llm: llm({ listModels: async () => [{ id: "other" }] }),
    });
    const deps = subagentModelDepsOf(ctx);

    await expect(
      deps.selectModel({ sessionId: "child-1", provider: "deepseek-account", model: "deepseek-flash" }),
    ).rejects.toThrow(/model=deepseek-flash 不可用/);
    expect(session.append).not.toHaveBeenCalled();
  });

  it("没有 live Session → 抛错", async () => {
    const ctx = ctxWith({ sessions: { get: () => undefined }, llm: llm() });
    const deps = subagentModelDepsOf(ctx);
    await expect(
      deps.selectModel({ sessionId: "cold", provider: "p", model: "m" }),
    ).rejects.toThrow(/没有 live Session/);
  });

  it("默认保存失败只 warn,不影响切换结果", async () => {
    const session = liveSession();
    const warn = vi.fn();
    const ctx = {
      logger: { warn },
      get(name: string) {
        if (name === "sessions") return { get: () => session };
        if (name === "llm") return llm();
        if (name === "agentDefaultModel") return { saveSelection: () => Promise.reject(new Error("disk full")) };
        return undefined;
      },
    } as unknown as Context;
    const deps = subagentModelDepsOf(ctx);

    const value = await deps.selectModel({ sessionId: "child-1", provider: "deepseek-account", model: "deepseek-flash" });
    expect(value.selected.model).toBe("deepseek-flash");
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith("[as-one] save default model failed:", expect.any(Error));
  });
});
