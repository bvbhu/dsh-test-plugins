/**
 * `panel/trae-claim-status.ts` 的单测。
 *
 * 守的是一条顺序:上游用 `HTTP 200 + code 1001 + enable:false` 表达**登录失效**,
 * 而「未启用签到」也是 `enabled:false`。如果认证失败落到 skipped,
 * 汇总就会显示「该渠道今日无签到活动(未领取)」—— 2026-11-22 实际发生过。
 */
import { describe, expect, it } from "vitest";

import { traeClaimMessageOf, traeClaimStatusOf, type TraeClaimLike } from "./trae-claim-status.js";
import { TRAE_CODE_CROWDED } from "../core/connectors/checkin.js";

const base: TraeClaimLike = {
  claimed: false,
  enabled: true,
  would_claim: false,
  code: 0,
  message: "",
};

describe("traeClaimStatusOf", () => {
  it("领取成功 → claimed", () => {
    expect(traeClaimStatusOf({ ...base, claimed: true })).toBe("claimed");
  });

  it("登录失效(auth_failed)→ failed,绝不落到 skipped", () => {
    const res = { ...base, enabled: false, auth_failed: true, code: 1001, message: "登录已失效(上游 code 1001)" };
    expect(traeClaimStatusOf(res)).toBe("failed");
    // 对照:同样的 enabled:false 但没有 auth_failed → skipped(这才是「未启用」)
    expect(traeClaimStatusOf({ ...base, enabled: false })).toBe("skipped");
  });

  it("今日已签 / 本设备已签 → already", () => {
    expect(traeClaimStatusOf({ ...base, already_checked_in: true })).toBe("already");
    expect(traeClaimStatusOf({ ...base, device_checked_in: true })).toBe("already");
  });

  it("干跑 → dry_run;其余 → failed", () => {
    expect(traeClaimStatusOf({ ...base, would_claim: true })).toBe("dry_run");
    expect(traeClaimStatusOf({ ...base, enabled: true, code: 500 })).toBe("failed");
  });
});

describe("traeClaimMessageOf", () => {
  it("领取成功带上积分与重试次数", () => {
    expect(
      traeClaimMessageOf({ ...base, claimed: true, checkin: { credits: 100 }, retries: 0 }),
    ).toBe("领取成功,当前积分 100");
    expect(
      traeClaimMessageOf({ ...base, claimed: true, checkin: { credits: 0 }, retries: 2 }),
    ).toBe("领取成功(上游拥挤,重试 2 次后成功)");
  });

  it("登录失效原样透出 core 的文案(含 code 与「重新登录」)", () => {
    const msg = "登录已失效(上游 code 1001:not able to authenticate) —— 请在 Trae 客户端重新登录后重新导入账号";
    expect(traeClaimMessageOf({ ...base, auth_failed: true, enabled: false, message: msg })).toBe(msg);
  });

  it("9074 拥挤 → 说清「账号本身没有问题」", () => {
    expect(traeClaimMessageOf({ ...base, code: TRAE_CODE_CROWDED, message: "超时" })).toContain(
      "账号本身没有问题",
    );
  });

  it("其它情况原样返回上游文案", () => {
    expect(traeClaimMessageOf({ ...base, code: 0, message: "该账号未启用签到" })).toBe("该账号未启用签到");
  });
});
