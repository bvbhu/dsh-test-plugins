/**
 * DSH 宿主侧服务形状的**结构镜像**(零 Node 类型 —— 可被 client 半引用)。
 *
 * 事实来源:.asar-out\dsh\node_modules\@deepseek-ai\dsh-host-webserver\lib\index.js
 * (真实宿主 WebServer 实现)与 dsh-usage-statistics-panel/src/context-types.ts。
 *
 * 已核实的 WebServer 契约:
 * - `register(route)`:route = { kind: 'exact'|'prefix', path, handler };
 *   重复 (kind, path) 直接 throw;返回 disposer(删表条目)。
 * - 匹配顺序:exact 表命中 → prefix 表最长前缀胜(pathname===prefix 或
 *   startsWith(`${prefix}/`))→ fallback(桌面包默认被 SPA dist 占据,勿用)。
 * - handler 抛错被宿主 catch → logger.warn + 若 headersSent 则 res.destroy(),
 *   否则 writeHead(400)+end —— **错误必须在自己 handler 里写 status/body**。
 * - gzip 中间件对 text/event-stream 不缓冲(compression filter 显式放行 SSE)。
 */

/** 请求侧(结构镜像 node IncomingMessage 的子集;body 走 async iterator)。 */
import type { Context } from "cordis";

export interface AsOneHttpRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
}

/** 响应侧(结构镜像 node ServerResponse 的子集)。 */
export interface AsOneHttpResponse {
  statusCode: number;
  writeHead(status: number, headers?: Record<string, string>): void;
  write?(chunk: string | Uint8Array): boolean;
  end(body?: string | Uint8Array): void;
}

/** 宿主 webServer 接受的路由对象(与宿主 register 的参数同形)。 */
export interface AsOneWebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (request: AsOneHttpRequest, response: AsOneHttpResponse) => void | Promise<void>;
}

/** 宿主 webServer 服务(ctx.webServer)。 */
export interface AsOneWebServer {
  register(route: AsOneWebRoute): () => void;
}

/**
 * 宿主 `llm` 服务(ctx.llm)—— 结构镜像,见 `llm-types.ts` 的 `DshLlmService`。
 * 这里重复声明一遍是为了让 `declare module "cordis"` 只依赖本地类型。
 */
export interface AsOneLlmService {
  registerAdapter(
    providers: string[],
    adapter: import("./llm-types.js").DshLlmAdapter,
  ): (() => void) & { replace(nextProviders: string[]): void };
}

/** 挂到 cordis Context 上:webServer + llm + DSH 生命周期 effect。 */
declare module "cordis" {
  interface Context {
    /**
     * DSH 生命周期 API:回调立即执行,返回的 disposer 在 ctx 销毁时调用。
     *
     * disposer 允许异步(与 cordis fiber.ts 的 Effect 类型一致):
     * 核心行的 setup 是 `await setupAsOne(...)`,卸载前必须先等它 settle。
     */
    effect(
      dispose: () => void | (() => void) | Promise<void | (() => void)>,
      label?: string,
    ): void;
    /** 注册本 fiber 提供的服务(disposer 在本 fiber 卸载时调用)。 */
    provide(name: string, value: unknown): void;
    webServer: AsOneWebServer;
    llm: AsOneLlmService;
    /** settings 行 provide 的 bot.mhy.* live 配置（Volatile 引用；见 settings-service.ts）。 */
    asOneMhySettings: import("./settings-service.js").AsOneMhySettingsService;
    /**
     * 六个渠道子组件行各自 provide 的 live 渠道开关（用户 m11109 定案：
     * Trae / WorkBuddy / SenseNova / MiniMax / Qoder / CodeArts 每渠道一个
     * 子组件，DSH 设置页一个 `enabled` 开关，免重启生效）。
     * 行缺席（未装载/被禁用）时取用方按「渠道启用」缺省处理。
     */
    asOneChannelTrae: import("./channel-service.js").AsOneChannelService;
    asOneChannelWorkbuddy: import("./channel-service.js").AsOneChannelService;
    asOneChannelSensenova: import("./channel-service.js").AsOneChannelService;
    asOneChannelMinimax: import("./channel-service.js").AsOneChannelService;
    asOneChannelQoder: import("./channel-service.js").AsOneChannelService;
    asOneChannelCodearts: import("./channel-service.js").AsOneChannelService;
  }

  /**
   * bot 组的三个自定义事件（emit/on 的 keyof Events 约束）。
   * - asOne:bot-message：bot-channel 行每收到一条 OneBot 消息帧就 emit（入站契约见
   *   bot-channel-service.ts 的 AsOneBotFrame）；bot-chat/bot-assistant/bot-notify 订阅。
   * - session/event：宿主会话事件，bot 行观察 assistant/message、turn/end 等。
   * - as-one:bot:mhy-signin：bot-mhy 行签到跑完 emit（{ok, summary}），bot-notify 消费。
   */
  interface Events {
    "asOne:bot-message": (frame: unknown) => void;
    "session/event": (session: unknown, event: unknown) => void;
    "as-one:bot:mhy-signin": (payload: { ok: boolean; summary: string }) => void;
  }
}

export type { Context };
