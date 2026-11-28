/**
 * QQ ↔ DSH 会话投递中继（chat / assistant 两行共用）。
 *
 * 职责：把一条 QQ 消息投进**已绑定**的 DSH 会话，并把该会话本回合的最终回复发回 QQ。
 *
 * 规则（与旧桥 fork 的差距，均按用户定案）：
 *   - 只投到人工创建、已被绑定的会话；**不创建会话**、不挂预设、不改模型；
 *   - 会话没在内存里就 resume 一次（resume 不传 agentOptions，沿用会话自己记住的模型）；
 *   - 投递只 steer 一次（steer 无返回值，绝不补 followup，避免重复回复）；
 *   - 回复只发**由 QQ 投递触发的内容**：主路径是消息自带的 source.rpcId 认领
 *     （插话不产生新 turn/start 也能认领），turn/start 时的 FIFO 只做兜底；
 *     回合以错误/取消结束时**不**回传（不打扰 QQ）；
 *   - 2026-11-27 定案：回复统一走 deliver_message 工具直发（私聊/群聊都算），
 *     中继只兜底——助理档（assistant）回合结束时若模型没调用工具，先把会话
 *     输出发回 QQ，再投一条催复指令要求模型用工具回复（每条新消息只催一次）；
 *     聊天档（chat）可以不回复：没调用工具就什么都不发。
 */
import { randomUUID } from "node:crypto";
import { bindingFor, loadBindings } from "./bot-bindings.js";
import { wasDelivered } from "./bot-reply.js";

/** 投递进会话的用户消息结构（dsh-llm createUserMessage 的形状 + 认领标记）。 */
export function buildUserMessage(
	text: string,
	rpcId?: string,
): {
	id: string;
	role: "user";
	content: { type: "text"; text: string }[];
	source: { kind: "user"; rpcId?: string };
} {
	return {
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: rpcId === undefined ? { kind: "user" } : { kind: "user", rpcId },
	};
}

/** assistant/message 事件里的助手文本（content 里 type=text 的拼接）。 */
export function assistantTextOf(event: { data?: { message?: { content?: unknown[] } } }): string {
	const content = event?.data?.message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** QQ 发送目标。 */
export interface RelayRoute {
	kind: "private" | "group";
	id: string;
}

/** 宿主 agents 服务的结构镜像（只取本模块用到的成员）。 */
export interface RelayAgents {
	get?(sessionId: string): unknown;
	resume?(options: { resumeSessionId: string }): Promise<RelayHandle>;
}

/** 宿主 agent 句柄（resume 的返回值）结构镜像。 */
export interface RelayHandle {
	agent?: AgentLike;
	dispose?(): void | Promise<void>;
}

/** 投递所需的 agent 能力面。 */
interface AgentLike {
	steer?(message: unknown): unknown;
	followup?(message: unknown): unknown;
	cancel?(reason?: unknown): void;
}

/** 聊天通道（channel.send 的窄投影）。 */
export interface RelayChannel {
	send(route: RelayRoute, text: string): Promise<void>;
}

/** 日志窄接口。 */
export interface RelayLogger {
	warn?(...args: unknown[]): void;
	info?(...args: unknown[]): void;
}

/** 会话事件（只取本模块关心的字段）。 */
export interface RelayEvent {
	type?: string;
	data?: {
		message?: { source?: { rpcId?: unknown } };
		inserted?: unknown[];
		reason?: { kind?: unknown };
	};
}

/** 认领标记前缀（只有本插件投递的消息才认）。 */
const CLAIM_PREFIX = "as-one-bot:";

/** QQ 引用回复解读指引：incomingText 产出的「[引用 …]」前缀消息投递时追加。 */
export const QUOTE_GUIDE =
	"（说明：消息开头以「[引用 …]」标注的若干行是用户引用的原消息，其后才是用户真正想说的话。" +
	"请先针对被引用的内容回应，再谈自己的观点；不要复述引用全文。）";

/** 模型没调用工具就结束回合时的催复指令（投回会话，要求它用工具回复）。 */
const NUDGE_TEXT =
	"（系统提示）你刚才的回复没有通过 deliver_message 工具发送，QQ 用户没有收到。" +
	"请立即调用 deliver_message 工具，把给用户的回复发出去（简洁：结论与要点即可，细节留在会话里）；" +
	"如果没有新内容可发，就发一句简短的确认。";

/** FIFO 兜底记账的有效期：超过这个时间还没 turn/start 的，视为用户自己发起的回合。 */
const PENDING_TTL_MS = 10 * 60_000;

/** 每个会话最多积压的记账（防止异常情况下无限增长）。 */
const MAX_PENDING = 8;

/** 认领表上限与过期时间。 */
const MAX_CLAIMS = 200;
const CLAIM_TTL_MS = 15 * 60_000;

/** 取裸 agent：resume 句柄可能包一层，agents.get 返回裸实例。 */
function rawAgentOf(entry: unknown): AgentLike | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const handle = entry as RelayHandle;
	return (handle.agent ?? entry) as AgentLike;
}

