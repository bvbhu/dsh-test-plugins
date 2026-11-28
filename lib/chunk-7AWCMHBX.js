// src/bot-bindings.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var DEFAULT_WAKE_WORDS = ["爱莉", "爱莉希雅", "昔涟", "elysia", "cyrene"];
var DEFAULT_SCHEDULE_PROMPT = "（定时唤醒）现在主动说一句话，像平常一样自然。";
var AS_ONE_HOME_ENV = "AS_ONE_HOME";
var BINDINGS_ENV = "AS_ONE_BOT_BINDINGS";
function asOneHome(env = process.env) {
  const override = String(env[AS_ONE_HOME_ENV] ?? "").trim();
  return override !== "" ? override : join(homedir(), ".as-one");
}
function bindingsFilePath(env = process.env) {
  const override = String(env[BINDINGS_ENV] ?? "").trim();
  if (override !== "") return override;
  return join(asOneHome(env), "bot-bindings.json");
}
var BINDINGS_TEMPLATE = {
  _说明: [
    "as-one 的 QQ 路由 → DSH 会话绑定表（与 as-one.db / logs 同在 ~/.as-one）。",
    "改完保存即生效（按文件修改时间热读，无需重启）。",
    "route: private:<QQ号> 或 group:<群号>；未列出的聊天不会唤醒任何会话（消息直接丢弃）。",
    "session: DSH 会话 ID（可写前 8 位以上的唯一前缀）或会话标题。",
    "mode: chat（聊天档：私聊视为 @ 全部唤醒；群聊需 @ 或命中唤醒词）| assistant（助理档：私聊唤醒、群聊仅 @）。",
    'wakeWords / schedule 可选；schedule 支持 "30m" 或 { "every": "30m", "prompt": "..." }。'
  ],
  _示例: {
    route: "private:3187192488",
    session: "session-xxxxxxxx（会话 ID 前缀或标题）",
    mode: "chat",
    wakeWords: ["爱莉", "爱莉希雅"],
    schedule: { every: "30m", prompt: "主动说一句话" }
  },
  bindings: []
};
function parseInterval(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(s|秒|m|分|h|时|d|天)?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2] ?? "s";
  const factor = unit === "m" || unit === "分" ? 60 : unit === "h" || unit === "时" ? 3600 : unit === "d" || unit === "天" ? 86400 : 1;
  return Math.max(30, Math.round(value * factor));
}
function parseWakeWords(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,，、\s]+/) : [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of list) {
    const word = String(item ?? "").trim();
    if (word === "") continue;
    const lower = word.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(word);
  }
  return out;
}
function matchWakeWord(text, words) {
  const haystack = String(text ?? "").toLowerCase();
  if (haystack.trim() === "") return "";
  let best = "";
  for (const word of words) {
    const needle = word.trim().toLowerCase();
    if (needle === "" || !haystack.includes(needle)) continue;
    if (needle.length > best.length) best = word;
  }
  return best;
}
function chatKeyOf(messageType, targetId) {
  return `${messageType}:${targetId}`;
}
function targetOfRoute(route) {
  const match = /^(private|group):(.+)$/.exec(route);
  if (!match) return null;
  return { kind: match[1], id: match[2] };
}
function normalizeBinding(raw, index) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { binding: null, error: `bindings[${index}] 不是对象` };
  }
  const entry = raw;
  const route = String(entry.route ?? "").trim();
  const session = String(entry.session ?? "").trim();
  if (!/^(private|group):.+$/.test(route)) {
    return { binding: null, error: `bindings[${index}] route 必须是 private:<QQ号> 或 group:<群号>` };
  }
  if (session === "") {
    return { binding: null, error: `bindings[${index}] 缺少 session` };
  }
  const mode = entry.mode === "assistant" ? "assistant" : "chat";
  const wakeWords = parseWakeWords(entry.wakeWords);
  let schedule = null;
  const rawSchedule = entry.schedule;
  if (typeof rawSchedule === "string" && rawSchedule.trim() !== "") {
    const every = parseInterval(rawSchedule);
    if (every !== null) schedule = { everySeconds: every, prompt: DEFAULT_SCHEDULE_PROMPT };
  } else if (rawSchedule && typeof rawSchedule === "object" && !Array.isArray(rawSchedule)) {
    const obj = rawSchedule;
    const every = parseInterval(String(obj.every ?? ""));
    if (every !== null) {
      const prompt = typeof obj.prompt === "string" && obj.prompt.trim() !== "" ? obj.prompt.trim() : DEFAULT_SCHEDULE_PROMPT;
      schedule = { everySeconds: every, prompt };
    }
  }
  return { binding: { route, session, mode, wakeWords, schedule }, error: "" };
}
function parseBindings(raw) {
  const errors = [];
  const bindings = [];
  if (raw === null || typeof raw !== "object") return { bindings, errors: ["绑定表不是对象"] };
  const list = raw.bindings;
  if (!Array.isArray(list)) return { bindings, errors: ["缺少 bindings 数组"] };
  list.forEach((item, index) => {
    const result = normalizeBinding(item, index);
    if (result.binding) bindings.push(result.binding);
    else errors.push(result.error);
  });
  return { bindings, errors };
}
var loadCache = /* @__PURE__ */ new Map();
function loadBindings(env = process.env) {
  const file = bindingsFilePath(env);
  let stat = null;
  try {
    stat = statSync(file);
  } catch {
    stat = null;
  }
  if (stat === null) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(BINDINGS_TEMPLATE, null, 2)}
