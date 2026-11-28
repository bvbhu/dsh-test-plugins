import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "./bot-session-tools.js";
import type { Context } from "./context-types.js";

/** 极简 cordis Context 替身：tools.register 捕获定义，外加 get/on/effect/logger/agents。 */
function fakeCtx(services: Record<string, unknown>, agents?: unknown) {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	const disposers: (() => void)[] = [];
	const tools = new Map<string, { def: unknown; dispose: () => void }>();
	const ctx = {
		agents,
		logger: { info: (): void => {}, warn: (): void => {} },
		tools: {
			register(def: { name: string }) {
				const dispose = () => {
					tools.delete(def.name);
				};
				tools.set(def.name, { def, dispose });
				return dispose;
			},
		},
		get: (name: string): unknown => services[name],
		on: (event: string, listener: (...args: unknown[]) => void): (() => void) => {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
			return () => {
				listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener));
			};
		},
		effect: (fn: () => (() => void) | void): void => {
			const dispose = fn();
			if (typeof dispose === "function") disposers.push(dispose);
		},
		emit: (event: string, ...args: unknown[]): void => {
			for (const listener of listeners.get(event) ?? []) listener(...args);
		},
		disposeAll: (): void => {
			for (const dispose of disposers.reverse()) dispose();
		},
	};
	return { ctx, tools };
}

/** 可观测的假 agents：get 返回 live agent（若有），否则 resume 一个。 */
function fakeAgents(
	live: Map<string, { steers: unknown[]; followups: unknown[]; steer?: unknown; followup?: unknown; cancel?: unknown }>,
) {
	const resumed: string[] = [];
	return {
		resumed,
		get(sessionId: string) {
			return live.get(sessionId);
		},
		async resume(options: { resumeSessionId: string }) {
			resumed.push(options.resumeSessionId);
			const agent = {
				steers: [] as unknown[],
				followups: [] as unknown[],
				steer: (m: unknown) => agent.steers.push(m),
				followup: (m: unknown) => agent.followups.push(m),
				cancel: () => {},
			};
			live.set(options.resumeSessionId, agent);
			return { agent, dispose: () => {} };
		},
	};
}

/** 构造一次 apply 并返回工具表与观测数据；sessionQuery 为可选服务替身。 */
function run(sessionQuery?: unknown, recentHistory?: unknown) {
	const sent: { t: unknown; text: string }[] = [];
	const live = new Map<
		string,
		{ steers: unknown[]; followups: unknown[]; steer?: unknown; followup?: unknown; cancel?: unknown }
	>();
	const agents = fakeAgents(live as never);
	const { ctx, tools } = fakeCtx(
		{
			asOneBotChannel: {
				send: async (t: unknown, text: string) => sent.push({ t, text }),
				...(recentHistory
					? {
							recentHistory,
							status: () => ({ connected: true, qq: "10000" }),
						}
					: {}),
			},
			...(sessionQuery ? { sessionQuery } : {}),
		},
		agents,
	);
	apply(ctx as unknown as Context);
	return { ctx, tools, agents, live, sent };
}

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	delete process.env.DSH_HOME;
	delete process.env.AS_ONE_BOT_BINDINGS;
});

/** 测试夹具：临时 DSH_HOME + 会话目录 + 绑定表文件，并通过环境变量指给行。 */
function fixture(bindings: unknown[], sessionIds: string[]) {
	const home = mkdtempSync(join(tmpdir(), "as-one-st-"));
	temps.push(home);
	for (const id of sessionIds) mkdirSync(join(home, "sessions", "slug-a", id), { recursive: true });
	const file = join(home, "bot-bindings.json");
	writeFileSync(file, JSON.stringify({ bindings }, null, 2), "utf8");
	process.env.DSH_HOME = home;
	process.env.AS_ONE_BOT_BINDINGS = file;
	return { home, file };
}

/** exec 替身：当前会话 id 从 exec.agent.session.header.id 取。 */
function execOf(sessionId: string) {
	return { agent: { session: { header: { id: sessionId } } } };
}

function call(tools: Map<string, { def: unknown; dispose: () => void }>, name: string, args: unknown, exec: unknown) {
	const entry = tools.get(name);
	if (!entry) throw new Error(`tool ${name} not registered`);
	const def = entry.def as {
		execute(args: unknown, exec: unknown): Promise<unknown>;
	};
	return def.execute(args, exec) as Promise<string>;
}

describe("search_sessions", () => {
	it("命中标题/ID 子串返回列表；无命中给提示", async () => {
		fixture([], ["session-abc12345", "session-def67890"]);
		const { tools } = run();
		const hits = await call(tools, "search_sessions", { query: "session-abc" }, execOf("session-abc12345"));
		expect(hits).toContain("session-abc12345");
		const none = await call(tools, "search_sessions", { query: "zzzz" }, execOf("session-abc12345"));
		expect(none).toContain("没有匹配");
	});
});

