/**
 * bot-notify —— 通知行（只私聊主人 3187192488，单向）。
 *
 * ## 事件源（全部走宿主 `session/event`，只观察不认领）
 * - 提问：`tool/call` 且 name 为 ask_user_question（工具卡片照常在 DSH 界面答）；
 * - 授权：`approval/asked`（ApprovalService 派发前 append 的审计事件，policy=never
 *   时无事件属设计如此）；
 * - mhy 签到完成：**不在本行处理**——设计文档第六节规定由 bot-mhy 行经
 *   asOneBotChannel 直推主人；本行不再转发 as-one:bot:mhy-signin，避免重复通知。
 * - 会话完成：`turn/end` 且 reason.kind 缺失或为 completed（跳过 qq-* 会话；
 *   排队消息非空时跳过——依据 agent.ts 先 append turn/end 再判 inbox，队列此刻仍在）。
 *
 * ## 完成通知的交互分流（不做状态机，纯按长度）
 * 主人回复「✅ 会话完成」通知后的等待窗口（10 分钟）内：
 * - ≤1 字符 → 把该会话最近回合的助手文本私聊发回；
 * - >1 字符 → 当作追加输入转进那个会话（steer 优先，followup 兜底）。
 *
 * 防误解：不做故障降级、不做状态机、不做双向通讯；行间零互 import（只 import type）。
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { Context } from "cordis";
import type { AsOneBotChannelService, AsOneBotConfigService } from "./bot-channel-service.js";
import { handoffOnce } from "./bot-channel-service.js";

/** 主人 QQ 号（字符串 ID，全行唯一的私聊目标）。 */
const OWNER_QQ = "3187192488";

/** 完成通知后的等待窗口：主人在这个窗口内回复才算「回那条通知」。 */
const REPLY_WINDOW_MS = 10 * 60_000;

/** bot-channel emit 的入站帧（结构镜像 bot-chat 行，只取需要的字段）。 */
interface BotMessageFrame {
	messageType?: string;
	targetId?: string;
	userId?: string;
	text?: string;
	segments?: unknown[];
	atBot?: boolean;
	raw?: unknown;
}

/** 宿主 session/event 事件的 data 的最小结构。 */
interface SessionEventData {
	[name: string]: unknown;
}

/** tool/call 的 data（arguments 是 JSON 字符串或已解析对象）。 */
interface ToolCallData {
	name?: string;
	arguments?: string | Record<string, unknown> | null;
}

/** approval/asked 的 data（ApprovalService 派发前 append 的审计事件）。 */
interface ApprovalAskedData {
	toolName?: string;
	reason?: string;
}

/** turn/end 的 data。 */
interface TurnEndData {
	reason?: { kind?: string } | null;
}

/** assistant/message 的 data（content 为分片数组）。 */
interface AssistantMessageData {
	message?: { content?: unknown[] } | null;
}

/** AsOneAgents 结构镜像（bot-chat 行同款，get 返回 handle 包装）。 */
interface AsOneAgentHandle {
	agent: {
		steer(message: unknown): unknown;
		followup(message: unknown): unknown;
	};
}

interface AsOneAgents {
	get(sessionId: string): AsOneAgentHandle | undefined;
}

/** 一条待交互的完成通知（等待窗口内的目标会话）。 */
interface PendingNotice {
	sessionId: string;
	/** 窗口截止时间戳；过期即作废。 */
	until: number;
}

/** 会话对象 → 会话号：宿主给的是 `{ header: { id } }`，两种形态都认。 */
function sessionIdOf(value: unknown): string {
	const v = value as { id?: unknown; header?: { id?: unknown } } | null | undefined;
	const fromHeader = v?.header?.id;
	if (typeof fromHeader === "string" && fromHeader !== "") return fromHeader;
	const direct = v?.id;
	return typeof direct === "string" ? direct : "";
}

