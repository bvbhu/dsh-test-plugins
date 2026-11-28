/**
 * 渠道启停覆盖的语义回归(用户 m11109:每渠道一个子组件,设置页一个开关)。
 *
 * 与账号覆盖同构:写只碰 `channel.enabled.<provider>` 一个键;读数按
 * `PRAGMA data_version` 跨实例失效重读;另有渠道行(子组件)装载时登记的
 * live 源优先于 db 镜像(schemastery Volatile 免重启)。这里锁死:
 *   - A 关闭渠道后 B 立刻看得到,且 B 的拨动不会覆盖 A 的改动;
 *   - live 源优先、直写 db 时作废 live 源;
 *   - 未写过的渠道缺省启用;
 *   - setting 表逐键镜像落库,重启后恢复。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@as-one/core/src/db/database.js";
import { setupAsOne } from "../src/setup.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "as-one-channel-"));
}

/** 播种一个 provider + 账号 + 一条最小可用的逻辑模型(不发网络请求)。 */
function seedAccount(dbPath: string, username: string): void {
  const db = openDatabase(dbPath);
  if (!db.provider.get("stub")) {
    db.provider.insert({ id: "stub", base_url: "http://127.0.0.1:9", protocol: "openai", env_prefix: null });
    db.realModel.set({
      provider: "stub",
      model: "m1",
      name: null,
      supports_vision: 0,
      max_input_tokens: null,
      max_output_tokens: null,
      hidden: 0,
      concurrency: 1,
    });
    db.logicalModel.insert({
      name: "lg1",
      strategy: "due-first",
      members: JSON.stringify([{ provider: "stub", model: "m1" }]),
    });
  }
  db.credential.set({ provider: "stub", username, secret: "dummy", refresh_secret: null, expires_at: null, raw_json: null });
  db.close();
}

describe("渠道启停覆盖(多实例)", () => {
  it("A 关闭渠道后 B 立刻看得到,且 B 的拨动不会覆盖 A 的改动", async () => {
    const dbPath = join(makeTmpDir(), "as-one.db");
    seedAccount(dbPath, "u1");

    // 两个运行时 = 两条独立连接 = 两个实例共用一个库。
    const a = await setupAsOne({ dbPath, env: {} });
    const b = await setupAsOne({ dbPath, env: {} });

    a.setChannelEnabled("stub", false);
    // 陈旧读必须消失:B 没重启也要看到 A 的关闭(容量归零)。
    expect(b.channelOverlay.get("stub")).toBe(false);
    expect(b.subagentCapOf("stub", "m1")).toBe(0);

    // B 拨另一个渠道:按旧实现(整份写回)这里会把 A 的改动复活;逐键之后必须还在。
    b.setChannelEnabled("other", false);
    const check = openDatabase(dbPath);
    expect(check.setting.get("channel.enabled.stub")?.v).toBe("0");
    expect(check.setting.get("channel.enabled.other")?.v).toBe("0");
    check.close();

    expect(a.channelOverlay.get("other")).toBe(false);
    a.dispose();
    b.dispose();
  });

  it("未写过的渠道缺省启用", async () => {
    const dbPath = join(makeTmpDir(), "as-one.db");
    seedAccount(dbPath, "u1");

    const rt = await setupAsOne({ dbPath, env: {} });
    expect(rt.channelOverlay.has("stub")).toBe(false);
    expect(rt.subagentCapOf("stub", "m1")).toBeGreaterThan(0);
    rt.dispose();
  });

  it("live 源优先于 db 镜像,直写 db 时作废 live 源", async () => {
    const dbPath = join(makeTmpDir(), "as-one.db");
    seedAccount(dbPath, "u1");

    const rt = await setupAsOne({ dbPath, env: {} });
    rt.setChannelEnabled("stub", false);
    expect(rt.subagentCapOf("stub", "m1")).toBe(0);

    // 模拟渠道行(子组件)装载:登记 live 源(设置页开关当前为关,但 getter
    // 读的是 Volatile live 值 —— 这里直接给 true 验证优先级)。
    rt.setChannelLive("stub", { enabled: () => true });
    expect(rt.subagentCapOf("stub", "m1")).toBeGreaterThan(0);

    // 面板直写 db(唯一写口)时 live 源必须作废,以 db 为准。
    rt.setChannelEnabled("stub", false);
    expect(rt.subagentCapOf("stub", "m1")).toBe(0);
    rt.dispose();
  });

  it("setting 镜像落库,重启后恢复", async () => {
    const dbPath = join(makeTmpDir(), "as-one.db");
    seedAccount(dbPath, "u1");

    const a = await setupAsOne({ dbPath, env: {} });
    a.setChannelEnabled("stub", false);
    a.dispose();

    const again = await setupAsOne({ dbPath, env: {} });
    expect(again.channelOverlay.get("stub")).toBe(false);
    expect(again.subagentCapOf("stub", "m1")).toBe(0);
    again.dispose();
  });
});
