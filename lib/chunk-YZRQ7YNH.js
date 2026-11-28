// src/bot-history.ts
function toUserId(value) {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
function normalizeHistoryEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const m = raw;
  let text = "";
  if (Array.isArray(m.message)) {
    for (const seg of m.message) {
      if (!seg || typeof seg !== "object") continue;
      const s = seg;
      if (s.type === "text" && s.data && typeof s.data === "object") {
        const d = s.data;
        if (typeof d.text === "string") text += d.text;
      }
    }
  }
  if (text === "" && typeof m.raw_message === "string") text = m.raw_message;
  const sender = m.sender && typeof m.sender === "object" ? m.sender : {};
  const name = typeof sender.card === "string" && sender.card.trim() !== "" ? sender.card : typeof sender.nickname === "string" ? sender.nickname : "";
  return {
    userId: toUserId(sender.user_id),
    name,
    time: typeof m.time === "number" ? m.time : 0,
    text
  };
}
function normalizeHistoryMessages(rawList, opts = {}) {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const out = [];
  if (!Array.isArray(rawList)) return out;
  for (const raw of rawList) {
    const entry = normalizeHistoryEntry(raw);
    if (!entry || entry.text.trim() === "") continue;
    out.push(entry);
  }
  out.sort((a, b) => a.time - b.time);
  return out.slice(-limit);
}
function hhmm(seconds) {
  if (seconds <= 0) return "--:--";
  return new Date(seconds * 1e3).toTimeString().slice(0, 5);
}
function formatHistoryLines(messages, opts = {}) {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const maxChars = opts.maxChars ?? 2e3;
  const title = opts.title ?? "聊天记录";
  const recent = messages.slice(-limit);
  if (recent.length === 0) return `（${title}暂无记录）`;
  const lines = [`[${title} 共 ${messages.length} 条，显示最近 ${recent.length} 条]`];
  for (const m of recent) {
    const who = m.name || m.userId || "未知";
    const mine = opts.selfId !== void 0 && m.userId === opts.selfId ? "（我）" : "";
    const body = m.text.trim();
    const text = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
    lines.push(`${hhmm(m.time)} ${who}${mine}: ${text}`);
  }
  return lines.join("\n");
}

export {
  normalizeHistoryMessages,
  formatHistoryLines
};
//# sourceMappingURL=chunk-YZRQ7YNH.js.map
