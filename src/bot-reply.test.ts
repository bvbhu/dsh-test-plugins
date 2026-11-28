import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_REPLY_CHARS, onUserMessage, resetReplyState, setReplyChannel, tryDeliver, wasDelivered } from "./bot-reply.js";

const temps: string[] = [];

function mkTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "as-one-reply-"));
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

const PRIVATE_ID = "3187192488";
const GROUP_ID = "999999999";

describe("bot-reply 次数与路由限制", () => {
	it("私聊绑定：成功发送一次后拒绝再次发送，新用户消息刷新次数", async () => {
		const dir = mkTmp();
		writeBindings(dir, [
			{ route: `private:${PRIVATE_ID}`, session: "session-reply-1", mode: "chat" },
		]);
		process.env.AS_ONE_HOME = dir;

		const sent: Array<{ kind: string; id: string; text: string }> = [];
		setReplyChannel({
			send: async (route, text) => {
				sent.push({ kind: route.kind, id: route.id, text });
			},
		});

		const first = await tryDeliver("session-reply-1", "第一条回复");
		expect(first.ok).toBe(true);
		expect(sent).toEqual([{ kind: "private", id: PRIVATE_ID, text: "第一条回复" }]);
		expect(wasDelivered("session-reply-1")).toBe(true);

		const second = await tryDeliver("session-reply-1", "第二条回复");
		expect(second.ok).toBe(false);
		expect(second.error).toContain("已发送过一次");
		expect(sent).toHaveLength(1);

		// 新的用户消息刷新次数
		onUserMessage("session-reply-1");
		expect(wasDelivered("session-reply-1")).toBe(false);
		const third = await tryDeliver("session-reply-1", "新消息后的回复");
		expect(third.ok).toBe(true);
		expect(sent).toHaveLength(2);
	});

	it("群聊绑定：允许通过工具发送（群聊回复同样走工具）", async () => {
		const dir = mkTmp();
		writeBindings(dir, [
			{ route: `group:${GROUP_ID}`, session: "session-reply-2", mode: "chat" },
		]);
		process.env.AS_ONE_HOME = dir;

		const sent: Array<{ kind: string; id: string; text: string }> = [];
		setReplyChannel({
			send: async (route, text) => {
				sent.push({ kind: route.kind, id: route.id, text });
			},
		});

		const result = await tryDeliver("session-reply-2", "发到群里");
		expect(result.ok).toBe(true);
		expect(sent).toEqual([{ kind: "group", id: GROUP_ID, text: "发到群里" }]);
	});

	it("未绑定会话：拒绝发送并提示检查绑定表", async () => {
		const dir = mkTmp();
		writeBindings(dir, []);
		process.env.AS_ONE_HOME = dir;

		setReplyChannel({ send: async () => {} });
		const result = await tryDeliver("session-nobody", "hi");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("未绑定");
	});

	it("超长回复：拒绝且不消耗次数（模型可精简后重试）", async () => {
		const dir = mkTmp();
		writeBindings(dir, [
			{ route: `private:${PRIVATE_ID}`, session: "session-reply-3", mode: "chat" },
		]);
		process.env.AS_ONE_HOME = dir;

		const sent: string[] = [];
		setReplyChannel({ send: async (_r, text) => { sent.push(text); } });

		const long = "长".repeat(MAX_REPLY_CHARS + 1);
		const rejected = await tryDeliver("session-reply-3", long);
		expect(rejected.ok).toBe(false);
		expect(rejected.error).toContain(String(MAX_REPLY_CHARS));
		expect(sent).toHaveLength(0);

		// 未被消耗：短回复仍可发送
		const ok = await tryDeliver("session-reply-3", "精简版");
		expect(ok.ok).toBe(true);
		expect(sent).toEqual(["精简版"]);
	});

	it("工具自投的消息（as-one-tool:）不刷新次数；插件投递的消息刷新", async () => {
		const dir = mkTmp();
		writeBindings(dir, [
			{ route: `private:${PRIVATE_ID}`, session: "session-reply-4", mode: "chat" },
		]);
		process.env.AS_ONE_HOME = dir;

		const sent: string[] = [];
		setReplyChannel({ send: async (_r, text) => { sent.push(text); } });

		const first = await tryDeliver("session-reply-4", "第一次");
		expect(first.ok).toBe(true);
		// 工具自己投的 as-one-tool: 消息 → 不刷新（delivered 保持 true）
		onUserMessage("session-reply-4", "as-one-tool:def");
		expect(wasDelivered("session-reply-4")).toBe(true);
		// 插件自己投的 as-one-bot: 消息 → 刷新（delivered 复位）
		onUserMessage("session-reply-4", "as-one-bot:abc");
		expect(wasDelivered("session-reply-4")).toBe(false);
		// 刷新后还能再发一次
		const second = await tryDeliver("session-reply-4", "第二次");
		expect(second.ok).toBe(true);
		expect(sent).toHaveLength(2);
	});

	it("通道未注入：发送失败但不消耗次数", async () => {
		const dir = mkTmp();
		writeBindings(dir, [
			{ route: `private:${PRIVATE_ID}`, session: "session-reply-5", mode: "chat" },
		]);
		process.env.AS_ONE_HOME = dir;
		// 不 setReplyChannel
		const result = await tryDeliver("session-reply-5", "没通道");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("通道未就绪");
		expect(wasDelivered("session-reply-5")).toBe(false);
	});
});
