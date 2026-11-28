/**
 * QQ 路由 → DSH 会话的绑定表（配置文件维护，2026-11-27 用户定案）。
 *
 * 文件：`~/.as-one/bot-bindings.json`（与 as-one 的库/日志同目录，持久化统一存放；
 * 可用环境变量 `AS_ONE_HOME` 改根目录、`AS_ONE_BOT_BINDINGS` 直接指文件）。
 * 首次加载时若文件不存在，会自动写入一份带说明的空模板，用户按格式维护 `bindings` 列表。
 *
 * 格式：
 * {
 *   "bindings": [
 *     { "route": "private:3187192488", "session": "session-4ead55ce", "mode": "chat",
 *       "wakeWords": ["爱莉", "爱莉希雅"], "schedule": { "every": "30m", "prompt": "主动说一句" } }
 *   ]
 * }
 *
 * 字段：
 *   route    必填，`private:<QQ号>` 或 `group:<群号>`
 *   session  必填，会话 ID（可只写前 8 位以上的唯一前缀）或会话标题
 *   mode     'chat'（缺省）| 'assistant'
 *   wakeWords 可选，聊天档群聊唤醒词；缺省用默认词表
 *   schedule 可选，定时唤醒：字符串间隔（如 "30m"）或 { every: "30m", prompt: "..." }
 *
 * 读取按 mtime 缓存：改文件后下一条消息即生效，无需重启。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 绑定档位。 */
export type BotBindMode = "chat" | "assistant";

/** 默认唤醒词（与旧版角色卡一致；群聊命中任一即唤醒）。 */
export const DEFAULT_WAKE_WORDS = ["爱莉", "爱莉希雅", "昔涟", "elysia", "cyrene"];

/** 默认定时唤醒提示词。 */
export const DEFAULT_SCHEDULE_PROMPT = "（定时唤醒）现在主动说一句话，像平常一样自然。";

/** 一条绑定。 */
export interface BotBinding {
	route: string;
	/** 文件里写的原值（ID / 前缀 / 标题）。 */
	session: string;
	mode: BotBindMode;
	wakeWords: string[];
	schedule: { everySeconds: number; prompt: string } | null;
}

/** 加载结果。 */
export interface BindingsLoad {
	file: string;
	bindings: BotBinding[];
	errors: string[];
}

/** 环境变量：as-one 持久化根目录（缺省 ~/.as-one，与库/日志同目录）。 */
export const AS_ONE_HOME_ENV = "AS_ONE_HOME";

/** 环境变量：绑定表路径覆盖。 */
export const BINDINGS_ENV = "AS_ONE_BOT_BINDINGS";

/** as-one 持久化根目录：AS_ONE_HOME 或 ~/.as-one。 */
export function asOneHome(env: NodeJS.ProcessEnv = process.env): string {
	const override = String(env[AS_ONE_HOME_ENV] ?? "").trim();
	return override !== "" ? override : join(homedir(), ".as-one");
}

/** 绑定表路径：<as-one 根目录>/bot-bindings.json，可被 AS_ONE_BOT_BINDINGS 覆盖。 */
export function bindingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
	const override = String(env[BINDINGS_ENV] ?? "").trim();
	if (override !== "") return override;
	return join(asOneHome(env), "bot-bindings.json");
}

/** 空模板（自动创建时写入；`_说明` 为纯提示，解析时忽略）。 */
export const BINDINGS_TEMPLATE = {
	_说明: [
		"as-one 的 QQ 路由 → DSH 会话绑定表（与 as-one.db / logs 同在 ~/.as-one）。",
		"改完保存即生效（按文件修改时间热读，无需重启）。",
		"route: private:<QQ号> 或 group:<群号>；未列出的聊天不会唤醒任何会话（消息直接丢弃）。",
		"session: DSH 会话 ID（可写前 8 位以上的唯一前缀）或会话标题。",
		"mode: chat（聊天档：私聊视为 @ 全部唤醒；群聊需 @ 或命中唤醒词）| assistant（助理档：私聊唤醒、群聊仅 @）。",
		"wakeWords / schedule 可选；schedule 支持 \"30m\" 或 { \"every\": \"30m\", \"prompt\": \"...\" }。",
	],
	_示例: {
		route: "private:3187192488",
		session: "session-xxxxxxxx（会话 ID 前缀或标题）",
		mode: "chat",
		wakeWords: ["爱莉", "爱莉希雅"],
		schedule: { every: "30m", prompt: "主动说一句话" },
	},
	bindings: [],
};

