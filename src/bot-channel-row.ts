/**
 * bot-channel 行 —— SnowLuma（OneBot v11 正向 WS）连接持有 + 分级路由。
 *
 * 事实来源：docs/bot-integration-design.md（确认版，2026-11-26）行 6；
 * lead 契约修正（m00121/m00185）：字符串 ID BotTarget、status() 返回
 * {connected, qq}、provide 两个服务、入站帧形状固定。
 *
 * 不变量：
 * - **只连不 spawn、绝不 kill SL**；SL 由独立入口常驻。
 * - 行间零互 import（arch.test R1）：只 import type 共享类型模块
 *   ./bot-channel-service.js 与 ./core-service.js，不 import 任何其他行。
 * - 单向发送，不做状态机、不做故障降级；连不上就 warn 一次后 resolve。
 * - WS 断线指数退避自动重连，重连不 throw 出 effect。
 * - 分级名单走 setting 表键 bot.tier.private.<qq> / bot.tier.group.<gid>
 *   （值 'chat'|'assistant'），不新建数据库表。
 */

import type { Context } from "./context-types.js";
import type { AsOneCoreService } from "./core-service.js";
import { normalizeHistoryMessages } from "./bot-history.js";
import type {
  AsOneBotChannelService,
  AsOneBotConfigService,
  AsOneBotFrame,
  AsOneHistoryMessage,
  BotScope,
  BotTarget,
  BotTier,
} from "./bot-channel-service.js";
import {
  botTierSettingKey,
  parseBotTier,
  GLOBAL_WAKEUP_SETTING_KEY,
  botWakeupEnabledSettingKey,
  parseEnabledFlag,
  isWakeupEnabledFor,
  SEED_DISABLED_WAKEUPS,
} from "./bot-channel-service.js";

export const name = "as-one-bot-channel";
export const inject = ["webServer", "asOneCore"];

