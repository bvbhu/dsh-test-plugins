import {
  buildUserMessage,
  resolveSessionRef,
  searchSessions
} from "./chunk-L2TZ6HV7.js";

// src/bot-assistant-tools.ts
var name = "@bvbhu/as-one/bot-assistant-tools";
var inject = ["agents", "tools"];
function renderText(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}
function apply(ctx) {
  const agents = ctx.agents;
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== "function") {
    ctx.logger?.warn?.("[as-one] tools service unavailable, bot-assistant-tools row skipped");
    return;
  }
  if (!agents || typeof agents.get !== "function") {
    ctx.logger?.warn?.("[as-one] agents service unavailable, bot-assistant-tools row skipped");
    return;
  }
  const handles = /* @__PURE__ */ new Map();
  const ensureAgent = async (sessionId) => {
    try {
      const live = agents.get?.(sessionId);
      if (live && typeof live === "object") {
        const agent = live.agent ?? live;
        if (typeof agent?.steer === "function") return agent;
      }
    } catch {
    }
    const cached = handles.get(sessionId);
    if (cached?.agent && typeof cached.agent.steer === "function") return cached.agent;
    if (typeof agents.resume !== "function") return void 0;
    try {
      const handle = await agents.resume({ resumeSessionId: sessionId });
      handles.set(sessionId, handle);
      return handle.agent;
    } catch (err) {
      ctx.logger?.warn?.(`[as-one] assistant-tools resume failed (${sessionId}):`, err);
      return void 0;
    }
  };
  ctx.effect(() => {
    const disposeSearch = tools.register({
      name: "search_sessions",
      description: "按标题或会话 ID 子串搜索宿主上的其他 DSH 会话，返回 id 与标题列表（最多 100 条）。投递消息前用它找到目标会话；空结果请换个更短的关键词。",
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
      description: "向另一个 DSH 会话投递一条用户消息（会话 ID 或标题，支持前缀）。只投递不等待回复；目标会话需已存在且可恢复。投递成功返回确认文本。",
      parameters: {
        session: {
          type: "string",
          required: true,
          description: "目标会话 ID（可写唯一前缀）或标题。"
        },
        text: {
          type: "string",
          required: true,
          description: "要投递的用户消息正文。"
        }
      },
      output: { schema: { type: "string" }, render: renderText },
      async execute(args) {
        const ref = String(args?.session ?? "").trim();
        const text = String(args?.text ?? "").trim();
        if (ref === "" || text === "") return "session 与 text 都不能为空";
        const sessionId = resolveSessionRef(ref, process.env);
        if (sessionId === "") return `解析不到会话「${ref}」（先用 search_sessions 找）`;
        const agent = await ensureAgent(sessionId);
        if (!agent || typeof agent.steer !== "function") {
          return `会话 ${sessionId} 无法唤起（不存在或 resume 失败）`;
        }
        try {
          agent.steer(buildUserMessage(text));
          return `已投递到会话 ${sessionId}`;
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] assistant-tools steer failed (${sessionId}):`, err);
          return `投递失败：${err?.message ?? err}`;
        }
      }
    });
    return () => {
      disposeSearch();
      disposeDeliver();
      handles.clear();
    };
  });
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=bot-assistant-tools.js.map
