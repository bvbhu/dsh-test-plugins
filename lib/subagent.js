import {
  applySubagentLimit,
  createCapacityView
} from "./chunk-GARIAXHU.js";
import {
  readJsonBody,
  writeJson
} from "./chunk-XYHWMRD4.js";
import "./chunk-7OUDRSRP.js";
import "./chunk-BJ7B4R26.js";

// src/subagent-model-api.ts
function ok(value) {
  return { ok: true, value };
}
function fail(code, message) {
  return { ok: false, error: { code, message } };
}
function argsOf(body) {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") return [];
  const rec = body;
  return Array.isArray(rec.args) ? rec.args : [];
}
var SubagentSessionNotLiveError = class extends Error {
  sessionId;
  constructor(sessionId, reason) {
    super(
      `子代理会话 ${sessionId} 的模型选择无法持久化。` + (reason === void 0 ? "" : `原因:${reason}`)
    );
    this.name = "SubagentSessionNotLiveError";
    this.sessionId = sessionId;
  }
};
var EMPTY_CATALOG = {
  default: { provider: "as-one", model: "" },
  routableProviders: [],
  groups: [],
  failures: []
};
function subagentModelDepsOf(ctx, pendingStore) {
  const host = ctx;
  const logger = ctx.logger;
  const selectChains = /* @__PURE__ */ new Map();
  const serviceOf = (name2) => {
    try {
      return host.get(name2);
    } catch {
      return void 0;
    }
  };
  const controllerOf = () => serviceOf("sessionController");
  const sessionsOf = () => serviceOf("sessions");
  const llmOf = () => serviceOf("llm");
  const defaultsOf = () => serviceOf("agentDefaultModel");
  const storeOf = () => {
    if (pendingStore !== void 0) return pendingStore;
    return serviceOf("asOnePendingStore");
  };
  const events = ctx;
  const sessionCache = /* @__PURE__ */ new Map();
  events.on?.("agent/created", ({ agent }) => {
    const session = agent?.session;
    if (session === void 0) return;
    const id = agent?.id ?? session.id;
    if (id !== void 0) sessionCache.set(id, session);
    if (id === void 0) return;
    const store = storeOf();
    const pending = store?.get(id);
    if (pending === void 0) return;
    const selection = {
      provider: pending.provider,
      model: pending.model,
      ...pending.reasoning_effort === null ? {} : { reasoningEffort: pending.reasoning_effort }
    };
    const appendSelection = session.append;
    appendSelection.call(session, "model/selection", selection);
    const sessionsForFlush = sessionsOf();
    if (typeof sessionsForFlush?.flush === "function") {
      void sessionsForFlush.flush(session).catch((error) => {
        logger?.warn?.("[as-one] flush session after draining pending model switch failed:", error);
      });
    }
    const defaults = defaultsOf();
    if (defaults !== void 0) {
      void defaults.saveSelection(selection).catch((error) => {
        logger?.warn?.("[as-one] save default model after draining pending switch failed:", error);
      });
    }
    try {
      store?.delete(id);
    } catch (error) {
      logger?.warn?.("[as-one] delete drained pending model switch failed:", error);
    }
  });
  events.on?.("agent/disposed", ({ agent }) => {
    const id = agent?.id;
    if (id !== void 0) sessionCache.delete(id);
  });
  return {
    getPendingSelection: (sessionId) => {
      const pending = storeOf()?.get(sessionId);
      if (pending === void 0) return null;
      return {
        provider: pending.provider,
        model: pending.model,
        ...pending.reasoning_effort === null ? {} : { reasoningEffort: pending.reasoning_effort }
      };
    },
    isSessionLive: (sessionId) => {
      if (sessionCache.has(sessionId)) return true;
      const live = sessionsOf()?.get?.(sessionId);
      return typeof live?.append === "function";
    },
    modelCatalog: async () => {
      const controller = controllerOf();
      if (controller === void 0) {
        throw new Error("宿主未提供 sessionController 服务(模型目录不可用)");
      }
      return controller.modelCatalog();
    },
    selectModel: async (request) => {
      const llm = llmOf();
      if (llm === void 0) {
        throw new Error("宿主未提供 llm 服务(模型校验不可用)");
      }
      const previous = selectChains.get(request.sessionId) ?? Promise.resolve();
      const run = previous.then(async () => {
        const selected = {
          provider: request.provider,
          model: request.model,
          ...request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }
        };
        if (!llm.listProviders().some((provider) => provider.id === selected.provider)) {
          throw new Error(`Select an available model before sending a message. (provider=${selected.provider} 不可用)`);
        }
        let models;
        try {
          models = await llm.listModels(selected.provider);
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error));
        }
        if (!models.some((model) => model.id === selected.model)) {
          throw new Error(`Select an available model before sending a message. (model=${selected.model} 不可用)`);
        }
        await llm.resolveCallConfig(selected);
        const sessions = sessionsOf();
        const cached = sessionCache.get(request.sessionId);
        const session = cached ?? sessions?.get?.(request.sessionId);
        if (session !== void 0 && typeof session.append === "function") {
          const liveSession = session;
          const appendSelection = session.append;
          appendSelection.call(liveSession, "model/selection", selected);
          if (typeof sessions?.flush === "function") {
            void sessions.flush(liveSession).catch((error) => {
              logger?.warn?.("[as-one] flush session after model switch failed:", error);
            });
          }
          const defaults = defaultsOf();
          if (defaults !== void 0) {
            void defaults.saveSelection(selected).catch((error) => {
              logger?.warn?.("[as-one] save default model failed:", error);
            });
          }
          try {
            storeOf()?.delete(request.sessionId);
          } catch (error) {
            logger?.warn?.("[as-one] clear stale pending model switch failed:", error);
          }
          return { selected: { ...selected } };
        }
        const store = storeOf();
        if (store === void 0) {
          throw new SubagentSessionNotLiveError(request.sessionId, "宿主未提供 pending store");
        }
        store.set({
          session_id: request.sessionId,
          provider: selected.provider,
          model: selected.model,
          reasoning_effort: selected.reasoningEffort ?? null,
          changed_at: Date.now()
        });
        return { selected: { ...selected }, pending: true };
      });
      selectChains.set(request.sessionId, run.then(() => void 0, () => void 0));
      return run;
    },
    subagentAddress: (sessionId) => {
      const sessions = sessionsOf();
      if (sessions === void 0) return void 0;
      if (typeof sessions.subagentAddress === "function") {
        return sessions.subagentAddress(sessionId);
      }
      try {
        const header = sessions.get?.(sessionId)?.header;
        if (header === void 0 || header.origin !== "subagent") return void 0;
        return {
          mode: "unknown",
          // 宿主 header 只有粗分类,continuable 以 client 投影为准
          parentSessionId: header.parentSession,
          childSessionId: sessionId
        };
      } catch {
        return void 0;
      }
    },
    logger
  };
}
function buildSubagentModelRoutes(deps) {
  const route = (method, handler) => ({
    kind: "exact",
    path: `/as-one/api/${method}`,
    handler: async (req, res) => {
      if ((req.method ?? "GET").toUpperCase() !== "POST") {
        writeJson(res, 405, fail("method_not_allowed", `expected POST, got ${req.method ?? "?"}`));
        return;
      }
      try {
        const body = await readJsonBody(req);
        const value = await handler(argsOf(body));
        writeJson(res, 200, ok(value));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.logger?.warn?.(`[as-one] ${method} failed:`, err);
        if (err instanceof SubagentSessionNotLiveError) {
          writeJson(res, 409, fail("subagent_session_not_live", detail));
          return;
        }
        writeJson(res, 500, fail("internal_error", detail));
      }
    }
  });
  return [
    route("getModelCatalog", async () => {
      try {
        return await deps.modelCatalog();
      } catch (err) {
        deps.logger?.warn?.("[as-one] getModelCatalog failed:", err);
        return { ...EMPTY_CATALOG, failures: [{ id: "catalog", name: "模型目录", message: "暂不可用" }] };
      }
    }),
    route("getSubagentSessionInfo", async (args) => {
      const sessionId = String(args[0] ?? "");
      const address = sessionId ? deps.subagentAddress(sessionId) : void 0;
      const mode = address === void 0 ? null : address.mode === "one-shot" || address.mode === "continuable" ? address.mode : "unknown";
      const info = {
        sessionId,
        isSubagent: address !== void 0,
        mode,
        parentSessionId: address?.parentSessionId ?? null,
        isLive: sessionId ? deps.isSessionLive(sessionId) : false
      };
      return info;
    }),
    route("getPendingSelection", async (args) => {
      const sessionId = String(args[0] ?? "");
      return sessionId ? deps.getPendingSelection(sessionId) : null;
    }),
    route("selectModel", async (args) => {
      const [sessionId, provider, model, reasoningEffort] = args;
      const request = {
        sessionId: String(sessionId ?? ""),
        provider: String(provider ?? ""),
        model: String(model ?? ""),
        ...reasoningEffort === void 0 || reasoningEffort === null ? {} : { reasoningEffort: String(reasoningEffort) }
      };
      if (!request.sessionId || !request.provider || !request.model) {
        throw new Error("selectModel 需要 sessionId / provider / model");
      }
      return deps.selectModel(request);
    })
  ];
}

