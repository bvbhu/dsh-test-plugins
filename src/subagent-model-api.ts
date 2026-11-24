/**
 * 子代理会话「模型选择器」的 host HTTP 路由。
 *
 * 背景:DSH 原生 client 模型选择器对子代理会话**硬禁用**
 * (`ui-model-selection/src/client/directory.ts:152` 抛
 * `model selection is unavailable for addressed subagent sessions`)。
 * 用户定案:在 continu able 子代理会话里自建一个「一模一样」的选择器,
 * 走 as-one 自家的 HTTP API(路径 B,不注入宿主 client 服务、零新依赖)。
 *
 * 这里只做**中转** —— 模型目录复用宿主的 host 服务:
 * - `ctx.get('sessionController').modelCatalog()` = DSH 原生模型目录。
 *
 * 切换**不能**走 `sessionController.selectModel(req)`:它在 `commands.ts:167`
 * 先 `resolveAgent()` → `liveAgent()`(`agent.ts:276-282`)对 `origin==='subagent'`
 * 的会话硬拒绝 `session "..." is owned by subagent routing`。也不能走
 * `ctx.get('agents').get(sessionId)`:子代理 Agent 注册在 child scope(`child-agent.ts:180-181`
 * "Registrations belong to the child's scope"),root ctx 的 `agents` 注册表读不到,
 * 实测报「没有 live Agent」。
 *
 * 正确 seam:子代理 Agent/Session 注册在 **child scope**,root ctx 的 `agents`/`sessions`
 * 注册表都按 scope 隔离(`core/session/src/index.ts:1313` `enter()` 用 `scopeTarget(session,
 * scopeOf(this.ctx))`),实测 root `sessions.get(childId)` 报「没有 live Session」。
 * 但 Cordis 事件**按 scope 向上冒泡**:`agent/created` 用 `scopeTarget(agent, agent)`
 * (`core/agent/src/index.ts:564`)派发,其 filter 对未限定 scope 的监听器(tag===undefined)
 * 永远返回 true(`core/scope/src/index.ts:170-185`)。DSH 自带的
 * `tool-subagent/src/model-selection-settings.ts:42-74` 正是这么做的:host ctx 上
 * `ctx.on('agent/created', ({agent}) => target.append(...))` 拿到 origin==='subagent'
 * 的 child session 并成功写入。这里照抄:在 as-one 自己的 ctx 上监听,把每个 live
 * session 按 id 缓存下来,selectModel 从缓存取(取不到才回退 root `sessions.get()`)。
 * 拿到 session 后 `append('model/selection', ...)` —— 这正是 `AgentModel.select()`
 * (`core/agent/src/model-selection.ts:112-115`)的底层实现,且 `core/session` 的 append
 * **没有** subagent/origin 守卫(守卫只在 api/session-controller 的 resolve 路径)。
 *
 * 校验链/默认保存/错误口径复刻 `commands.ts:168-194`,与父会话一致。写下
 * `model/selection` 事件后,`modelSelection` 投影(`core/agent/src/model-selection.ts:72-90`)
 * 折叠出 `next=selection`,client 选择器与下一个模型请求立即读到。
 *
 * 形状全部是**结构镜像**(零 `@deepseek-ai` import),避免把宿主类型拖进 bundle。
 */

import { readJsonBody, writeJson } from "./wire.js";
import type { AsOneWebRoute, Context } from "./context-types.js";

// ── 宿主服务结构镜像(对应 api/session-controller/src/types.ts) ───────────

export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface ModelReasoningEffort {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface ModelReasoning {
  readonly efforts: readonly ModelReasoningEffort[];
  readonly defaultEffort?: string;
}

export interface ModelBadge {
  readonly text: string | Record<string, string>;
  readonly tone: "neutral" | "info" | "success" | "warning";
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly reasoning?: ModelReasoning;
  readonly badge?: ModelBadge;
}

export interface ModelCatalogGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly ModelCatalogEntry[];
}

