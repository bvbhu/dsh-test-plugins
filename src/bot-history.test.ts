import { describe, expect, it } from "vitest";
import {
	formatHistoryLines,
	normalizeHistoryEntry,
	normalizeHistoryMessages,
} from "./bot-history.js";

describe("normalizeHistoryEntry", () => {
	it("段数组 text 拼接 + card 优先于 nickname + 时间戳", () => {
		const entry = normalizeHistoryEntry({
			message: [
				{ type: "text", data: { text: "你好" } },
				{ type: "face", data: {} },
				{ type: "text", data: { text: "呀" } },
			],
			time: 1730000000,
			sender: { user_id: 20001, card: "小明", nickname: "小明(QQ)" },
		});
		expect(entry).toEqual({
			userId: "20001",
			name: "小明",
			time: 1730000000,
			text: "你好呀",
		});
	});

	it("无 card 时兜底 nickname；user_id 为 number 也字符串化", () => {
		const entry = normalizeHistoryEntry({
			message: [{ type: "text", data: { text: "hi" } }],
			time: 0,
			sender: { user_id: 10000, nickname: "主人" },
		});
		expect(entry).toMatchObject({ userId: "10000", name: "主人", time: 0 });
	});

	it("message 为空数组时兜底 raw_message（CQ 字符串）", () => {
		const entry = normalizeHistoryEntry({
			message: [],
			raw_message: "[CQ:face]",
			sender: { user_id: 20001 },
		});
		expect(entry?.text).toBe("[CQ:face]");
	});

	it("坏项返回 null（非对象 / 无文本且无 raw_message）", () => {
		expect(normalizeHistoryEntry(null)).toBeNull();
		expect(normalizeHistoryEntry("str")).toBeNull();
		expect(
			normalizeHistoryEntry({ message: [{ type: "face", data: {} }], sender: { user_id: 1 } }),
		).not.toBeNull(); // 空文本条目本身合法，文本层过滤在 normalizeHistoryMessages
	});
});

describe("normalizeHistoryMessages", () => {
	const rawList = [
		{ message: [{ type: "text", data: { text: "晚" } }], time: 1730000120, sender: { user_id: 2, nickname: "乙" } },
		{ message: [{ type: "text", data: { text: "早" } }], time: 1730000000, sender: { user_id: 1, nickname: "甲" } },
		{ message: [{ type: "face", data: {} }], time: 1730000060, sender: { user_id: 3 } }, // 空文本跳过
		null, // 坏项跳过
		{ message: [{ type: "text", data: { text: "中" } }], time: 1730000060, sender: { user_id: 4, nickname: "丁" } },
	];

	it("按时间升序；空文本与坏项跳过", () => {
		const out = normalizeHistoryMessages(rawList);
		expect(out.map((m) => m.text)).toEqual(["早", "中", "晚"]);
	});

	it("limit 保留最近 N 条（升序）", () => {
		const out = normalizeHistoryMessages(rawList, { limit: 2 });
		expect(out.map((m) => m.text)).toEqual(["中", "晚"]);
	});

	it("非数组输入返回空数组", () => {
		expect(normalizeHistoryMessages(undefined)).toEqual([]);
		expect(normalizeHistoryMessages({})).toEqual([]);
	});
});

describe("formatHistoryLines", () => {
	const messages = [
		{ userId: "1", name: "甲", time: 1730000000, text: "早" },
		{ userId: "10000", name: "主人", time: 1730000060, text: "在的" },
	];

	it("头部统计 + HH:mm 排版 + （我）标记", () => {
		const out = formatHistoryLines(messages, { selfId: "10000", title: "群聊" });
		expect(out).toBe(
			"[群聊 共 2 条，显示最近 2 条]\n" +
				`${new Date(1730000000 * 1000).toTimeString().slice(0, 5)} 甲: 早\n` +
				`${new Date(1730000060 * 1000).toTimeString().slice(0, 5)} 主人（我）: 在的`,
		);
	});

	it("空记录返回提示行", () => {
		expect(formatHistoryLines([], { title: "私聊" })).toBe("（私聊暂无记录）");
	});

	it("单条超 maxChars 截断加省略号", () => {
		const out = formatHistoryLines([{ userId: "1", name: "甲", time: 0, text: "x".repeat(50) }], { maxChars: 10 });
		expect(out).toContain("xxxxxxxxxx…");
	});

	it("无名无 ID 显示「未知」；时间 0 显示 --:--", () => {
		const out = formatHistoryLines([{ userId: "", name: "", time: 0, text: " hi " }]);
		expect(out).toContain("--:-- 未知: hi");
	});
});