/** SnowLuma OneBot v11 正向 WS（SL 独立入口常驻，本行只连）。 */
const ONEBOT_WS_URL = "ws://127.0.0.1:63717/?access_token=27wDFiCfgJuxYCIqmAa3NOEepqewVC-R2oaUD7nbjoM";
/** 重连退避：首delay 500ms，指数增长，上限 30s。 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** 自实现最小 WS 类型：@types/node 无 WebSocket 全局、node_modules 无 ws 包。 */
type MinimalSocket = {
  readyState: number;
  close(): void;
  send(data: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
};
type SocketCtor = new (url: string) => MinimalSocket;
type MessageEventLike = { data?: unknown };
const SOCKET_OPEN = 1;
/** 发 API 调用超时（ms）。 */
const SEND_TIMEOUT_MS = 10_000;

/** 分级名单种子：主人私聊 3187192488、群 873745856 / 664364260 → assistant；名单外 → chat。 */
const SEED_ASSISTANTS: Record<BotScope, string[]> = {
  private: ["3187192488"],
  group: ["873745856", "664364260"],
};

function makeConfigService(core: AsOneCoreService): AsOneBotConfigService {
  const setting = core.runtime.db.setting;
  const written = new Set<string>();

  const isSeed = (scope: BotScope, id: string) => SEED_ASSISTANTS[scope].includes(id);

  const rawTier = (scope: BotScope, id: string): string | null => {
    try {
      return setting.get(botTierSettingKey(scope, id))?.v ?? null;
    } catch {
      return null;
    }
  };

  const resolveScope = (id: string): BotScope =>
    rawTier("group", id) !== null || isSeed("group", id) ? "group" : "private";

  return {
    getTier(id: string, scope: BotScope): BotTier {
      const explicit = rawTier(scope, id);
      if (explicit !== null) return parseBotTier(explicit);
      // 种子名单只在没有显式 setting 时生效；setTier 写入后以 setting 为准。
      return isSeed(scope, id) ? "assistant" : "chat";
    },
    listTiers() {
      const assistants = new Set<string>();
      const chats = new Set<string>();
      for (const scope of ["private", "group"] as const) {
        for (const id of SEED_ASSISTANTS[scope]) {
          if (rawTier(scope, id) === null && !written.has(botTierSettingKey(scope, id))) {
            assistants.add(id);
          }
        }
      }
      // 显式配置（含用户新增）来自 setting 表，无需建表。
      for (const row of setting.entries("bot.tier.")) {
        const match = /^bot\.tier\.(private|group)\.(.+)$/.exec(row.k);
        if (!match) continue;
        const scope = match[1] as BotScope;
        const id = match[2];
        const tier = parseBotTier(row.v);
        if (tier === "assistant") assistants.add(id);
        else chats.add(id);
      }
      return { assistants: [...assistants], chats: [...chats] };
    },
    setTier(id: string, tier: BotTier): void {
      const scope = resolveScope(id);
      const key = botTierSettingKey(scope, id);
      setting.set(key, tier);
      written.add(key);
    },
    isWakeupGloballyEnabled(): boolean {
      try {
        return parseEnabledFlag(setting.get(GLOBAL_WAKEUP_SETTING_KEY)?.v);
      } catch {
        return true;
      }
    },
    setWakeupGloballyEnabled(enabled: boolean): void {
      setting.set(GLOBAL_WAKEUP_SETTING_KEY, enabled ? "1" : "0");
    },
    isWakeupEnabled(id: string, scope: BotScope): boolean {
      try {
        return isWakeupEnabledFor(scope, id, (key) => setting.get(key)?.v ?? null);
      } catch {
        return true;
      }
    },
    setWakeupEnabled(id: string, scope: BotScope, enabled: boolean): void {
      setting.set(botWakeupEnabledSettingKey(scope, id), enabled ? "1" : "0");
    },
    listDisabledWakeups(): Array<{ scope: BotScope; id: string }> {
      const out: Array<{ scope: BotScope; id: string }> = [];
      for (const scope of ["private", "group"] as const) {
        for (const id of SEED_DISABLED_WAKEUPS[scope]) {
          if (!this.isWakeupEnabled(id, scope)) out.push({ scope, id });
        }
      }
      for (const row of setting.entries("bot.wakeup.enabled.")) {
        const match = /^bot\.wakeup\.enabled\.(private|group)\.(.+)$/.exec(row.k);
        if (!match) continue;
        const scope = match[1] as BotScope;
        const id = match[2];
        if (!this.isWakeupEnabled(id, scope) && !out.some((e) => e.scope === scope && e.id === id)) {
          out.push({ scope, id });
        }
      }
      return out;
    },
  };
}

/** 被引用文本截断上限（防止超长引用撑爆上下文）。 */
const MAX_QUOTED_TEXT = 500;

/** 从 OneBot 原始消息段提取纯文本 + 是否 @ 机器人（self_id）+ 引用消息 id。 */
function parseSegments(segments: unknown[], selfId: string | undefined): { text: string; atBot: boolean; replyTo?: string } {
  let text = "";
  let atBot = false;
  let replyTo: string | undefined;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as { type?: unknown; data?: unknown };
    if (s.type === "text" && s.data && typeof s.data === "object") {
      const d = s.data as { text?: unknown };
      if (typeof d.text === "string") text += d.text;
    } else if (s.type === "at" && s.data && typeof s.data === "object") {
      const d = s.data as { qq?: unknown };
      const qq = typeof d.qq === "string" ? d.qq : typeof d.qq === "number" ? String(d.qq) : undefined;
      if (selfId !== undefined && qq === selfId) atBot = true;
    } else if (s.type === "reply" && s.data && typeof s.data === "object") {
      // OneBot reply 段：data.id = 被引用消息 id（QQ「回复」功能）。
      const d = s.data as { id?: unknown };
      const id = typeof d.id === "string" ? d.id : typeof d.id === "number" ? String(d.id) : undefined;
      if (id !== undefined && replyTo === undefined) replyTo = id;
    }
  }
  return { text, atBot, replyTo };
}

/** 把 OneBot message/post_type 帧映射为下游统一帧；非消息帧返回 null。 */
function toBotFrame(frame: unknown, selfIdRef: { current: string | null }): AsOneBotFrame | null {
  if (!frame || typeof frame !== "object") return null;
  const raw = frame as Record<string, unknown>;
  const selfId = typeof raw.self_id === "string" ? raw.self_id : typeof raw.self_id === "number" ? String(raw.self_id) : undefined;
  if (selfId !== undefined) selfIdRef.current = selfId;
  if (raw.post_type !== "message") return null;

  const messageType = raw.message_type === "group" ? "group" : "private";
  const segments = Array.isArray(raw.message) ? (raw.message as unknown[]) : [];
  if (messageType === "private" && segments.length === 0 && typeof raw.raw_message === "string") {
    // 少数实现把 CQ 字符串放在 raw_message 且 message 为空，兜底成 text 段。
    segments.push({ type: "text", data: { text: raw.raw_message } });
  }
  const { text, atBot, replyTo } = parseSegments(segments, selfId);
  const userId = typeof raw.user_id === "string" ? raw.user_id : typeof raw.user_id === "number" ? String(raw.user_id) : "";
  const groupId = typeof raw.group_id === "string" ? raw.group_id : typeof raw.group_id === "number" ? String(raw.group_id) : "";
  return {
    messageType,
    targetId: messageType === "group" ? groupId : userId,
    userId,
    text,
    segments,
    atBot: messageType === "group" ? atBot : false,
    raw: frame,
    ...(replyTo !== undefined ? { replyTo } : {}),
  };
}

