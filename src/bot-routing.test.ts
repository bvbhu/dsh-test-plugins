import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as applyAssistant } from "./bot-assistant-row.js";
import { apply as applyChat } from "./bot-chat-row.js";
import type { Context } from "./context-types.js";

/** 极简 cordis Context 替身：只实现行用到的 get/on/effect/logger + agents。 */
function fakeCtx(services: Record<string, unknown>, agents?: unknown) {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	const disposers: (() => void)[] = [];
	const ctx = {
		agents,
		logger: { info: (): void => {}, warn: (): void => {} },
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
	return ctx;
}

/** 可观测的假 agents：get 返回 live agent（若有），否则 resume 一个。 */
function fakeAgents(live: Map<string, { steers: unknown[]; followups: unknown[] }>) {
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

const FLUSH = async (times = 3): Promise<void> => {
	for (let i = 0; i < times; i += 1) await Promise.resolve();
};

function frame(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		messageType: "private" as const,
		targetId: "3187192488",
		userId: "3187192488",
		text: "在吗",
		segments: [],
		atBot: false,
		raw: {},
		...overrides,
	};
}

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	delete process.env.DSH_HOME;
	delete process.env.AS_ONE_BOT_BINDINGS;
});

/** 测试夹具：临时 DSH_HOME + 会话目录 + 绑定表文件，并通过环境变量指给行。 */
function fixture(bindings: unknown[], sessionIds: string[]) {
	const home = mkdtempSync(join(tmpdir(), "as-one-routing-"));
	temps.push(home);
	for (const id of sessionIds) mkdirSync(join(home, "sessions", "slug-a", id), { recursive: true });
	const file = join(home, "bot-bindings.json");
	writeFileSync(file, JSON.stringify({ bindings }, null, 2), "utf8");
	process.env.DSH_HOME = home;
	process.env.AS_ONE_BOT_BINDINGS = file;
	return { home, file };
}

/** 跑两行之一：返回 ctx / agents / live / sent。 */
function run(row: "chat" | "assistant") {
	const sent: { t: unknown; text: string }[] = [];
	const live = new Map<string, { steers: unknown[]; followups: unknown[] }>();
	const agents = fakeAgents(live as never);
	const ctx = fakeCtx(
		{
			asOneBotChannel: { send: async (t: unknown, text: string) => sent.push({ t, text }), status: () => ({ connected: true, qq: null }) },
			asOneBotConfig: { isWakeupEnabled: () => true, isWakeupGloballyEnabled: () => true },
		},
		agents,
	);
	if (row === "chat") applyChat(ctx as unknown as Context);
	else applyAssistant(ctx as unknown as Context);
	return { ctx, agents, live, sent };
}

describe("bot-chat 行：配置文件绑定 + 唤醒 + 投递 + 回传", () => {
	it("未绑定 → 丢弃，不 resume", async () => {
		fixture([], ["session-a"]);
		const { ctx, agents } = run("chat");
		ctx.emit("asOne:bot-message", frame());
		await FLUSH();
		expect(agents.resumed).toEqual([]);
		ctx.disposeAll();
	});

	it("私聊一律唤醒（视为 @），只 steer 一次；助理档没调用工具时兜底回传", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a"]);
		const { ctx, agents, live, sent } = run("assistant");
		ctx.emit("asOne:bot-message", frame({ text: "今天天气不错" }));
		await FLUSH();
		expect(agents.resumed).toEqual(["session-a"]);
		expect(live.get("session-a")!.steers).toHaveLength(1);
		expect(live.get("session-a")!.followups).toHaveLength(0);
		const session = { header: { id: "session-a" } };
		ctx.emit("session/event", session, { type: "turn/start" });
		ctx.emit("session/event", session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "聊星星吧♪" }] } } });
		ctx.emit("session/event", session, { type: "turn/end" });
		await FLUSH();
		expect(sent).toEqual([{ t: { kind: "private", id: "3187192488" }, text: "聊星星吧♪" }]);
		ctx.disposeAll();
	});

	it("群聊：未 @ 且无唤醒词静默；@ 唤醒；命中唤醒词唤醒", async () => {
		fixture([{ route: "group:664364260", session: "session-g", mode: "chat" }], ["session-g"]);
		const { ctx, agents, live } = run("chat");
		const groupFrame = (extra: Record<string, unknown>) =>
			frame({ messageType: "group", targetId: "664364260", userId: "42", raw: { sender: { card: "群友" } }, ...extra });
		ctx.emit("asOne:bot-message", groupFrame({ text: "随便聊聊" }));
		await FLUSH();
		expect(agents.resumed).toEqual([]);
		ctx.emit("asOne:bot-message", groupFrame({ text: "在吗", atBot: true }));
		await FLUSH();
		expect(agents.resumed).toEqual(["session-g"]);
		ctx.emit("asOne:bot-message", groupFrame({ text: "爱莉今天好呀" }));
		await FLUSH();
		expect(agents.resumed).toEqual(["session-g"]); // 已 resume，复用句柄
		expect(live.get("session-g")!.steers).toHaveLength(2);
		const first = live.get("session-g")!.steers[0] as { content: { text: string }[] };
		expect(first.content[0]!.text).toContain("[群 664364260] 群友：");
		ctx.disposeAll();
	});

	it("mode=assistant → chat 行跳过", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a"]);
		const { ctx, agents } = run("chat");
		ctx.emit("asOne:bot-message", frame());
		await FLUSH();
		expect(agents.resumed).toEqual([]);
		ctx.disposeAll();
	});

	it("session 写唯一前缀也能投递", async () => {
		fixture([{ route: "private:3187192488", session: "session-abc", mode: "chat" }], ["session-abc12345"]);
		const { ctx, agents } = run("chat");
		ctx.emit("asOne:bot-message", frame());
		await FLUSH();
		expect(agents.resumed).toEqual(["session-abc12345"]);
		ctx.disposeAll();
	});

	it("绑定表损坏 → 静默丢弃，不抛异常", async () => {
		const home = mkdtempSync(join(tmpdir(), "as-one-routing-"));
		temps.push(home);
		const file = join(home, "bot-bindings.json");
		writeFileSync(file, "{oops", "utf8");
		process.env.DSH_HOME = home;
		process.env.AS_ONE_BOT_BINDINGS = file;
		const { ctx, agents } = run("chat");
		ctx.emit("asOne:bot-message", frame());
		await FLUSH();
		expect(agents.resumed).toEqual([]);
		ctx.disposeAll();
	});
});

