import {
  bindingFor,
  chatKeyOf,
  createRelay,
  loadBindings,
  resolveSessionRef
} from "./chunk-7AWCMHBX.js";
import "./chunk-BJ7B4R26.js";

// src/bot-assistant-row.ts
var name = "@bvbhu/as-one/bot-assistant";
var inject = ["asOneBotChannel", "asOneBotConfig", "agents"];
var MODE = "assistant";
function quotedPrefix(f) {
  if (!f.quotedText) return "";
  const scope = f.quotedGroupId ?? (f.messageType === "group" ? f.targetId : void 0);
  const where = scope !== void 0 ? `[引用 群 ${scope}]` : "[引用]";
  return `${where} ${f.quotedUserId || "未知"}：${f.quotedText}
`;
}
function incomingText(f) {
  const quoted = quotedPrefix(f);
  if (f.messageType !== "group") return quoted + f.text.trim();
  const sender = f.raw;
  const name2 = String(sender?.sender?.card ?? sender?.sender?.nickname ?? "").trim() || f.userId;
  return `${quoted}[群 ${f.targetId} @] ${name2}：${f.text.trim()}`;
}
function apply(ctx) {
  const channel = ctx.get("asOneBotChannel");
  if (!channel || typeof channel.send !== "function") {
    ctx.logger?.warn?.("[as-one] bot channel service unavailable, bot-assistant row skipped");
    return;
  }
  const config = ctx.get("asOneBotConfig");
  ctx.effect(() => {
    const agents = ctx.agents;
    const relay = createRelay({ agents, channel, logger: ctx.logger });
    const logged = /* @__PURE__ */ new Map();
    const logOnce = (key, message) => {
      const last = logged.get(key) ?? 0;
      if (Date.now() - last < 6e5) return;
      logged.set(key, Date.now());
      ctx.logger?.info?.(message);
    };
    const sessionOf = (binding) => {
      const resolved = resolveSessionRef(binding.session);
      if (resolved === "") {
        logOnce(
          `unresolved:${binding.route}`,
          `[as-one] bot-assistant: binding ${binding.route} 的 session「${binding.session}」解析不到（检查 ~/.as-one/bot-bindings.json）`
        );
      }
      return resolved;
    };
    const offInbound = ctx.on("asOne:bot-message", (frame) => {
      const f = frame;
      if (!f || f.messageType !== "private" && f.messageType !== "group") return;
      if (typeof f.text !== "string" || f.text.trim() === "") return;
      const route = chatKeyOf(f.messageType, f.targetId);
      const { bindings } = loadBindings();
      const binding = bindingFor(bindings, route);
      if (!binding) {
        logOnce(`unbound:${route}`, `[as-one] bot-assistant: route ${route} 未绑定（~/.as-one/bot-bindings.json），消息丢弃`);
        return;
      }
      if (binding.mode !== MODE) return;
      if (config?.isWakeupEnabled && !config.isWakeupEnabled(f.targetId, f.messageType)) return;
      if (f.messageType === "group" && !f.atBot) return;
      const sessionId = sessionOf(binding);
      if (sessionId === "") return;
      const target = { kind: f.messageType, id: f.targetId };
      void relay.deliver(sessionId, target, incomingText(f)).catch((err) => {
        ctx.logger?.warn?.(`[as-one] bot-assistant deliver failed (${sessionId}):`, err);
      });
    });
    const offEvent = ctx.on("session/event", (session, event) => {
      const ev = event;
      if (!ev?.type) return;
      const ref = session;
      const sessionId = typeof ref?.header?.id === "string" ? ref.header.id : typeof ref?.id === "string" ? ref.id : "";
      if (sessionId === "") return;
      relay.onSessionEvent(sessionId, ev);
    });
    ctx.logger?.info?.("[as-one] bot-assistant row mounted (bindings from ~/.as-one/bot-bindings.json)");
    return () => {
      offInbound();
      offEvent();
      relay.dispose();
    };
  }, "@bvbhu/as-one/bot-assistant: bound assistant sessions");
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=bot-assistant.js.map