`, "utf8");
      stat = statSync(file);
    } catch {
      return { file, bindings: [], errors: [`无法创建绑定表 ${file}`] };
    }
  }
  const cached = loadCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;
  let result;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const { bindings, errors } = parseBindings(parsed);
    result = { file, bindings, errors };
  } catch (err) {
    result = { file, bindings: [], errors: [`解析失败：${err.message}`] };
  }
  loadCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}
function bindingFor(bindings, route) {
  return bindings.find((binding) => binding.route === route);
}
var resolveCache = { home: "", at: 0, ids: [], titles: /* @__PURE__ */ new Map() };
function refreshSessionIndex(env) {
  const now = Date.now();
  const home = String(env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh");
  if (resolveCache.home === home && now - resolveCache.at < 3e4) return;
  resolveCache.home = home;
  resolveCache.at = now;
  const ids = /* @__PURE__ */ new Set();
  const titles = /* @__PURE__ */ new Map();
  try {
    const sessionsDir = join(home, "sessions");
    for (const slug of readdirSync(sessionsDir)) {
      const dir = join(sessionsDir, slug);
      let entries = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.startsWith("session-")) ids.add(name);
      }
    }
  } catch {
  }
  try {
    const projDir = join(home, "storages", "session_projcache", "sessions");
    for (const name of readdirSync(projDir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      ids.add(id);
      try {
        const record = JSON.parse(readFileSync(join(projDir, name), "utf8"));
        const raw = record?.record?.rows?.title;
        const title = typeof raw === "string" ? raw : typeof raw?.val === "string" ? raw.val : "";
        if (title.trim() !== "") titles.set(id, title.trim());
      } catch {
      }
    }
  } catch {
  }
  resolveCache.ids = [...ids];
  resolveCache.titles = titles;
}
function searchSessions(query, env = process.env, limit = 20) {
  const want = String(query ?? "").trim().toLowerCase();
  if (want === "") return [];
  refreshSessionIndex(env);
  const entries = new Map(resolveCache.titles);
  for (const id of resolveCache.ids) if (!entries.has(id)) entries.set(id, "");
  const out = [];
  for (const [id, title] of entries) {
    const lowerTitle = title.toLowerCase();
    const lowerId = id.toLowerCase();
    let rank = 0;
    if (lowerTitle === want || lowerId === want) rank = 0;
    else if (lowerTitle.startsWith(want) || lowerId.startsWith(want)) rank = 1;
    else if (lowerTitle.includes(want) || lowerId.includes(want)) rank = 2;
    else continue;
    out.push({ id, title, rank });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out.slice(0, Math.max(1, Math.min(100, limit))).map(({ id, title }) => ({ id, title }));
}
function resolveSessionRef(ref, env = process.env) {
  const want = String(ref ?? "").trim().replace(/^[`'"]+|[`'"]+$/g, "");
  if (want === "") return "";
  refreshSessionIndex(env);
  const lower = want.toLowerCase();
  const ids = resolveCache.ids;
  if (ids.includes(want)) return want;
  const prefixHits = ids.filter((id) => id.toLowerCase().startsWith(lower));
  if (prefixHits.length === 1) return prefixHits[0];
  const titleExact = [...resolveCache.titles.entries()].filter(([, title]) => title.toLowerCase() === lower);
  if (titleExact.length === 1) return titleExact[0][0];
  const titlePart = [...resolveCache.titles.entries()].filter(([, title]) => title.toLowerCase().includes(lower));
  if (titlePart.length === 1) return titlePart[0][0];
  return "";
}

