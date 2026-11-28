/**
 * bot-chat 行 —— 已绑定路由（chat 档）的 QQ 消息 → 人工创建的聊天会话。
 *
 * patch 行 `@bvbhu/as-one/bot-chat`。2026-11-27 用户定案：
 *   - 绑定表维护在配置文件 `~/.as-one/bot-bindings.json` 的 `bindings` 列表里（改完即生效）；
 *   - 只处理 mode=chat 的绑定；未绑定 → 消息直接丢弃；mode=assistant → bot-assistant 行；
 *   - 唤醒规则（chat 档）：私聊视为 @ 全部唤醒；群聊被 @ 或命中唤醒词；定时唤醒另计；
 *   - 投递走 bot-relay（只 steer 一次；只把本回合回复发回 QQ）。
 *
 * 跨行契约（只 import type / 共享模块，零运行时依赖其他行）：
 *   - bot-channel 行 provide `asOneBotChannel` 与 `asOneBotConfig`；
 *   - 入站帧事件 `asOne:bot-message`（本行订阅）；出站经 bot-relay → channel.send。
 */

import type { AsOneBotChannelService, AsOneBotConfigService, AsOneBotFrame } from "./bot-channel-service.js";
import type { Context } from "./context-types.js";
import {
	DEFAULT_WAKE_WORDS,
	bindingFor,
	chatKeyOf,
	loadBindings,
	matchWakeWord,
	resolveSessionRef,
	targetOfRoute,
} from "./bot-bindings.js";
import type { BotBinding, BotBindMode } from "./bot-bindings.js";
import { createRelay } from "./bot-relay.js";
import type { RelayAgents, RelayRoute } from "./bot-relay.js";

export const name = "@bvbhu/as-one/bot-chat";
export const inject = ["asOneBotChannel", "asOneBotConfig", "agents"];

/** 定时唤醒巡检间隔。 */
const SCHEDULE_TICK_MS = 30_000;

/** 本行负责的档位。 */
const MODE: BotBindMode = "chat";

/** 引用上下文前缀（QQ「回复」一条消息时，让会话知道在回复什么）。 */
function quotedPrefix(f: AsOneBotFrame): string {
	if (!f.quotedText) return "";
	const scope = f.quotedGroupId ?? (f.messageType === "group" ? f.targetId : undefined);
	const where = scope !== undefined ? `[引用 群 ${scope}]` : "[引用]";
	return `${where} ${f.quotedUserId || "未知"}：${f.quotedText}\n`;
}

/** 入站文本 → 投递文本：群聊带发送者与来源，私聊保持原样；引用回复带被引用上下文。 */
function incomingText(f: AsOneBotFrame): string {
	const quoted = quotedPrefix(f);
	if (f.messageType !== "group") return quoted + f.text.trim();
	const sender = f.raw as { sender?: { card?: unknown; nickname?: unknown } } | null | undefined;
	const name = String(sender?.sender?.card ?? sender?.sender?.nickname ?? "").trim() || f.userId;
	return `${quoted}[群 ${f.targetId}] ${name}：${f.text.trim()}`;
}