export interface ModelCatalogFailure {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

export interface ModelCatalog {
  readonly default: ModelSelection;
  readonly routableProviders: readonly string[];
  readonly groups: readonly ModelCatalogGroup[];
  readonly failures: readonly ModelCatalogFailure[];
}

export interface SelectModelRequest extends ModelSelection {
  readonly sessionId: string;
}

export interface SelectModelValue {
  readonly selected: ModelSelection;
}

interface SessionControllerLike {
  modelCatalog(): Promise<ModelCatalog>;
}

/**
 * 切换模型要复刻 `commands.ts:168-194` 的校验链,但绕过 `resolveAgent()` 的
 * subagent 守卫:不取 live Agent,而是从 host SessionStore 拿 child Session 直接
 * append `model/selection`。以下是所需宿主服务的结构镜像(零 `@deepseek-ai` import)。
 */
interface LlmLike {
  listProviders(): readonly { readonly id: string }[];
  listModels(provider: string): Promise<readonly { readonly id: string }[]>;
  resolveCallConfig(config: ModelSelection): Promise<unknown>;
}
interface AgentDefaultModelLike {
  saveSelection(selection: ModelSelection): Promise<unknown>;
}

/** 子代理会话信息(client 可用它补投影拿不到的字段,如父会话 id)。 */
export interface SubagentSessionInfo {
  readonly sessionId: string;
  readonly isSubagent: boolean;
  readonly mode: "one-shot" | "continuable" | "unknown" | null;
  readonly parentSessionId: string | null;
  /**
   * 该会话此刻是否有可写 live Session。`false` ⇒ 模型切换必然不可用
   * (子代理休眠),UI 应把选择器置灰并说明原因,而不是让用户点出 500。
   */
  readonly isLive: boolean;
}

interface SubagentAddress {
  readonly mode?: string;
  readonly parentSessionId?: string;
  readonly childSessionId?: string;
}

interface SessionHeaderLike {
  readonly origin?: string;
  readonly parentSession?: string;
}

interface SessionsLike {
  /** client 侧服务才有;host `ctx.get('sessions')` 没有这个方法。 */
  subagentAddress?(sessionId: string): SubagentAddress | undefined;
  /**
   * host `ctx.get('sessions')` 的真实方法:拿 Session 看 durable header,也可
   * 直接 `append('model/selection', ...)`(`AgentModel.select` 的底层实现)。
   */
  get?(sessionId: string): ({
    readonly header?: SessionHeaderLike;
  } & Partial<WritableSessionLike>) | undefined;
  /** 让 durable 事件尽快落盘;best-effort,失败不影响切换结果。 */
  flush?(session: unknown): Promise<boolean>;
}

interface WritableSessionLike {
  append(type: "model/selection", data: ModelSelection): unknown;
}

/** 从 `agent/created` 事件里缓存下来的 live session(带 durable header)。 */
interface LiveSessionLike extends WritableSessionLike {
  readonly id?: string;
  readonly header?: SessionHeaderLike;
}

/**
 * Cordis 事件源的最小镜像。`agent/created`/`agent/disposed` 的载荷是
 * `{ agent }`,`agent.session` 就是 child scope 里那个可写 Session。
 */
interface EventSourceLike {
  on?(
    name: string,
    listener: (payload: { agent?: { id?: string; session?: LiveSessionLike } }) => void,
  ): (() => void) | void;
}

// ── wire envelope(与 panel-routes.ts 逐字一致) ──────────────────────────

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function fail(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

/** body `{args:[...]}` → 位置参数(与 panel-routes.ts 的 argsOf 同语义)。 */
function argsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") return [];
  const rec = body as Record<string, unknown>;
  return Array.isArray(rec.args) ? rec.args : [];
}

// ── 依赖装配(可注入,便于单测) ──────────────────────────────────────────

export interface SubagentModelDeps {
  modelCatalog(): Promise<ModelCatalog>;
  selectModel(request: SelectModelRequest): Promise<SelectModelValue>;
  subagentAddress(sessionId: string): SubagentAddress | undefined;
  /**
   * 该会话此刻是否真的有**可写**的 live Session。
   *
   * 子代理会话只在它的 Agent 运行期间存在于 `agent/created` 缓存里;休眠时
   * 任何人都拿不到可写 Session(宿主对子代理生命周期独占)。UI 据此决定
   * 选择器可用与否,避免让用户点出一个必然失败的 500。
   */
  isSessionLive(sessionId: string): boolean;
  logger?: { warn?(message: string, error?: unknown): void };
}

/**
 * 目标子代理会话当前**没有活的 Session**(agent 未在运行),因此没有可写入的日志。
 *
 * 为什么必须单独一类:宿主对子代理会话的生命周期是独占的 ——
 * `sessionController.resolveAgent(childId)` 直接返回
 * `RemoteError("session/agent-busy", 'session "…" is owned by subagent routing',
 * { reason: "use subagent delivery for this child session" })`,
 * `sessions.get(childId)` 也是 undefined(child scope 隔离)。
 * 唯一能拿到可写 Session 的时机是 `agent/created` 事件里 —— 也就是说
 * **子代理必须正在运行**。用户单纯翻看一个已结束的子代理会话时,任何人都无法
 * 写它的模型选择(DSH 自己的选择器干脆对这类会话 `available:false`)。
 *
 * 这不是「内部错误」,而是**状态不满足**;路由层据此返回 409 而不是 500。
 */
export class SubagentSessionNotLiveError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `子代理会话 ${sessionId} 当前未在运行,模型只能在其运行时切换。` +
        `请在该子代理执行期间操作,或先发一条消息让它启动。`,
    );
    this.name = "SubagentSessionNotLiveError";
    this.sessionId = sessionId;
  }
}

