/**
 * 网关核心行 —— bundle 拆分后的根入口（`@bvbhu/as-one`，patch id 保持 `as-one-gateway`）。
 *
 * 单包多 patch 行拆分（用户 D1 决策：网关核心不拆，拆「子代理相关 / 对外端口 /
 * 外部用量」+ 公共服务层）。本行只做网关核心：面板路由 + LLM adapter（嵌进 DSH
 * 原生模型选择器）+ 压缩增强 + 内部换档触发。子代理路由 / 对外网关路由 /
 * 外部用量采集各自独立成行（见 subagent-row / external-port-row /
 * external-usage-row），跨行只经 `asOneCore` 服务或宿主事件。
 *
 * 写法仿 dsh-usage-statistics-panel/src/index.ts:
 * - 导出 name / inject / apply(cordis 直接加载);
 * - ctx.effect(回调, label) 注册生命周期:回调立即执行,返回值 = disposer,
 *   在 ctx 销毁(HMR / 卸载)时调用 —— 路由与 adapter 一起清理。
 *
 * LLM adapter 用 `ctx.inject(["llm"], …)` 子 fiber:依赖没满足就不执行,
 * 网关/面板路由不受影响。注册必须发生在 effect 里:宿主 `registerAdapter`
 * 用 `ctx.effect` 记账,子 fiber 销毁时自动摘掉,否则下次 apply 撞
 * `DUPLICATE_ADAPTER`。
 */

import { warmupDeepseekTokenizer } from "@as-one/core/src/tokenizer/deepseek.js";

import { buildPanelRoutes } from "./panel-routes.js";
import { AS_ONE_PROVIDER, AsOneLlmAdapter } from "./llm-adapter.js";
import type { DshAttachmentService } from "./llm-types.js";
import type { Context } from "./context-types.js";
import type { AsOneCoreService } from "./core-service.js";
import { internalSwitch, setCompactHost, type CompactTriggerCompaction } from "./compact-trigger.js";
import { rerouteSettingsFrom } from "./reroute.js";
import { applyCompaction } from "./components/compaction/index.js";
import { createCapacityView } from "./components/capacity.js";
import { fallbackModelOf } from "./components/subagent-limit.js";

export const name = "@bvbhu/as-one";
export const inject = ["webServer", "asOneCore"];