describe("deliver_message", () => {
	it("已绑定会话：正文通过通道发回绑定路由", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a"]);
		const { tools, sent } = run();
		const out = await call(tools, "deliver_message", { text: "你好呀" }, execOf("session-a"));
		expect(out).toContain("已发送");
		expect(sent.map((item) => item.text)).toEqual(["你好呀"]);
	});

	it("未绑定会话被拒绝", async () => {
		fixture([], ["session-a"]);
		const { tools } = run();
		const out = await call(tools, "deliver_message", { text: "你好呀" }, execOf("session-a"));
		expect(out).toContain("未绑定");
	});
});

describe("send_to_session（3187192488 专属）", () => {
	it("绑定会话：resume 对方并 steer 一次，消息正文正确", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools, agents, live } = run();
		const out = await call(tools, "send_to_session", { session: "session-b", text: "帮我看下这个" }, execOf("session-a"));
		expect(out).toContain("已向会话 session-b 投递消息");
		expect(agents.resumed).toEqual(["session-b"]);
		const steered = live.get("session-b")!.steers;
		expect(steered).toHaveLength(1);
		expect(live.get("session-b")!.followups).toHaveLength(0);
		const body = steered[0] as { content: { text: string }[]; source: { kind: string; rpcId?: string } };
		expect(body.content[0].text).toBe("帮我看下这个");
		// 无认领 rpcId：回复留在对方会话，不回 QQ。
		expect(body.source.rpcId).toBeUndefined();
	});

	it("对方 agent 在内存 → 直接 steer，不再 resume", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools, agents, live } = run();
		live.set("session-b", { steers: [] as unknown[], followups: [] as unknown[], steer: (m: unknown) => live.get("session-b")!.steers.push(m), followup: (m: unknown) => {}, cancel: () => {} });
		await call(tools, "send_to_session", { session: "session-b", text: "在吗" }, execOf("session-a"));
		expect(agents.resumed).toEqual([]);
		expect(live.get("session-b")!.steers).toHaveLength(1);
	});

	it("前缀/标题解析目标；解析不到报错", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-target-999"]);
		const { tools, agents } = run();
		const ok = await call(tools, "send_to_session", { session: "session-target", text: "hi" }, execOf("session-a"));
		expect(ok).toContain("session-target-999");
		expect(agents.resumed).toEqual(["session-target-999"]);
		const bad = await call(tools, "send_to_session", { session: "不存在的会话", text: "hi" }, execOf("session-a"));
		expect(bad).toContain("解析不到会话");
	});

	it("非绑定会话调用被拒绝", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools, agents } = run();
		const out = await call(tools, "send_to_session", { session: "session-b", text: "hi" }, execOf("session-other"));
		expect(out).toContain("仅绑定 private:3187192488");
		expect(agents.resumed).toEqual([]);
	});

	it("超长消息与空参数被拒绝", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools, agents } = run();
		const long = await call(tools, "send_to_session", { session: "session-b", text: "x".repeat(8001) }, execOf("session-a"));
		expect(long).toContain("8000");
		const empty = await call(tools, "send_to_session", { session: "", text: "hi" }, execOf("session-a"));
		expect(empty).toContain("session 不能为空");
		expect(agents.resumed).toEqual([]);
	});

	it("行卸载：cancel + dispose 缓存的 resume 句柄", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { ctx, tools } = run();
		await call(tools, "send_to_session", { session: "session-b", text: "hi" }, execOf("session-a"));
		ctx.disposeAll();
	});
});

describe("read_session（3187192488 专属）", () => {
	/** sessionQuery 替身：按会话 id 返回事件数组。 */
	function fakeEngine(eventsBySession: Record<string, unknown[]>, failOn?: string) {
		return {
			readSession: async (sessionId: string) => {
				if (failOn && sessionId === failOn) throw new Error("corpus miss");
				return { events: eventsBySession[sessionId] ?? [] };
			},
		};
	}

	const sessionBEvents = [
		{ type: "session", seq: 0, time: "2026-11-27T00:00:00Z", data: {} },
		{ type: "user/message", seq: 1, time: "2026-11-27T00:00:00Z", data: { content: [{ type: "text", text: "你好" }] } },
		{
			type: "assistant/message",
			seq: 2,
			time: "2026-11-27T00:00:00Z",
			data: { message: { content: [{ type: "reasoning", text: "内部思考" }, { type: "text", text: "你好呀" }] } },
		},
		{
			type: "assistant/message",
			seq: 3,
			time: "2026-11-27T00:00:00Z",
			data: { message: { content: [{ type: "tool-call", text: "调用工具" }, { type: "text", text: "最后回复" }] } },
		},
	];

	it("绑定会话：经 sessionQuery 读取，只取用户/助手正文，跳过推理与工具块", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools } = run(fakeEngine({ "session-b": sessionBEvents }));
		const out = await call(tools, "read_session", { session: "session-b" }, execOf("session-a"));
		expect(out).toContain("3 条消息（该会话共 3 条）");
		expect(out).toContain("[用户] 你好");
		expect(out).toContain("[助手] 你好呀");
		expect(out).toContain("[助手] 最后回复");
		// reasoning / tool-call 块不出现。
		expect(out).not.toContain("内部思考");
		expect(out).not.toContain("调用工具");
		// session 元信息事件不出现。
		expect(out).not.toContain("session/event");
	});

	it("limit 取最近 N 条，默认 20", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools } = run(fakeEngine({ "session-b": sessionBEvents }));
		const one = await call(tools, "read_session", { session: "session-b", limit: 1 }, execOf("session-a"));
		expect(one).toContain("1 条消息（该会话共 3 条）");
		expect(one).toContain("[助手] 最后回复");
		expect(one).not.toContain("[用户] 你好");
	});

	it("非绑定会话调用被拒绝", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools } = run(fakeEngine({ "session-b": sessionBEvents }));
		const out = await call(tools, "read_session", { session: "session-b" }, execOf("session-other"));
		expect(out).toContain("仅绑定 private:3187192488");
	});

	it("readSession 抛错时优雅降级为错误提示", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools } = run(fakeEngine({}, "session-b"));
		const out = await call(tools, "read_session", { session: "session-b" }, execOf("session-a"));
		expect(out).toContain("读取会话 session-b 的日志失败");
		expect(out).toContain("corpus miss");
	});

	it("目标会话无文本消息时报错", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools } = run(fakeEngine({ "session-b": [{ type: "session", seq: 0, data: {} }] }));
		const out = await call(tools, "read_session", { session: "session-b" }, execOf("session-a"));
		expect(out).toContain("没有用户/助手的文本消息");
	});

	it("sessionQuery 服务缺失时优雅降级", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a", "session-b"]);
		const { tools } = run();
		const out = await call(tools, "read_session", { session: "session-b" }, execOf("session-a"));
		expect(out).toContain("宿主未提供 sessionQuery 服务");
	});

	it("解析不到目标会话时报错", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a"]);
		const { tools } = run(fakeEngine({}));
		const out = await call(tools, "read_session", { session: "不存在" }, execOf("session-a"));
		expect(out).toContain("解析不到会话");
	});
});

