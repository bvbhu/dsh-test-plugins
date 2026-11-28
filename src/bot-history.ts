/**
 * QQ 聊天记录规范化与渲染（纯函数，行间共享模块）。
 *
 * 移植自旧桥 dsh-qq-onebot-bridge/lib/history.js（已归档 D:\projects\归档\bot\），
 * 供 bot-channel 行（OneBot get_*_msg_history 响应规范化）与
 * bot-session-tools 行（qq_recent_history 工具渲染）共用。
 * bot-channel-row 与 bot-session-tools 都 import 本模块 —— 共享服务模块，
 * 不违反 arch.test R1（只禁行 ↔ 行互 import）。
 */
import type { AsOneHistoryMessage } from "./bot-channel-service.js";

/** 渲染选项。 */
export interface HistoryFormatOptions {
  /** 最多显示多少条（1–100，默认 20）。 */
  limit?: number;
  /** 单条文本截断上限（默认 2000）。 */
  maxChars?: number;
  /** 当前机器人 QQ：命中时名字后加「（我）」标记。 */
  selfId?: string;
  /** 头部标题（默认「聊天记录」）。 */
  title?: string;
}

/** OneBot 历史消息条目的裸形状（结构窄投影）。 */
interface RawHistoryEntry {
  message?: unknown;
  raw_message?: unknown;
  time?: unknown;
  sender?: { user_id?: unknown; card?: unknown; nickname?: unknown };
}

/** 字符串化 QQ id（兼容 number / string 两种实现口径）。 */
function toUserId(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/**
 * OneBot 历史消息条目 → 规范化记录；坏项返回 null（调用方跳过，不抛错）。
 * 文本来源：message 段数组拼接 text 段；空数组时兜底 raw_message（CQ 字符串）。
 */
export function normalizeHistoryEntry(raw: unknown): AsOneHistoryMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as RawHistoryEntry;
  let text = "";
  if (Array.isArray(m.message)) {
    for (const seg of m.message) {
      if (!seg || typeof seg !== "object") continue;
      const s = seg as { type?: unknown; data?: unknown };
      if (s.type === "text" && s.data && typeof s.data === "object") {
        const d = s.data as { text?: unknown };
        if (typeof d.text === "string") text += d.text;
      }
    }
  }
  if (text === "" && typeof m.raw_message === "string") text = m.raw_message;
  const sender = m.sender && typeof m.sender === "object" ? m.sender : {};
  const name =
    typeof sender.card === "string" && sender.card.trim() !== ""
      ? sender.card
      : typeof sender.nickname === "string"
        ? sender.nickname
        : "";
  return {
    userId: toUserId(sender.user_id),
    name,
    time: typeof m.time === "number" ? m.time : 0,
    text,
  };
}

/** 规范化一批历史消息：坏项/空文本跳过，按时间升序，超出 limit 保留最近。 */
export function normalizeHistoryMessages(rawList: unknown, opts: { limit?: number } = {}): AsOneHistoryMessage[] {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const out: AsOneHistoryMessage[] = [];
  if (!Array.isArray(rawList)) return out;
  for (const raw of rawList) {
    const entry = normalizeHistoryEntry(raw);
    if (!entry || entry.text.trim() === "") continue; // 非文本消息（表情/图片）跳过
    out.push(entry);
  }
  out.sort((a, b) => a.time - b.time);
  return out.slice(-limit);
}

/** Unix 秒 → HH:mm；0（未知时间）显示 --:--。 */
function hhmm(seconds: number): string {
  if (seconds <= 0) return "--:--";
  return new Date(seconds * 1000).toTimeString().slice(0, 5);
}

/**
 * 渲染为可读文本（移植旧桥 formatHistoryLines）：
 * 头部 `[标题 共 N 条，显示最近 M 条]`，每行 `HH:mm 名字（我）: 文本`。
 * 空记录返回提示行而不是空串。
 */
export function formatHistoryLines(messages: AsOneHistoryMessage[], opts: HistoryFormatOptions = {}): string {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const maxChars = opts.maxChars ?? 2000;
  const title = opts.title ?? "聊天记录";
  const recent = messages.slice(-limit);
  if (recent.length === 0) return `（${title}暂无记录）`;
  const lines: string[] = [`[${title} 共 ${messages.length} 条，显示最近 ${recent.length} 条]`];
  for (const m of recent) {
    const who = m.name || m.userId || "未知";
    const mine = opts.selfId !== undefined && m.userId === opts.selfId ? "（我）" : "";
    const body = m.text.trim();
    const text = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
    lines.push(`${hhmm(m.time)} ${who}${mine}: ${text}`);
  }
  return lines.join("\n");
}