/** 文本裁剪：压平空白 + trim + 超长截断（会话标题 80 字上限）。 */
function clip(text: string, max = 80): string {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 工作区索引条目（workspace.json 的 workspaces 表）。 */
interface WorkspaceInfo {
	title: string;
	path: string;
}

/** 宿主主目录（USERPROFILE 优先，与旧桥一致）。 */
function homeDir(): string {
	return process.env.USERPROFILE || process.env.HOME || "";
}

/** 会话原始目录：当前 SessionHeader 直接带 cwd；旧格式退回 header.meta.cwd。 */
function sessionCwdOf(session: unknown): string {
	const v = session as { header?: { cwd?: unknown; meta?: { cwd?: unknown } } } | null | undefined;
	const direct = v?.header?.cwd;
	if (typeof direct === "string" && direct.trim() !== "") return direct;
	const meta = v?.header?.meta?.cwd;
	return typeof meta === "string" ? meta : "";
}

/** 投影行取值：兼容裸字符串与 {ver,seq,val} 两种形态。 */
function projectionVal(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && typeof (value as { val?: unknown }).val === "string") {
		return (value as { val: string }).val;
	}
	return "";
}

/** 会话标题：宿主实时投影 → 磁盘投影缓存 → session 自身字段（三级回退，同旧桥）。 */
function sessionTitleOf(ctx: Context, session: unknown, sessionId: string): string {
	try {
		const projections = (ctx as unknown as {
			sessionProjections?: { snapshot?: (s: unknown, keys: string[]) => { values?: Record<string, unknown> } | undefined };
		}).sessionProjections;
		const snap = projections?.snapshot?.(session, ["title"]);
		const raw = projectionVal(snap?.values?.title);
		if (raw.trim() !== "") return clip(raw, 80);
	} catch { /* 宿主版本差异，继续往下找 */ }
	try {
		// 投影缓存文件名两种约定并存：带不带 session- 前缀都试一遍。
		const bare = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
		for (const candidate of [sessionId, bare === sessionId ? `session-${sessionId}` : bare]) {
			const file = join(homeDir(), ".dsh", "storages", "session_projcache", "sessions", `${candidate}.json`);
			const row = JSON.parse(readFileSync(file, "utf8"))?.record?.rows?.title;
			const raw = projectionVal(row);
			if (raw.trim() !== "") return clip(raw, 80);
		}
	} catch { /* 没有投影缓存也没关系 */ }
	const v = session as { header?: { title?: unknown }; title?: unknown; meta?: { title?: unknown } } | null | undefined;
	const raw = v?.header?.title ?? v?.title ?? v?.meta?.title;
	return typeof raw === "string" ? clip(raw, 80) : "";
}

/** 完成通知标签：工作区标题 + 会话标题（标题缺失用短 id 兜底，避免没头没尾）。 */
export function formatCompletionLabel(workspaceTitle: string, sessionTitle: string, sessionId: string): string {
	const ws = String(workspaceTitle ?? "").trim() || "未关联工作区";
	const title = String(sessionTitle ?? "").trim() || (String(sessionId ?? "").trim().slice(0, 12) || "未命名会话");
	return `${ws}：${title}`;
}

/** 从 agents.get 的返回里挖出真正的 Agent（兼容 handle 包装与裸实例两种形态）。 */
function rawAgentOf(agents: AsOneAgents | undefined, sessionId: string): unknown {
	const entry = agents?.get(sessionId);
	if (!entry || typeof entry !== "object") return undefined;
	const agent = (entry as { agent?: unknown }).agent;
	return agent ?? entry;
}

/** 排队消息数（结构镜像桥 completion-filter 的 queuedInputCount；结构判断不了返回 undefined）。 */
function queuedInputCountOf(agent: unknown): number | undefined {
	const inbox = (agent as { inbox?: unknown } | null | undefined)?.inbox;
	if (!inbox || typeof inbox !== "object") return undefined;
	const count = (list: unknown): number => (Array.isArray(list) ? list.length : 0);
	return count((inbox as { nextTurn?: unknown }).nextTurn) + count((inbox as { nextStep?: unknown }).nextStep);
}

/** assistant/message 事件里的助手文本（content 数组里 type=text 的拼接）。 */
function assistantTextOf(event: { data?: unknown }): string {
	const content = (event.data as AssistantMessageData | undefined)?.message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
}

export const name = "@bvbhu/as-one/bot-notify";

export const inject = ["asOneBotChannel", "asOneBotConfig", "asOneCore", "agents", "webServer"];