/** 解析间隔：90s / 30m / 2h / 1d / 纯秒数。 */
export function parseInterval(raw: string): number | null {
	const text = String(raw ?? "").trim().toLowerCase();
	const match = /^(\d+(?:\.\d+)?)\s*(s|秒|m|分|h|时|d|天)?$/.exec(text);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unit = match[2] ?? "s";
	const factor = unit === "m" || unit === "分" ? 60 : unit === "h" || unit === "时" ? 3600 : unit === "d" || unit === "天" ? 86_400 : 1;
	return Math.max(30, Math.round(value * factor));
}

/** 间隔 → 人读文案。 */
export function formatInterval(seconds: number): string {
	if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
	if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
	if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
	return `${seconds} 秒`;
}

/** 唤醒词字符串/数组 → 去重词表。 */
export function parseWakeWords(raw: unknown): string[] {
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,，、\s]+/) : [];
	const out: string[] = [];
	const seen = new Set<string>();
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

/** 唤醒词匹配：大小写不敏感子串；命中取**最长**的词，未命中返回空串。 */
export function matchWakeWord(text: string, words: string[]): string {
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

/** 路由键。 */
export function chatKeyOf(messageType: "private" | "group", targetId: string): string {
	return `${messageType}:${targetId}`;
}

/** 路由键 → {kind,id}（定时唤醒用）。 */
export function targetOfRoute(route: string): { kind: "private" | "group"; id: string } | null {
	const match = /^(private|group):(.+)$/.exec(route);
	if (!match) return null;
	return { kind: match[1] as "private" | "group", id: match[2] };
}

/** 解析一条原始绑定（可能来自用户手写，格式不符返回 null + 原因）。 */
export function normalizeBinding(raw: unknown, index: number): { binding: BotBinding | null; error: string } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { binding: null, error: `bindings[${index}] 不是对象` };
	}
	const entry = raw as { route?: unknown; session?: unknown; mode?: unknown; wakeWords?: unknown; schedule?: unknown };
	const route = String(entry.route ?? "").trim();
	const session = String(entry.session ?? "").trim();
	if (!/^(private|group):.+$/.test(route)) {
		return { binding: null, error: `bindings[${index}] route 必须是 private:<QQ号> 或 group:<群号>` };
	}
	if (session === "") {
		return { binding: null, error: `bindings[${index}] 缺少 session` };
	}
	const mode: BotBindMode = entry.mode === "assistant" ? "assistant" : "chat";
	const wakeWords = parseWakeWords(entry.wakeWords);
	let schedule: BotBinding["schedule"] = null;
	const rawSchedule = entry.schedule;
	if (typeof rawSchedule === "string" && rawSchedule.trim() !== "") {
		const every = parseInterval(rawSchedule);
		if (every !== null) schedule = { everySeconds: every, prompt: DEFAULT_SCHEDULE_PROMPT };
	} else if (rawSchedule && typeof rawSchedule === "object" && !Array.isArray(rawSchedule)) {
		const obj = rawSchedule as { every?: unknown; prompt?: unknown };
		const every = parseInterval(String(obj.every ?? ""));
		if (every !== null) {
			const prompt = typeof obj.prompt === "string" && obj.prompt.trim() !== "" ? obj.prompt.trim() : DEFAULT_SCHEDULE_PROMPT;
			schedule = { everySeconds: every, prompt };
		}
	}
	return { binding: { route, session, mode, wakeWords, schedule }, error: "" };
}

/** 解析整份文档（不做文件 IO，便于单测）。 */
export function parseBindings(raw: unknown): { bindings: BotBinding[]; errors: string[] } {
	const errors: string[] = [];
	const bindings: BotBinding[] = [];
	if (raw === null || typeof raw !== "object") return { bindings, errors: ["绑定表不是对象"] };
	const list = (raw as { bindings?: unknown }).bindings;
	if (!Array.isArray(list)) return { bindings, errors: ["缺少 bindings 数组"] };
	list.forEach((item, index) => {
		const result = normalizeBinding(item, index);
		if (result.binding) bindings.push(result.binding);
		else errors.push(result.error);
	});
	return { bindings, errors };
}