// src/bot-reply.ts
var TOOL_RPC_PREFIX = "as-one-tool:";
var MAX_REPLY_CHARS = 3e3;
var delivered = /* @__PURE__ */ new Map();
var channel;
var logger;
function setReplyChannel(next, log) {
  channel = next;
  logger = log ?? logger;
}
function bindingForSession(sessionId) {
  const { bindings } = loadBindings();
  for (const binding of bindings) {
    if (binding.session === sessionId) return binding;
  }
  for (const binding of bindings) {
    if (resolveSessionRef(binding.session) === sessionId) return binding;
  }
  return void 0;
}
function onUserMessage(sessionId, rpcId) {
  if (typeof rpcId === "string" && rpcId.startsWith(TOOL_RPC_PREFIX)) return;
  delivered.set(sessionId, false);
}
function wasDelivered(sessionId) {
  return delivered.get(sessionId) === true;
}
async function tryDeliver(sessionId, text) {
  if (sessionId === "") return { ok: false, error: "无法确定当前会话" };
  const body = String(text ?? "").trim();
  if (body === "") return { ok: false, error: "发送内容不能为空" };
  const binding = bindingForSession(sessionId);
  const target = binding ? targetOfRoute(binding.route) : null;
  if (!target) {
    return { ok: false, error: "当前会话未绑定 QQ 路由（检查 ~/.as-one/bot-bindings.json），无法发送" };
  }
  if (delivered.get(sessionId) === true) {
    return { ok: false, error: "本回合已发送过一次消息；只有新的用户消息才会刷新次数，请直接结束回合" };
  }
  if (body.length > MAX_REPLY_CHARS) {
    return {
      ok: false,
      error: `回复超过 ${MAX_REPLY_CHARS} 字上限（${body.length} 字）：请精简后重发，或拆成多条短句只发最关键的一条`
    };
  }
  if (!channel) {
    return { ok: false, error: "QQ 通道未就绪（插件行未挂载），发送失败" };
  }
  try {
    await channel.send({ kind: target.kind, id: target.id }, body);
  } catch (err) {
    logger?.warn?.(`[as-one] bot-reply send failed (${sessionId}):`, err);
    return { ok: false, error: `发送失败：${err.message ?? String(err)}` };
  }
  delivered.set(sessionId, true);
  return { ok: true };
}