const EMPTY_CATALOG: ModelCatalog = {
  default: { provider: "as-one", model: "" },
  routableProviders: [],
  groups: [],
  failures: [],
};

/**
 * 从 cordis ctx 取真实宿主服务;取不到就降级为「空目录 + 明确报错」。
 *
 * 服务按**每次调用时**解析,不在装配时捕获:as-one 可能与 session-controller
 * 同时挂载,装配那刻 `ctx.get('sessionController')` 还是 undefined,而请求到来时
 * 它已经就绪。惰性解析避开这个插件顺序竞态。
 */
export function subagentModelDepsOf(ctx: Context): SubagentModelDeps {
  const host = ctx as unknown as { get(name: string): unknown };
  const logger = ctx.logger as SubagentModelDeps["logger"];
  /** 复刻宿主的 per-session 串行链,避免并发切换交错写事件。 */
  const selectChains = new Map<string, Promise<unknown>>();
  const serviceOf = <T>(name: string): T | undefined => {
    try {
      return host.get(name) as T | undefined;
    } catch {
      return undefined;
    }
  };
  const controllerOf = () => serviceOf<SessionControllerLike>("sessionController");
  const sessionsOf = () => serviceOf<SessionsLike>("sessions");
  const llmOf = () => serviceOf<LlmLike>("llm");
  const defaultsOf = () => serviceOf<AgentDefaultModelLike>("agentDefaultModel");

  // 子代理 Agent/Session 都注册在 child scope,root 的 `agents`/`sessions` store
  // 按 scope 隔离,实测 `ctx.get('sessions').get(childId)` 返回 undefined。
  // 但 Cordis 事件按 scope 向上冒泡:as-one 这种未打 DSH scope tag 的插件 ctx
  // 注册 `ctx.on('agent/created')` 能收到每个 child 的 publication,载荷里的
  // `agent.session` 就是那个可写 Session(DSH 自带 model-selection-settings.ts
  // 就是这么写 child 的)。这里按 id 缓存,selectModel 优先取缓存。
  const events = ctx as unknown as EventSourceLike;
  const sessionCache = new Map<string, LiveSessionLike>();
  events.on?.("agent/created", ({ agent }) => {
    const session = agent?.session;
    if (session === undefined) return;
    const id = agent?.id ?? session.id;
    if (id !== undefined) sessionCache.set(id, session);
  });
  events.on?.("agent/disposed", ({ agent }) => {
    const id = agent?.id;
    if (id !== undefined) sessionCache.delete(id);
  });

  return {
    isSessionLive: (sessionId) => {
      if (sessionCache.has(sessionId)) return true;
      const live = sessionsOf()?.get?.(sessionId) as { append?: unknown } | undefined;
      return typeof live?.append === "function";
    },
    modelCatalog: async () => {
      const controller = controllerOf();
      if (controller === undefined) {
        throw new Error("宿主未提供 sessionController 服务(模型目录不可用)");
      }
      return controller.modelCatalog();
    },
    selectModel: async (request) => {
      // 优先从 agent/created 缓存取 child Session(child scope 的 live Session
      // 不在 root sessions store);取不到再回退 root sessions.get()(兼容测试/
      // 未来宿主把 child 暴露出来的情况)。
      const sessions = sessionsOf();
      const cached = sessionCache.get(request.sessionId);
      const session: ({ readonly header?: SessionHeaderLike } & Partial<WritableSessionLike>) | undefined =
        cached ?? sessions?.get?.(request.sessionId);
      if (session === undefined || typeof session.append !== "function") {
        throw new SubagentSessionNotLiveError(request.sessionId);
      }
      // 在闭包外收窄成局部常量,供 async 回调内使用。
      const sessionsForFlush = sessions;
      const liveSession = session;
      const appendSelection = session.append;
      const llm = llmOf();
      if (llm === undefined) {
        throw new Error("宿主未提供 llm 服务(模型校验不可用)");
      }
      const previous = selectChains.get(request.sessionId) ?? Promise.resolve();
      const run = previous.then(async (): Promise<SelectModelValue> => {
        const selected: ModelSelection = {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        };
        // 复刻 requireModel → modelAvailable(catalog.ts:81-91)。
        if (!llm.listProviders().some((provider) => provider.id === selected.provider)) {
          throw new Error(`Select an available model before sending a message. (provider=${selected.provider} 不可用)`);
        }
        let models: readonly { readonly id: string }[];
        try {
          models = await llm.listModels(selected.provider);
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error));
        }
        if (!models.some((model) => model.id === selected.model)) {
          throw new Error(`Select an available model before sending a message. (model=${selected.model} 不可用)`);
        }
        await llm.resolveCallConfig(selected);
        // AgentModel.select() 的底层实现本身:append 一条 log-only 的
        // model/selection 事件;modelSelection 投影折叠出 next=selected。
        appendSelection.call(liveSession, "model/selection", selected);
        // best-effort 落盘;失败只 warn,不回滚内存中的选择。
        if (typeof sessionsForFlush?.flush === "function") {
          void sessionsForFlush.flush(liveSession).catch((error: unknown) => {
            logger?.warn?.("[as-one] flush session after model switch failed:", error);
          });
        }
        const defaults = defaultsOf();
        if (defaults !== undefined) {
          void defaults.saveSelection(selected).catch((error: unknown) => {
            logger?.warn?.("[as-one] save default model failed:", error);
          });
        }
        return { selected: { ...selected } };
      });
      selectChains.set(request.sessionId, run.then(() => undefined, () => undefined));
      return run;
    },
    subagentAddress: (sessionId) => {
      const sessions = sessionsOf();
      if (sessions === undefined) return undefined;
      // 优先用 client 侧方法(测试/部分宿主有),但宿主 ctx.get('sessions') 通常没有。
      if (typeof sessions.subagentAddress === "function") {
        return sessions.subagentAddress(sessionId);
      }
      // host 侧:读 Session durable header 判定子代理身份(origin === 'subagent')。
      try {
        const header = sessions.get?.(sessionId)?.header;
        if (header === undefined || header.origin !== "subagent") return undefined;
        return {
          mode: "unknown", // 宿主 header 只有粗分类,continuable 以 client 投影为准
          parentSessionId: header.parentSession,
          childSessionId: sessionId,
        } as SubagentAddress;
      } catch {
        return undefined;
      }
    },
    logger,
  };
}