// src/subagent-row.ts
var name = "@bvbhu/as-one/subagent";
var inject = ["webServer", "asOneCore"];
function apply(ctx) {
  const core = ctx.get("asOneCore");
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, subagent row skipped");
    return;
  }
  const runtime = core.runtime;
  ctx.effect(
    () => {
      const subagentModelRoutes = buildSubagentModelRoutes(
        subagentModelDepsOf(ctx, runtime.db.subagentModelPending)
      );
      const capacity = createCapacityView(runtime.ledger);
      const resolveLogicalModel = (name2) => {
        const slash = name2.indexOf("/");
        if (slash > 0) {
          const provider = name2.slice(0, slash);
          const model = name2.slice(slash + 1);
          return provider !== "" && model !== "" ? { provider, model } : null;
        }
        try {
          const first = runtime.scheduler.chain(name2)[0];
          return first ? { provider: first.endpoint.provider, model: first.endpoint.model } : null;
        } catch {
          return null;
        }
      };
      const disposeSubagentLimit = applySubagentLimit(ctx, capacity, runtime.subagentCapOf, {
        getSetting: runtime.getSetting,
        resolveLogical: resolveLogicalModel
      });
      const disposers = [];
      for (const route of subagentModelRoutes) {
        try {
          disposers.push(ctx.webServer.register(route));
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] register route ${route.path} failed:`, err);
        }
      }
      ctx.logger?.info?.(
        `[as-one] mounted ${subagentModelRoutes.length} subagent-model route(s)`
      );
      return () => {
        disposeSubagentLimit();
        for (const dispose of disposers) dispose();
      };
    },
    "@bvbhu/as-one/subagent: model selector routes + concurrency limit"
  );
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=subagent.js.map