describe("qq_recent_history", () => {
	/** OneBot get_group_msg_history 响应的 messages 形状替身。 */
	const groupMessages = [
		{ message: [{ type: "text", data: { text: "在吗" } }], time: 1730000000, sender: { user_id: 20001, nickname: "小明" } },
		{ message: [{ type: "text", data: { text: "在的" } }], time: 1730000060, sender: { user_id: "10000", card: "主人" } },
		{ message: [{ type: "text", data: { text: "那帮我看看" } }], time: 1730000120, sender: { user_id: 20001, card: "小明" } },
	];

	it("绑定群会话：渲染升序消息，机器人自己的消息带（我）标记", async () => {
		fixture([{ route: "group:873745856", session: "session-a", mode: "assistant" }], ["session-a"]);
		const calls: { target: unknown; limit?: unknown }[] = [];
		const { tools } = run(undefined, async (target: unknown, limit?: number) => {
			calls.push({ target, limit });
			return groupMessages;
		});
		const out = await call(tools, "qq_recent_history", {}, execOf("session-a"));
		expect(calls).toEqual([{ target: { kind: "group", id: "873745856" }, limit: 20 }]);
		expect(out).toContain("[群聊 共 3 条，显示最近 3 条]");
		expect(out).toContain("小明: 在吗");
		expect(out).toContain("主人（我）: 在的");
		expect(out).toContain("小明: 那帮我看看");
	});

	it("私聊路由标题为私聊；limit 夹到 1–100", async () => {
		fixture([{ route: "private:20001", session: "session-a", mode: "assistant" }], ["session-a"]);
		const calls: { target: unknown; limit?: unknown }[] = [];
		const { tools } = run(undefined, async (target: unknown, limit?: number) => {
			calls.push({ target, limit });
			return [{ message: [{ type: "text", data: { text: "hi" } }], time: 1730000000, sender: { user_id: 20001, nickname: "小明" } }];
		});
		const out = await call(tools, "qq_recent_history", { limit: 500 }, execOf("session-a"));
		expect(calls[0].target).toEqual({ kind: "private", id: "20001" });
		expect(calls[0].limit).toBe(100);
		expect(out).toContain("[私聊 共 1 条，显示最近 1 条]");
	});

	it("通道未提供 recentHistory（旧行）时优雅降级", async () => {
		fixture([{ route: "group:873745856", session: "session-a", mode: "assistant" }], ["session-a"]);
		const { tools } = run();
		const out = await call(tools, "qq_recent_history", {}, execOf("session-a"));
		expect(out).toContain("不支持读取聊天记录");
	});

	it("recentHistory 抛错时优雅降级为错误提示", async () => {
		fixture([{ route: "group:873745856", session: "session-a", mode: "assistant" }], ["session-a"]);
		const { tools } = run(undefined, async () => {
			throw new Error("OneBot connection closed");
		});
		const out = await call(tools, "qq_recent_history", {}, execOf("session-a"));
		expect(out).toContain("读取聊天记录失败");
		expect(out).toContain("OneBot connection closed");
	});

	it("未绑定会话被拒绝", async () => {
		fixture([], ["session-a"]);
		const { tools } = run(undefined, async () => []);
		const out = await call(tools, "qq_recent_history", {}, execOf("session-a"));
		expect(out).toContain("未绑定 QQ 路由");
	});
});
