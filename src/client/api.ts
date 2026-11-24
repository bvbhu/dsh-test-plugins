/**
 * client 半 —— 面板数据层:把共享视图层的 invoke 桥接到宿主的 HTTP 路由。
 *
 * 共享页面(`@as-one/panel-ui`)只调 `invokePanel(method, ...args)`;这里在
 * 面板挂载前注入实现:`POST as-one/api/<method>`,body `{ args: [...] }`
 * (宿主半 src/panel-routes.ts 的 argsOf 接受该形状,也兼容裸数组与旧对象)。
 *
 * wire 形状:成功 `{ ok: true, value: T }`、失败 `{ ok: false, error: { code, message } }`;
 * 失败/网络/坏响应统一抛 AsOneApiError(code, message)。零 Node 类型。
 */

import { setPanelInvoker } from "@as-one/panel-ui";
import type { SessionCurrentRoute } from "@as-one/panel-ui";

/**
 * 本插件的 LLM provider id —— 与宿主半 `registerAdapter(["as-one"], …)` **逐字一致**。
 *
 * 这里刻意写常量而不是 import 宿主半的 `llm-adapter.ts`:client bundle 只该装
 * 浏览器代码,把 adapter(连带 @as-one/core 的网关类型与 node 语义)拖进来会让
 * client 包凭空变大,还多一条「构建期能看到 node 内置」的错觉。
 */
export const AS_ONE_PROVIDER_ID = "as-one";

export class AsOneApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AsOneApiError";
    this.code = code;
  }
}

type WireOk<T> = { ok: true; value: T };
type WireFailure = { ok: false; error: { code: string; message: string } };
type WireResponse<T> = WireOk<T> | WireFailure;

/** 文档相对 URL(绝不 root-absolute),与宿主半的 exact 路由一一对应。 */
async function post<T>(method: string, args: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`as-one/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args }),
    });
  } catch {
    throw new AsOneApiError("network", "请求失败(网络错误)");
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AsOneApiError("bad-response", `响应不是合法 JSON(HTTP ${res.status})`);
  }

  const wire = json as WireResponse<T>;
  if (wire !== null && typeof wire === "object" && "ok" in wire) {
    if (wire.ok) return wire.value;
    const failure = wire as WireFailure;
    throw new AsOneApiError(
      failure.error?.code ?? "error",
      failure.error?.message ?? "As One API 错误",
    );
  }
  return json as T;
}

/**
 * 把共享视图层的数据通道接到本面板的 HTTP 路由。
 * 幂等:面板重新挂载时重复调用即可。
 */
export function bindPanelBridge(): void {
  setPanelInvoker((method, ...args) => post(method, args));
}

/** 某会话**当前请求**的真实模型(输入框内徽标用;查不到 → null)。 */
export function fetchSessionCurrentRoute(
  sessionId: string,
  model: string,
): Promise<SessionCurrentRoute | null> {
  return post<SessionCurrentRoute | null>("getSessionCurrentRoute", [sessionId, model]);
}

// ── 子代理会话模型选择器(client ↔ host 中转路由) ────────────────────────

export interface SubagentModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface SubagentModelReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

export interface SubagentModelReasoning {
  efforts: SubagentModelReasoningEffort[];
  defaultEffort?: string;
}

export interface SubagentModelBadge {
  text: string | Record<string, string>;
  tone: "neutral" | "info" | "success" | "warning";
}

export interface SubagentModelCatalogEntry {
  id: string;
  name: string;
  description?: string;
  reasoning?: SubagentModelReasoning;
  badge?: SubagentModelBadge;
}

export interface SubagentModelCatalogGroup {
  id: string;
  name: string;
  models: SubagentModelCatalogEntry[];
}

export interface SubagentModelCatalogFailure {
  id: string;
  name: string;
  message: string;
}

export interface SubagentModelCatalog {
  default: SubagentModelSelection;
  routableProviders: string[];
  groups: SubagentModelCatalogGroup[];
  failures: SubagentModelCatalogFailure[];
}

export interface SubagentSessionInfo {
  sessionId: string;
  isSubagent: boolean;
  mode: "one-shot" | "continuable" | "unknown" | null;
  parentSessionId: string | null;
  /**
   * 该会话此刻是否有可写 live Session。`false` ⇒ 子代理休眠,模型切换
   * 必然不可用(宿主独占其生命周期),UI 应置灰而不是让用户点出失败。
   */
  isLive?: boolean;
}

/** DSH 原生模型目录(经 host sessionController.modelCatalog 中转)。 */
export function fetchModelCatalog(): Promise<SubagentModelCatalog> {
  return post<SubagentModelCatalog>("getModelCatalog", []);
}

/** 会话子代理身份兜底(client 投影拿不到时用)。 */
export function fetchSubagentSessionInfo(sessionId: string): Promise<SubagentSessionInfo> {
  return post<SubagentSessionInfo>("getSubagentSessionInfo", [sessionId]);
}

/**
 * 切换会话模型。
 *
 * ⚠️ 不走 `sessionController.selectModel` —— 它对子代理会话硬拒绝,也拿不到
 * child scope 的可写 Session。宿主在子代理**运行期间**经 `agent/created`
 * 暴露 `agent.session`,as-one 缓存它并 `append("model/selection", …)`
 * (DSH 自己的 `subagent-model-selection-settings` 就是这么写 child 的)。
 * 子代理休眠时没有任何可写 Session,此时返回 409 `subagent_session_not_live`。
 */
export function selectSubagentModel(
  sessionId: string,
  provider: string,
  model: string,
  reasoningEffort?: string,
): Promise<unknown> {
  return post<unknown>("selectModel", [sessionId, provider, model, reasoningEffort]);
}
