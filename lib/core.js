import {
  setupAsOne
} from "./chunk-4Z6VTPLS.js";
import "./chunk-7NII7QAL.js";
import "./chunk-KJWR6LSK.js";

// src/core-row.ts
import { homedir } from "node:os";
import { join } from "node:path";

// src/warmup-gate.ts
function createWarmupGate(opts) {
  const logger = opts.logger ?? console;
  const retryAfterMs = opts.retryAfterMs ?? 6e4;
  const now = opts.now ?? Date.now;
  let current = null;
  let stableResult = null;
  let lastRunAt = null;
  const start = (reason) => {
    const t0 = now();
    lastRunAt = t0;
    let resolveSettled;
    const settledPromise = new Promise((resolve) => {
      resolveSettled = resolve;
    });
    const run = {
      outcomePromise: Promise.resolve({ ok: true, timedOut: false, elapsedMs: 0, error: null, reason }),
      settledPromise,
      settled: false,
      latest: null
    };
    let timer = null;
    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    let refreshPromise;
    try {
      refreshPromise = Promise.resolve(opts.refresh());
    } catch (err) {
      refreshPromise = Promise.reject(err);
    }
    const finalize = (outcome) => {
      run.latest = outcome;
      if (!run.settled) {
        run.settled = true;
        stableResult = outcome;
        resolveSettled();
        clearTimer();
      }
    };
    const finished = refreshPromise.then(
      () => {
        const outcome = {
          ok: true,
          timedOut: false,
          elapsedMs: Math.max(0, now() - t0),
          error: null,
          reason
        };
        logger.info?.(
          `[as-one] 额度预热完成（${Math.round(outcome.elapsedMs)}ms，原因 ${reason}），due-first 到期排序已就绪`
        );
        finalize(outcome);
        return outcome;
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn?.(
          `[as-one] 额度预热失败（${Math.max(0, Math.round(now() - t0))}ms），放行请求但到期排序不可用：${message}`
        );
        const outcome = {
          ok: false,
          timedOut: false,
          elapsedMs: Math.max(0, now() - t0),
          error: message,
          reason
        };
        finalize(outcome);
        return outcome;
      }
    );
    if (opts.timeoutMs !== void 0) {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
        timer.unref?.();
      });
      run.outcomePromise = Promise.race([
        finished,
        timeout.then(() => {
          const message = `超时 ${opts.timeoutMs}ms（刷新仍在后台进行；已挡住本轮请求，等待刷新完成后重试）`;
          logger.warn?.(`[as-one] ${message}；due-first 到期排序不可用，本轮不放行`);
          const timedOut = {
            ok: false,
            timedOut: true,
            elapsedMs: Math.max(0, now() - t0),
            error: message,
            reason
          };
          if (run.latest === null) run.latest = timedOut;
          return timedOut;
        })
      ]);
    } else {
      run.outcomePromise = finished;
    }
    return run;
  };
  return {
    async wait() {
      if (current === null) current = start("startup");
      const active = current;
      const outcome = await active.outcomePromise;
      await active.settledPromise;
      const finalOutcome = active.latest ?? outcome;
      if (finalOutcome.timedOut) {
        throw new Error(finalOutcome.error ?? "额度预热超时，刷新未完成，拒绝按旧快照调度");
      }
      if (!opts.needsRefresh?.()) return finalOutcome;
      const t = now();
      if (lastRunAt !== null && t - lastRunAt < retryAfterMs) {
        return { ok: false, timedOut: false, elapsedMs: 0, error: null, reason: "throttled" };
      }
      current = start("stale");
      const next = current;
      const nextOutcome = await next.outcomePromise;
      await next.settledPromise;
      return next.latest ?? nextOutcome;
    },
    settled() {
      return current !== null && current.settled;
    },
    outcome() {
      if (current !== null && current.settled) return current.latest;
      return stableResult;
    }
  };
}

