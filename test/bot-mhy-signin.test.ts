import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { starRailSigned, summarizeSignin } from "../src/bot-mhy-row.js";

/** 2026-11-28 00:04 真实失败形状：崩坏3「签到功能维护中」把整条拉成 failed，
 *  但星穹铁道两通行证均已「已签到」。 */
const REAL_SHAPE = {
	time: "2026-11-27T16:04:21.106Z",
	ok: false,
	okCount: 0,
	failedCount: 2,
	results: [
		{
			qq: "3187192488",
			ltuid: "309046837",
			status: "failed",
			ok: false,
			message:
				"**崩坏3**\n崩坏3共计2个账号\n石英的石英块-624943013：签到功能维护中，请耐心等待！\n更新后的前三次签到可获得共计120水晶~\n玩家273202591-273202591：签到功能维护中，请耐心等待！\n更新后的前三次签到可获得共计120水晶~\n**原神**\n原神共计1个账号\n我不玩原神-290815432：已签到\n**崩坏2**\n崩坏2共计1个账号\n石英的石英块-61189684：签到成功\n**未定事件簿**\n签到: 未绑定未定事件簿信息\n**崩坏星穹铁道**\n崩坏星穹铁道共计1个账号\n石英的石英块-112024883：已签到\n",
		},
		{
			qq: "3290836832",
			ltuid: "470965129",
			status: "failed",
			ok: false,
			message:
				"**崩坏3**\n签到: 未绑定崩坏3信息\n**原神**\n签到: 未绑定原神信息\n**崩坏2**\n签到: 未绑定崩坏2信息\n**未定事件簿**\n签到: 未绑定未定事件簿信息\n**崩坏星穹铁道**\n崩坏星穹铁道共计1个账号\n孤星-173892370：今日已签到~\n",
		},
	],
	failed: [
		{ qq: "3187192488", ltuid: "309046837", reason: "**崩坏3**" },
		{ qq: "3290836832", ltuid: "470965129", reason: "**崩坏3**" },
	],
};

describe("米游社签到通知口径（星穹铁道为准）", () => {
	const writeResult = (data: unknown): string => {
		const dir = mkdtempSync(join(tmpdir(), "as-one-mhy-"));
		const nested = join(dir, "plugins", "xiaoyao-cvs-plugin", "data");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "sign-all-last.json"), JSON.stringify(data));
		return dir;
	};

	it("崩坏3 维护中但星穹铁道已签到 → 视为完成（真实 2026-11-28 形状）", () => {
		const dir = writeResult(REAL_SHAPE);
		const res = summarizeSignin(dir, 1, "tail");
		expect(res.ok).toBe(true);
		expect(res.summary).toContain("米游社签到完成");
		expect(res.summary).toContain("2 个通行证已签到");
	});

	it("星穹铁道也未绑定 → 仍失败，失败详情点名通行证", () => {
		const data = structuredClone(REAL_SHAPE);
		data.results[0].message = "**崩坏星穹铁道**\n签到: 未绑定崩坏星穹铁道信息\n";
		const dir = writeResult(data);
		const res = summarizeSignin(dir, 1, "");
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("失败 1 个");
		expect(res.summary).toContain("309046837");
	});

	it("results 缺失的残文件 → 退回文件自报口径", () => {
		const dir = writeResult({ ok: true, okCount: 1, failedCount: 0, results: [], failed: [] });
		const res = summarizeSignin(dir, 0, "");
		expect(res.ok).toBe(true);
	});

	it("结果文件不存在 → 失败且明说无法确认", () => {
		const dir = mkdtempSync(join(tmpdir(), "as-one-mhy-empty-"));
		const res = summarizeSignin(dir, null, "spawn tail");
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("未生成签到结果文件");
	});

	it("starRailSigned：维护中文字不误判、段外已签到不算、今日已签到算", () => {
		expect(starRailSigned("**崩坏3**\n签到功能维护中，请耐心等待！\n**崩坏星穹铁道**\n共计1个账号\n石英的石英块-112024883：已签到\n")).toBe(
			true,
		);
		expect(starRailSigned("**崩坏3**\n石英的石英块-624943013：签到功能维护中\n")).toBe(false);
		expect(starRailSigned("**原神**\n我不玩原神-290815432：已签到\n")).toBe(false);
		expect(starRailSigned("**崩坏星穹铁道**\n孤星-173892370：今日已签到~\n")).toBe(true);
		expect(starRailSigned("**崩坏星穹铁道**\n签到: 未绑定崩坏星穹铁道信息\n")).toBe(false);
	});
});
