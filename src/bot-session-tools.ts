/**
 * bot-session-tools 行 —— chat / assistant 两档会话共用的五个工具：
 *   search_sessions：按标题/ID 子串搜宿主会话；
 *   deliver_message：把本会话的回复直接发回绑定的 QQ 路由
 *                    （2026-11-27 用户定案：私聊与群聊的回复都是调用工具输出，
 *                     而不是中继回读会话输出；每条新消息只能成功发送一次，
 *                     上限 3000 字；未绑定会话一律拒绝）；
 *   send_to_session：向任意 DSH 会话投递一条用户消息（2026-11-27 新增，
 *                    仅绑定 private:3187192488 的会话可用：回复留在对方
 *                    会话里，不经 QQ 中继）；
 *   read_session：读取任意 DSH 会话最近的消息内容（同上，仅 3187192488
 *                  绑定会话可用；经 sessionQuery 服务的 readSession
 *                  读取完整会话日志，不再直接解压日志文件）；
 *   qq_recent_history：读取本会话绑定的 QQ 聊天（群/私聊）最近的消息
 *                    （2026-11-27 移植自旧桥；唤醒只带触发那条消息，
 *                    需要上下文时用它回顾之前聊过什么）。
 *
 * 挂载位置：preset-chat 与 preset-assistant 的 plugins 列表（其余预设不受影响）。
 *
 * 跨行契约：bot-channel 行 provide `asOneBotChannel`；次数状态与 bot-reply
 * 共享（同模块单例）；事件订阅与 bot-chat / bot-assistant 行同签名。
 */
import type { Context } from "./context-types.js";
import { bindingFor, loadBindings, resolveSessionRef, searchSessions, targetOfRoute } from "./bot-bindings.js";
import { buildUserMessage, type RelayAgents, type RelayHandle } from "./bot-relay.js";
import { bindingForSession, setReplyChannel, tryDeliver, onUserMessage } from "./bot-reply.js";
import { formatHistoryLines, normalizeHistoryMessages } from "./bot-history.js";

export const name = "@bvbhu/as-one/bot-session-tools";
export const inject = ["tools", "asOneBotChannel", "agents", "sessionQuery"];

/** 跨会话工具的专属路由：只有绑定到该路由的会话才能调用 send_to_session / read_session。 */
const OWNER_ROUTE = "private:3187192488";

/** send_to_session 单条消息长度上限（内部投递，比 QQ 的 3000 字宽松）。 */
const SEND_MAX_CHARS = 8000;

/** read_session 单条消息渲染截断长度。 */
const READ_CLIP_CHARS = 800;

/** 工具注册表窄投影。 */
interface SessionToolsRegistry {
	register(definition: unknown): () => void;
}

/** 聊天通道窄投影（send 与 bot-reply 的 ReplyChannel 同形；recentHistory 为只读历史）。 */
interface SessionToolsChannel {
	send(route: { kind: "private" | "group"; id: string }, text: string): Promise<void>;
	recentHistory?(target: { kind: "private" | "group"; id: string }, limit?: number): Promise<unknown[]>;
	status?(): { connected: boolean; qq: string | null };
}

/** 宿主 agent 句柄的裸能力面（steer/followup）。 */
interface SessionToolsAgent {
	steer?(message: unknown): unknown;
	followup?(message: unknown): unknown;
	cancel?(reason?: unknown): void;
}

/** 工具输出渲染：统一渲染成一条文本块。 */
function renderText(value: unknown): unknown[] {
	return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}

/** 从 exec.agent 取当前会话 id（Agent 结构未随包发布 d.ts，按结构窄投影）。 */
function sessionIdOf(exec: unknown): string {
	const agent = (exec as { agent?: { session?: { header?: { id?: unknown } } } } | undefined)?.agent;
	const id = agent?.session?.header?.id;
	return typeof id === "string" ? id : "";
}

/** 取裸 agent：resume 句柄可能包一层，agents.get 返回裸实例。 */
function rawAgentOf(entry: unknown): SessionToolsAgent | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const handle = entry as RelayHandle;
	return (handle.agent ?? entry) as SessionToolsAgent;
}

/** 当前会话是否就是 OWNER_ROUTE 绑定的会话（跨会话工具的准入门槛）。 */
function isOwnerSession(sessionId: string): boolean {
	if (sessionId === "") return false;
	const binding = bindingFor(loadBindings().bindings, OWNER_ROUTE);
	if (!binding) return false;
	return resolveSessionRef(binding.session) === sessionId;
}