export function apply(ctx: Context): void {
	const bot = (ctx as unknown as { get(name: string): unknown }).get(
		"asOneBotChannel",
	) as AsOneBotChannelService | undefined;
	if (!bot || typeof bot.send !== "function") {
		ctx.logger?.warn?.("[as-one] bot channel service unavailable, bot-notify row skipped");
		return;
	}

	const config = (ctx as unknown as { get(name: string): unknown }).get(
		"asOneBotConfig",
	) as AsOneBotConfigService | undefined;
	const agents = (ctx as unknown as { agents?: AsOneAgents }).agents;

	/** 每个会话最近一条 assistant/message 文本（完成通知被回「总结」时用）。 */
	const recentTurnText = new Map<string, string>();
	/** 每个会话在通知里的直观标签（工作区名 + 会话标题；只在拿到 session 对象时记）。 */
	const sessionLabels = new Map<string, string>();
	/** 完成通知后的等待窗口（一次只留最近一条）。 */
	let pendingNotice: PendingNotice | null = null;

	/** 工作区索引缓存（5 秒 TTL）：workspace.json 的 workspaces 表双通道索引。 */
	const workspaceCache = { at: 0, bySession: new Map<string, WorkspaceInfo>(), byPath: new Map<string, WorkspaceInfo>() };

	/** 读工作区索引：sessionId 反查 + cwd 路径匹配（数组/对象两种表形态都认）。 */
	function readWorkspaceIndex(): { bySession: Map<string, WorkspaceInfo>; byPath: Map<string, WorkspaceInfo> } {
		const now = Date.now();
		if (workspaceCache.at !== 0 && now - workspaceCache.at < 5000) return workspaceCache;
		const bySession = new Map<string, WorkspaceInfo>();
		const byPath = new Map<string, WorkspaceInfo>();
		try {
			const data = JSON.parse(readFileSync(join(homeDir(), ".dsh", "storages", "workspace.json"), "utf8")) as {
				tables?: { workspaces?: unknown };
			};
			const raw = data?.tables?.workspaces;
			const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});
			for (const ws of list) {
				if (!ws || typeof ws !== "object") continue;
				const info: WorkspaceInfo = {
					title: String((ws as { title?: unknown }).title ?? ""),
					path: String((ws as { path?: unknown }).path ?? ""),
				};
				if (info.path) byPath.set(info.path.toLowerCase(), info);
				const ids = (ws as { sessionIds?: unknown }).sessionIds;
				if (Array.isArray(ids)) for (const id of ids) bySession.set(String(id), info);
			}
		} catch { /* workspace.json 读不到就算了，回退到 cwd 文件名 */ }
		workspaceCache.at = now;
		workspaceCache.bySession = bySession;
		workspaceCache.byPath = byPath;
		return workspaceCache;
	}

	/** 会话所属工作区：sessionId 反查 → cwd 路径匹配 → cwd 文件名兜底。 */
	function workspaceOf(session: unknown, sessionId: string): WorkspaceInfo {
		const index = readWorkspaceIndex();
		const hit = index.bySession.get(sessionId);
		if (hit) return hit;
		const cwd = sessionCwdOf(session);
		if (cwd) return index.byPath.get(cwd.toLowerCase()) ?? { title: basename(cwd), path: cwd };
		return { title: "", path: "" };
	}

	/** 把工作区名 + 会话标题记进标签表（拿到 session 对象时调用）。 */
	function rememberLabel(session: unknown, sessionId: string): void {
		if (sessionId === "") return;
		sessionLabels.set(
			sessionId,
			formatCompletionLabel(workspaceOf(session, sessionId).title, sessionTitleOf(ctx, session, sessionId), sessionId),
		);
	}

	/** 通知里用的会话标签（优先工作区+标题，回退短 id）。 */
	function labelOf(sessionId: string): string {
		return sessionLabels.get(sessionId) ?? (sessionId.slice(0, 12) || "未命名会话");
	}

	/**
	 * 提示音队列（dsh-chime 合并）：通知真正发出时入队，client 半每 250ms
	 * 经 `/as-one/chime/poll` 取走播放。音效映射：会话完成 → done；
	 * 提问/授权 → question（都需要主人回来看，同一支「注意」音）。
	 * 只在 sendOwner 的通知点位传 chime，主人后续回话/失败提示不鸣音。
	 */
	const chimePending: { sound: string; at: number }[] = [];
	const pushChime = (sound: string): void => {
		chimePending.push({ sound, at: Date.now() });
		if (chimePending.length > 30) chimePending.splice(0, chimePending.length - 30);
	};

	const sendOwner = (text: string, chime?: string): void => {
		// 总开关关闭时连通知也不发（严格静默）—— 音效同样不发。
		if (config?.isWakeupEnabled && !config.isWakeupEnabled(OWNER_QQ, "private")) return;
		if (chime !== undefined) pushChime(chime);
		void Promise.resolve(bot.send({ kind: "private", id: OWNER_QQ }, text)).catch((err: unknown) => {
			ctx.logger?.warn?.("[as-one] bot-notify send failed:", err);
		});
	};

	/** 最近回合摘要：assistant/message 收集的文本；没收集到就明说。 */
	const summaryOf = (sessionId: string): string => {
		const text = String(recentTurnText.get(sessionId) ?? "").trim();
		return text || `会话 ${labelOf(sessionId)} 还没有可总结的助手回复`;
	};

	// 提示音轮询路由（client 半每 250ms 取走队列；15s 新鲜窗口，超过即弃 ——
	// 宿主重启或页面没开时兜底，避免陈旧音效到页面才响）。webServer handler
	// 抛错会被宿主 catch 成 400，所以这里全程 try 兜底。
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: "/as-one/chime/poll",
			handler: (_req, res) => {
				try {
					const now = Date.now();
					const fresh = chimePending.filter((p) => now - p.at <= 15_000);
					chimePending.length = 0;
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ sounds: fresh.map((p) => p.sound) }));
				} catch (err) {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ sounds: [], error: String(err) }));
				}
			},
		});
		return dispose;
	}, "@bvbhu/as-one/bot-notify: chime poll route");

	/** 把主人输入转进会话：steer 优先，followup 兜底；Agent 不接受输入就回话告知。 */
	const deliverToSession = (sessionId: string, text: string): void => {
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
			const offSession = (ctx as unknown as {
				on(event: string, listener: (session: unknown, event: unknown) => void): () => void;
			}).on("session/event", (session: unknown, event: unknown) => {
				const ev = event as { type?: string; data?: SessionEventData };
				const sessionId = sessionIdOf(session);
				if (sessionId === "" || ev?.type === undefined) return;

				if (ev.type === "assistant/message") {
					const text = assistantTextOf(ev as never);
					if (text.trim() !== "") recentTurnText.set(sessionId, text);
				rememberLabel(session, sessionId);
					return;
				}

				if (ev.type === "turn/end") {
					// 桥自建的 qq-* 会话不是主人的正经工作会话，完成通知跳过。
					if (sessionId.startsWith("qq-")) return;
					const reason = (ev.data as TurnEndData | undefined)?.reason;
					const okEnd = !reason || !reason.kind || reason.kind === "completed";
					if (!okEnd) return;
					// 排队消息非空时这一轮马上会继续，「完成」是误判；结构判断不了也保守跳过。
					const queued = queuedInputCountOf(rawAgentOf(agents, sessionId));
					if (queued === undefined || queued > 0) return;

					pendingNotice = { sessionId, until: Date.now() + REPLY_WINDOW_MS };
					rememberLabel(session, sessionId);
				sendOwner(`✅ 会话完成：${labelOf(sessionId)}`, "done");
					return;
				}

				if (ev.type === "tool/call") {
					const data = ev.data as ToolCallData | undefined;
					if (data?.name !== "ask_user_question") return;
					rememberLabel(session, sessionId);
				sendOwner(`🔔 会话在等你回答：${labelOf(sessionId)}（去 DSH 界面回答）`, "question");
					return;
				}

				if (ev.type === "approval/asked") {
					const data = ev.data as ApprovalAskedData | undefined;
					const tool = String(data?.toolName ?? "").trim() || "某工具";
					rememberLabel(session, sessionId);
				sendOwner(`🔐 ${labelOf(sessionId)} 请求授权：${tool}`, "question");
					return;
				}
			});

			const offFrame = (ctx as unknown as {
				on(event: string, listener: (payload: unknown) => void): () => void;
			}).on("asOne:bot-message", (frame: unknown) => {
				const f = frame as BotMessageFrame | null | undefined;
				// 只认主人私聊帧；且必须正处在「刚发完成通知」的等待窗口里。
				if (f?.targetId !== OWNER_QQ) return;
				const notice = pendingNotice;
				if (!notice || Date.now() >= notice.until) return;
				const text = String(f.text ?? "").trim();
				pendingNotice = null; // 一次交互即消费，避免窗口内多条消息串会话。
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
		"@bvbhu/as-one/bot-notify: session observers",
	);
}
