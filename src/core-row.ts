/**
 * 核心服务行（L1 公共服务层）—— bundle 拆分后的共享运行时。
 *
 * 单包多 patch 行拆分（用户 D1 决策：网关核心不拆，拆「子代理相关 / 对外端口 /
 * 外部用量」+ 公共服务层）后的第一个 patch 行：**必须最先加载**（cordis.patch.yml
 * 顺序），因为它 `ctx.provide('asOneCore', …)` 供其余四行 `inject`。
 *
 * 写法仿 dsh-usage-statistics-panel/src/index.ts:
 * - 导出 name / inject / apply(cordis 直接加载);
 * - `apply` 里只有一个 `ctx.effect`:setup 异步完成（await setupAsOne）后才
 *   provide 服务，disposer 在 ctx 销毁(HMR / 卸载)时调用 —— 监听器与运行时
 *   一起清理。cordis 对 async effect 会先等 setup settle 再 unload。
 *
 * 免重启 dev 语义:所有可重建服务(ledger / health / scheduler 实例)在
 * apply 里现建现放,持久状态只放 SQLite(`<homedir>/.as-one/as-one.db`)。
 *
 * **没有配置文件、没有 YAML config** —— 路径固定,设置项(含重路由车道)全部
 * 在 `setting` 表,由面板「设置」页读写。
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { setupAsOne, type AsOneRuntime } from "./setup.js";
import { createWarmupGate, type WarmupGate } from "./warmup-gate.js";
import { evaluateQuotaFreshness } from "./quota-freshness.js";
import type { Context } from "./context-types.js";
import type { AsOneCoreService } from "./core-service.js";

export type { AsOneCoreService };

export const name = "@bvbhu/as-one/core";
export const inject: string[] = [];

/** 固定路径布局:数据、库、日志都在这一个目录里。 */
function resolveDirs(): { dataDir: string; dbPath: string; logDir: string } {
  const dataDir = join(homedir(), ".as-one");
  return { dataDir, dbPath: join(dataDir, "as-one.db"), logDir: join(dataDir, "logs") };
}

/**
 * 额度预热门的装配（用户 2026-11-16 定案）。
 *
 * 两条触发条件：
 * 1. **启动后首次调度前** —— 无条件刷一轮，把到期时间填进运行期快照；
 * 2. **没有有效数据时** —— 每个请求调度前用 {@link evaluateQuotaFreshness}
 *    判一次（只读内存，廉价），无效才再刷，受节流约束。
 *
 * 为什么要借面板的 `syncAllQuota`：额度探针（trae/workbuddy/minimax/qoder）
 * 全部活在 `@as-one/panel` 里，`src/` 不该反过来实现一遍 —— 那必然和面板分叉。
 * 面板宿主已经建好（`createPanelHost` 在 `setupAsOne` 之后），这里只是拿它的
 * 方法当刷新器。
 */