/** 加载缓存：同一路径 + 相同 mtime/size 不重复解析。 */
const loadCache = new Map<string, { mtimeMs: number; size: number; result: BindingsLoad }>();

/** 读绑定表；文件缺失自动写模板；损坏返回空表 + 错误（不抛异常）。 */
export function loadBindings(env: NodeJS.ProcessEnv = process.env): BindingsLoad {
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
			if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(BINDINGS_TEMPLATE, null, 2)}\n`, "utf8");
			stat = statSync(file);
		} catch {
			return { file, bindings: [], errors: [`无法创建绑定表 ${file}`] };
		}
	}
	const cached = loadCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;
	let result: BindingsLoad;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		const { bindings, errors } = parseBindings(parsed);
		result = { file, bindings, errors };
	} catch (err) {
		result = { file, bindings: [], errors: [`解析失败：${(err as Error).message}`] };
	}
	loadCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result });
	return result;
}

/** 按路由取绑定。 */
export function bindingFor(bindings: BotBinding[], route: string): BotBinding | undefined {
	return bindings.find((binding) => binding.route === route);
}

/** 会话 id / 前缀 / 标题解析缓存（按 DSH_HOME 分键，30 秒）。 */
const resolveCache = { home: "", at: 0, ids: [] as string[], titles: new Map<string, string>() };

/** 扫 DSH 会话目录 + 投影缓存，得到 id 与标题索引。 */
function refreshSessionIndex(env: NodeJS.ProcessEnv): void {
	const now = Date.now();
	const home = String(env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh");
	if (resolveCache.home === home && now - resolveCache.at < 30_000) return;
	resolveCache.home = home;
	resolveCache.at = now;
	const ids = new Set<string>();
	const titles = new Map<string, string>();
	try {
		const sessionsDir = join(home, "sessions");
		for (const slug of readdirSync(sessionsDir)) {
			const dir = join(sessionsDir, slug);
			let entries: string[] = [];
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
		// 没有 sessions 目录：只靠投影缓存。
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
				// 单个投影文件坏掉跳过。
			}
		}
	} catch {
		// 没有投影缓存。
	}
	resolveCache.ids = [...ids];
	resolveCache.titles = titles;
}

/** 搜索结果里的一条会话。 */
export interface SessionSummary {
	id: string;
	title: string;
}

/** 标题/ID 子串搜索：全等 → 前缀 → 子串，按命中质量排序。 */
export function searchSessions(
	query: string,
	env: NodeJS.ProcessEnv = process.env,
	limit = 20,
): SessionSummary[] {
	const want = String(query ?? "").trim().toLowerCase();
	if (want === "") return [];
	refreshSessionIndex(env);
	// 搜索面 = 标题索引 ∪ 目录扫出的会话 id（projcache 缺标题时 ID 仍可搜）。
	const entries = new Map<string, string>(resolveCache.titles);
	for (const id of resolveCache.ids) if (!entries.has(id)) entries.set(id, "");
	const out: Array<SessionSummary & { rank: number }> = [];
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

/** 会话引用解析：全 ID → 唯一前缀 → 标题（全等优先，其次唯一子串）。 */
export function resolveSessionRef(ref: string, env: NodeJS.ProcessEnv = process.env): string {
	const want = String(ref ?? "").trim().replace(/^[`'"]+|[`'"]+$/g, "");
	if (want === "") return "";
	refreshSessionIndex(env);
	const lower = want.toLowerCase();
	const ids = resolveCache.ids;
	if (ids.includes(want)) return want;
	const prefixHits = ids.filter((id) => id.toLowerCase().startsWith(lower));
	if (prefixHits.length === 1) return prefixHits[0]!;
	const titleExact = [...resolveCache.titles.entries()].filter(([, title]) => title.toLowerCase() === lower);
	if (titleExact.length === 1) return titleExact[0]![0];
	const titlePart = [...resolveCache.titles.entries()].filter(([, title]) => title.toLowerCase().includes(lower));
	if (titlePart.length === 1) return titlePart[0]![0];
	return "";
}