export function apply(ctx: Context): void {
  const core = (ctx as unknown as { get(name: string): unknown }).get("asOneCore") as
    | AsOneCoreService
    | undefined;
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, bot channel row skipped");
    return;
  }

  ctx.effect(
    async () => {
      const config = makeConfigService(core);
      const emitter = ctx as unknown as { emit(event: string, payload: unknown): void };

      let socket: MinimalSocket | null = null;
      let disposed = false;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let reconnectBackoff = RECONNECT_BASE_MS;
      let warnedOffline = false;
      /** get_message 失败只 warn 一次（避免每条引用消息刷屏）。 */
      let quotedWarned = false;
      const selfIdRef: { current: string | null } = { current: null };
      const pending = new Map<string, { resolve(value?: unknown): void; reject(err: Error): void }>();
      let echoSeq = 0;

      const warnOfflineOnce = () => {
        if (warnedOffline) return;
        warnedOffline = true;
        ctx.logger?.warn?.("[as-one] bot channel offline; send dropped");
      };

      const rejectPending = (err: Error) => {
        for (const { reject } of pending.values()) reject(err);
        pending.clear();
      };

      const onOpen = () => {
        reconnectBackoff = RECONNECT_BASE_MS; // 连上后重置退避
        warnedOffline = false;
        ctx.logger?.info?.("[as-one] bot channel connected to SnowLuma OneBot WS");
      };

      /**
       * OneBot API 调用（走与 send 相同的 echo/pending 通道；send 忽略返回值）。
       * 连接不可用时 warn 一次后 reject。
       */
      const callApi = (action: string, params: Record<string, unknown>): Promise<unknown> =>
        new Promise((resolve, reject) => {
          if (!socket || socket.readyState !== SOCKET_OPEN) {
            warnOfflineOnce();
            reject(new Error("OneBot connection closed"));
            return;
          }
          const echo = `as-one-api-${++echoSeq}`;
          const payload = JSON.stringify({ action, params, echo });
          const timer = setTimeout(() => {
            pending.delete(echo);
            reject(new Error(`OneBot action ${action} timed out`));
          }, SEND_TIMEOUT_MS);
          pending.set(echo, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (err) => {
              clearTimeout(timer);
              reject(err);
            },
          });
          try {
            socket!.send(payload);
          } catch (err) {
            pending.delete(echo);
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });

      /** 拉取被引用消息的文本（OneBot get_message）；失败返回 null（只 warn 一次）。 */
      const fetchQuoted = async (
        replyTo: string,
      ): Promise<{ text: string; userId: string; groupId?: string } | null> => {
        try {
          const resp = (await callApi("get_message", { message_id: replyTo })) as
            | { data?: { message?: unknown[]; user_id?: unknown; group_id?: unknown } }
            | null
            | undefined;
          const data = resp && typeof resp === "object" ? (resp as { data?: unknown }).data : null;
          if (!data || typeof data !== "object") return null;
          const d = data as { message?: unknown[]; user_id?: unknown; group_id?: unknown };
          const segs = Array.isArray(d.message) ? d.message : [];
          const { text } = parseSegments(segs, undefined);
          if (!text.trim()) return null;
          const userId =
            typeof d.user_id === "string" ? d.user_id : typeof d.user_id === "number" ? String(d.user_id) : "";
          const groupId =
            typeof d.group_id === "string" ? d.group_id : typeof d.group_id === "number" ? String(d.group_id) : undefined;
          return {
            text: text.length > MAX_QUOTED_TEXT ? `${text.slice(0, MAX_QUOTED_TEXT)}…` : text,
            userId,
            groupId,
          };
        } catch (err) {
          if (!quotedWarned) {
            quotedWarned = true;
            ctx.logger?.warn?.(
              `[as-one] bot channel get_message failed (reply ${replyTo}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return null;
        }
      };

      const onMessage = (event: unknown) => {
        const data = (event as MessageEventLike)?.data;
        if (typeof data !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // 非 JSON 帧忽略
        }
        if (!parsed || typeof parsed !== "object") return;
        const obj = parsed as Record<string, unknown>;
        // API 响应帧（带 echo）：只结算 send/callApi 的 pending，不再 emit。
        if (typeof obj.echo === "string" && pending.has(obj.echo)) {
          const p = pending.get(obj.echo)!;
          pending.delete(obj.echo);
          const ok = obj.status === "ok" && (obj.retcode === 0 || obj.retcode === undefined);
          if (ok) p.resolve(obj);
          else p.reject(new Error(`OneBot action failed: ${JSON.stringify(obj)}`));
          return;
        }
        const postType = obj.post_type;
        if (postType === "message") {
          const botFrame = toBotFrame(parsed, selfIdRef);
          if (!botFrame) return;
          // 引用回复：先经 OneBot get_message 拉被引用文本，拉到后随帧带给下游，
          // 让绑定会话知道用户在回复哪条消息（拉不到也照常 emit，只是没有引用上下文）。
          if (botFrame.replyTo !== undefined) {
            void fetchQuoted(botFrame.replyTo).then((q) => {
              if (q) {
                botFrame.quotedText = q.text;
                botFrame.quotedUserId = q.userId;
                if (q.groupId !== undefined) botFrame.quotedGroupId = q.groupId;
              }
              emitter.emit("asOne:bot-message", botFrame);
            });
          } else {
            emitter.emit("asOne:bot-message", botFrame);
          }
        } else if (postType === "notice" || postType === "request") {
          // notice/request 不 emit，只记日志（lead 契约修正 4）。
          ctx.logger?.info?.(`[as-one] bot channel ${postType} frame ignored`);
        }
      };

      const onClose = () => {
        socket = null;
        rejectPending(new Error("OneBot connection closed"));
        if (disposed) return;
        warnOfflineOnce();
        const delay = reconnectBackoff;
        reconnectBackoff = Math.min(reconnectBackoff * 2, RECONNECT_MAX_MS);
        reconnectTimer = setTimeout(connect, delay);
      };

      const onError = () => {
        // 错误事件不 throw 出 effect；关闭时由 onClose 统一重连。
        warnOfflineOnce();
      };

      const connect = () => {
        if (disposed) return;
        reconnectTimer = null;
        const Ctor = (globalThis as unknown as { WebSocket?: SocketCtor }).WebSocket;
        if (!Ctor) {
          ctx.logger?.warn?.("[as-one] WebSocket unavailable, bot channel inert");
          return;
        }
        const ws = new Ctor(ONEBOT_WS_URL);
        socket = ws;
        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", onMessage);
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
      };

      const channel: AsOneBotChannelService = {
        send(target: BotTarget, text: string): Promise<void> {
          if (!socket || socket.readyState !== SOCKET_OPEN) {
            warnOfflineOnce();
            return Promise.resolve(); // 连不上：warn 一次后 resolve，不 throw
          }
          const action = target.kind === "group" ? "send_group_msg" : "send_private_msg";
          const params =
            target.kind === "group"
              ? { group_id: target.id, message: [{ type: "text", data: { text } }] }
              : { user_id: target.id, message: [{ type: "text", data: { text } }] };
          const echo = `as-one-${++echoSeq}`;
          const payload = JSON.stringify({ action, params, echo });
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(echo);
              reject(new Error(`OneBot action ${action} timed out`));
            }, SEND_TIMEOUT_MS);
            pending.set(echo, {
              resolve: () => {
                clearTimeout(timer);
                resolve();
              },
              reject: (err) => {
                clearTimeout(timer);
                reject(err);
              },
            });
            try {
              socket!.send(payload);
            } catch (err) {
              pending.delete(echo);
              clearTimeout(timer);
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        },
        status(): { connected: boolean; qq: string | null } {
          return { connected: !!socket && socket.readyState === SOCKET_OPEN, qq: selfIdRef.current };
        },
        /**
         * 读取目标聊天最近消息（OneBot get_group_msg_history / get_friend_msg_history，只读）。
         * 连接不可用时 reject（callApi 语义；调用方降级为提示文案）。
         */
        async recentHistory(target: BotTarget, limit = 20): Promise<AsOneHistoryMessage[]> {
          const action = target.kind === "group" ? "get_group_msg_history" : "get_friend_msg_history";
          const params =
            target.kind === "group"
              ? { group_id: target.id, message_seq: 0, count: limit }
              : { user_id: target.id, message_seq: 0, count: limit };
          const resp = (await callApi(action, params)) as
            | { data?: { messages?: unknown[] } }
            | null
            | undefined;
          const data = resp && typeof resp === "object" ? (resp as { data?: unknown }).data : null;
          const list =
            data && typeof data === "object" && Array.isArray((data as { messages?: unknown }).messages)
              ? (data as { messages: unknown[] }).messages
              : [];
          return normalizeHistoryMessages(list, { limit });
        },
      };

      // setup 完成（WS 监听已装）：provide 两个服务（lead 契约修正 3）。
      ctx.provide("asOneBotChannel", channel);
      ctx.provide("asOneBotConfig", config);
      connect();

      return () => {
        disposed = true;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        for (const [type, listener] of [
          ["open", onOpen],
          ["message", onMessage],
          ["close", onClose],
          ["error", onError],
        ] as const) {
          socket?.removeEventListener(type, listener);
        }
        socket?.close(); // 只断自己的 WS，绝不 kill SnowLuma
        socket = null;
        rejectPending(new Error("OneBot connection closed"));
      };
    },
    "as-one-bot-channel",
  );
}
