/**
 * `panel/adopt-fields.ts` 的单测。
 *
 * 历史事故都在这块「搬字段」的逻辑里（见模块注释）：
 *   1. 身份字段全丢 → 签到被回 9074；
 *   2. `adopted_at_ms` 写成秒 → 1970；
 *   3. 不写 `expires_at` / `refresh_secret` → 令牌新、过期旧、永不自动续期
 *      （2026-11-22 实测：本机 trae 早就重登了，库里还是 11-08 的旧令牌，
 *      直到签到被回 `code 1001` 才暴露）。
 */
import { describe, expect, it } from "vitest";

import { adoptVaultFields } from "./adopt-fields.js";

/** 2026-11-09T21:00:00+08:00 的 epoch 秒。 */
const NOW_SEC = 1794248400;

describe("adoptVaultFields", () => {
  it("adopted_at_ms 是毫秒（wallNow 返回秒 → ×1000）", () => {
    const f = adoptVaultFields({ nowSec: NOW_SEC });
    expect(f.raw.adopted_at_ms).toBe(NOW_SEC * 1000);
    expect(new Date(f.raw.adopted_at_ms as number).getUTCFullYear()).toBe(2026);
    // 反例：直接存秒会落到 1970
    expect(new Date(NOW_SEC).getUTCFullYear()).toBe(1970);
  });

  it("身份字段整包透传（device_id / machine_id / user_id / refresh_token / edition / host）", () => {
    const f = adoptVaultFields({
      nowSec: NOW_SEC,
      region: "cn",
      extra: {
        device_id: "158024470301",
        machine_id: "4f397e4e",
        user_id: "1294573385294467",
        refresh_token: "rt-xxx",
        edition: "cn",
        host: "https://api.trae.cn",
      },
    });
    expect(f.raw.device_id).toBe("158024470301");
    expect(f.raw.machine_id).toBe("4f397e4e");
    expect(f.raw.user_id).toBe("1294573385294467");
    expect(f.raw.refresh_token).toBe("rt-xxx");
    expect(f.raw.region).toBe("cn");
    expect(f.raw.source).toBe("discover");
  });

  it("token / provider / region 不进 raw（token 走 secret 列）", () => {
    const f = adoptVaultFields({
      nowSec: NOW_SEC,
      region: "cn",
      extra: { token: "should-not-appear", provider: "x", region: "ai", device_id: "d1" },
    });
    expect(f.raw.token).toBeUndefined();
    expect(f.raw.provider).toBeUndefined();
    // 入参 region 优先，extra 里的不覆盖
    expect(f.raw.region).toBe("cn");
    expect(f.raw.device_id).toBe("d1");
  });

  it("空值字段被跳过（不写 null / 空串污染 raw）", () => {
    const f = adoptVaultFields({
      nowSec: NOW_SEC,
      extra: { device_id: "", machine_id: null, user_id: undefined, edition: "cn" },
    });
    expect("device_id" in f.raw).toBe(false);
    expect("machine_id" in f.raw).toBe(false);
    expect("user_id" in f.raw).toBe(false);
    expect(f.raw.edition).toBe("cn");
  });

  it("到期时间：毫秒 → 秒（vault.put 的单位），未知则 undefined（保留库里原值）", () => {
    const expiresMs = 1796522700249; // 2026-12-06T03:52:30.249Z
    const f = adoptVaultFields({ nowSec: NOW_SEC, extra: { token_expires_at_ms: expiresMs } });
    expect(f.expiresAt).toBe(expiresMs / 1000);
    expect(new Date((f.expiresAt ?? 0) * 1000).toISOString()).toBe("2026-12-06T02:05:00.249Z");

    // 没有/非法 → undefined（不能写 null 去清空库里已有的到期时间）
    expect(adoptVaultFields({ nowSec: NOW_SEC }).expiresAt).toBeUndefined();
    expect(adoptVaultFields({ nowSec: NOW_SEC, extra: { token_expires_at_ms: 0 } }).expiresAt).toBeUndefined();
    expect(
      adoptVaultFields({ nowSec: NOW_SEC, extra: { token_expires_at_ms: "1796522700249" } }).expiresAt,
    ).toBeUndefined();
  });

  it("refresh token 落 refresh_secret（面板刷新只认这一列）", () => {
    expect(adoptVaultFields({ nowSec: NOW_SEC, extra: { refresh_token: "rt-abc" } }).refreshSecret).toBe("rt-abc");
    // 空白/缺失 → undefined（保留库里原值）
    expect(adoptVaultFields({ nowSec: NOW_SEC, extra: { refresh_token: "   " } }).refreshSecret).toBeUndefined();
    expect(adoptVaultFields({ nowSec: NOW_SEC }).refreshSecret).toBeUndefined();
  });
});