/** 回合结束原因是否算「正常完成」（缺省也算）。 */
function isCleanEnd(reason: { kind?: unknown } | undefined): boolean {
	const kind = reason?.kind;
	return kind === undefined || kind === null || kind === "completed";
}

/**
 * 建一个中继。返回的 deliver/onSessionEvent/dispose 由行在 effect 里持有。
 */
export function createRelay(options: {
	agents: RelayAgents | undefined;
	channel: RelayChannel;
	logger?: RelayLogger;
}): {
	deliver(sessionId: string, route: RelayRoute, text: string): Promise<boolean>;
	onSessionEvent(sessionId: string, event: RelayEvent): void;
	dispose(): void;
} {
	const { agents, channel, logger } = options;

	/** sessionId → resume 出来的句柄（由本中继持有，丢弃时释放）。 */
	const handles = new Map<string, RelayHandle>();
	/** sessionId → 投递记账 FIFO（时间戳），turn/start 兜底用。 */
	const pending = new Map<string, number[]>();
	/** rpcId → 认领记录（消息级，主路径）。 */
	const claims = new Map<string, { sessionId: string; route: RelayRoute; at: number }>();
	/** sessionId → 本回合是否归 QQ 投递。 */
	const claimed = new Set<string>();
	/** sessionId → 是否已就「没调用工具」发过催复指令（每条新消息重置）。 */
	const nudged = new Set<string>();
	/** sessionId → 本回合最后一条助手文本（回合结束时统一发一条）。 */
	const lastText = new Map<string, string>();
	/** sessionId → 最近一次投递的路由（回复发回这里）。 */
	const routes = new Map<string, RelayRoute>();

	const pushPending = (sessionId: string, at: number): void => {
		const list = pending.get(sessionId) ?? [];
		list.push(at);
		while (list.length > MAX_PENDING) list.shift();
		pending.set(sessionId, list);
	};

	/** 认领一条消息：标记本回合归 QQ，并记住回复路由。 */
	const claimMessage = (sessionId: string, route: RelayRoute): void => {
		claimed.add(sessionId);
		routes.set(sessionId, route);
		nudged.delete(sessionId);
	};

	/** 取会话 agent：live 直接用；否则 resume 一次并缓存句柄。失败返回 undefined。 */
	const ensureAgent = async (sessionId: string): Promise<AgentLike | undefined> => {
		try {
			const live = agents?.get?.(sessionId);
			if (live) return rawAgentOf(live);
		} catch {
			// get 抛错按未找到处理。
		}
		const cached = handles.get(sessionId);
		if (cached) return rawAgentOf(cached);
		if (typeof agents?.resume !== "function") return undefined;
		try {
			const handle = await agents.resume({ resumeSessionId: sessionId });
			handles.set(sessionId, handle);
			return rawAgentOf(handle);
		} catch (err) {
			logger?.warn?.(`[as-one] bot relay resume failed (${sessionId}):`, err);
			return undefined;
		}
	};

	/** 认领表清理：过期 + 超上限。 */
	const pruneClaims = (): void => {
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
		async deliver(sessionId: string, route: RelayRoute, text: string): Promise<boolean> {
			const body = String(text ?? "").trim();
			if (sessionId === "" || body === "") return false;
			// QQ 引用回复解读指引：incomingText 产出的「[引用 …]」前缀消息投递时追加，
			// 让会话知道如何解读引用上下文（普通消息与定时唤醒不受影响）。
			const payload = body.startsWith("[引用") ? `${body}\n${QUOTE_GUIDE}` : body;
			routes.set(sessionId, route);
			const agent = await ensureAgent(sessionId);
			if (!agent) {
				logger?.warn?.(`[as-one] bot relay: session not found (${sessionId})`);
				return false;
			}
			const claimId = `${CLAIM_PREFIX}${randomUUID()}`;
			claims.set(claimId, { sessionId, route, at: Date.now() });
			pruneClaims();
			const message = buildUserMessage(payload, claimId);
			pushPending(sessionId, Date.now());
			try {
				// 只投一次：steer 无返回值，绝不因为 undefined 补 followup。
				if (typeof agent.steer === "function") agent.steer(message);
				else if (typeof agent.followup === "function") agent.followup(message);
				else {
					logger?.warn?.(`[as-one] bot relay: agent has no steer/followup (${sessionId})`);
					return false;
				}
				return true;
			} catch (err) {
				logger?.warn?.(`[as-one] bot relay steer failed (${sessionId}):`, err);
				return false;
			}
		},

		/** 订阅 session/event 后按会话喂进来。 */
		onSessionEvent(sessionId: string, event: RelayEvent): void {
			const type = event?.type;

			// 主路径：消息级认领（user/message 的 data 就是 UserMessage）。
			if (type === "user/message" || type === "agent/inbox/spliced") {
				const list = type === "user/message" ? [event.data] : (event.data?.inserted ?? []);
				for (const item of list) {
					if (!item || typeof item !== "object") continue;
					const rpcId = (item as { source?: { rpcId?: unknown } }).source?.rpcId;
					if (typeof rpcId !== "string" || !rpcId.startsWith(CLAIM_PREFIX)) continue;
					const claim = claims.get(rpcId);
					if (!claim) continue;
					claims.delete(rpcId);
					claimMessage(sessionId, claim.route);
				}
				return;
			}

			if (type === "turn/start") {
				// 已有消息级认领时不再消费 FIFO，避免把后面的记账提前消耗掉。
				if (claimed.has(sessionId)) return;
				const list = pending.get(sessionId);
				while (list !== undefined && list.length > 0 && Date.now() - (list[0] ?? 0) > PENDING_TTL_MS) list.shift();
				const at = list?.shift();
				if (at !== undefined && Date.now() - at <= PENDING_TTL_MS && routes.has(sessionId)) {
					claimMessage(sessionId, routes.get(sessionId)!);
				}
				return;
			}

			if (type === "assistant/message") {
				if (!claimed.has(sessionId)) return;
				const text = assistantTextOf(event as never);
				if (text.trim() !== "") lastText.set(sessionId, text);
				return;
			}

			if (type === "turn/end") {
				if (!claimed.has(sessionId)) return;
				claimed.delete(sessionId);
				const text = lastText.get(sessionId);
				lastText.delete(sessionId);
				const route = routes.get(sessionId);
				if (text === undefined || text.trim() === "" || route === undefined) return;
				// 错误/取消的回合不回传（不打扰 QQ，细节留在界面里看）。
				if (!isCleanEnd(event.data?.reason)) return;
				// 回复由 deliver_message 工具直发：工具已发过则不再兜底回读会话输出。
				if (wasDelivered(sessionId)) return;
				// 档位：聊天档（chat）可以不回复——没调用工具就什么都不发；
				// 助理档（assistant）必须回复——兜底发会话输出，再投催复指令要求用工具。
				const mode = bindingFor(loadBindings().bindings, `${route.kind}:${route.id}`)?.mode;
				if (mode === "chat") return;
				void Promise.resolve(channel.send(route, text)).catch((err: unknown) => {
					logger?.warn?.(`[as-one] bot relay reply failed (${sessionId}):`, err);
				});
				// 每条新消息只催一次（claimMessage 重置），避免催回复环。
				if (!nudged.has(sessionId)) {
					nudged.add(sessionId);
					void ensureAgent(sessionId).then((agent) => {
						if (!agent?.steer) return;
						try {
							agent.steer(buildUserMessage(NUDGE_TEXT));
						} catch (err) {
							logger?.warn?.(`[as-one] bot relay nudge failed (${sessionId}):`, err);
						}
					});
				}
			}
		},

		/** 行卸载：取消并释放本中继 resume 出来的句柄。 */
		dispose(): void {
			for (const handle of handles.values()) {
				try {
					handle.agent?.cancel?.({ kind: "user" });
				} catch {
					// 取消失败不影响释放。
				}
				try {
					void Promise.resolve(handle.dispose?.()).catch(() => {});
				} catch {
					// 释放失败只记日志即可。
				}
			}
			handles.clear();
			pending.clear();
			claims.clear();
			claimed.clear();
			nudged.clear();
			lastText.clear();
			routes.clear();
		},
	};
}