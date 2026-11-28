/**
 * bot-channel 跨行服务类型模块（**只 import type**，无运行时代码）。
 *
 * 事实来源：docs/bot-integration-design.md（确认版，2026-11-26）§二；
 * lead 契约修正（m00121/m00185）：BotTarget 用字符串 ID、status 返回
 * {connected, qq}、provide 两个服务、入站帧契约固定。
 *
 * 行文件（bot-channel-row.ts）import 本模块仅取类型；bot-chat /
 * bot-assistant / bot-notify 同样只 import type —— arch.test R1
 * （行间零互 import）不禁止类型模块。
 */
import type { AsOneRuntime } from "./setup.js";

/** 发送目标（字符串 ID，lead 契约修正 1：不是 number）。 */
export type BotTarget = { kind: "private"; id: string } | { kind: "group"; id: string };

/** 发送目标 scope（与 setting 键前缀对应）。 */
export type BotScope = "private" | "group";

/** 分级档位（setting 值）。 */
export type BotTier = "assistant" | "chat";

/**
 * 入站帧契约（lead 契约修正 4）：bot-chat / bot-assistant / bot-notify
 * 都按这个形状消费 `asOne:bot-message` 事件。
 */
export interface AsOneBotFrame {
  /** private = 私聊，group = 群聊。 */
  messageType: "private" | "group";
  /** 私聊 = 对方 QQ；群聊 =群号。 */
  targetId: string;
  /** 发送者 QQ。 */
  userId: string;
  /** 纯文本（segments 里 text 段拼接）。 */
  text: string;
  /** 原始消息段（未加工透传给下游）。 */
  segments: unknown[];
  /** 群消息是否 @ 了机器人。 */
  atBot: boolean;
  /** OneBot 原始帧（下游需要细节时自取）。 */
  raw: unknown;
  /**
   * 引用回复的被引用消息 id（OneBot reply 段 data.id；没有引用回复时省略）。
   * bot-channel 行在 emit 前用它经 OneBot get_message 拉取被引用文本。
   */
  replyTo?: string;
  /**
   * 被引用消息的纯文本（经 OneBot get_message 拉取并解析；拉不到/非文本时省略）。
   * 下游 incomingText() 用它拼「引用 …」上下文，让会话知道用户在回复哪条消息。
   */
  quotedText?: string;
  /** 被引用消息的发送者 QQ（拉取成功才有）。 */
  quotedUserId?: string;
  /** 被引用消息所在群号（私聊引用时为 undefined）。 */
  quotedGroupId?: string;
}

/** 一条聊天记录消息（OneBot 历史消息规范化结果；移植自旧桥 lib/history.js）。 */
export interface AsOneHistoryMessage {
  /** 发送者 QQ（字符串，与 BotTarget 同口径；系统消息可能为空）。 */
  userId: string;
  /** 显示名（群名片 card → 昵称 nickname；缺失为空串）。 */
  name: string;
  /** Unix 秒时间戳（0 = 未知）。 */
  time: number;
  /** 纯文本（段数组拼接；空串表示非文本消息）。 */
  text: string;
}

/** bot-channel 行 provide 的服务：SnowLuma OneBot v11 正向 WS 通道。 */
export interface AsOneBotChannelService {
  /**
   * 单向发送（OneBot send_private_msg / send_group_msg）。
   * 连接不可用时 warn 一次后 resolve —— 不做故障降级、不做状态机。
   */
  send(target: BotTarget, text: string): Promise<void>;
  /** { connected: WS 是否 OPEN, qq: 最近一次帧里的 self_id（未知为 null） }。 */
  status(): { connected: boolean; qq: string | null };
  /**
   * 读取目标聊天最近的消息（OneBot get_group_msg_history / get_friend_msg_history，只读）。
   * 连接不可用时 reject（调用方自行降级为提示文案，不抛未处理异常）。
   * limit 1–100，默认 20；返回按时间升序的规范化消息。
   */
  recentHistory(target: BotTarget, limit?: number): Promise<AsOneHistoryMessage[]>;
}

