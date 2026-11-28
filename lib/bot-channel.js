import {
  normalizeHistoryMessages
} from "./chunk-YZRQ7YNH.js";
import {
  GLOBAL_WAKEUP_SETTING_KEY,
  SEED_DISABLED_WAKEUPS,
  botTierSettingKey,
  botWakeupEnabledSettingKey,
  isWakeupEnabledFor,
  parseBotTier,
  parseEnabledFlag
} from "./chunk-JEIZ5HJM.js";

// src/bot-channel-row.ts
var name = "as-one-bot-channel";
var inject = ["webServer", "asOneCore"];
var ONEBOT_WS_URL = "ws://127.0.0.1:63717/?access_token=27wDFiCfgJuxYCIqmAa3NOEepqewVC-R2oaUD7nbjoM";
var RECONNECT_BASE_MS = 500;
var RECONNECT_MAX_MS = 3e4;
var SOCKET_OPEN = 1;
var SEND_TIMEOUT_MS = 1e4;
var SEED_ASSISTANTS = {
  private: ["3187192488"],
  group: ["873745856", "664364260"]
};
function makeConfigService(core) {
  const setting = core.runtime.db.setting;
  const written = /* @__PURE__ */ new Set();
  const isSeed = (scope, id) => SEED_ASSISTANTS[scope].includes(id);
  const rawTier = (scope, id) => {
    try {
      return setting.get(botTierSettingKey(scope, id))?.v ?? null;
    } catch {
      return null;
    }
  };
  const resolveScope = (id) => rawTier("group", id) !== null || isSeed("group", id) ? "group" : "private";
  return {
    getTier(id, scope) {
      const explicit = rawTier(scope, id);
      if (explicit !== null) return parseBotTier(explicit);
      return isSeed(scope, id) ? "assistant" : "chat";
    },
    listTiers() {
      const assistants = /* @__PURE__ */ new Set();
      const chats = /* @__PURE__ */ new Set();
      for (const scope of ["private", "group"]) {
        for (const id of SEED_ASSISTANTS[scope]) {
          if (rawTier(scope, id) === null && !written.has(botTierSettingKey(scope, id))) {
            assistants.add(id);
          }
        }
      }
      for (const row of setting.entries("bot.tier.")) {
        const match = /^bot\.tier\.(private|group)\.(.+)$/.exec(row.k);
        if (!match) continue;
        const scope = match[1];
        const id = match[2];
        const tier = parseBotTier(row.v);
        if (tier === "assistant") assistants.add(id);
        else chats.add(id);
      }
      return { assistants: [...assistants], chats: [...chats] };
    },
    setTier(id, tier) {
      const scope = resolveScope(id);
      const key = botTierSettingKey(scope, id);
      setting.set(key, tier);
      written.add(key);
    },
    isWakeupGloballyEnabled() {
      try {
        return parseEnabledFlag(setting.get(GLOBAL_WAKEUP_SETTING_KEY)?.v);
      } catch {
        return true;
      }
    },
    setWakeupGloballyEnabled(enabled) {
      setting.set(GLOBAL_WAKEUP_SETTING_KEY, enabled ? "1" : "0");
    },
    isWakeupEnabled(id, scope) {
      try {
        return isWakeupEnabledFor(scope, id, (key) => setting.get(key)?.v ?? null);
      } catch {
        return true;
      }
    },
    setWakeupEnabled(id, scope, enabled) {
      setting.set(botWakeupEnabledSettingKey(scope, id), enabled ? "1" : "0");
    },
    listDisabledWakeups() {
      const out = [];
      for (const scope of ["private", "group"]) {
        for (const id of SEED_DISABLED_WAKEUPS[scope]) {
          if (!this.isWakeupEnabled(id, scope)) out.push({ scope, id });
        }
      }
      for (const row of setting.entries("bot.wakeup.enabled.")) {
        const match = /^bot\.wakeup\.enabled\.(private|group)\.(.+)$/.exec(row.k);
        if (!match) continue;
        const scope = match[1];
        const id = match[2];
        if (!this.isWakeupEnabled(id, scope) && !out.some((e) => e.scope === scope && e.id === id)) {
          out.push({ scope, id });
        }
      }
      return out;
    }
  };
}
var MAX_QUOTED_TEXT = 500;
function parseSegments(segments, selfId) {
  let text = "";
  let atBot = false;
  let replyTo;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg;
    if (s.type === "text" && s.data && typeof s.data === "object") {
      const d = s.data;
      if (typeof d.text === "string") text += d.text;
    } else if (s.type === "at" && s.data && typeof s.data === "object") {
      const d = s.data;
      const qq = typeof d.qq === "string" ? d.qq : typeof d.qq === "number" ? String(d.qq) : void 0;
      if (selfId !== void 0 && qq === selfId) atBot = true;
    } else if (s.type === "reply" && s.data && typeof s.data === "object") {
      const d = s.data;
      const id = typeof d.id === "string" ? d.id : typeof d.id === "number" ? String(d.id) : void 0;
      if (id !== void 0 && replyTo === void 0) replyTo = id;
    }
  }
  return { text, atBot, replyTo };
}
function toBotFrame(frame, selfIdRef) {
  if (!frame || typeof frame !== "object") return null;
  const raw = frame;
  const selfId = typeof raw.self_id === "string" ? raw.self_id : typeof raw.self_id === "number" ? String(raw.self_id) : void 0;
  if (selfId !== void 0) selfIdRef.current = selfId;
  if (raw.post_type !== "message") return null;
  const messageType = raw.message_type === "group" ? "group" : "private";
  const segments = Array.isArray(raw.message) ? raw.message : [];
  if (messageType === "private" && segments.length === 0 && typeof raw.raw_message === "string") {
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
    ...replyTo !== void 0 ? { replyTo } : {}
  };
}
function apply(ctx) {
  const core = ctx.get("asOneCore");
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, bot channel row skipped");
    return;
  }
  ctx.effect(
    async () => {
      const config = makeConfigService(core);
      const emitter = ctx;
      let socket = null;
      let disposed = false;
      let reconnectTimer = null;
      let reconnectBackoff = RECONNECT_BASE_MS;
      let warnedOffline = false;
      let quotedWarned = false;
      const selfIdRef = { current: null };
      const pending = /* @__PURE__ */ new Map();
      let echoSeq = 0;
      const warnOfflineOnce = () => {
        if (warnedOffline) return;
        warnedOffline = true;
        ctx.logger?.warn?.("[as-one] bot channel offline; send dropped");
      };
      const rejectPending = (err) => {
        for (const { reject } of pending.values()) reject(err);
        pending.clear();
      };
      const onOpen = () => {
        reconnectBackoff = RECONNECT_BASE_MS;
        warnedOffline = false;
        ctx.logger?.info?.("[as-one] bot channel connected to SnowLuma OneBot WS");
      };
      const callApi = (action, params) => new Promise((resolve, reject) => {
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
          }
        });
        try {
          socket.send(payload);
        } catch (err) {
          pending.delete(echo);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      const fetchQuoted = async (replyTo) => {
        try {
          const resp = await callApi("get_message", { message_id: replyTo });
          const data = resp && typeof resp === "object" ? resp.data : null;
          if (!data || typeof data !== "object") return null;
          const d = data;
          const segs = Array.isArray(d.message) ? d.message : [];
          const { text } = parseSegments(segs, void 0);
          if (!text.trim()) return null;
          const userId = typeof d.user_id === "string" ? d.user_id : typeof d.user_id === "number" ? String(d.user_id) : "";
          const groupId = typeof d.group_id === "string" ? d.group_id : typeof d.group_id === "number" ? String(d.group_id) : void 0;
          return {
            text: text.length > MAX_QUOTED_TEXT ? `${text.slice(0, MAX_QUOTED_TEXT)}…` : text,
            userId,
            groupId
          };
        } catch (err) {
          if (!quotedWarned) {
            quotedWarned = true;
            ctx.logger?.warn?.(
              `[as-one] bot channel get_message failed (reply ${replyTo}): ${err instanceof Error ? err.message : String(err)}`
            );
          }
          return null;
        }
      };
      const onMessage = (event) => {
        const data = event?.data;
        if (typeof data !== "string") return;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const obj = parsed;
        if (typeof obj.echo === "string" && pending.has(obj.echo)) {
          const p = pending.get(obj.echo);
          pending.delete(obj.echo);
          const ok = obj.status === "ok" && (obj.retcode === 0 || obj.retcode === void 0);
          if (ok) p.resolve(obj);
          else p.reject(new Error(`OneBot action failed: ${JSON.stringify(obj)}`));
          return;
        }
        const postType = obj.post_type;
        if (postType === "message") {
          const botFrame = toBotFrame(parsed, selfIdRef);
          if (!botFrame) return;
          if (botFrame.replyTo !== void 0) {
            void fetchQuoted(botFrame.replyTo).then((q) => {
              if (q) {
                botFrame.quotedText = q.text;
                botFrame.quotedUserId = q.userId;
                if (q.groupId !== void 0) botFrame.quotedGroupId = q.groupId;
              }
              emitter.emit("asOne:bot-message", botFrame);
            });
          } else {
            emitter.emit("asOne:bot-message", botFrame);
          }
        } else if (postType === "notice" || postType === "request") {
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
        warnOfflineOnce();
      };
      const connect = () => {
        if (disposed) return;
        reconnectTimer = null;
        const Ctor = globalThis.WebSocket;
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
      const channel = {
        send(target, text) {
          if (!socket || socket.readyState !== SOCKET_OPEN) {
            warnOfflineOnce();
            return Promise.resolve();
          }
          const action = target.kind === "group" ? "send_group_msg" : "send_private_msg";
          const params = target.kind === "group" ? { group_id: target.id, message: [{ type: "text", data: { text } }] } : { user_id: target.id, message: [{ type: "text", data: { text } }] };
          const echo = `as-one-${++echoSeq}`;
          const payload = JSON.stringify({ action, params, echo });
          return new Promise((resolve, reject) => {
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
              }
            });
            try {
              socket.send(payload);
            } catch (err) {
              pending.delete(echo);
              clearTimeout(timer);
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        },
        status() {
          return { connected: !!socket && socket.readyState === SOCKET_OPEN, qq: selfIdRef.current };
        },
        /**
         * 读取目标聊天最近消息（OneBot get_group_msg_history / get_friend_msg_history，只读）。
         * 连接不可用时 reject（callApi 语义；调用方降级为提示文案）。
         */
        async recentHistory(target, limit = 20) {
          const action = target.kind === "group" ? "get_group_msg_history" : "get_friend_msg_history";
          const params = target.kind === "group" ? { group_id: target.id, message_seq: 0, count: limit } : { user_id: target.id, message_seq: 0, count: limit };
          const resp = await callApi(action, params);
          const data = resp && typeof resp === "object" ? resp.data : null;
          const list = data && typeof data === "object" && Array.isArray(data.messages) ? data.messages : [];
          return normalizeHistoryMessages(list, { limit });
        }
      };
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
          ["error", onError]
        ]) {
          socket?.removeEventListener(type, listener);
        }
        socket?.close();
        socket = null;
        rejectPending(new Error("OneBot connection closed"));
      };
    },
    "as-one-bot-channel"
  );
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=bot-channel.js.map
