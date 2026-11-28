/**
 * 子代理行 —— bundle 拆分后的子代理相关组（patch 行 `@bvbhu/as-one/subagent`）。
 *
 * 单包多 patch 行拆分（用户 D1 决策）后的第三行，只装两件事：
 * 1. 子代理会话模型选择器中转路由（continuable 子代理页原生选择器被硬禁用，
 *    这里挂中转路由:模型目录/会话信息/pending 选择/切换,复用宿主 sessionController）;
 * 2. 子代理并发限制 = 模型自身的并发容量（启用凭据数 × 每凭据并发）。
 *
 * 依赖核心行的 `asOneCore` 服务（runtime / subagentCapOf / ledger），跨行只经
 * 该服务或宿主事件,不 import 任何其他行模块。
 */

import { buildSubagentModelRoutes, subagentModelDepsOf } from "./subagent-model-api.js";
import { applySubagentLimit } from "./components/subagent-limit.js";
import { createCapacityView } from "./components/capacity.js";
import type { AsOneRuntime } from "./setup.js";
import type { Context } from "./context-types.js";
import type { AsOneCoreService } from "./core-service.js";

export const name = "@bvbhu/as-one/subagent";
export const inject = ["webServer", "asOneCore"];

export function apply(ctx: Context): void {
  const core = (ctx as unknown as { get(name: string): unknown }).get("asOneCore") as
    | AsOneCoreService
    | undefined;
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, subagent row skipped");
    return;
  }
  const runtime = core.runtime as AsOneRuntime;

  ctx.effect(
    () => {
      // 注入 runtime.db.subagentModelPending:休眠子代理的待切换选择持久化在这里,
      // 下次真实 agent/created 时 drain 写入 child Session 的 model/selection。
      const subagentModelRoutes = buildSubagentModelRoutes(
        subagentModelDepsOf(ctx, runtime.db.subagentModelPending),
      );
      // 容量视图包装 rt.ledger（真实在途账本），组件只按 setting 表的开关/配额裁决。
      const capacity = createCapacityView(runtime.ledger);
      // 子代理并发限制 = 模型自身的并发容量（启用凭据数 × 每凭据并发；逻辑模型取成员之和）。
      // 2026-11 用户定案：不再有任何 subagentLimit.* 设置项。
      const resolveLogicalModel = (name: string): { provider: string; model: string } | null => {
        const slash = name.indexOf("/");
        if (slash > 0) {
          const provider = name.slice(0, slash);
          const model = name.slice(slash + 1);
          return provider !== "" && model !== "" ? { provider, model } : null;
        }
        try {
          const first = runtime.scheduler.chain(name)[0];
          return first ? { provider: first.endpoint.provider, model: first.endpoint.model } : null;
        } catch {
          return null;
        }
      };
      const disposeSubagentLimit = applySubagentLimit(ctx, capacity, runtime.subagentCapOf, {
        getSetting: runtime.getSetting,
        resolveLogical: resolveLogicalModel,
      });

      const disposers: (() => void)[] = [];
      for (const route of subagentModelRoutes) {
        try {
          // 宿主 register 收单条路由对象;返回 disposer。
          disposers.push(ctx.webServer.register(route as never));
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] register route ${route.path} failed:`, err);
        }
      }
      ctx.logger?.info?.(
        `[as-one] mounted ${subagentModelRoutes.length} subagent-model route(s)`,
      );

      return () => {
        // 逆注册顺序:并发限制（释放 bound 预留 + capacity.reset）→ 中转路由。
        disposeSubagentLimit();
        for (const dispose of disposers) dispose();
      };
    },
    "@bvbhu/as-one/subagent: model selector routes + concurrency limit",
  );
}
