import {
  handoffOnce
} from "./chunk-W5TM3CZ3.js";
import "./chunk-BJ7B4R26.js";

// src/bot-notify-row.ts
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
var OWNER_QQ = "3187192488";
var REPLY_WINDOW_MS = 10 * 6e4;
function sessionIdOf(value) {
  const v = value;
  const fromHeader = v?.header?.id;
  if (typeof fromHeader === "string" && fromHeader !== "") return fromHeader;
  const direct = v?.id;
  return typeof direct === "string" ? direct : "";
}
function clip(text, max = 80) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}
function sessionCwdOf(session) {
  const v = session;
  const direct = v?.header?.cwd;
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  const meta = v?.header?.meta?.cwd;
  return typeof meta === "string" ? meta : "";
}
function projectionVal(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.val === "string") {
    return value.val;
  }
  return "";
}
function sessionTitleOf(ctx, session, sessionId) {
  try {
    const projections = ctx.sessionProjections;
    const snap = projections?.snapshot?.(session, ["title"]);
    const raw2 = projectionVal(snap?.values?.title);
    if (raw2.trim() !== "") return clip(raw2, 80);
  } catch {
  }
  try {
    const bare = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
    for (const candidate of [sessionId, bare === sessionId ? `session-${sessionId}` : bare]) {
      const file = join(homeDir(), ".dsh", "storages", "session_projcache", "sessions", `${candidate}.json`);
      const row = JSON.parse(readFileSync(file, "utf8"))?.record?.rows?.title;
      const raw2 = projectionVal(row);
      if (raw2.trim() !== "") return clip(raw2, 80);
    }
  } catch {
  }
  const v = session;
  const raw = v?.header?.title ?? v?.title ?? v?.meta?.title;
  return typeof raw === "string" ? clip(raw, 80) : "";
}
function formatCompletionLabel(workspaceTitle, sessionTitle, sessionId) {
  const ws = String(workspaceTitle ?? "").trim() || "未关联工作区";
  const title = String(sessionTitle ?? "").trim() || (String(sessionId ?? "").trim().slice(0, 12) || "未命名会话");
  return `${ws}：${title}`;
}
function rawAgentOf(agents, sessionId) {
  const entry = agents?.get(sessionId);
  if (!entry || typeof entry !== "object") return void 0;
  const agent = entry.agent;
  return agent ?? entry;
}
function queuedInputCountOf(agent) {
  const inbox = agent?.inbox;
  if (!inbox || typeof inbox !== "object") return void 0;
  const count = (list) => Array.isArray(list) ? list.length : 0;
  return count(inbox.nextTurn) + count(inbox.nextStep);
}
function assistantTextOf(event) {
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => typeof part === "object" && part !== null).filter((part) => part.type === "text").map((part) => typeof part.text === "string" ? part.text : "").join("");
}
var name = "@bvbhu/as-one/bot-notify";
var inject = ["asOneBotChannel", "asOneBotConfig", "asOneCore", "agents", "webServer"];
function apply(ctx) {
  const bot = ctx.get(
    "asOneBotChannel"
  );
  if (!bot || typeof bot.send !== "function") {
    ctx.logger?.warn?.("[as-one] bot channel service unavailable, bot-notify row skipped");
    return;
  }
  const config = ctx.get(
    "asOneBotConfig"
  );
  const agents = ctx.agents;
  const recentTurnText = /* @__PURE__ */ new Map();
  const sessionLabels = /* @__PURE__ */ new Map();
  let pendingNotice = null;
  const workspaceCache = { at: 0, bySession: /* @__PURE__ */ new Map(), byPath: /* @__PURE__ */ new Map() };
  function readWorkspaceIndex() {
    const now = Date.now();
    if (workspaceCache.at !== 0 && now - workspaceCache.at < 5e3) return workspaceCache;
    const bySession = /* @__PURE__ */ new Map();
    const byPath = /* @__PURE__ */ new Map();
    try {
      const data = JSON.parse(readFileSync(join(homeDir(), ".dsh", "storages", "workspace.json"), "utf8"));
      const raw = data?.tables?.workspaces;
      const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});
      for (const ws of list) {
        if (!ws || typeof ws !== "object") continue;
        const info = {
          title: String(ws.title ?? ""),
          path: String(ws.path ?? "")
        };
        if (info.path) byPath.set(info.path.toLowerCase(), info);
        const ids = ws.sessionIds;
        if (Array.isArray(ids)) for (const id of ids) bySession.set(String(id), info);
      }
    } catch {
    }
    workspaceCache.at = now;
    workspaceCache.bySession = bySession;
    workspaceCache.byPath = byPath;
    return workspaceCache;
  }
  function workspaceOf(session, sessionId) {
    const index = readWorkspaceIndex();
    const hit = index.bySession.get(sessionId);
    if (hit) return hit;
    const cwd = sessionCwdOf(session);
    if (cwd) return index.byPath.get(cwd.toLowerCase()) ?? { title: basename(cwd), path: cwd };
    return { title: "", path: "" };
  }
  function rememberLabel(session, sessionId) {
    if (sessionId === "") return;
    sessionLabels.set(
      sessionId,
      formatCompletionLabel(workspaceOf(session, sessionId).title, sessionTitleOf(ctx, session, sessionId), sessionId)
    );
  }
  function labelOf(sessionId) {
    return sessionLabels.get(sessionId) ?? (sessionId.slice(0, 12) || "未命名会话");
  }
  const chimePending = [];
  const pushChime = (sound) => {
    chimePending.push({ sound, at: Date.now() });
    if (chimePending.length > 30) chimePending.splice(0, chimePending.length - 30);
  };
  const sendOwner = (text, chime) => {
    if (config?.isWakeupEnabled && !config.isWakeupEnabled(OWNER_QQ, "private")) return;
    if (chime !== void 0) pushChime(chime);
    void Promise.resolve(bot.send({ kind: "private", id: OWNER_QQ }, text)).catch((err) => {
      ctx.logger?.warn?.("[as-one] bot-notify send failed:", err);
    });
  };
  const summaryOf = (sessionId) => {
    const text = String(recentTurnText.get(sessionId) ?? "").trim();
    return text || `会话 ${labelOf(sessionId)} 还没有可总结的助手回复`;
  };
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: "/as-one/chime/poll",
      handler: (_req, res) => {
        try {
          const now = Date.now();
          const fresh = chimePending.filter((p) => now - p.at <= 15e3);
          chimePending.length = 0;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sounds: fresh.map((p) => p.sound) }));
        } catch (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sounds: [], error: String(err) }));
        }
      }
    });
    return dispose;
  }, "@bvbhu/as-one/bot-notify: chime poll route");
  const deliverToSession = (sessionId, text) => {
    const agent = rawAgentOf(agents, sessionId);
    if (!agent || typeof agent !== "object") {
      sendOwner(`会话 ${labelOf(sessionId)} 现在没打开，投不进去：先在 DSH 里打开它，再回复通知。`);
      return;
    }
    const outgoing = { content: [{ type: "text", text }], source: { kind: "user" } };
    try {
      handoffOnce(agent, outgoing);
    } catch (err) {
      ctx.logger?.warn?.(`[as-one] bot-notify deliver failed (${sessionId}):`, err);
      sendOwner(`投递到会话 ${labelOf(sessionId)} 失败：${String(err)}`);
    }
  };
  ctx.effect(
    () => {
      const offSession = ctx.on("session/event", (session, event) => {
        const ev = event;
        const sessionId = sessionIdOf(session);
        if (sessionId === "" || ev?.type === void 0) return;
        if (ev.type === "assistant/message") {
          const text = assistantTextOf(ev);
          if (text.trim() !== "") recentTurnText.set(sessionId, text);
          rememberLabel(session, sessionId);
          return;
        }
        if (ev.type === "turn/end") {
          if (sessionId.startsWith("qq-")) return;
          const reason = ev.data?.reason;
          const okEnd = !reason || !reason.kind || reason.kind === "completed";
          if (!okEnd) return;
          const queued = queuedInputCountOf(rawAgentOf(agents, sessionId));
          if (queued === void 0 || queued > 0) return;
          pendingNotice = { sessionId, until: Date.now() + REPLY_WINDOW_MS };
          rememberLabel(session, sessionId);
          sendOwner(`✅ 会话完成：${labelOf(sessionId)}`, "done");
          return;
        }
        if (ev.type === "tool/call") {
          const data = ev.data;
          if (data?.name !== "ask_user_question") return;
          rememberLabel(session, sessionId);
          sendOwner(`🔔 会话在等你回答：${labelOf(sessionId)}（去 DSH 界面回答）`, "question");
          return;
        }
        if (ev.type === "approval/asked") {
          const data = ev.data;
          const tool = String(data?.toolName ?? "").trim() || "某工具";
          rememberLabel(session, sessionId);
          sendOwner(`🔐 ${labelOf(sessionId)} 请求授权：${tool}`, "question");
          return;
        }
      });
      const offFrame = ctx.on("asOne:bot-message", (frame) => {
        const f = frame;
        if (f?.targetId !== OWNER_QQ) return;
        const notice = pendingNotice;
        if (!notice || Date.now() >= notice.until) return;
        const text = String(f.text ?? "").trim();
        pendingNotice = null;
        if (text.length <= 1) {
          sendOwner(summaryOf(notice.sessionId));
          return;
        }
        deliverToSession(notice.sessionId, text);
      });
      return () => {
        offFrame();
        offSession();
      };
    },
    "@bvbhu/as-one/bot-notify: session observers"
  );
}
export {
  apply,
  formatCompletionLabel,
  inject,
  name
};
//# sourceMappingURL=bot-notify.js.map
