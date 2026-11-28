import { describe, expect, it } from "vitest";
import {
  GLOBAL_WAKEUP_SETTING_KEY,
  botWakeupEnabledSettingKey,
  handoffOnce,
  isWakeupEnabledFor,
  parseEnabledFlag,
} from "../src/bot-channel-service.js";

describe("bot wakeup strict switch", () => {
  const read = (map: Record<string, string>) => (key: string) => map[key] ?? null;

  it("群 180568043 默认禁用；显式写 1 才允许", () => {
    expect(isWakeupEnabledFor("group", "180568043", read({}))).toBe(false);
    expect(
      isWakeupEnabledFor("group", "180568043", read({ [botWakeupEnabledSettingKey("group", "180568043")]: "1" })),
    ).toBe(true);
    expect(isWakeupEnabledFor("group", "664364260", read({}))).toBe(true);
  });

  it("总开关关闭时任何目标都不可唤醒", () => {
    expect(isWakeupEnabledFor("private", "3187192488", read({ [GLOBAL_WAKEUP_SETTING_KEY]: "0" }))).toBe(false);
    expect(
      isWakeupEnabledFor(
        "group",
        "180568043",
        read({ [GLOBAL_WAKEUP_SETTING_KEY]: "0", [botWakeupEnabledSettingKey("group", "180568043")]: "1" }),
      ),
    ).toBe(false);
  });

  it("关闭值识别", () => {
    expect(parseEnabledFlag("0")).toBe(false);
    expect(parseEnabledFlag("off")).toBe(false);
    expect(parseEnabledFlag("1")).toBe(true);
    expect(parseEnabledFlag(null)).toBe(true);
  });

  it("handoffOnce 只投递一次：steer 存在时绝不追加 followup", () => {
    const steer = (): unknown => undefined; // 真实 DSH Agent 就是无返回值
    const followup = (): unknown => undefined;
    let steerCount = 0;
    let followupCount = 0;
    handoffOnce({ steer: () => steerCount++, followup: () => followupCount++ }, { text: "x" });
    expect(steerCount).toBe(1);
    expect(followupCount).toBe(0);
    handoffOnce({ followup: () => followupCount++ }, { text: "x" });
    expect(followupCount).toBe(1);
  });
});