describe("回复回传认领（消息级 rpcId 优先）", () => {
	function chatSetup() {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "assistant" }], ["session-a"]);
		return run("assistant");
	}

	it("插话（回合中途，无新 turn/start）也能认领并回传", async () => {
		const { ctx, agents, live, sent } = chatSetup();
		ctx.emit("asOne:bot-message", frame({ text: "爱莉在吗" }));
		await FLUSH();
		const steered = live.get("session-a")!.steers[0] as { source: { rpcId: string } };
		const session = { header: { id: "session-a" } };
		ctx.emit("session/event", session, { type: "turn/start" });
		ctx.emit("session/event", session, { type: "user/message", data: steered });
		ctx.emit("session/event", session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "在的呀♪" }] } } });
		ctx.emit("session/event", session, { type: "turn/end" });
		await FLUSH();
		expect(sent.map((item) => item.text)).toEqual(["在的呀♪"]);
		expect(agents.resumed).toEqual(["session-a"]);
		ctx.disposeAll();
	});

	it("回合以错误结束 → 不回传", async () => {
		const { ctx, live, sent } = chatSetup();
		ctx.emit("asOne:bot-message", frame({ text: "爱莉在吗" }));
		await FLUSH();
		const session = { header: { id: "session-a" } };
		ctx.emit("session/event", session, { type: "turn/start" });
		ctx.emit("session/event", session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "半截回复" }] } } });
		ctx.emit("session/event", session, { type: "turn/end", data: { reason: { kind: "error" } } });
		await FLUSH();
		expect(sent).toEqual([]);
		expect(live.get("session-a")!.steers).toHaveLength(1);
		ctx.disposeAll();
	});

	it("用户自己在界面发的回合 → 不回传", async () => {
		const { ctx, sent } = chatSetup();
		ctx.emit("asOne:bot-message", frame({ text: "爱莉在吗" }));
		await FLUSH();
		const session = { header: { id: "session-a" } };
		ctx.emit("session/event", session, { type: "turn/start" });
		ctx.emit("session/event", session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一回合♪" }] } } });
		ctx.emit("session/event", session, { type: "turn/end" });
		await FLUSH();
		ctx.emit("session/event", session, { type: "turn/start" });
		ctx.emit("session/event", session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "界面里的回复" }] } } });
		ctx.emit("session/event", session, { type: "turn/end" });
		await FLUSH();
		expect(sent.map((item) => item.text)).toEqual(["第一回合♪"]);
		ctx.disposeAll();
	});
});

describe("bot-assistant 行：私聊直唤 / 群聊仅 @", () => {
	function setup() {
		fixture(
			[
				{ route: "private:3187192488", session: "session-a", mode: "assistant" },
				{ route: "group:664364260", session: "session-b", mode: "assistant" },
			],
			["session-a", "session-b"],
		);
		return run("assistant");
	}

	it("私聊任意消息直接唤醒", async () => {
		const { ctx, agents } = setup();
		ctx.emit("asOne:bot-message", frame({ text: "跑个任务" }));
		await FLUSH();
		expect(agents.resumed).toEqual(["session-a"]);
		ctx.disposeAll();
	});

	it("群聊未 @ → 静默；被 @ → 唤醒", async () => {
		const { ctx, agents } = setup();
		ctx.emit("asOne:bot-message", frame({ messageType: "group", targetId: "664364260", userId: "42" }));
		await FLUSH();
		expect(agents.resumed).toEqual([]);
		ctx.emit("asOne:bot-message", frame({ messageType: "group", targetId: "664364260", userId: "42", atBot: true }));
		await FLUSH();
		expect(agents.resumed).toEqual(["session-b"]);
		ctx.disposeAll();
	});

	it("mode=chat → assistant 行跳过", async () => {
		fixture([{ route: "private:3187192488", session: "session-a", mode: "chat" }], ["session-a"]);
		const { ctx, agents } = run("assistant");
		ctx.emit("asOne:bot-message", frame());
		await FLUSH();
		expect(agents.resumed).toEqual([]);
		ctx.disposeAll();
	});
});