// src/quota-freshness.ts
function evaluateQuotaFreshness(input) {
  let total = 0;
  let withExpiry = 0;
  let newestAtMs = null;
  let newestIsError = false;
  let newestErrorAtMs = null;
  for (const snap of input.snapshots) {
    if (!snap || typeof snap !== "object") continue;
    total += 1;
    const exp = snap.expires_at;
    if (typeof exp === "number" && exp > 0) withExpiry += 1;
    const at = snap.fetched_at;
    if (typeof at === "number" && at > 0) {
      if (newestAtMs === null || at > newestAtMs) {
        newestAtMs = at;
        newestIsError = typeof snap.error === "string" && snap.error !== "";
        newestErrorAtMs = at;
      }
    }
  }
  if (total === 0) {
    return { fresh: false, reason: "没有任何额度快照（进程刚启动 / 从未刷新）", withExpiry, total, newestAtMs };
  }
  if (withExpiry === 0) {
    return {
      fresh: false,
      reason: "没有任何带到期时间的快照，due-first 的排序键为空",
      withExpiry,
      total,
      newestAtMs
    };
  }
  if (newestAtMs === null) {
    return { fresh: false, reason: "快照缺少 fetched_at，无法判断新鲜度", withExpiry, total, newestAtMs };
  }
  const age = input.now - newestAtMs;
  if (age > input.maxAgeMs) {
    const hours = (age / 36e5).toFixed(1);
    return {
      fresh: false,
      reason: `快照已过期（最新一条 ${hours} 小时前，上限 ${(input.maxAgeMs / 36e5).toFixed(1)} 小时）`,
      withExpiry,
      total,
      newestAtMs
    };
  }
  if (newestIsError && newestErrorAtMs !== null) {
    return {
      fresh: false,
      reason: "最新一次刷新全部失败（快照是 error 态），没有可用到期数据",
      withExpiry,
      total,
      newestAtMs
    };
  }
  return { fresh: true, reason: "", withExpiry, total, newestAtMs };
}

// src/core-row.ts
var name = "@bvbhu/as-one/core";
var inject = [];
function resolveDirs() {
  const dataDir = join(homedir(), ".as-one");
  return { dataDir, dbPath: join(dataDir, "as-one.db"), logDir: join(dataDir, "logs") };
}
function createQuotaWarmup(runtime, ctx) {
  let panel = null;
  const refresh = async () => {
    if (panel === null) {
      const { createPanelHost } = await import("./panel-host-KZFTDXI5.js");
      panel = createPanelHost(runtime, {}).panel;
    }
    const fn = panel?.syncAllQuota;
    if (typeof fn !== "function") return;
    let incomplete = null;
    try {
      const res = await fn.call(panel, true);
      if (res !== null && res !== void 0 && res.ok === false) {
        incomplete = res.message ?? `额度刷新不完整(${res.written ?? 0}/${res.probed ?? 0} 个账号读到)`;
      }
    } catch (err) {
      incomplete = err instanceof Error ? err.message : String(err);
    } finally {
      try {
        runtime.scheduler.invalidate();
      } catch (err) {
        ctx.logger?.warn?.("[as-one] 预热后调度器缓存失效失败", err);
      }
    }
    if (incomplete !== null) throw new Error(incomplete);
  };
  const needsRefresh = () => {
    try {
      const table = runtime.repo.quotas() ?? {};
      const snapshots = Object.values(table);
      const hours = Number(runtime.getSetting("external_refresh.interval_hours") ?? "5");
      const maxAgeHours = Number.isFinite(hours) && hours > 0 ? hours : 5;
      const verdict = evaluateQuotaFreshness({
        snapshots,
        now: Date.now(),
        maxAgeMs: maxAgeHours * 36e5
      });
      if (!verdict.fresh) {
        ctx.logger?.info?.(`[as-one] 额度快照无效（${verdict.reason}）→ 调度前先刷新`);
      }
      return !verdict.fresh;
    } catch (err) {
      ctx.logger?.warn?.("[as-one] 额度新鲜度判定失败，本轮不刷新", err);
      return false;
    }
  };
  return createWarmupGate({
    refresh,
    needsRefresh,
    logger: ctx.logger
  });
}
function apply(ctx) {
  ctx.effect(
    async () => {
      const { dataDir, dbPath, logDir } = resolveDirs();
      let runtime;
      try {
        runtime = await setupAsOne({ dataDir, dbPath, logDir });
      } catch (err) {
        ctx.logger?.warn?.("[as-one] setup failed, core service unavailable:", err);
        return () => {
        };
      }
      const warmup = createQuotaWarmup(runtime, ctx);
      runtime.attachQuotaGate(warmup);
      const subagentSessions = /* @__PURE__ */ new Set();
      const sessionEvents = ctx;
      const childSessionIdOf = (agent) => agent?.id ?? agent?.session?.id;
      const offCreated = sessionEvents.on("agent/created", ({ agent }) => {
        const id = childSessionIdOf(agent);
        if (id !== void 0 && agent?.session?.header?.origin === "subagent") subagentSessions.add(id);
      });
      const offDisposed = sessionEvents.on("agent/disposed", ({ agent }) => {
        const id = childSessionIdOf(agent);
        if (id !== void 0) subagentSessions.delete(id);
      });
      ctx.provide("asOneCore", { runtime, subagentSessions, warmup });
      ctx.logger?.info?.("[as-one] core service ready (runtime + warmup + subagent registry)");
      return () => {
        offCreated();
        offDisposed();
        runtime.dispose();
      };
    },
    "@bvbhu/as-one/core: runtime + warmup + subagent session registry"
  );
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=core.js.map
