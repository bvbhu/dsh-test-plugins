import {
  formatHistoryLines,
  normalizeHistoryMessages
} from "./chunk-YZRQ7YNH.js";
import {
  bindingFor,
  bindingForSession,
  buildUserMessage,
  loadBindings,
  onUserMessage,
  resolveSessionRef,
  searchSessions,
  setReplyChannel,
  targetOfRoute,
  tryDeliver
} from "./chunk-B4JZMZHX.js";

// src/bot-session-tools.ts
var name = "@bvbhu/as-one/bot-session-tools";
var inject = ["tools", "asOneBotChannel", "agents", "sessionQuery"];
var OWNER_ROUTE = "private:3187192488";
var SEND_MAX_CHARS = 8e3;
var READ_CLIP_CHARS = 800;
function renderText(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}
function sessionIdOf(exec) {
  const agent = exec?.agent;
  const id = agent?.session?.header?.id;
  return typeof id === "string" ? id : "";
}
function rawAgentOf(entry) {
  if (!entry || typeof entry !== "object") return void 0;
  const handle = entry;
  return handle.agent ?? entry;
}
function isOwnerSession(sessionId) {
  if (sessionId === "") return false;
  const binding = bindingFor(loadBindings().bindings, OWNER_ROUTE);
  if (!binding) return false;
  return resolveSessionRef(binding.session) === sessionId;
}
function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…（已截断，共 ${text.length} 字）`;
}
function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((part) => typeof part === "object" && part !== null).filter((part) => part.type === "text").map((part) => typeof part.text === "string" ? part.text : "").join("");
}
function extractMessagesOfEvents(events) {
  const out = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const type = ev.type;
    if (type === "user/message") {
      const body = textOfContent(ev.data?.content);
      if (body.trim() !== "") out.push({ role: "user", text: body });
    } else if (type === "assistant/message") {
      const body = textOfContent(ev.data?.message?.content);
      if (body.trim() !== "") out.push({ role: "assistant", text: body });
    }
  }
  return out;
}
function apply(ctx) {
  const tools = ctx.tools;
  const channel = ctx.get("asOneBotChannel");
  const agents = ctx.agents;
  const sessionQuery = ctx.get("sessionQuery");
  if (!tools || typeof tools.register !== "function") {
    ctx.logger?.warn?.("[as-one] tools service unavailable, bot-session-tools row skipped");
    return;
  }
  if (!channel || typeof channel.send !== "function") {
    ctx.logger?.warn?.("[as-one] bot channel service unavailable, bot-session-tools row skipped");
    return;
  }
  setReplyChannel(
    { send: (route, text) => channel.send(route, text) },
    {
      warn: (...args) => {
        const log = ctx.logger?.warn;
        if (!log) return;
        log(args[0], ...args.slice(1));
      }
    }
  );
  ctx.effect(() => {
    const offEvent = ctx.on("session/event", (session, event) => {
      const ev = event;
      if (ev?.type !== "user/message") return;
      const ref = session;
      const sessionId = typeof ref?.header?.id === "string" ? ref.header.id : typeof ref?.id === "string" ? ref.id : "";
      if (sessionId === "") return;
      onUserMessage(sessionId, ev?.data?.message?.source?.rpcId);
    });
    const handles = /* @__PURE__ */ new Map();
    const ensureAgent = async (sessionId) => {
      try {
        const live = agents?.get?.(sessionId);
        if (live) return rawAgentOf(live);
      } catch {
      }
      const cached = handles.get(sessionId);
      if (cached) return rawAgentOf(cached);
      if (typeof agents?.resume !== "function") return void 0;
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId });
        handles.set(sessionId, handle);
        return rawAgentOf(handle);
      } catch (err) {
        ctx.logger?.warn?.(`[as-one] bot-session-tools resume failed (${sessionId}):`, err);
        return void 0;
      }
    };
    const disposeSearch = tools.register({
      name: "search_sessions",
      description: "按标题或会话 ID 子串搜索宿主上的其他 DSH 会话，返回 id 与标题列表（最多 100 条）。空结果请换个更短的关键词。",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "会话标题或 ID 的子串（大小写不敏感）。"
        },
        limit: {
          type: "number",
          description: "最多返回条数，1–100，缺省 20。"
        }
      },
      output: { schema: { type: "string" }, render: renderText },
      async execute(args) {
        const query = String(args?.query ?? "").trim();
        if (query === "") return "query 不能为空";
        const rawLimit = Number(args?.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.round(rawLimit) : 20;
        const hits = searchSessions(query, process.env, limit);
        if (hits.length === 0) return `没有匹配「${query}」的会话`;
        const lines = hits.map((hit) => `- ${hit.id}：${hit.title || "（无标题）"}`);
        return `${hits.length} 个匹配：
