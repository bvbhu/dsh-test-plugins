import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AS_ONE_HOME_ENV,
	BINDINGS_ENV,
	DEFAULT_WAKE_WORDS,
	asOneHome,
	bindingFor,
	bindingsFilePath,
	chatKeyOf,
	formatInterval,
	loadBindings,
	matchWakeWord,
	normalizeBinding,
	parseBindings,
	parseInterval,
	parseWakeWords,
	resolveSessionRef,
	targetOfRoute,
} from "./bot-bindings.js";

const temps: string[] = [];

function mkTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "as-one-bind-"));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("间隔与唤醒词", () => {
	it("间隔解析与格式化", () => {
		expect(parseInterval("90s")).toBe(90);
		expect(parseInterval("30m")).toBe(1800);
		expect(parseInterval("2h")).toBe(7200);
		expect(parseInterval("1d")).toBe(86_400);
		expect(parseInterval("600")).toBe(600);
		expect(parseInterval("abc")).toBeNull();
		expect(formatInterval(1800)).toBe("30 分钟");
	});

	it("唤醒词：数组/字符串去重，最长命中优先", () => {
		expect(parseWakeWords(["爱莉", "爱莉", "昔涟"])).toEqual(["爱莉", "昔涟"]);
		expect(parseWakeWords("爱莉，昔涟")).toEqual(["爱莉", "昔涟"]);
		expect(matchWakeWord("你好，爱莉希雅在吗", DEFAULT_WAKE_WORDS)).toBe("爱莉希雅");
		expect(matchWakeWord("HELLO ELYSIA", DEFAULT_WAKE_WORDS)).toBe("elysia");
		expect(matchWakeWord("今天天气不错", DEFAULT_WAKE_WORDS)).toBe("");
	});

	it("路由键互逆", () => {
		expect(chatKeyOf("group", "664364260")).toBe("group:664364260");
		expect(targetOfRoute("private:3187192488")).toEqual({ kind: "private", id: "3187192488" });
		expect(targetOfRoute("nope")).toBeNull();
	});
});

describe("绑定条目归一化", () => {
	it("缺省 mode=chat、无唤醒词走默认、schedule 字符串", () => {
		const { binding, error } = normalizeBinding(
			{ route: "group:1", session: "session-a", schedule: "30m" },
			0,
		);
		expect(error).toBe("");
		expect(binding).toMatchObject({ route: "group:1", session: "session-a", mode: "chat", wakeWords: [] });
		expect(binding!.schedule?.everySeconds).toBe(1800);
	});

	it("schedule 对象带提示词", () => {
		const { binding } = normalizeBinding(
			{ route: "private:2", session: "session-b", mode: "assistant", schedule: { every: "2h", prompt: "说一句" } },
			1,
		);
		expect(binding!.mode).toBe("assistant");
		expect(binding!.schedule).toEqual({ everySeconds: 7200, prompt: "说一句" });
	});

	it("非法 route / 缺 session 报错", () => {
		expect(normalizeBinding({ route: "x", session: "s" }, 0).error).toContain("route");
		expect(normalizeBinding({ route: "group:1" }, 1).error).toContain("session");
	});

	it("parseBindings 汇总错误", () => {
		const { bindings, errors } = parseBindings({
			bindings: [{ route: "private:1", session: "session-a" }, { route: "bad" }],
		});
		expect(bindings).toHaveLength(1);
		expect(errors).toHaveLength(1);
	});

	it("bindingFor 按路由取", () => {
		const { bindings } = parseBindings({ bindings: [{ route: "private:1", session: "session-a" }] });
		expect(bindingFor(bindings, "private:1")?.session).toBe("session-a");
		expect(bindingFor(bindings, "private:2")).toBeUndefined();
	});
});

describe("绑定表文件加载", () => {
	it("默认路径在 as-one 持久化根目录（~/.as-one）", () => {
		expect(asOneHome({} as NodeJS.ProcessEnv)).toContain(join(".as-one"));
		expect(bindingsFilePath({} as NodeJS.ProcessEnv)).toBe(join(asOneHome({} as NodeJS.ProcessEnv), "bot-bindings.json"));
		const custom = join(mkTmp(), "custom-root");
		expect(bindingsFilePath({ [AS_ONE_HOME_ENV]: custom } as NodeJS.ProcessEnv)).toBe(
			join(custom, "bot-bindings.json"),
		);
		expect(bindingsFilePath({ [BINDINGS_ENV]: "X:/exact.json" } as NodeJS.ProcessEnv)).toBe("X:/exact.json");
	});

	it("文件不存在 → 自动写模板；随后按内容热读", () => {
		const dir = mkTmp();
		const file = join(dir, "bot-bindings.json");
		const env = { [BINDINGS_ENV]: file } as NodeJS.ProcessEnv;
		const first = loadBindings(env);
		expect(first.bindings).toEqual([]);
		writeFileSync(
			file,
			JSON.stringify({ bindings: [{ route: "private:3187192488", session: "session-x", mode: "chat" }] }, null, 2),
			"utf8",
		);
		const second = loadBindings(env);
		expect(second.bindings).toHaveLength(1);
		expect(second.bindings[0]!.route).toBe("private:3187192488");
	});

	it("损坏 JSON → 空表 + 错误，不抛异常", () => {
		const dir = mkTmp();
		const file = join(dir, "bot-bindings.json");
		writeFileSync(file, "{ not json", "utf8");
		const result = loadBindings({ [BINDINGS_ENV]: file } as NodeJS.ProcessEnv);
		expect(result.bindings).toEqual([]);
		expect(result.errors[0]).toContain("解析失败");
	});
});

describe("会话引用解析", () => {
	function homeWithSession(id: string, title = ""): string {
		const home = mkTmp();
		mkdirSync(join(home, "sessions", "slug-a", id), { recursive: true });
		if (title !== "") {
			const proj = join(home, "storages", "session_projcache", "sessions");
			mkdirSync(proj, { recursive: true });
			writeFileSync(
				join(proj, `${id}.json`),
				JSON.stringify({ record: { rows: { title: { ver: 1, seq: 1, val: title } } } }),
				"utf8",
			);
		}
		return home;
	}

	it("全 ID / 唯一前缀 / 标题都能解析", () => {
		const home = homeWithSession("session-abc12345", "键盘调试");
		const env = { DSH_HOME: home } as NodeJS.ProcessEnv;
		expect(resolveSessionRef("session-abc12345", env)).toBe("session-abc12345");
		expect(resolveSessionRef("session-abc", env)).toBe("session-abc12345");
		expect(resolveSessionRef("键盘调试", env)).toBe("session-abc12345");
		expect(resolveSessionRef("不存在", env)).toBe("");
	});
});