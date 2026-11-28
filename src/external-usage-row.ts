/**
 * 外部用量行 —— bundle 拆分后的外部用量采集组（patch 行 `@bvbhu/as-one/external-usage`）。
 *
 * 单包多 patch 行拆分（用户 D1 决策）后的第五行，只装一件事：只采
 * `session/event` 里**没经过 as-one** 的调用（`provider !== "as-one"`），
 * 写独立的 `stats_external_daily`；不回填历史（用户定案:网关库里已有大量
 * 用量,再导一遍就是重复统计）。没有任何事件源时这段是纯 no-op,不影响插件加载。
 *
 * 依赖核心行的 `asOneCore` 服务（runtime.db.statsExternalDaily），跨行只经
 * 该服务或宿主事件,不 import 任何其他行模块。
 */

import { AS_ONE_PROVIDER } from "./llm-adapter.js";
import { createExternalUsageCollector, sessionIdOf } from "./usage-external.js";
import type { Context } from "./context-types.js";
import type { AsOneCoreService } from "./core-service.js";

export const name = "@bvbhu/as-one/external-usage";
export const inject = ["asOneCore"];

export function apply(ctx: Context): void {
  const core = (ctx as unknown as { get(name: string): unknown }).get("asOneCore") as
    | AsOneCoreService
    | undefined;
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, external usage row skipped");
    return;
  }
  const runtime = core.runtime;

  ctx.effect(
    () => {
      let collector: ReturnType<typeof createExternalUsageCollector> | undefined;
      let offEvent: (() => void) | undefined;
      let offDisposed: (() => void) | undefined;
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
              last_seen: Math.round(sample.at),
            });
          },
          logger: ctx.logger,
        });
        const host = ctx as unknown as {
          on(event: string, listener: (session: unknown, event: unknown) => void): () => void;
        };
        offEvent = host.on("session/event", (session, event) => {
          // 宿主给的是 `{ header: { id } }`;按 `session.id` 取会拿到 undefined,
          // 于是每条事件都被当空会话丢掉(外部表曾经一直是空的)。
          collector?.onEvent(sessionIdOf(session), event as { type?: string });
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
    "@bvbhu/as-one/external-usage: external usage collector",
  );
}