/** bot-channel 行 provide 的服务：分级名单 + 严格唤醒开关（setting 表，无新表）。 */
export interface AsOneBotConfigService {
  /** 名单内返回 'assistant'，名单外/未配置返回 'chat'。 */
  getTier(id: string, scope: BotScope): BotTier;
  /** 列出全部已配置名单（assistants / chats 两个数组）。 */
  listTiers(): { assistants: string[]; chats: string[] };
  /** 写名单（setting 键 bot.tier.<scope>.<id>，值 'assistant'|'chat'）。 */
  setTier(id: string, tier: BotTier): void;
  /** 总开关：关闭时任何 QQ 帧都不唤醒会话、任何 QQ 目标都不发消息。 */
  isWakeupGloballyEnabled(): boolean;
  /** 写总开关（setting 键 bot.wakeup.enabled，值 '1'|'0'）。 */
  setWakeupGloballyEnabled(enabled: boolean): void;
  /** 目标是否允许被唤醒/向其发送回复（含总开关、种子禁用名单与显式设置）。 */
  isWakeupEnabled(id: string, scope: BotScope): boolean;
  /** 写目标开关（setting 键 bot.wakeup.enabled.<scope>.<id>，值 '1'|'0'）。 */
  setWakeupEnabled(id: string, scope: BotScope, enabled: boolean): void;
  /** 列出当前禁用目标（种子 + 显式关闭），便于排查。 */
  listDisabledWakeups(): Array<{ scope: BotScope; id: string }>;
}

/** setting 键：bot.tier.private.<qq> / bot.tier.group.<gid>。 */
export function botTierSettingKey(scope: BotScope, id: string): string {
  return `bot.tier.${scope}.${id}`;
}

/** setting 值解析：'assistant' → assistant，其余（含 null/空）→ chat。 */
export function parseBotTier(value: string | null | undefined): BotTier {
  return value === "assistant" ? "assistant" : "chat";
}

/** 唤醒总开关 setting 键。 */
export const GLOBAL_WAKEUP_SETTING_KEY = "bot.wakeup.enabled";

/** 目标唤醒开关 setting 键：bot.wakeup.enabled.private.<qq> / .group.<gid>。 */
export function botWakeupEnabledSettingKey(scope: BotScope, id: string): string {
  return `bot.wakeup.enabled.${scope}.${id}`;
}

/**
 * 种子禁用名单：用户明确要求完全静默群 180568043（2026-11-27）。
 * 显式写 '1' 可以覆盖种子（setWakeupEnabled(id, "group", true)）。
 */
export const SEED_DISABLED_WAKEUPS: Record<BotScope, string[]> = {
  private: [],
  group: ["180568043"],
};

/** 显式关闭值：'0' / 'false' / 'off' / 'no'（大小写不敏感）；空值走 fallback。 */
export function parseEnabledFlag(value: string | null | undefined, fallback = true): boolean {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

/** 纯函数：读取 setting 判定目标是否允许唤醒（总开关 → 显式目标 → 种子名单）。 */
export function isWakeupEnabledFor(
  scope: BotScope,
  id: string,
  read: (key: string) => string | null | undefined,
): boolean {
  if (!parseEnabledFlag(read(GLOBAL_WAKEUP_SETTING_KEY))) return false;
  const explicit = read(botWakeupEnabledSettingKey(scope, id));
  if (explicit !== null && explicit !== undefined && String(explicit).trim() !== "") {
    return parseEnabledFlag(explicit);
  }
  return !SEED_DISABLED_WAKEUPS[scope].includes(id);
}

/**
 * 单条入站消息只唤醒一次。
 *
 * 历史 bug：调用方写 `const steered = agent.steer(msg); if (steered === undefined) agent.followup(msg)`，
 * 但 DSH 的 `steer()` 没有返回值（永远 undefined），于是每条消息被 steer + followup 投递两次，
 * 群里一问就回两条。这里明确：只要 steer 存在就只调 steer；它抛错也只冒泡给调用方记日志，
 * 不再补 followup，避免"部分成功 + 补发"造成重复。只有没有 steer 的旧 Agent 才用 followup。
 */
export function handoffOnce(agent: unknown, message: unknown): void {
  const a = agent as { steer?: (message: unknown) => unknown; followup?: (message: unknown) => unknown } | null | undefined;
  if (!a || typeof a !== "object") return;
  if (typeof a.steer === "function") {
    a.steer(message);
    return;
  }
  if (typeof a.followup === "function") {
    a.followup(message);
  }
}

/** AsOneRuntime 的窄投影（本模块只依赖它读 setting 的形状）。 */
export type AsOneRuntimeLike = Pick<AsOneRuntime, "db">;
