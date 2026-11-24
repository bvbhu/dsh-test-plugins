/**
 * 子代理会话模型切换的单测(A 方案)。
 *
 * 场景:`sessionController.selectModel()` 会对 `origin==='subagent'` 的会话
 * 抛 `session "..." is owned by subagent routing`;root `ctx.agents.get()` 又
 * 拿不到注册在 child scope 的子 Agent。我们的 host 中转改为从 host SessionStore
 * (`ctx.get('sessions')`)拿 child Session,直接 `append('model/selection', ...)`
 * —— 这正是 `AgentModel.select()` 的底层实现,且 core/session 的 append 无
 * subagent 守卫。
 *
 * 锁住五件事:
 *   1) 运行时优先走 agent/created 缓存的 child Session(origin==='subagent' 的
 *      child Session 在 root sessions store 查不到),再回退 sessions.get();
 *      写 'model/selection',不调 sessionController.selectModel(),不依赖 agents.get();
 *   2) 保留可用性校验(provider/model 不在目录里要抛错,且**不**写选择、**不**写 pending);
 *   3) 保留默认保存(agentDefaultModel.saveSelection),失败不影响主流程;
 *   4) 休眠子代理走用户定案 A:把目标选择写进 as-one SQLite `subagent_model_pending`
 *      (pendingStore),立即返回 `pending:true`,**不发唤醒消息、不给父会话写结算通知**;
 *      getPendingSelection 能读回它(重启不丢);
 *   5) 子代理下次真实 `agent/created` 时 drain:把 pending 写进它的 Session +
 *      flush + saveSelection,然后删行;不注册 pre-step、不取消请求。
 */

import { describe, expect, it, vi } from "vitest";
import type { Context } from "../src/context-types.js";
import { SubagentSessionNotLiveError, subagentModelDepsOf } from "../src/subagent-model-api.js";

type PendingRow = {
  session_id: string;
  provider: string;
  model: string;
  reasoning_effort: string | null;
  changed_at: number;
};

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

/** 内存版 pending store(行为对齐 database.ts 的 subagentModelPending 组)。 */
function pendingStore(initial: PendingRow[] = []) {
  const rows = new Map<string, PendingRow>(initial.map((row) => [row.session_id, row]));
  return {
    rows,
    get: vi.fn((sessionId: string) => rows.get(sessionId)),
    set: vi.fn((row: PendingRow) => { rows.set(row.session_id, row); }),
    delete: vi.fn((sessionId: string) => { rows.delete(sessionId); }),
  };
}

