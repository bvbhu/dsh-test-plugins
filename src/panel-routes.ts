/**
 * 面板数据路由 —— client 半的数据面(`/as-one/api/*`)。
 *
 * 与 Electron 版**同一份实现**:方法表来自 `@as-one/panel` 的 `createPanel`,
 * 分派走同一个 `dispatchPanel`。本文件只负责把 HTTP 请求翻译成
 * 「方法名 + 位置参数」,wire 形状对齐 docs/client-half-design.md §5:
 *   成功 `{ ok: true, value: T }`  失败 `{ ok: false, error: { code, message } }`
 *
 * ⚠️ 宿主半坑:webServer 对 handler 抛错统一 writeHead(400) —— 所有错误路径
 * 必须在 handler 内自写状态/body,不靠 throw。
 *
 * 参数约定(向后兼容两代 client):
 * 1. `{ args: [...] }` —— 新约定,位置参数与 Electron IPC 完全一致;
 * 2. 裸数组 `[...]` —— 同上;
 * 3. 旧对象 `{ provider, index, enabled }` 之类 —— 由 {@link LEGACY_ARGS} 映射。
 */

import type { AsOneWebRoute } from "./context-types.js";
import { readJsonBody, writeJson } from "./wire.js";
import { createPanelHost } from "./panel-host.js";
import type { PanelHost, PanelHostOptions } from "./panel-host.js";
import type { AsOneRuntime } from "./setup.js";

/**
 * 面板方法全集 —— 与共享包 `dispatchPanel` 的 case 对齐（**只读快照**，仅供
 * 诊断/文档；路由表不再依赖它）。
 *
 * 2026-11 改进：`buildPanelRoutes` 改为按**面板对象的实际方法键**建路由
 * （`Object.keys(host.panel)`），新增/删除面板方法自动随动 —— 这里漏写只会让
 * 这份快照过时，不会造成 404。真正的一致性风险只剩共享包 `dispatchPanel` 的
 * switch 漏 case（表现为「未知面板方法」），由 test/setup.test.ts 的覆盖断言
 * 盯住。
 */
export const PANEL_METHODS = [
  // 总览 / 运行期
  "getStatus",
  "getRuntime",
  "restartGateway",
  // 用量(网关 + 网关外,由 getUsageHistory 的 source 参数切换)
  "getUsageHistory",
  "getUsageSummary",
  // 逻辑模型
  "getLogicalModels",
  "writeLogicalModel",
  "removeLogicalModel",
  // 模型总览(部署)
  "getDeployments",
  "getSessionCurrentRoute",
  "setDeploymentExposure",
  "setDeploymentReasoning",
  "fetchDeploymentReasoning",
  "getModelProviders",
  "upsertModelProvider",
  "removeModelProvider",
  "fetchModels",
  "setModelExposure",
  "checkModels",
  "getMetrics",
  "checkModel",
  // 渠道(SenseNova / Trae / WorkBuddy)
  "getSensenovaAccounts",
  "getQuota",
  "getProviderPage",
  "getChannelAccounts",
  "checkinStatus",
  "checkinClaim",
  "checkinOverview",
  "checkinAll",
  "channelOverview",
  // 调度排序诊断(只读):看「为什么这个模型排在第一位」
  "getSchedulerPlan",
  "refreshStatus",
  "refreshRun",
  "syncChannel",
  "syncChannelQuota",
  "syncChannelCatalog",
  "syncAllQuota",
  "setChannelModels",
  "setChannelModel",
  "getClientPaths",
  "saveClientPath",
  "detectClientPath",
  "discoverChannelAccounts",
  "adoptChannelAccount",
  // 设置
  "getSettings",
  "saveSettings",
  "getRequestLog",
  "setRequestLog",
  // sensenova 页
  "getSensenovaStatus",
  "getSensenovaModels",
  "setSensenovaExposure",
  "sensenovaRefresh",
  "sensenovaLogin",
  "sensenovaSavePassword",
  "sensenovaRefetchKey",
  "sensenovaAddAccount",
  "sensenovaRemoveAccount",
  // qoder 页
  "getQoderAccounts",
  "getQoderStatus",
  "getQoderModels",
  "qoderRefreshCatalog",
  "qoderSetModelEnabled",
  "qoderCredits",
  "qoderCheckin",
  "qoderCampaigns",
  "qoderAddAccount",
  "qoderRemoveAccount",
  "qoderSetAccountEnabled",
  "qoderProbeChat",
  "qoderRecentErrors",
  // 数据目录
  "getDataDir",
  // 旧兼容
  "listProviders",
  "setAccountEnabled",
  "getRecentRequests",
  "getRequestLogStatus",
] as const;

/**
 * 共享 Panel 对象上的**内部方法**（非 HTTP API，勿建路由）。
 *
 * 这些是面板自身读缓存的 plumbing（qoder/sensenova 额度缓存视图），从来
 * 不进 `dispatchPanel` 的 switch、也不该被 HTTP 调用 —— 路由面按面板方法键
 * 派生时必须显式排除。共享包往 Panel 对象上加新方法时，守卫测试会逼你做
 * 「可分发（走 switch）还是内部（补进本表）」的决定。
 */
