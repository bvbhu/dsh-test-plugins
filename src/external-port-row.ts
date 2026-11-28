/**
 * 对外端口行 —— bundle 拆分后的对外网关面（patch 行 `@bvbhu/as-one/external-port`）。
 *
 * 单包多 patch 行拆分（用户 D1 决策）后的第四行，只装一件事：对外
 * OpenAI 兼容网关路由（/v1/models、/v1/chat/completions、/v1/messages）。
 * 依赖核心行的 `asOneCore` 服务（runtime + warmup：warmup.wait() 在
 * resolveUpstream 前，保证首次请求拿到刷新后的额度快照）。
 *
 * 跨行只经 `asOneCore` 服务或宿主事件,不 import 任何其他行模块。
 */

import { buildGatewayRoutes } from "./routes.js";
import type { Context } from "./context-types.js";
import type { AsOneCoreService } from "./core-service.js";

export const name = "@bvbhu/as-one/external-port";
export const inject = ["webServer", "asOneCore"];

export function apply(ctx: Context): void {
  const core = (ctx as unknown as { get(name: string): unknown }).get("asOneCore") as
    | AsOneCoreService
    | undefined;
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, external port row skipped");
    return;
  }

  ctx.effect(
    () => {
      const gatewayRoutes = buildGatewayRoutes(core.runtime, {
        logger: ctx.logger as unknown as Pick<Console, "warn" | "error">,
        warmup: core.warmup,
      });
      const disposers: (() => void)[] = [];
      for (const route of gatewayRoutes) {
        try {
          // 宿主 register 收单条路由对象;返回 disposer。
          disposers.push(ctx.webServer.register(route as never));
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] register route ${route.path} failed:`, err);
        }
      }
      ctx.logger?.info?.(
        `[as-one] mounted ${gatewayRoutes.length} gateway route(s)`,
      );

      return () => {
        for (const dispose of disposers) dispose();
      };
    },
    "@bvbhu/as-one/external-port: /v1 gateway routes",
  );
}