/** 文本截断渲染（超长加省略标记）。 */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…（已截断，共 ${text.length} 字）`;
}

/** 内容块数组 → 纯文本（只取 type=text 的块）。 */
function textOfContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** 会话日志里的一条消息。 */
interface SessionMessage {
	role: "user" | "assistant";
	text: string;
}

/** sessionQuery 服务的窄投影：readSession 返回完整会话日志快照。 */
interface SessionQueryEngine {
	readSession(sessionId: string): Promise<{ events: unknown[] }>;
}

/** sessionQuery 快照事件 → 用户/助手消息序列（只取正文，跳过推理与工具调用块）。 */
function extractMessagesOfEvents(events: unknown[]): SessionMessage[] {
	const out: SessionMessage[] = [];
	for (const ev of events) {
		if (!ev || typeof ev !== "object") continue;
		const type = (ev as { type?: unknown }).type;
		if (type === "user/message") {
			const body = textOfContent((ev as { data?: { content?: unknown } }).data?.content);
			if (body.trim() !== "") out.push({ role: "user", text: body });
		} else if (type === "assistant/message") {
			const body = textOfContent((ev as { data?: { message?: { content?: unknown } } }).data?.message?.content);
			if (body.trim() !== "") out.push({ role: "assistant", text: body });
		}
	}
	return out;
}

export function apply(ctx: Context): void {
	const tools = (ctx as unknown as { tools?: SessionToolsRegistry }).tools;
	const channel =
		(ctx as unknown as { get(name: string): unknown }).get("asOneBotChannel") as
			| SessionToolsChannel
			| undefined;
	const agents = (ctx as unknown as { agents?: RelayAgents }).agents;
	// sessionQuery 由 inject 保证存在；此处仍做防御，缺失时 read_session 优雅降级。
	const sessionQuery = (ctx as unknown as { get(name: string): unknown }).get("sessionQuery") as
		| SessionQueryEngine
		| undefined;
	if (!tools || typeof tools.register !== "function") {
		ctx.logger?.warn?.("[as-one] tools service unavailable, bot-session-tools row skipped");
		return;
	}
	if (!channel || typeof channel.send !== "function") {
		ctx.logger?.warn?.("[as-one] bot channel service unavailable, bot-session-tools row skipped");
		return;
	}

	// 次数状态与 bot-chat / bot-assistant 两行共享（同模块单例）。
	setReplyChannel(
		{ send: (route, text) => channel.send(route, text) },
		{
			warn: (...args: unknown[]) => {
				const log = ctx.logger?.warn;
				if (!log) return;
				log(args[0] as string, ...args.slice(1));
			},
		},
	);

	ctx.effect(() => {
		const offEvent = (ctx as unknown as {
			on(event: string, listener: (session: unknown, event: unknown) => void): () => void;
		}).on("session/event", (session: unknown, event: unknown) => {
			const ev = event as { type?: string; data?: { message?: { source?: { rpcId?: unknown } } } };
			if (ev?.type !== "user/message") return;
			const ref = session as { id?: unknown; header?: { id?: unknown } } | null | undefined;
			const sessionId =
				typeof ref?.header?.id === "string" ? ref.header.id : typeof ref?.id === "string" ? ref.id : "";
			if (sessionId === "") return;
			onUserMessage(sessionId, ev?.data?.message?.source?.rpcId);
		});

		/** send_to_session 复用的 resume 句柄缓存（行卸载时释放）。 */
		const handles = new Map<string, RelayHandle>();

		/** 取会话 agent：live 直接用；否则 resume 一次并缓存句柄。失败返回 undefined。 */
		const ensureAgent = async (sessionId: string): Promise<SessionToolsAgent | undefined> => {
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
				ctx.logger?.warn?.(`[as-one] bot-session-tools resume failed (${sessionId}):`, err);
				return undefined;
			}
		};

		const disposeSearch = tools.register({
			name: "search_sessions",
			description:
				"按标题或会话 ID 子串搜索宿主上的其他 DSH 会话，返回 id 与标题列表（最多 100 条）。"
				+ "空结果请换个更短的关键词。",
			parameters: {
				query: {
					type: "string",
					required: true,
					description: "会话标题或 ID 的子串（大小写不敏感）。",
				},
				limit: {
					type: "number",
					description: "最多返回条数，1–100，缺省 20。",
				},
			},
			output: { schema: { type: "string" }, render: renderText },
			async execute(args: { query?: unknown; limit?: unknown }) {
				const query = String(args?.query ?? "").trim();
				if (query === "") return "query 不能为空";
				const rawLimit = Number(args?.limit);
				const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.round(rawLimit) : 20;
				const hits = searchSessions(query, process.env, limit);
				if (hits.length === 0) return `没有匹配「${query}」的会话`;
				const lines = hits.map((hit) => `- ${hit.id}：${hit.title || "（无标题）"}`);
				return `${hits.length} 个匹配：\n${lines.join("\n")}`;
			},
		});

		const disposeDeliver = tools.register({
			name: "deliver_message",
			description:
				"把本会话的回复直接发回绑定的 QQ 路由（私聊/群聊专用；未绑定会话会被拒绝）。"
				+ "发给 QQ 的消息要简洁：简要说明即可，不必面面俱到——"
				+ "用户可以直接远程查看 DSH 会话全文，所以不要把完整过程、全文或冗长日志搬进 QQ，"
				+ "只保留关键结论、要点与下一步，细节留在会话里。"
				+ "回复必须通过本工具发送（私聊和群聊都一样）：每条新到用户消息只能成功发送一次，单次上限 3000 字；"
				+ "发送成功即结束回合，不要重复调用。",
			parameters: {
				text: {
					type: "string",
					required: true,
					description: "要发回 QQ 的回复正文（≤3000 字）。",
				},
			},
			output: { schema: { type: "string" }, render: renderText },
			async execute(args: { text?: unknown }, exec: unknown) {
				const sessionId = sessionIdOf(exec);
				if (sessionId === "") return "无法确定当前会话（工具未在会话内调用）";
				const text = String(args?.text ?? "").trim();
				if (text === "") return "text 不能为空";
				const result = await tryDeliver(sessionId, text);
				if (!result.ok) return result.error ?? "发送失败";
				return `已发送到 QQ（${sessionId}）`;
			},
		});

		const disposeSend = tools.register({
			name: "send_to_session",
			description:
				"向任意 DSH 会话投递一条用户消息（仅绑定 private:3187192488 的会话可用）。"
				+ "session 支持会话 ID、唯一前缀或标题（可用 search_sessions 先查）。"
				+ "投递后对方会话自行处理并回复，回复留在对方会话里，不会发回 QQ。",
			parameters: {
				session: {
					type: "string",
					required: true,
					description: "目标 DSH 会话的 ID、唯一前缀或标题。",
				},
				text: {
					type: "string",
					required: true,
					description: `要投递给对方的消息正文（≤${SEND_MAX_CHARS} 字）。`,
				},
			},
			output: { schema: { type: "string" }, render: renderText },
			async execute(args: { session?: unknown; text?: unknown }, exec: unknown) {
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
					// 只投一次：steer 无返回值，绝不因为 undefined 补 followup。
					if (typeof agent.steer === "function") agent.steer(buildUserMessage(body));
					else if (typeof agent.followup === "function") agent.followup(buildUserMessage(body));
					else return `会话 ${targetId} 的 agent 没有 steer/followup 能力，投递失败`;
				} catch (err) {
					ctx.logger?.warn?.(`[as-one] bot-session-tools steer failed (${targetId}):`, err);
					return `向会话 ${targetId} 投递失败：${(err as Error).message ?? String(err)}`;
				}
				return `已向会话 ${targetId} 投递消息（${body.length} 字），回复会留在该会话里`;
			},
		});

		const disposeRead = tools.register({
			name: "read_session",
			description:
				"读取任意 DSH 会话最近的消息内容（仅绑定 private:3187192488 的会话可用）。"
				+ "session 支持会话 ID、唯一前缀或标题（可用 search_sessions 先查）；"
				+ "返回用户与助手的文本消息（助手只取正文，不含推理与工具调用）。",
			parameters: {
				session: {
					type: "string",
					required: true,
					description: "目标 DSH 会话的 ID、唯一前缀或标题。",
				},
				limit: {
					type: "number",
					description: "返回最近多少条消息，1–100，缺省 20。",
				},
			},
			output: { schema: { type: "string" }, render: renderText },
			async execute(args: { session?: unknown; limit?: unknown }, exec: unknown) {
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
				let snapshot: { events?: unknown } | undefined;
				try {
					snapshot = await sessionQuery.readSession(targetId);
				} catch (err) {
					ctx.logger?.warn?.(`[as-one] bot-session-tools readSession failed (${targetId}):`, err);
					return `读取会话 ${targetId} 的日志失败：${(err as Error).message ?? String(err)}`;
				}
				const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
				const messages = extractMessagesOfEvents(events);
				if (messages.length === 0) return `会话 ${targetId} 的日志里没有用户/助手的文本消息`;
				const recent = messages.slice(-limit);
				const lines = recent.map((message) =>
					`[${message.role === "user" ? "用户" : "助手"}] ${clip(message.text, READ_CLIP_CHARS)}`,
				);
				return `${recent.length} 条消息（该会话共 ${messages.length} 条）：\n${lines.join("\n")}`;
			},
		});

		const disposeQqHistory = tools.register({
			name: "qq_recent_history",
			description:
				"读取本会话绑定的 QQ 聊天（群/私聊）最近的消息，用于回顾之前聊过什么。"
				+ "唤醒后的会话只能看到触发的那一条消息，需要上下文（之前谁说了什么）时用本工具。"
				+ "返回按时间升序的最近消息列表，含发送者与文本。",
			parameters: {
				limit: {
					type: "number",
					description: "最近多少条，1–100，缺省 20。",
				},
			},
			output: { schema: { type: "string" }, render: renderText },
			async execute(args: { limit?: unknown }, exec: unknown) {
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
				let messages: unknown[];
				try {
					messages = await channel.recentHistory!(target, limit);
				} catch (err) {
					ctx.logger?.warn?.(`[as-one] bot-session-tools recentHistory failed (${sessionId}):`, err);
					return `读取聊天记录失败：${(err as Error).message ?? String(err)}`;
				}
				return formatHistoryLines(normalizeHistoryMessages(messages, { limit }), {
					selfId: channel.status?.().qq ?? undefined,
					title: target.kind === "group" ? "群聊" : "私聊",
				});
			},
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
					// 取消失败不影响释放。
				}
				try {
					void Promise.resolve(handle.dispose?.()).catch(() => {});
				} catch {
					// 释放失败只记日志即可。
				}
			}
			handles.clear();
		};
	});
}