export function apply(ctx: Context): void {
	const channel =
		(ctx as unknown as { get(name: string): unknown }).get("asOneBotChannel") as
			| AsOneBotChannelService
			| undefined;
	if (!channel || typeof channel.send !== "function") {
		ctx.logger?.warn?.("[as-one] bot channel service unavailable, bot-chat row skipped");
		return;
	}
	const config =
		(ctx as unknown as { get(name: string): unknown }).get("asOneBotConfig") as
			| AsOneBotConfigService
			| undefined;

	ctx.effect(() => {
		const agents = (ctx as unknown as { agents?: RelayAgents }).agents;
		const relay = createRelay({ agents, channel, logger: ctx.logger });

		/** 未绑定 / 未解析 / 被跳过只记一次日志（避免每条消息刷屏）。 */
		const logged = new Map<string, number>();
		const logOnce = (key: string, message: string): void => {
			const last = logged.get(key) ?? 0;
			if (Date.now() - last < 600_000) return;
			logged.set(key, Date.now());
			ctx.logger?.info?.(message);
		};

		/** 绑定 → 解析出真正的 sessionId；解析不到返回空串（并记一次日志）。 */
		const sessionOf = (binding: BotBinding): string => {
			const resolved = resolveSessionRef(binding.session);
			if (resolved === "") {
				logOnce(
					`unresolved:${binding.route}`,
					`[as-one] bot-chat: binding ${binding.route} 的 session「${binding.session}」解析不到（检查 ~/.as-one/bot-bindings.json）`,
				);
			}
			return resolved;
		};

		const wakeWordsOf = (binding: BotBinding): string[] =>
			binding.wakeWords.length > 0 ? binding.wakeWords : DEFAULT_WAKE_WORDS;

		const offInbound = (ctx as unknown as {
			on(event: string, listener: (payload: unknown) => void): () => void;
		}).on("asOne:bot-message", (frame: unknown) => {
			const f = frame as AsOneBotFrame;
			if (!f || (f.messageType !== "private" && f.messageType !== "group")) return;
			if (typeof f.text !== "string" || f.text.trim() === "") return;

			const route = chatKeyOf(f.messageType, f.targetId);
			const { bindings } = loadBindings();
			const binding = bindingFor(bindings, route);
			if (!binding) {
				logOnce(`unbound:${route}`, `[as-one] bot-chat: route ${route} 未绑定（~/.as-one/bot-bindings.json），消息丢弃`);
				return;
			}
			if (binding.mode !== MODE) return; // 助理档 → bot-assistant 行
			if (config?.isWakeupEnabled && !config.isWakeupEnabled(f.targetId, f.messageType)) return;

			// 私聊视为 @：全部唤醒；群聊看 @ 与唤醒词。
			const woken =
				f.messageType === "group"
					? f.atBot || matchWakeWord(f.text, wakeWordsOf(binding)) !== ""
					: true;
			if (!woken) return;

			const sessionId = sessionOf(binding);
			if (sessionId === "") return;
			const target: RelayRoute = { kind: f.messageType, id: f.targetId };
			void relay.deliver(sessionId, target, incomingText(f)).catch((err: unknown) => {
				ctx.logger?.warn?.(`[as-one] bot-chat deliver failed (${sessionId}):`, err);
			});
		});

		/** 会话事件 → 中继记账（回答只发回由 QQ 投递触发的回合）。 */
		const offEvent = (ctx as unknown as {
			on(event: string, listener: (session: unknown, event: unknown) => void): () => void;
		}).on("session/event", (session: unknown, event: unknown) => {
			const ev = event as { type?: string };
			if (!ev?.type) return;
			const ref = session as { id?: unknown; header?: { id?: unknown } } | null | undefined;
			const sessionId = typeof ref?.header?.id === "string" ? ref.header.id : typeof ref?.id === "string" ? ref.id : "";
			if (sessionId === "") return;
			relay.onSessionEvent(sessionId, ev);
		});

		/** 定时唤醒：内存里记每个路由上次触发时间（重启后从启动时刻起算）。 */
		const lastFired = new Map<string, number>();
		const timer = setInterval(() => {
			try {
				if (config?.isWakeupGloballyEnabled && !config.isWakeupGloballyEnabled()) return;
				const { bindings } = loadBindings();
				const now = Date.now();
				for (const binding of bindings) {
					if (binding.mode !== MODE || binding.schedule === null) continue;
					const target = targetOfRoute(binding.route);
					if (!target) continue;
					const last = lastFired.get(binding.route);
					if (last === undefined) {
						lastFired.set(binding.route, now);
						continue;
					}
					if (now - last < binding.schedule.everySeconds * 1000) continue;
					if (config?.isWakeupEnabled && !config.isWakeupEnabled(target.id, target.kind)) continue;
					const sessionId = sessionOf(binding);
					if (sessionId === "") continue;
					lastFired.set(binding.route, now);
					void relay.deliver(sessionId, target, binding.schedule.prompt).catch((err: unknown) => {
						ctx.logger?.warn?.(`[as-one] bot-chat scheduled wake failed (${binding.route}):`, err);
					});
				}
			} catch (err) {
				ctx.logger?.warn?.("[as-one] bot-chat schedule tick failed:", err);
			}
		}, SCHEDULE_TICK_MS);

		ctx.logger?.info?.("[as-one] bot-chat row mounted (bindings from ~/.as-one/bot-bindings.json)");
		return () => {
			clearInterval(timer);
			offInbound();
			offEvent();
			relay.dispose();
		};
	}, "@bvbhu/as-one/bot-chat: bound chat sessions");
}