function createQuotaWarmup(
  runtime: AsOneRuntime,
  ctx: Context,
): WarmupGate {
  /** 面板方法表（惰性建：`createPanelHost` 有副作用，别在模块顶层跑）。 */
  let panel: { syncAllQuota?: (force?: boolean) => Promise<unknown> } | null = null;

  const refresh = async (): Promise<void> => {
    if (panel === null) {
      // 与 `buildPanelRoutes` 内部用的是**同一个** runtime，但各自建一份 host
      // 会让 chQuotaCache（模块级）被两个实例共享 —— 那没问题（缓存本来就是
      // 模块级单例）；两份 host 的 `qoderQuotaRefresh` 闭包各自引用同一 runtime，
      // 覆盖面一致（`CH_QUOTA_PROVIDERS` 是模块级常量，含 codearts）。
      const { createPanelHost } = await import("./panel-host.js");
      panel = createPanelHost(runtime, {}).panel as unknown as {
        syncAllQuota?: (force?: boolean) => Promise<unknown>;
      };
    }
    const fn = panel?.syncAllQuota;
    if (typeof fn !== "function") return;

    // ⚠️ **刷新后必须让调度器缓存失效** —— 这是「启动后第一次请求路由错」的根因。
    // `Scheduler.chain()` 对 due-first 会把结果按「分钟 + 额度代数」记忆化
    // （`_cache`）；刷到新额度却不清缓存，下一次 chain() 仍拿旧快照排序。
    // 放在 finally 里：即使 syncAllQuota 抛错、或 ok:false 被我们转成失败，
    // 只要探针写过任何一行，调度器都必须重新读，不允许任何 chain() 用旧快照。
    let incomplete: string | null = null;
    try {
      const res = (await fn.call(panel, true)) as
        | { ok?: boolean; message?: string; written?: number; probed?: number }
        | null
        | undefined;
      // ⚠️ **不完整就是失败**（2026-11-16 用户定案：「syncAllQuota，对于非 openai
      // 供应商必须全部读到数据」）。`ok:false` 抛给 gate，由它明确记降级原因。
      if (res !== null && res !== undefined && res.ok === false) {
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

  /**
   * 「有没有有效到期数据」的判定。
   *
   * ⚠️ 数据源必须与调度器读的**同一份**：`chQuotaTableForScheduler()` 是网关
   * 侧 `quotaSnapshot` 的实现，它把 `chQuotaCache` + provider 聚合 + sensenova
   * 比例合成一张表。这里只关心「有没有 expires_at / 新不新鲜」。
   */
  const needsRefresh = (): boolean => {
    try {
      const table = runtime.repo.quotas() ?? {};
      const snapshots = Object.values(table) as Array<{
        expires_at?: number | null;
        fetched_at?: number | null;
        error?: string | null;
      }>;
      const hours = Number(runtime.getSetting("external_refresh.interval_hours") ?? "5");
      const maxAgeHours = Number.isFinite(hours) && hours > 0 ? hours : 5;
      const verdict = evaluateQuotaFreshness({
        snapshots,
        now: Date.now(),
        maxAgeMs: maxAgeHours * 3_600_000,
      });
      if (!verdict.fresh) {
        ctx.logger?.info?.(`[as-one] 额度快照无效（${verdict.reason}）→ 调度前先刷新`);
      }
      return !verdict.fresh;
    } catch (err) {
      // 判定失败**不触发**刷新：宁可少刷一次，也不要因判定 bug 每请求打上游。
      ctx.logger?.warn?.("[as-one] 额度新鲜度判定失败，本轮不刷新", err);
      return false;
    }
  };

  return createWarmupGate({
    refresh,
    needsRefresh,
    logger: ctx.logger as unknown as Pick<Console, "warn" | "info">,
  });
}

export function apply(ctx: Context): void {
  ctx.effect(
    async () => {
      const { dataDir, dbPath, logDir } = resolveDirs();

      let runtime: AsOneRuntime;
      try {
        runtime = await setupAsOne({ dataDir, dbPath, logDir });
      } catch (err) {
        // 启动失败不能拖垮宿主:记日志,服务不提供(其余行 inject 不满足即不加载)。
        ctx.logger?.warn?.("[as-one] setup failed, core service unavailable:", err);
        return () => {};
      }

      // ⚠️ 预热门必须在**两处**都注入（2026-11-16 真根因）：
      //   · `buildGatewayRoutes` → 外部 `/v1/*` 调用方；
      //   · `AsOneLlmAdapter`   → **DSH 自己的对话请求**（进程内 `adapter.stream()`，
      //     不走 HTTP 路由，所以只修前者的那段预热对用户看到的请求完全无效）。
      // 它内部惰性建面板 host，提前构造是安全的。
      const warmup = createQuotaWarmup(runtime, ctx);
      // 把门挂到运行时上：**所有**要读调度结果的异步入口都能 `await runtime.awaitQuota?.()`，
      // 而不是各自记着"先预热"（2026-11-18 用户定案：同步到所有使用面，保证数据唯一）。
      // 门本身幂等 + 脏了才刷，多挂几处不会多打上游。
      runtime.attachQuotaGate(warmup);

      // 已创建的子代理会话（用于**请求期**并发兜底；创建期拦截不走这里）。
      // 宿主 `agent/created` 的 `agent.session.header.origin === 'subagent'` 是
      // DSH 0.2.2 的会话来源判定（与 as-one 既有 selector 判定同源）。
      const subagentSessions = new Set<string>();
      const sessionEvents = ctx as unknown as {
        on(event: string, listener: (payload: { agent?: { id?: string; session?: { id?: string; header?: { origin?: string } } } }) => void): () => void;
      };
      const childSessionIdOf = (agent: { id?: string; session?: { id?: string } } | undefined) =>
        agent?.id ?? agent?.session?.id;
      const offCreated = sessionEvents.on("agent/created", ({ agent }) => {
        const id = childSessionIdOf(agent);
        if (id !== undefined && agent?.session?.header?.origin === "subagent") subagentSessions.add(id);
      });
      const offDisposed = sessionEvents.on("agent/disposed", ({ agent }) => {
        const id = childSessionIdOf(agent);
        if (id !== undefined) subagentSessions.delete(id);
      });

      ctx.provide("asOneCore", { runtime, subagentSessions, warmup } satisfies AsOneCoreService);
      ctx.logger?.info?.("[as-one] core service ready (runtime + warmup + subagent registry)");

      return () => {
        offCreated();
        offDisposed();
        runtime.dispose();
      };
    },
    "@bvbhu/as-one/core: runtime + warmup + subagent session registry",
  );
}