// ── 路由构造 ────────────────────────────────────────────────────────────

type Handler = (args: unknown[]) => Promise<unknown>;

/**
 * 三个 exact POST 路由,路径与 client `post()` 的 `as-one/api/<method>` 对齐。
 * client 不直接读宿主投影服务,故这里额外提供 `getSubagentSessionInfo` 兜底。
 */
export function buildSubagentModelRoutes(deps: SubagentModelDeps): AsOneWebRoute[] {
  const route = (method: string, handler: Handler): AsOneWebRoute => ({
    kind: "exact",
    path: `/as-one/api/${method}`,
    handler: async (req, res) => {
      if ((req.method ?? "GET").toUpperCase() !== "POST") {
        writeJson(res, 405, fail("method_not_allowed", `expected POST, got ${req.method ?? "?"}`));
        return;
      }
      try {
        const body = await readJsonBody(req);
        const value = await handler(argsOf(body));
        writeJson(res, 200, ok(value));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.logger?.warn?.(`[as-one] ${method} failed:`, err);
        // 「子代理没在运行」是**状态不满足**,不是内部错误:返回 409 +
        // 稳定错误码,UI 能据此把选择器置灰并给出可操作的说明,而不是
        // 让用户对着一个 500 猜(用户 m03723 报的就是这个 500)。
        if (err instanceof SubagentSessionNotLiveError) {
          writeJson(res, 409, fail("subagent_session_not_live", detail));
          return;
        }
        writeJson(res, 500, fail("internal_error", detail));
      }
    },
  });

  return [
    route("getModelCatalog", async () => {
      try {
        return await deps.modelCatalog();
      } catch (err) {
        // 目录拿不到不该让 UI 崩:退化成空目录,failures 里说明原因。
        deps.logger?.warn?.("[as-one] getModelCatalog failed:", err);
        return { ...EMPTY_CATALOG, failures: [{ id: "catalog", name: "模型目录", message: "暂不可用" }] };
      }
    }),
    route("getSubagentSessionInfo", async (args) => {
      const sessionId = String(args[0] ?? "");
      const address = sessionId ? deps.subagentAddress(sessionId) : undefined;
      const mode =
        address === undefined ? null :
        address.mode === "one-shot" || address.mode === "continuable" ? address.mode : "unknown";
      const info: SubagentSessionInfo = {
        sessionId,
        isSubagent: address !== undefined,
        mode,
        parentSessionId: address?.parentSessionId ?? null,
        isLive: sessionId ? deps.isSessionLive(sessionId) : false,
      };
      return info;
    }),
    route("selectModel", async (args) => {
      const [sessionId, provider, model, reasoningEffort] = args as [
        unknown, unknown, unknown, unknown?,
      ];
      const request: SelectModelRequest = {
        sessionId: String(sessionId ?? ""),
        provider: String(provider ?? ""),
        model: String(model ?? ""),
        ...(reasoningEffort === undefined || reasoningEffort === null
          ? {}
          : { reasoningEffort: String(reasoningEffort) }),
      };
      if (!request.sessionId || !request.provider || !request.model) {
        throw new Error("selectModel 需要 sessionId / provider / model");
      }
      return deps.selectModel(request);
    }),
  ];
}