${lines.join("\n")}`;
      }
    });
    const disposeDeliver = tools.register({
      name: "deliver_message",
      description: "把本会话的回复直接发回绑定的 QQ 路由（私聊/群聊专用；未绑定会话会被拒绝）。发给 QQ 的消息要简洁：简要说明即可，不必面面俱到——用户可以直接远程查看 DSH 会话全文，所以不要把完整过程、全文或冗长日志搬进 QQ，只保留关键结论、要点与下一步，细节留在会话里。回复必须通过本工具发送（私聊和群聊都一样）：每条新到用户消息只能成功发送一次，单次上限 3000 字；发送成功即结束回合，不要重复调用。",
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "要发回 QQ 的回复正文（≤3000 字）。"
        }
      },
      output: { schema: { type: "string" }, render: renderText },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec);
        if (sessionId === "") return "无法确定当前会话（工具未在会话内调用）";
        const text = String(args?.text ?? "").trim();
        if (text === "") return "text 不能为空";
        const result = await tryDeliver(sessionId, text);
        if (!result.ok) return result.error ?? "发送失败";
        return `已发送到 QQ（${sessionId}）`;
      }
    });
    const disposeSend = tools.register({
      name: "send_to_session",
      description: "向任意 DSH 会话投递一条用户消息（仅绑定 private:3187192488 的会话可用）。session 支持会话 ID、唯一前缀或标题（可用 search_sessions 先查）。投递后对方会话自行处理并回复，回复留在对方会话里，不会发回 QQ。",
      parameters: {
        session: {
          type: "string",
          required: true,
          description: "目标 DSH 会话的 ID、唯一前缀或标题。"
        },
        text: {
          type: "string",
          required: true,
          description: `要投递给对方的消息正文（≤${SEND_MAX_CHARS} 字）。`
        }
      },
      output: { schema: { type: "string" }, render: renderText },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec);
        if (sessionId === "") return "无法确定当前会话（工具未在会话内调用）";
        if (!isOwnerSession(sessionId)) {
          return `本工具仅绑定 ${OWNER_ROUTE} 的会话可用，当前会话不是该路由绑定的会话`;
        }
        const ref = String(args?.session ?? "").trim();
        if (ref === "") return "session 不能为空";
        const targetId = resolveSessionRef(ref);
        if (targetId === "") return `解析不到会话「${ref}」：请用 search_sessions 核对 ID 或标题`;
        const body = String(args?.text ?? "").trim();
        if (body === "") return "text 不能为空";
        if (body.length > SEND_MAX_CHARS) {
          return `消息超过 ${SEND_MAX_CHARS} 字上限（${body.length} 字），请精简后重发`;
        }
        const agent = await ensureAgent(targetId);
        if (!agent) return `会话 ${targetId} 的 agent 未就绪（不在内存且 resume 失败），投递失败`;
        try {
          if (typeof agent.steer === "function") agent.steer(buildUserMessage(body));
          else if (typeof agent.followup === "function") agent.followup(buildUserMessage(body));
          else return `会话 ${targetId} 的 agent 没有 steer/followup 能力，投递失败`;
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] bot-session-tools steer failed (${targetId}):`, err);
          return `向会话 ${targetId} 投递失败：${err.message ?? String(err)}`;
        }
        return `已向会话 ${targetId} 投递消息（${body.length} 字），回复会留在该会话里`;
      }
    });
    const disposeRead = tools.register({
      name: "read_session",
      description: "读取任意 DSH 会话最近的消息内容（仅绑定 private:3187192488 的会话可用）。session 支持会话 ID、唯一前缀或标题（可用 search_sessions 先查）；返回用户与助手的文本消息（助手只取正文，不含推理与工具调用）。",
      parameters: {
        session: {
          type: "string",
          required: true,
          description: "目标 DSH 会话的 ID、唯一前缀或标题。"
        },
        limit: {
          type: "number",
          description: "返回最近多少条消息，1–100，缺省 20。"
        }
      },
      output: { schema: { type: "string" }, render: renderText },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec);
        if (sessionId === "") return "无法确定当前会话（工具未在会话内调用）";
        if (!isOwnerSession(sessionId)) {
          return `本工具仅绑定 ${OWNER_ROUTE} 的会话可用，当前会话不是该路由绑定的会话`;
        }
        const ref = String(args?.session ?? "").trim();
        if (ref === "") return "session 不能为空";
        const targetId = resolveSessionRef(ref);
        if (targetId === "") return `解析不到会话「${ref}」：请用 search_sessions 核对 ID 或标题`;
        const rawLimit = Number(args?.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.round(rawLimit)) : 20;
        if (!sessionQuery || typeof sessionQuery.readSession !== "function") {
          return "宿主未提供 sessionQuery 服务，无法读取会话日志";
        }
        let snapshot;
        try {
          snapshot = await sessionQuery.readSession(targetId);
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] bot-session-tools readSession failed (${targetId}):`, err);
          return `读取会话 ${targetId} 的日志失败：${err.message ?? String(err)}`;
        }
        const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
        const messages = extractMessagesOfEvents(events);
        if (messages.length === 0) return `会话 ${targetId} 的日志里没有用户/助手的文本消息`;
        const recent = messages.slice(-limit);
        const lines = recent.map(
          (message) => `[${message.role === "user" ? "用户" : "助手"}] ${clip(message.text, READ_CLIP_CHARS)}`
        );
        return `${recent.length} 条消息（该会话共 ${messages.length} 条）：
${lines.join("\n")}`;
      }
    });
    const disposeQqHistory = tools.register({
      name: "qq_recent_history",
      description: "读取本会话绑定的 QQ 聊天（群/私聊）最近的消息，用于回顾之前聊过什么。唤醒后的会话只能看到触发的那一条消息，需要上下文（之前谁说了什么）时用本工具。返回按时间升序的最近消息列表，含发送者与文本。",
      parameters: {
        limit: {
          type: "number",
          description: "最近多少条，1–100，缺省 20。"
        }
      },
      output: { schema: { type: "string" }, render: renderText },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec);
        if (sessionId === "") return "无法确定当前会话（工具未在会话内调用）";
        const binding = bindingForSession(sessionId);
        if (!binding) return "当前会话未绑定 QQ 路由（检查 ~/.as-one/bot-bindings.json），无法读取聊天记录";
        const target = targetOfRoute(binding.route);
        if (!target) return `绑定路由 ${binding.route} 无法解析为 QQ 目标，无法读取聊天记录`;
        if (typeof channel?.recentHistory !== "function") {
          return "当前 QQ 通道不支持读取聊天记录（bot-channel 行需重启 DSH 后生效）";
        }
        const rawLimit = Number(args?.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.round(rawLimit)) : 20;
        let messages;
        try {
          messages = await channel.recentHistory(target, limit);
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] bot-session-tools recentHistory failed (${sessionId}):`, err);
          return `读取聊天记录失败：${err.message ?? String(err)}`;
        }
        return formatHistoryLines(normalizeHistoryMessages(messages, { limit }), {
          selfId: channel.status?.().qq ?? void 0,
          title: target.kind === "group" ? "群聊" : "私聊"
        });
      }
    });
    return () => {
      offEvent();
      disposeSearch();
      disposeDeliver();
      disposeSend();
      disposeRead();
      disposeQqHistory();
      for (const handle of handles.values()) {
        try {
          handle.agent?.cancel?.({ kind: "user" });
        } catch {
        }
        try {
          void Promise.resolve(handle.dispose?.()).catch(() => {
          });
        } catch {
        }
      }
      handles.clear();
    };
  });
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=bot-session-tools.js.map
