/**
 * bot-assistant 行 —— 已绑定路由（assistant 档）的 QQ 消息 → 人工创建的助理会话。
 *
 * patch 行 `@bvbhu/as-one/bot-assistant`。2026-11-27 用户定案：
 *   - 绑定表维护在配置文件 `~/.as-one/bot-bindings.json` 的 `bindings` 列表里（改完即生效）；
 *   - 只处理 mode=assistant 的绑定；未绑定 → 消息直接丢弃；mode=chat → bot-chat 行；
 *   - 唤醒规则（助理档，刻意简单）：私聊 → 直接唤醒；群聊 → 仅被 @ 唤醒；
 *   - 投递走 bot-relay（只 steer 一次；只把本回合回复发回 QQ）。
 *
 * 跨行契约：只 import type / 共享模块，零运行时依赖其他行。
 */

import type { AsOneBotChannelService, AsOneBotConfigService, AsOneBotFrame } from "./bot-channel-service.js";
import type { Context } from "./context-types.js";
import { bindingFor, chatKeyOf, loadBindings, resolveSessionRef } from "./bot-bindings.js";
import type { BotBinding, BotBindMode } from "./bot-bindings.js";
import { createRelay } from "./bot-relay.js";
import type { RelayAgents, RelayRoute } from "./bot-relay.js";

export const name = "@bvbhu/as-one/bot-assistant";
export const inject = ["asOneBotChannel", "asOneBotConfig", "agents"];

/** 本行负责的档位。 */
const MODE: BotBindMode = "assistant";

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
	return `${quoted}[群 ${f.targetId} @] ${name}：${f.text.trim()}`;
}

export function apply(ctx: Context): void {
	const channel =
		(ctx as unknown as { get(name: string): unknown }).get("asOneBotChannel") as
			| AsOneBotChannelService
			| undefined;
	if (!channel || typeof channel.send !== "function") {
		ctx.logger?.warn?.("[as-one] bot channel service unavailable, bot-assistant row skipped");
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
					`[as-one] bot-assistant: binding ${binding.route} 的 session「${binding.session}」解析不到（检查 ~/.as-one/bot-bindings.json）`,
				);
			}
			return resolved;
		};

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
				logOnce(`unbound:${route}`, `[as-one] bot-assistant: route ${route} 未绑定（~/.as-one/bot-bindings.json），消息丢弃`);
				return;
			}
			if (binding.mode !== MODE) return; // 聊天档 → bot-chat 行
			if (config?.isWakeupEnabled && !config.isWakeupEnabled(f.targetId, f.messageType)) return;
			// 助理档唤醒规则：私聊直接唤醒；群聊仅被 @ 唤醒。
			if (f.messageType === "group" && !f.atBot) return;

			const sessionId = sessionOf(binding);
			if (sessionId === "") return;
			const target: RelayRoute = { kind: f.messageType, id: f.targetId };
			void relay.deliver(sessionId, target, incomingText(f)).catch((err: unknown) => {
				ctx.logger?.warn?.(`[as-one] bot-assistant deliver failed (${sessionId}):`, err);
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

		ctx.logger?.info?.("[as-one] bot-assistant row mounted (bindings from ~/.as-one/bot-bindings.json)");
		return () => {
			offInbound();
			offEvent();
			relay.dispose();
		};
	}, "@bvbhu/as-one/bot-assistant: bound assistant sessions");
}