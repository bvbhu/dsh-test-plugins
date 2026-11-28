/**
 * QQ 回复控制（chat / assistant 两行与 bot-session-tools 行共享）。
 *
 * 2026-11-27 用户定案：
 *   - 私聊与群聊路由的会话：回复 = 调用 deliver_message 工具输出（工具把
 *     文本直接发回 QQ），中继不再回读会话输出；
 *   - deliver_message 限制：每个「新到的人类消息」只能成功发送一次；
 *     超过 3000 字拒绝（返回指引，不消耗次数）；只有真人消息刷新次数
 *     （本插件自己投的 as-one-bot: 消息也视为新消息；工具自己投的
 *     as-one-tool: 消息不刷新，避免无限自我投递）；
 *   - 模型没调用工具就结束回合时，中继兜底发一条文本，并追加发指令
 *     要求模型用工具回复（见 bot-relay.ts 的 turn/end）。
 *
 * 进程内单例：行与工具行都 import 本模块，天然共享同一份状态。
 */
import type { RelayRoute } from "./bot-relay.js";
import {
	bindingFor,
	loadBindings,
	resolveSessionRef,
	targetOfRoute,
} from "./bot-bindings.js";
import type { BotBinding } from "./bot-bindings.js";

/** deliver_message 工具投递的消息认领前缀（防止工具投递的消息刷新次数）。 */
export const TOOL_RPC_PREFIX = "as-one-tool:";

/** 单次回复长度上限（QQ 文本消息安全余量）。 */
export const MAX_REPLY_CHARS = 3000;

/** 发送失败/被拒时的结构化结果。 */
export interface ReplyResult {
	ok: boolean;
	/** 失败时的中文原因（直接作为工具错误返回给模型）。 */
	error?: string;
}

/** 发送通道（与 bot-relay 的 RelayChannel 同形）。 */
export interface ReplyChannel {
	send(route: RelayRoute, text: string): Promise<void>;
}

/** 日志窄接口。 */
export interface ReplyLogger {
	warn?(...args: unknown[]): void;
	info?(...args: unknown[]): void;
}

/**
 * sessionId → 本回合是否已工具回复。
 *
 * ⚠️ 进程内可变单例（review P3）：delivered / channel / logger 都活在这个
 * 模块实例上，语义依赖「每进程恰好一份」。host bundle 用 esbuild splitting
 * 把多行共用模块收进共享 chunk（单实例），所以行之间共享没问题；**不要**把
 * 本文件复制成第二份真源（旧 gateway-upstream parity 副本就是这么漂移的），
 * 否则两份 delivered 各记各的，工具回复去重会漏。
 */
const delivered = new Map<string, boolean>();

/** 已注册的发送通道（行挂载时注入；未注入时所有发送按失败处理）。 */
let channel: ReplyChannel | undefined;

/** 日志。 */
let logger: ReplyLogger | undefined;

/** 行挂载时注入通道（幂等）。 */
export function setReplyChannel(next: ReplyChannel | undefined, log?: ReplyLogger): void {
	channel = next;
	logger = log ?? logger;
}

/** 当前会话 → 绑定（先按文件原值全等匹配，再走解析器兜底）。 */
export function bindingForSession(sessionId: string): BotBinding | undefined {
	const { bindings } = loadBindings();
	for (const binding of bindings) {
		if (binding.session === sessionId) return binding;
	}
	for (const binding of bindings) {
		if (resolveSessionRef(binding.session) === sessionId) return binding;
	}
	return undefined;
}

/** 人类消息到达：刷新次数（工具自投的 as-one-tool: 消息除外）。 */
export function onUserMessage(sessionId: string, rpcId?: unknown): void {
	if (typeof rpcId === "string" && rpcId.startsWith(TOOL_RPC_PREFIX)) return;
	delivered.set(sessionId, false);
}

/** 本回合是否已通过工具回复（中继兜底判断用；未初始化按未回复）。 */
export function wasDelivered(sessionId: string): boolean {
	return delivered.get(sessionId) === true;
}

/**
 * deliver_message 的发送入口：
 *   - 校验会话绑定存在（私聊/群聊路由均可）；
 *   - 校验次数（本回合未发送过）与长度（≤ MAX_REPLY_CHARS）；
 *   - 成功发送后消耗次数。
 * 长度/未绑定被拒时**不**消耗次数（模型可修正后重试）。
 */
export async function tryDeliver(sessionId: string, text: string): Promise<ReplyResult> {
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
			error: `回复超过 ${MAX_REPLY_CHARS} 字上限（${body.length} 字）：请精简后重发，或拆成多条短句只发最关键的一条`,
		};
	}
	if (!channel) {
		return { ok: false, error: "QQ 通道未就绪（插件行未挂载），发送失败" };
	}
	try {
		await channel.send({ kind: target.kind, id: target.id }, body);
	} catch (err) {
		logger?.warn?.(`[as-one] bot-reply send failed (${sessionId}):`, err);
		return { ok: false, error: `发送失败：${(err as Error).message ?? String(err)}` };
	}
	delivered.set(sessionId, true);
	return { ok: true };
}

/** 清理（测试用）。 */
export function resetReplyState(): void {
	delivered.clear();
	channel = undefined;
	logger = undefined;
}