describe("subagentModelDepsOf.selectModel(绕过 subagent 守卫)", () => {
  it("用 sessions.get().append('model/selection') 写选择,不碰 selectModel()/agents.get()", async () => {
    const session = liveSession();
    const selectModel = vi.fn();
    const agentsGet = vi.fn();
    const defaults = { saveSelection: vi.fn().mockResolvedValue(undefined) };
    const store = pendingStore();
    const ctx = ctxWith({
      sessions: { get: (id: string) => (id === "child-1" ? session : undefined), flush: async () => true },
      agents: { get: agentsGet },
      llm: llm(),
      agentDefaultModel: defaults,
      sessionController: { modelCatalog: vi.fn(), selectModel },
    });

    const deps = subagentModelDepsOf(ctx, store);
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
    const deps = subagentModelDepsOf(harness.ctx, pendingStore());
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

  it("provider 不在目录 → 抛错且不写选择、不写 pending、不唤醒", async () => {
    const session = liveSession();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const store = pendingStore();
    const ctx = ctxWith({
      sessions: { get: () => session },
      llm: llm({ listProviders: () => [{ id: "as-one" }] }),
      subagents: { prompt },
    });
    const deps = subagentModelDepsOf(ctx, store);

    await expect(
      deps.selectModel({ sessionId: "child-1", provider: "deepseek-account", model: "deepseek-flash" }),
    ).rejects.toThrow(/provider=deepseek-account 不可用/);
    expect(session.append).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("model 不在目录 → 抛错且不写选择、不写 pending、不唤醒", async () => {
    const session = liveSession();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const store = pendingStore();
    const ctx = ctxWith({
      sessions: { get: () => session },
      llm: llm({ listModels: async () => [{ id: "other" }] }),
      subagents: { prompt },
    });
    const deps = subagentModelDepsOf(ctx, store);

    await expect(
      deps.selectModel({ sessionId: "child-1", provider: "deepseek-account", model: "deepseek-flash" }),
    ).rejects.toThrow(/model=deepseek-flash 不可用/);
    expect(session.append).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  // 休眠子代理走用户定案 A:不唤醒、不写父会话,只把目标选择写 pending 表。
  it("休眠 → 写 subagent_model_pending 返回 pending:true,绝不调 subagents.prompt", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const store = pendingStore();
    const ctx = ctxWith({
      sessions: { get: () => undefined }, // root store 查不到 child(休眠)
      llm: llm(),
      subagents: { prompt },
    });
    const deps = subagentModelDepsOf(ctx, store);

    const value = await deps.selectModel({
      sessionId: "cold", provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high",
    });

    expect(value).toEqual({
      selected: { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high" },
      pending: true,
    });
    // 不发唤醒消息 —— 这是 A 方案相对 C 方案的核心区别(避免父会话结算通知)。
    expect(prompt).not.toHaveBeenCalled();
    expect(store.set).toHaveBeenCalledTimes(1);
    const row = store.set.mock.calls[0]?.[0] as PendingRow;
    expect(row.session_id).toBe("cold");
    expect(row.provider).toBe("deepseek-account");
    expect(row.model).toBe("deepseek-flash");
    expect(row.reasoning_effort).toBe("high");
    expect(typeof row.changed_at).toBe("number");
  });

  it("休眠默认思考强度 → reasoning_effort 存 null,读回时不带 reasoningEffort", async () => {
    const store = pendingStore();
    const deps = subagentModelDepsOf(ctxWith({ sessions: { get: () => undefined }, llm: llm() }), store);
    await deps.selectModel({ sessionId: "cold", provider: "deepseek-account", model: "deepseek-flash" });
    const row = store.set.mock.calls[0]?.[0] as PendingRow;
    expect(row.reasoning_effort).toBeNull();
    expect(deps.getPendingSelection("cold")).toEqual({
      provider: "deepseek-account", model: "deepseek-flash",
    });
  });

  it("getPendingSelection:休眠期读回目标模型(重启后 store 里的行仍可读)", async () => {
    const seed: PendingRow = {
      session_id: "cold", provider: "deepseek-account", model: "deepseek-v4-pro",
      reasoning_effort: null, changed_at: 1700000000000,
    };
    const store = pendingStore([seed]); // 模拟进程重启后从 SQLite 读回的行
    const deps = subagentModelDepsOf(ctxWith({ sessions: { get: () => undefined }, llm: llm() }), store);
    expect(deps.getPendingSelection("cold")).toEqual({
      provider: "deepseek-account", model: "deepseek-v4-pro",
    });
    expect(deps.getPendingSelection("missing")).toBeNull();
  });

  it("下次真实 agent/created → drain pending 写 model/selection + flush + saveSelection + 删行", async () => {
    const session = liveSession();
    const flush = vi.fn().mockResolvedValue(true);
    const defaults = { saveSelection: vi.fn().mockResolvedValue(undefined) };
    const store = pendingStore([{
      session_id: "cold", provider: "deepseek-account", model: "deepseek-flash",
      reasoning_effort: "high", changed_at: 1700000000000,
    }]);
    const harness = ctxWithEvents({
      sessions: { get: () => undefined, flush },
      llm: llm(),
      agentDefaultModel: defaults,
    });
    const deps = subagentModelDepsOf(harness.ctx, store);

    // 真实唤醒:agent 带 live session,没有 ctx.on(不注册 pre-step)。
    harness.emit("agent/created", { agent: { id: "cold", session } });

    expect(session.append).toHaveBeenCalledWith("model/selection", {
      provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high",
    });
    expect(flush).toHaveBeenCalledWith(session);
    expect(defaults.saveSelection).toHaveBeenCalledWith({
      provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high",
    });
    expect(store.delete).toHaveBeenCalledWith("cold");
    expect(store.rows.has("cold")).toBe(false);
    expect(deps.getPendingSelection("cold")).toBeNull();
  });

  it("agent/created 无 pending 行 → 不写任何选择、不 flush、不删行", async () => {
    const session = liveSession();
    const flush = vi.fn().mockResolvedValue(true);
    const store = pendingStore();
    const harness = ctxWithEvents({ sessions: { get: () => undefined, flush }, llm: llm() });
    subagentModelDepsOf(harness.ctx, store);
    harness.emit("agent/created", { agent: { id: "cold", session } });
    expect(session.append).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("agent/disposed 后缓存失效 → 休眠走 pending 表(仍可切换,不抛)", async () => {
    const session = liveSession();
    const store = pendingStore();
    const harness = ctxWithEvents({ sessions: { get: () => undefined }, llm: llm() });
    const deps = subagentModelDepsOf(harness.ctx, store);
    harness.emit("agent/created", { agent: { id: "gone", session: { ...session, id: "gone" } } });
    harness.emit("agent/disposed", { agent: { id: "gone" } });

    const value = await deps.selectModel({ sessionId: "gone", provider: "deepseek-account", model: "deepseek-flash" });
    expect(value.pending).toBe(true);
    expect(store.set).toHaveBeenCalled();
  });

  // 宿主未提供 pending store ⇒ 连持久化都做不到,只能如实 409(不是笼统 500)。
  it("无 pending store 且休眠 → SubagentSessionNotLiveError(409 可判别)", async () => {
    const ctx = ctxWith({ sessions: { get: () => undefined }, llm: llm() });
    const deps = subagentModelDepsOf(ctx);
    await expect(
      deps.selectModel({ sessionId: "cold", provider: "deepseek-account", model: "deepseek-flash" }),
    ).rejects.toBeInstanceOf(SubagentSessionNotLiveError);
  });

  it("isSessionLive:休眠为 false,agent/created 之后为 true,disposed 之后回到 false", () => {
    const session = liveSession();
    const harness = ctxWithEvents({ sessions: { get: () => undefined }, llm: llm() });
    const deps = subagentModelDepsOf(harness.ctx, pendingStore());

    expect(deps.isSessionLive("child-9")).toBe(false);

    harness.emit("agent/created", { agent: { id: "child-9", session: { ...session, id: "child-9" } } });
    expect(deps.isSessionLive("child-9")).toBe(true);

    harness.emit("agent/disposed", { agent: { id: "child-9" } });
    expect(deps.isSessionLive("child-9")).toBe(false);
  });

  it("isSessionLive:root sessions.get 提供的可写 Session 也算活着", () => {
    const session = liveSession();
    const ctx = ctxWith({ sessions: { get: () => session }, llm: llm() });
    const deps = subagentModelDepsOf(ctx, pendingStore());
    expect(deps.isSessionLive("child-1")).toBe(true);
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
    const deps = subagentModelDepsOf(ctx, pendingStore());

    const value = await deps.selectModel({ sessionId: "child-1", provider: "deepseek-account", model: "deepseek-flash" });
    expect(value.selected.model).toBe("deepseek-flash");
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith("[as-one] save default model failed:", expect.any(Error));
  });
});
