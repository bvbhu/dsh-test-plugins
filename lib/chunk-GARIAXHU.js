// src/components/capacity.ts
function keyOf(provider, model) {
  const p = provider && provider !== "" ? provider : "*";
  const m = model && model !== "" ? model : "*";
  return `${p}/${m}`;
}
function modelKeyOfEndpoint(endpointId) {
  const base = endpointId.split("@")[0] ?? endpointId;
  return base.includes("/") ? base : `*/${base}`;
}
var CapacityView = class {
  constructor(ledger) {
    this.ledger = ledger;
  }
  ledger;
  pending = /* @__PURE__ */ new Map();
  /** 当前占用（含 pending）。`provider` 为 `*` 时跨 provider 按模型名聚合。
   *  `excludeSessionId` 非空时排除该会话在 ledger 里的租约（用于「主会话不计入」）。 */
  usage(provider, model, excludeSessionId) {
    return this.usageWith(provider, model, excludeSessionId);
  }
  usageWith(provider, model, excludeSessionId) {
    const key = keyOf(provider, model);
    let count = this.pending.get(key) ?? 0;
    for (const lease of this.ledger.detail()) {
      if (excludeSessionId && String(lease.sessionId ?? "") === excludeSessionId) continue;
      const leaseKey = modelKeyOfEndpoint(String(lease.endpointId ?? ""));
      if (this.matches(key, leaseKey)) count += 1;
    }
    return count;
  }
  /** `provider/model` 查询键是否命中某条租约的模型键。 */
  matches(queryKey, leaseKey) {
    if (queryKey === leaseKey) return true;
    const [qp, qm] = queryKey.split("/");
    const [lp, lm] = leaseKey.split("/");
    if (qp === "*" && qm === lm) return true;
    if (qm === "*" && qp === lp) return true;
    return false;
  }
  /** 只数 ledger 里的真实在途（不含 pending），给面板/诊断用。 */
  inFlight(provider, model) {
    const key = keyOf(provider, model);
    let count = 0;
    for (const lease of this.ledger.detail()) {
      const leaseKey = modelKeyOfEndpoint(String(lease.endpointId ?? ""));
      if (leaseKey === key) count += 1;
    }
    return count;
  }
  /** 预占一个名额（批准 subagent 但还没落账时调用）。 */
  reserve(provider, model) {
    const key = keyOf(provider, model);
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
  }
  /** 释放一个预占（请求已落账或被拒时调用）。 */
  unreserve(provider, model) {
    const key = keyOf(provider, model);
    const next = (this.pending.get(key) ?? 0) - 1;
    if (next <= 0) this.pending.delete(key);
    else this.pending.set(key, next);
  }
  /** 当前所有 pending（诊断用）。 */
  pendingSnapshot() {
    return Object.fromEntries([...this.pending.entries()].sort(([a], [b]) => a < b ? -1 : 1));
  }
  /** 清空 pending（插件卸载 / 测试）。 */
  reset() {
    this.pending.clear();
  }
};
function createCapacityView(ledger) {
  return new CapacityView(ledger);
}

// src/components/subagent-limit.ts
import { AsyncLocalStorage } from "node:async_hooks";
var DEFAULT_TOOL_NAMES = ["subagent", "subagent_fork"];
var AbortedError = class extends Error {
  code = "ABORTED";
  constructor(message) {
    super(message);
    this.name = "AbortedError";
  }
};
function modelNameOf(exec) {
  const args = exec?.arguments;
  return args && typeof args.model === "string" && args.model !== "" ? args.model : void 0;
}
function applyDefaultModel(exec, opts) {
  const explicit = modelNameOf(exec);
  if (explicit !== void 0) return null;
  const raw = opts.getSetting?.("subagent.default_model")?.trim() ?? "";
  if (raw === "") return null;
  const ref = raw.includes("/") ? (() => {
    const [provider, ...rest] = raw.split("/");
    const model = rest.join("/");
    return provider && model ? { provider, model } : null;
  })() : opts.resolveLogical?.(raw) ?? null;
  if (ref === null) return null;
  const args = exec.arguments ?? {};
  args.provider = ref.provider;
  args.model = ref.model;
  exec.arguments = args;
  return { provider: ref.provider, model: ref.model, source: "default" };
}
function fallbackModelOf(getSetting) {
  const raw = getSetting?.("subagent.fallback_model")?.trim() ?? "";
  return raw === "" ? void 0 : raw;
}
function resolveModel(exec) {
  const args = exec?.arguments;
  const argProvider = args && typeof args.provider === "string" && args.provider !== "" ? args.provider : void 0;
  const argModel = args && typeof args.model === "string" && args.model !== "" ? args.model : void 0;
  if (argModel !== void 0) {
    return { provider: argProvider, model: argModel, source: "arguments" };
  }
  let selection;
  try {
    selection = exec?.agent?.model?.current?.();
  } catch {
    selection = void 0;
  }
  if (selection !== null && typeof selection === "object" && typeof selection.model === "string" && selection.model !== "") {
    const s = selection;
    const provider = typeof s.provider === "string" && s.provider !== "" ? s.provider : void 0;
    return { provider, model: s.model, source: "agent.model" };
  }
  return { provider: void 0, model: void 0, source: "fallback" };
}
function display(resolved) {
  if (resolved.model === void 0) return "当前模型";
  return resolved.provider !== void 0 ? `${resolved.provider}/${resolved.model}` : resolved.model;
}
function limitError(resolved, used, limit) {
  return new AbortedError(
    `subagent 未创建：模型 ${display(resolved)} 的子代理并发已达上限（${used}/${limit}）。当前可用槽位 0 个。请等待已有子代理结束后重试，或直接在当前会话完成这部分工作。`
  );
}
function applySubagentLimit(ctx, capacity, capOf, routeOptions = {}) {
  const toolNames = new Set(DEFAULT_TOOL_NAMES);
  const startContext = new AsyncLocalStorage();
  const boundByRun = /* @__PURE__ */ new Map();
  const release = (res) => {
    if (res.state === "done") return;
    res.state = "done";
    capacity.unreserve(res.provider, res.model);
  };
  const handler = async (exec, next) => {
    const e = exec;
    if (!e.name || !toolNames.has(e.name)) return next();
    const injected = applyDefaultModel(e, routeOptions);
    const resolved = injected ?? resolveModel(e);
    const limit = capOf(resolved.provider, resolved.model);
    if (limit === null) return next();
    const used = capacity.usage(resolved.provider, resolved.model);
    if (used >= limit) throw limitError(resolved, used, limit);
    const reservation = {
      provider: resolved.provider,
      model: resolved.model,
      state: "open"
    };
    capacity.reserve(resolved.provider, resolved.model);
    let failed = false;
    try {
      return await startContext.run(reservation, next);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (failed && reservation.state === "open") release(reservation);
    }
  };
  const host = ctx;
  host.on("tools/execute", handler);
  host.on("subagent/start", (info) => {
    const res = startContext.getStore();
    if (!res || res.state !== "open") return;
    res.state = "bound";
    const runId = String(info?.runId ?? "");
    if (runId) boundByRun.set(runId, res);
  });
  host.on("subagent/end", (info) => {
    const runId = String(info?.runId ?? "");
    const res = boundByRun.get(runId);
    if (!res) return;
    boundByRun.delete(runId);
    release(res);
  });
  return () => {
    for (const res of boundByRun.values()) release(res);
    boundByRun.clear();
    capacity.reset();
  };
}

export {
  createCapacityView,
  fallbackModelOf,
  applySubagentLimit
};
//# sourceMappingURL=chunk-GARIAXHU.js.map