export const PANEL_INTERNAL_METHODS = ["sensenovaQuotaCached", "qoderCreditsCached"] as const;

/** 旧对象式 body → 位置参数(只在 body 既不是数组也没有 `args` 时生效)。 */
const LEGACY_ARGS: Record<string, (body: Record<string, unknown>) => unknown[]> = {
  setAccountEnabled: (b) => [String(b.provider ?? ""), Number(b.index), Boolean(b.enabled)],
  getRecentRequests: (b) => (b.limit === undefined ? [] : [Number(b.limit)]),
  getUsageHistory: (b) => [
    String(b.range ?? "all"),
    String(b.granularity ?? "day"),
    String(b.group ?? "model"),
  ],
  removeLogicalModel: (b) => [String(b.name ?? "")],
  writeLogicalModel: (b) => [b.input ?? b],
  getQuota: (b) => [String(b.provider ?? "")],
  getProviderPage: (b) => [String(b.provider ?? "")],
  getChannelAccounts: (b) => [String(b.provider ?? "")],
  syncChannel: (b) => [String(b.provider ?? ""), Boolean(b.force)],
  syncChannelQuota: (b) => [String(b.provider ?? ""), Boolean(b.force)],
  syncChannelCatalog: (b) => [String(b.provider ?? ""), Boolean(b.force)],
  checkModel: (b) => [String(b.provider ?? ""), String(b.model ?? "")],
  saveSettings: (b) => [b.updates ?? b],
  setRequestLog: (b) => [
    b.enabled === undefined ? undefined : Boolean(b.enabled),
    String(b.contentMode ?? b.content_mode ?? "off"),
  ],
};

/** 成功 envelope。 */
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** 失败 envelope。 */
function fail(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

/** 把 HTTP body 翻译成位置参数。 */
export function argsOf(method: string, body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") return [];
  const rec = body as Record<string, unknown>;
  if (Array.isArray(rec.args)) return rec.args;
  const legacy = LEGACY_ARGS[method];
  return legacy ? legacy(rec) : [];
}

/**
 * 面板方法表(向后兼容旧导出名)。
 *
 * 旧实现是 8 个手写方法;现在整份来自共享包 —— 因此 `getSettings` 等返回的是
 * **共享契约**(`@as-one/panel/src/types.js` 的 `RendererApi`),不再是插件早期
 * 那份精简版。
 */
export function createPanelMethods(rt: AsOneRuntime, options: PanelHostOptions = {}): PanelHost["panel"] {
  return createPanelHost(rt, options).panel;
}

/** 把面板方法包成 POST exact 路由(每方法一条,body 见文件头参数约定)。 */
export function buildPanelRoutes(rt: AsOneRuntime, options: PanelHostOptions = {}): AsOneWebRoute[] {
  const host = createPanelHost(rt, options);

  const route = (path: string, method: string): AsOneWebRoute =>
    ({
      kind: "exact",
      path,
      handler: async (req, res) => {
        if ((req.method ?? "GET").toUpperCase() !== "POST") {
          writeJson(res, 405, fail("method_not_allowed", `expected POST, got ${req.method ?? "?"}`));
          return;
        }
        try {
          const body = await readJsonBody(req);
          // 插件专有的 restartGateway 在 PanelContext 上（共享 Panel 虽然声明了
          // 这个方法，但 dispatchPanel 故意不分发它——重启入口只在托盘菜单）；
          // 其余一律走共享分派器。getUsageSummary 等旧别名已是 Panel 自己的
          // 方法（shared overview 域里转发到 getUsageHistory("all","day","model")），
          // 不再需要路由层特判。
          const value =
            method === "restartGateway"
              ? await host.ctx.restartGateway()
              : await host.dispatch(method, argsOf(method, body));
          writeJson(res, 200, ok(value));
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const status =
            typeof (err as { status?: unknown }).status === "number"
              ? (err as { status: number }).status
              : 500;
          writeJson(res, status, fail("internal_error", detail));
        }
      },
    }) satisfies AsOneWebRoute;

  // 路由面 = 面板对象的**实际方法键**（2026-11 改进）：面板域新增/删除方法时
  // 路由自动随动。此前手抄清单漏写一个名字 → 该方法的路由直接 404，且要到
  // 用户点开对应页面才暴露。内部方法（缓存读口，非 HTTP API）显式排除。
  const panelRecord = host.panel as unknown as Record<string, unknown>;
  const internal = new Set<string>(PANEL_INTERNAL_METHODS);
  const methods = Object.keys(panelRecord)
    .filter((name) => typeof panelRecord[name] === "function")
    .filter((name) => !internal.has(name));
  const routes = methods.map((method) => route(`/as-one/api/${method}`, method));
  // restartGateway：Panel 接口上虽声明了它，但共享 dispatchPanel 故意不分发
  // （重启入口只在托盘菜单，用户定案 m03639）——插件模式由 panel-host 的
  // PanelContext 如实回答「不能重启」，路由层特判转发过去。
  routes.push(route("/as-one/api/restartGateway", "restartGateway"));
  return routes;
}
