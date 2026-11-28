import {
  AS_ONE_PROVIDER
} from "./chunk-KVYDQHKE.js";
import {
  dayKey
} from "./chunk-KXSRZ5ZM.js";
import "./chunk-7OUDRSRP.js";

// src/usage-external.ts
var GATEWAY_PROVIDER_HISTORY = ["as-one", "one", "nexus", "litenexus"];
function sessionIdOf(value) {
  const v = value;
  const fromHeader = v?.header?.id;
  if (typeof fromHeader === "string" && fromHeader !== "") return fromHeader;
  const direct = v?.id;
  return typeof direct === "string" ? direct : "";
}
var EXTERNAL_PROVIDER_RENAMES = {
  "sensenova-1": "sensenova",
  "sensenova-2": "sensenova",
  "sensenova-3": "sensenova",
  "sensenova-token-plans": "sensenova",
  "sensenova-vision": "sensenova",
  "tokenrhythm-1": "tokenrhythm",
  "tokenrhythm-2": "tokenrhythm",
  minmax: "minimax",
  minimax2: "minimax",
  yn: "hyperai",
  "yn-deepseek": "hyperai",
  "hyperai-deepseek": "hyperai",
  "deepseek-official": "deepseek-account"
};
function isDelegationMarker(provider, model) {
  return provider === "agent" && model === "agent";
}
function renameExternalProvider(raw) {
  const name2 = typeof raw === "string" ? raw.trim() : "";
  if (name2 === "") return "";
  return EXTERNAL_PROVIDER_RENAMES[name2] ?? name2;
}
function routeOf(value) {
  if (!value) return null;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (provider === "" || model === "") return null;
  return { provider, model };
}
function tokensOf(usage) {
  if (!usage) return null;
  const input = num(usage.inputTokens);
  const cached = num(usage.cacheReadTokens);
  const write = num(usage.cacheWriteTokens);
  const output = num(usage.outputTokens);
  const prompt = input + cached + write;
  if (prompt + output <= 0) return null;
  return { prompt, cached, completion: output };
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
var ExternalUsageFold = class {
  /** `turn:step` 去重槽 —— 一次调用可能先来流式 usage、再来最终 message。 */
  seen = /* @__PURE__ */ new Set();
  /** 路由未知时先攒着的调用数(agent-loop 会先 append `step/start` 再 append `request/context`)。 */
  pendingCalls = 0;
  route = null;
  /** 当前已识别的路由(诊断用)。 */
  get currentRoute() {
    return this.route;
  }
  /**
   * 折叠一个事件。返回需要落库的增量(**0~1 条**),由调用方决定写不写。
   *
   * `exclude` 是「这些 provider 不归这里管」的集合(默认含 `as-one`)。
   */
  fold(event, exclude) {
    const type = event?.type ?? "";
    const at = typeof event?.time === "number" && Number.isFinite(event.time) ? event.time : Date.now();
    const day = dayKey(at);
    const data = event?.data ?? {};
    if (type === "request/context") {
      const route = routeOf({ provider: data.provider, model: data.model });
      if (!route) return [];
      this.route = route;
      return this.flushCalls(day, at, exclude);
    }
    if (type === "assistant/message") {
      const route = routeOf(data.message?.source) ?? this.route;
      if (routeOf(data.message?.source)) this.route = routeOf(data.message?.source);
      const tokens = tokensOf(data.usage);
      if (!route || !tokens) return [];
      if (exclude.has(route.provider)) return [];
      if (isDelegationMarker(route.provider, route.model)) return [];
      const key = dedupeKey(data);
      if (key !== null) {
        if (this.seen.has(key)) return [];
        this.seen.add(key);
      }
      return [
        {
          day,
          provider: route.provider,
          model: route.model,
          calls: 0,
          promptTokens: tokens.prompt,
          cachedTokens: tokens.cached,
          completionTokens: tokens.completion,
          at
        }
      ];
    }
    if (type === "step/start" || type === "llm/retry-started") {
      this.pendingCalls += 1;
      return this.flushCalls(day, at, exclude);
    }
    if (type === "turn/end") {
      this.pendingCalls = 0;
      return [];
    }
    if (type === "compaction/summary") {
      const route = routeOf({ provider: data.provider, model: data.model });
      if (!route || exclude.has(route.provider)) return [];
      if (isDelegationMarker(route.provider, route.model)) return [];
      const tokens = tokensOf(data.usage);
      return [
        {
          day,
          provider: route.provider,
          model: route.model,
          // 摘要调用没有 step/start 打开它,这次事件自己就是一次调用。
          calls: 1,
          promptTokens: tokens?.prompt ?? 0,
          cachedTokens: tokens?.cached ?? 0,
          completionTokens: tokens?.completion ?? 0,
          at
        }
      ];
    }
    return [];
  }
  /** 把攒着的调用数落到当前路由上;没路由就继续攒着。 */
  flushCalls(day, at, exclude) {
    if (this.pendingCalls <= 0) return [];
    const route = this.route;
    if (!route) return [];
    const calls = this.pendingCalls;
    this.pendingCalls = 0;
    if (exclude.has(route.provider)) return [];
    if (isDelegationMarker(route.provider, route.model)) return [];
    return [
      {
        day,
        provider: route.provider,
        model: route.model,
        calls,
        promptTokens: 0,
        cachedTokens: 0,
        completionTokens: 0,
        at
      }
    ];
  }
};
function dedupeKey(data) {
  if (typeof data?.turn !== "number" || typeof data?.step !== "number") return null;
  return `${data.turn}:${data.step}`;
}
function createExternalUsageCollector(deps) {
  const exclude = new Set(deps.exclude ?? GATEWAY_PROVIDER_HISTORY);
  const folds = /* @__PURE__ */ new Map();
  const counters = { unknownRoute: 0, excluded: 0, recorded: 0 };
  return {
    onEvent(sessionId, event) {
      if (typeof sessionId !== "string" || sessionId === "") return;
      let fold = folds.get(sessionId);
      if (!fold) {
        fold = new ExternalUsageFold();
        folds.set(sessionId, fold);
      }
      let samples;
      try {
        samples = fold.fold(event, exclude);
      } catch (err) {
        deps.logger?.warn?.("[as-one] 外部用量折叠失败", err);
        return;
      }
      for (const sample of samples) {
        const provider = renameExternalProvider(sample.provider);
        if (provider === "") continue;
        try {
          deps.record(provider === sample.provider ? sample : { ...sample, provider });
          counters.recorded += 1;
        } catch (err) {
          deps.logger?.warn?.("[as-one] 外部用量落库失败", err);
        }
      }
    },
    onSessionDisposed(sessionId) {
      folds.delete(sessionId);
    },
    stats() {
      return { ...counters };
    }
  };
}

// src/external-usage-row.ts
var name = "@bvbhu/as-one/external-usage";
var inject = ["asOneCore"];
function apply(ctx) {
  const core = ctx.get("asOneCore");
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, external usage row skipped");
    return;
  }
  const runtime = core.runtime;
  ctx.effect(
    () => {
      let collector;
      let offEvent;
      let offDisposed;
      try {
        collector = createExternalUsageCollector({
          exclude: [AS_ONE_PROVIDER],
          record: (sample) => {
            runtime.db.statsExternalDaily.record({
              day: sample.day,
              provider: sample.provider,
              model: sample.model,
              calls: sample.calls,
              prompt_tokens: sample.promptTokens,
              cached_tokens: sample.cachedTokens,
              completion_tokens: sample.completionTokens,
              last_seen: Math.round(sample.at)
            });
          },
          logger: ctx.logger
        });
        const host = ctx;
        offEvent = host.on("session/event", (session, event) => {
          collector?.onEvent(sessionIdOf(session), event);
        });
        offDisposed = host.on("session/disposed", (session) => {
          collector?.onSessionDisposed(sessionIdOf(session));
        });
        ctx.logger?.info?.("[as-one] 网关外用量采集已挂上 session/event");
      } catch (err) {
        ctx.logger?.warn?.("[as-one] 网关外用量采集挂载失败(统计会缺这一块):", err);
      }
      return () => {
        offEvent?.();
        offDisposed?.();
      };
    },
    "@bvbhu/as-one/external-usage: external usage collector"
  );
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=external-usage.js.map