export function apply(ctx: Context): void {
  const core = (ctx as unknown as { get(name: string): unknown }).get("asOneCore") as
    | AsOneCoreService
    | undefined;
  if (!core) {
    // 核心行未就绪(setup 失败或加载顺序异常):本行不挂任何东西,其余行同理。
    ctx.logger?.warn?.("[as-one] core service unavailable, gateway row skipped");
    return;
  }
  const runtime = core.runtime;

  // 压缩拦截器要挂在有 `llm` 服务的子 fiber 上（下面 llm effect 里装配），
  // 这里先留 disposer 槽位（disposer 在本行 effect 销毁时统一调用）。
  let disposeCompaction: (() => void) | undefined;

  ctx.effect(
    () => {
      // 面板要先建出来 —— 预热门要借它的 `syncAllQuota(true)` 打真实探针。
      const panelRoutes = buildPanelRoutes(runtime);

      ctx.inject(["llm"], (child) => {
        child.effect(() => {
          const adapter = new AsOneLlmAdapter(runtime, {
            // ⚠️ DSH 的对话请求走这条进程内路径（`adapter.stream()` → `resolveUpstream`），
            // **不经过** `/v1/chat/completions` 路由 —— 所以预热门必须在这里再注入一次，
            // 否则启动后首个请求仍会拿空额度快照排成 members 配置序（恒走 trae）。
            warmup: core.warmup,
            // 宿主 attachments 服务的惰性取用口 —— adapter 靠它把 `read_image`
            // 与用户附件的「附件引用」读成字节再编成 data URL。
            //
            // ⚠️ 故意不把 attachments 写进 `ctx.inject([...])`:纯 Web 宿主 / 没挂
            // 附件服务的部署里,整个 adapter 都不该因此消失(那样连文本模型都选不到)。
            // 服务缺失时 adapter 如实降级(丢图片块),文本请求照常。
            // 现读 setting 表:面板保存后下一个请求就换车道。
            reroutes: () => rerouteSettingsFrom(runtime.getSetting),
            // 只对**已创建的子代理会话**返回替代模型；创建期并发拦截不在此路径。
            subagentFallback: (sessionId, model) => {
              if (sessionId === undefined || !core.subagentSessions.has(sessionId)) return undefined;
              const fallback = fallbackModelOf(runtime.getSetting);
              return fallback === model ? undefined : fallback;
            },
            resolveAttachments: () => {
              try {
                return (child.get("attachments") as DshAttachmentService | undefined) ?? undefined;
              } catch {
                return undefined;
              }
            },
          });
          let unregister: (() => void) | undefined;
          try {
            unregister = child.llm.registerAdapter([AS_ONE_PROVIDER], adapter);
            child.logger?.info?.(`[as-one] llm adapter registered as "${AS_ONE_PROVIDER}"`);
          } catch (err) {
            // 已经有人占了这条路由(比如同宿主装了两个 As One 插件实例):
            // 记一条日志继续,网关与面板不受影响。
            child.logger?.warn?.("[as-one] llm adapter registration failed:", err);
          }

          // 压缩增强拦截器挂在同一 child 上（它有 llm 服务）。失败只记日志，
          // 宿主原摘要不受影响。
          try {
            disposeCompaction = applyCompaction({
              ctx: child as unknown as Context,
              runtime,
              capacity: createCapacityView(runtime.ledger),
              getSetting: (key) => runtime.getSetting(key),
            });
          } catch (err) {
            child.logger?.warn?.("[as-one] compaction enhancement setup failed:", err);
          }

          return () => {
            try {
              unregister?.();
            } catch (err) {
              child.logger?.warn?.("[as-one] llm adapter dispose failed:", err);
            }
          };
        }, "@bvbhu/as-one: llm adapter");
      });

      // 预热 DeepSeek 分词表(纯内存建表 ~100ms)。放在挂载时而不是第一次请求时:
      // 那一百毫秒恰好落在「用户按下回车」上就很明显。
      warmupDeepseekTokenizer();

      // 只补「内部换档」这一种宿主看不见的压缩触发;不接管任何宿主压缩事件。
      setCompactHost({
        compaction: (() => {
          try {
            return (ctx.get("compaction") as CompactTriggerCompaction | undefined) ?? undefined;
          } catch {
            return undefined;
          }
        })(),
        warn: (message, error) => ctx.logger?.warn?.(message, error),
      });
      try {
        const host = ctx as unknown as {
          on(
            event: string,
            listener: (payload: unknown, next: () => unknown) => unknown,
            opts?: unknown,
          ): () => void;
        };
        host.on(
          "agent/request",
          (payload, next) =>
            internalSwitch.onAgentRequest(
              payload as Parameters<typeof internalSwitch.onAgentRequest>[0],
              next,
            ),
          { prepend: true },
        );
      } catch (err) {
        ctx.logger?.warn?.("[as-one] compact trigger registration skipped:", err);
      }

      const disposers: (() => void)[] = [];
      for (const route of panelRoutes) {
        try {
          // 宿主 register 收单条路由对象;返回 disposer。
          disposers.push(ctx.webServer.register(route as never));
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] register route ${route.path} failed:`, err);
        }
      }
      ctx.logger?.info?.(
        `[as-one] mounted ${panelRoutes.length} panel route(s)`,
      );

      return () => {
        // 逆注册顺序:压缩 → 面板路由（子 fiber 销毁时摘 adapter）。
        disposeCompaction?.();
        for (const dispose of disposers) dispose();
      };
    },
    "@bvbhu/as-one: gateway core (panel routes + llm adapter + compaction)",
  );
}