// src/bot-relay.ts
import { randomUUID } from "node:crypto";
function buildUserMessage(text, rpcId) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: rpcId === void 0 ? { kind: "user" } : { kind: "user", rpcId }
  };
}
function assistantTextOf(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => typeof part === "object" && part !== null).filter((part) => part.type === "text").map((part) => typeof part.text === "string" ? part.text : "").join("");
}
var CLAIM_PREFIX = "as-one-bot:";
var QUOTE_GUIDE = "（说明：消息开头以「[引用 …]」标注的若干行是用户引用的原消息，其后才是用户真正想说的话。请先针对被引用的内容回应，再谈自己的观点；不要复述引用全文。）";
var NUDGE_TEXT = "（系统提示）你刚才的回复没有通过 deliver_message 工具发送，QQ 用户没有收到。请立即调用 deliver_message 工具，把给用户的回复发出去（简洁：结论与要点即可，细节留在会话里）；如果没有新内容可发，就发一句简短的确认。";
var PENDING_TTL_MS = 10 * 6e4;
var MAX_PENDING = 8;
var MAX_CLAIMS = 200;
var CLAIM_TTL_MS = 15 * 6e4;
function rawAgentOf(entry) {
  if (!entry || typeof entry !== "object") return void 0;
  const handle = entry;
  return handle.agent ?? entry;
}
function isCleanEnd(reason) {
  const kind = reason?.kind;
  return kind === void 0 || kind === null || kind === "completed";
}
function createRelay(options) {
  const { agents, channel: channel2, logger: logger2 } = options;
  const handles = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const claims = /* @__PURE__ */ new Map();
  const claimed = /* @__PURE__ */ new Set();
  const nudged = /* @__PURE__ */ new Set();
  const lastText = /* @__PURE__ */ new Map();
  const routes = /* @__PURE__ */ new Map();
  const pushPending = (sessionId, at) => {
    const list = pending.get(sessionId) ?? [];
    list.push(at);
    while (list.length > MAX_PENDING) list.shift();
    pending.set(sessionId, list);
  };
  const claimMessage = (sessionId, route) => {
    claimed.add(sessionId);
    routes.set(sessionId, route);
    nudged.delete(sessionId);
  };
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
      logger2?.warn?.(`[as-one] bot relay resume failed (${sessionId}):`, err);
      return void 0;
    }
  };
  const pruneClaims = () => {
    const now = Date.now();
    for (const [id, claim] of claims) {
      if (now - claim.at > CLAIM_TTL_MS) claims.delete(id);
    }
    if (claims.size > MAX_CLAIMS) {
      const extra = claims.size - MAX_CLAIMS;
      let index = 0;
      for (const id of claims.keys()) {
        if (index >= extra) break;
        claims.delete(id);
        index += 1;
      }
    }
  };
  return {
    /** 投递一条 QQ 消息到已绑定会话；返回是否成功唤起。 */
    async deliver(sessionId, route, text) {
      const body = String(text ?? "").trim();
      if (sessionId === "" || body === "") return false;
      const payload = body.startsWith("[引用") ? `${body}
${QUOTE_GUIDE}` : body;
      routes.set(sessionId, route);
      const agent = await ensureAgent(sessionId);
      if (!agent) {
        logger2?.warn?.(`[as-one] bot relay: session not found (${sessionId})`);
        return false;
      }
      const claimId = `${CLAIM_PREFIX}${randomUUID()}`;
      claims.set(claimId, { sessionId, route, at: Date.now() });
      pruneClaims();
      const message = buildUserMessage(payload, claimId);
      pushPending(sessionId, Date.now());
      try {
        if (typeof agent.steer === "function") agent.steer(message);
        else if (typeof agent.followup === "function") agent.followup(message);
        else {
          logger2?.warn?.(`[as-one] bot relay: agent has no steer/followup (${sessionId})`);
          return false;
        }
        return true;
      } catch (err) {
        logger2?.warn?.(`[as-one] bot relay steer failed (${sessionId}):`, err);
        return false;
      }
    },
    /** 订阅 session/event 后按会话喂进来。 */
    onSessionEvent(sessionId, event) {
      const type = event?.type;
      if (type === "user/message" || type === "agent/inbox/spliced") {
        const list = type === "user/message" ? [event.data] : event.data?.inserted ?? [];
        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const rpcId = item.source?.rpcId;
          if (typeof rpcId !== "string" || !rpcId.startsWith(CLAIM_PREFIX)) continue;
          const claim = claims.get(rpcId);
          if (!claim) continue;
          claims.delete(rpcId);
          claimMessage(sessionId, claim.route);
        }
        return;
      }
      if (type === "turn/start") {
        if (claimed.has(sessionId)) return;
        const list = pending.get(sessionId);
        while (list !== void 0 && list.length > 0 && Date.now() - (list[0] ?? 0) > PENDING_TTL_MS) list.shift();
        const at = list?.shift();
        if (at !== void 0 && Date.now() - at <= PENDING_TTL_MS && routes.has(sessionId)) {
          claimMessage(sessionId, routes.get(sessionId));
        }
        return;
      }
      if (type === "assistant/message") {
        if (!claimed.has(sessionId)) return;
        const text = assistantTextOf(event);
        if (text.trim() !== "") lastText.set(sessionId, text);
        return;
      }
      if (type === "turn/end") {
        if (!claimed.has(sessionId)) return;
        claimed.delete(sessionId);
        const text = lastText.get(sessionId);
        lastText.delete(sessionId);
        const route = routes.get(sessionId);
        if (text === void 0 || text.trim() === "" || route === void 0) return;
        if (!isCleanEnd(event.data?.reason)) return;
        if (wasDelivered(sessionId)) return;
        const mode = bindingFor(loadBindings().bindings, `${route.kind}:${route.id}`)?.mode;
        if (mode === "chat") return;
        void Promise.resolve(channel2.send(route, text)).catch((err) => {
          logger2?.warn?.(`[as-one] bot relay reply failed (${sessionId}):`, err);
        });
        if (!nudged.has(sessionId)) {
          nudged.add(sessionId);
          void ensureAgent(sessionId).then((agent) => {
            if (!agent?.steer) return;
            try {
              agent.steer(buildUserMessage(NUDGE_TEXT));
            } catch (err) {
              logger2?.warn?.(`[as-one] bot relay nudge failed (${sessionId}):`, err);
            }
          });
        }
      }
    },
    /** 行卸载：取消并释放本中继 resume 出来的句柄。 */
    dispose() {
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
      pending.clear();
      claims.clear();
      claimed.clear();
      nudged.clear();
      lastText.clear();
      routes.clear();
    }
  };
}

export {
  DEFAULT_WAKE_WORDS,
  matchWakeWord,
  chatKeyOf,
  targetOfRoute,
  loadBindings,
  bindingFor,
  searchSessions,
  resolveSessionRef,
  setReplyChannel,
  bindingForSession,
  onUserMessage,
  tryDeliver,
  buildUserMessage,
  createRelay
};
//# sourceMappingURL=chunk-7AWCMHBX.js.map
