import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay, QUOTE_GUIDE, type RelayEvent } from "./bot-relay.js";
import { resetReplyState, setReplyChannel, tryDeliver } from "./bot-reply.js";

const temps: string[] = [];

function mkTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "as-one-relay-"));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetReplyState();
});

function writeBindings(dir: string, bindings: unknown[]): void {
	writeFileSync(
		join(dir, "bot-bindings.json"),
		JSON.stringify({ bindings }, null, 2),
		"utf8",
	);
}

const SESSION = "session-relay-1";
const PRIVATE_ID = "3187192488";

function ev(e: unknown): RelayEvent {
	return e as RelayEvent;
}

function assistantText(text: string): RelayEvent {
	return ev({
		type: "assistant/message",
		data: { message: { content: [{ type: "text", text }] } },
	});
}

function setup(dir: string): {
	relay: ReturnType<typeof createRelay>;
	sent: string[];
	steered: string[];
} {
	const sent: string[] = [];
	const steered: string[] = [];
	setReplyChannel({
		send: async (_route, text) => {
			sent.push(text);
		},
	});
	const agent = {
		steer: (message: unknown) => {
			const text = (message as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
			steered.push(text);
		},
	};
	const relay = createRelay({
		agents: { get: () => agent },
		channel: { send: async (_route, text) => { sent.push(text); } },
	});
	return { relay, sent, steered };
}

function endTurn(relay: ReturnType<typeof createRelay>, sessionId: string): Promise<void> {
	relay.onSessionEvent(sessionId, ev({ type: "turn/start" }));
	relay.onSessionEvent(sessionId, assistantText("会话里的回复"));
	relay.onSessionEvent(sessionId, ev({ type: "turn/end", data: { reason: { kind: "completed" } } }));
	// 催复指令走 ensureAgent().then（微任务+宏任务），等一拍再断言。
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("bot-relay 兜底与催复指令（按档位）", () => {
	it("助理档：模型没调用工具就结束回合 → 兜底发会话输出，再投催复指令", async () => {
		const dir = mkTmp();
		writeBindings(dir, [
			{ route: `private:${PRIVATE_ID}`, session: SESSION, mode: "assistant" },
		]);
		process.env.AS_ONE_HOME = dir;
		const { relay, sent, steered } = setup(dir);

		const ok = await relay.deliver(SESSION, { kind: "private", id: PRIVATE_ID }, "你好");
		expect(ok).toBe(true);
		await endTurn(relay, SESSION);

		expect(sent).toEqual(["会话里的回复"]);
		// steered[0] 是投递本身，steered[1] 是催复指令
		expect(steered).toHaveLength(2);
		expect(steered[1]).toContain("deliver_message");
	});

	it("助理档：模型已调用工具 → 不回读会话输出，也不催复", async () => {
		const dir = mkTmp();
		writeBindings(dir, [
			{ route: `private:${PRIVATE_ID}`, session: SESSION, mode: "assistant" },
		]);
		process.env.AS_ONE_HOME = dir;
		const { relay, sent, steered } = setup(dir);

		const ok = await relay.deliver(SESSION, { kind: "private", id: PRIVATE_ID }, "你好");
		expect(ok).toBe(true);
		const delivered = await tryDeliver(SESSION, "工具直发的回复");
		expect(delivered.ok).toBe(true);
		expect(sent).toEqual(["工具直发的回复"]);

		await endTurn(relay, SESSION);

		// 工具直发后：兜底跳过、催复跳过；steered 只有投递本身一条。
		expect(sent).toEqual(["工具直发的回复"]);
		expect(steered).toHaveLength(1);
	});

	it("聊天档：模型没调用工具就结束回合 → 可以不回复，什么都不发也不催复", async () => {
		const dir = mkTmp();
		writeBindings(dir, [
			{ route: `private:${PRIVATE_ID}`, session: SESSION, mode: "chat" },
		]);
		process.env.AS_ONE_HOME = dir;
		const { relay, sent, steered } = setup(dir);

		const ok = await relay.deliver(SESSION, { kind: "private", id: PRIVATE_ID }, "你好");
		expect(ok).toBe(true);
		await endTurn(relay, SESSION);

		// 聊天档可以不回复：什么都不发，也不催复；steered 只有投递本身一条。
		expect(sent).toHaveLength(0);
		expect(steered).toHaveLength(1);
	});

	it("助理档：错误回合 → 不回传也不催复", async () => {
		const dir = mkTmp();
		writeBindings(dir, [
			{ route: `private:${PRIVATE_ID}`, session: SESSION, mode: "assistant" },
		]);
		process.env.AS_ONE_HOME = dir;
		const { relay, sent, steered } = setup(dir);

		const ok = await relay.deliver(SESSION, { kind: "private", id: PRIVATE_ID }, "你好");
		expect(ok).toBe(true);
		relay.onSessionEvent(SESSION, ev({ type: "turn/start" }));
		relay.onSessionEvent(SESSION, assistantText("半截回复"));
		relay.onSessionEvent(SESSION, ev({ type: "turn/end", data: { reason: { kind: "error" } } }));

		expect(sent).toHaveLength(0);
		// 错误回合不回传也不催复；steered 只有投递本身一条。
		expect(steered).toHaveLength(1);
	});
});

describe("bot-relay 引用回复解读指引（QUOTE_GUIDE）", () => {
	it("引用回复：投递带「[引用 …]」前缀的消息 → steer 收到含 QUOTE_GUIDE 的文本", async () => {
		const dir = mkTmp();
		const { relay, steered } = setup(dir);

		const ok = await relay.deliver(SESSION, { kind: "group", id: "123" }, "[引用 群 123] 爱莉：hello");
		expect(ok).toBe(true);
		// steered[0] 是投递本身：正文 + 换行 + QUOTE_GUIDE。
		expect(steered).toHaveLength(1);
		expect(steered[0]).toContain("[引用 群 123] 爱莉：hello");
		expect(steered[0]).toContain(QUOTE_GUIDE);
	});

	it("普通消息：投递不带「[引用 …]」前缀的消息 → steer 收到的文本不含 QUOTE_GUIDE", async () => {
		const dir = mkTmp();
		const { relay, steered } = setup(dir);

		const ok = await relay.deliver(SESSION, { kind: "private", id: PRIVATE_ID }, "你好");
		expect(ok).toBe(true);
		expect(steered).toHaveLength(1);
		expect(steered[0]).toBe("你好");
		expect(steered[0]).not.toContain(QUOTE_GUIDE);
	});
});
