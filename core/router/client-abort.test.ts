/**
 * 回归：「手动打断会话也会让模型进冷却」（2026-11-17 用户报）。
 *
 * 故障链：客户端打断（Esc / 停止按钮）→ `clientSignal.abort()` →
 * `gateway-upstream` 的 `clientGone` 分支 → `router.finish({ok:false,
 * kind:"client_disconnected"})` → 旧 `noteFailure` 里 `client_disconnected`
 * **不在** `TRANSIENT_KINDS` → 按 `cooldownFloorS` 落冷却 —— 而端点全程没失败
 * （上游可能正正常常吐流，是我们这头掐的）。
 *
 * 口径：打断 = 用户主动放弃，**只释放租约、记账，不落冷却**；且不清零已有的
 * 冷却（与其它瞬时故障同款：上次失败的冷却不能被这次打断洗掉）。
 */

import { describe, expect, it } from "vitest";

import { noteFailure, noteSuccess, TRANSIENT_KINDS } from "./types.js";

const NOW = 1_700_000_000;

function health(extra: Record<string, unknown> = {}) {
  return {
    endpointId: "p/m@p/u",
    provider: "workbuddy",
    fails: 0,
    cooldownUntil: 0,
    lastError: "",
    lastKind: "",
    lastStatus: 0,
    updatedAt: 0,
    ...extra,
  } as Parameters<typeof noteFailure>[0];
}

/** 只有 `cooldownFloorS` 与本组用例相关，其余字段给中性值满足类型。 */
const POLICY = {
  maxAttempts: 3,
  cooldownFloorS: 900,
  baseS: 1,
  factor: 2,
  capS: 30,
  jitterRatio: 0,
  codes: new Set<string>(),
};

describe("client_disconnected 是瞬时不冷却失败", () => {
  it("TRANSIENT_KINDS 含 client_disconnected", () => {
    expect(TRANSIENT_KINDS.has("client_disconnected")).toBe(true);
  });

  it("打断不落冷却（只记账）", () => {
    const rec = noteFailure(health(), {
      kind: "client_disconnected",
      status: 0,
      error: "客户端断开",
      now: NOW,
      hint: { until: null, policy: POLICY },
    });
    expect(rec.fails).toBe(1);
    expect(rec.lastKind).toBe("client_disconnected");
    // 关键：没有冷却。
    expect(rec.cooldownUntil).toBe(0);
  });

  it("打断不清零已有的冷却（不能被用来洗掉上次真实失败）", () => {
    const cooling = health({ cooldownUntil: NOW + 600 });
    const rec = noteFailure(cooling, {
      kind: "client_disconnected",
      status: 0,
      error: "客户端断开",
      now: NOW,
      hint: { until: null, policy: POLICY },
    });
    expect(rec.cooldownUntil).toBe(NOW + 600);
  });

  it("对照组：普通失败仍按 cooldownFloorS 落冷却", () => {
    const rec = noteFailure(health(), {
      kind: "upstream",
      status: 502,
      error: "Bad Gateway",
      now: NOW,
      hint: { until: null, policy: POLICY },
    });
    expect(rec.cooldownUntil).toBe(NOW + 900);
  });

  it("打断后一次成功即完全清账", () => {
    const afterBreak = noteFailure(health(), {
      kind: "client_disconnected",
      status: 0,
      error: "客户端断开",
      now: NOW,
    });
    const rec = noteSuccess(afterBreak, NOW + 5);
    expect(rec.fails).toBe(0);
    expect(rec.cooldownUntil).toBe(0);
    expect(rec.lastKind).toBe("");
  });
});

/**
 * 回归：「瞬时错误不要进冷却」—— 但上游**明确给的** `Retry-After` 仍然算数
 * （2026-11-23 用户 m03723，定案为折中口径）。
 *
 * 故障链：超时/连接类失败(`TRANSIENT_KINDS`)本该只记账不熔断，但
 * `gateway-upstream` 两处 `router.finish` 都把 `cooldownUntil: cooldownUntilOf(gerr)`
 * 传下来 —— 而 `cooldownUntilOf` 只看 `retryAfter` 有没有，**不看 kind**。
 * 只要上游在 503/504 上带了个 `Retry-After`，`hint.until` 就落在
 * `noteFailure` 的第一优先级分支，在瞬时豁免之前 `return`，把端点打进冷却。
 *
 * 口径（折中，2026-11-23 用户定案）：
 * - 上游**明确**给的恢复时刻（`hint.untilSource === "upstream"`）压过瞬时豁免 ——
 *   上游都说「到 X 之前别来」了，就没有「这是瞬时抖动」的解释空间（这是继承
 *   自 Python 时代的原口径，`router.test.ts` 的「明确恢复时刻」用例保的就是它）。
 * - **网关自己推算**的时刻（缺省 `"gateway"`）压不过豁免 —— 那种推算没有上游
 *   背书，不该让一次网络抖动换来整段冷却。
 */
describe("瞬时错误与上游 Retry-After 的边界", () => {
  it("timeout + 网关推算的 until → 不冷却", () => {
    const rec = noteFailure(health(), {
      kind: "timeout",
      status: 504,
      error: "上游超时",
      now: NOW,
      hint: { until: NOW + 30, policy: POLICY, untilSource: "gateway" },
    });
    expect(rec.fails).toBe(1);
    expect(rec.lastKind).toBe("timeout");
    expect(rec.cooldownUntil).toBe(0);
  });

  it("connection + 网关推算的 until → 不冷却", () => {
    const rec = noteFailure(health(), {
      kind: "connection",
      status: 502,
      error: "read ECONNRESET",
      now: NOW,
      hint: { until: NOW + 30, policy: POLICY, untilSource: "gateway" },
    });
    expect(rec.cooldownUntil).toBe(0);
  });

  it("client_disconnected + 网关推算的 until → 不冷却", () => {
    const rec = noteFailure(health(), {
      kind: "client_disconnected",
      status: 0,
      error: "客户端断开",
      now: NOW,
      hint: { until: NOW + 30, policy: POLICY, untilSource: "gateway" },
    });
    expect(rec.cooldownUntil).toBe(0);
  });

  it("untilSource 缺省按 gateway → 瞬时错误照旧不冷却", () => {
    // 保守缺省:没标来源的时刻不享受上游权威。
    const rec = noteFailure(health(), {
      kind: "timeout",
      status: 504,
      error: "上游超时",
      now: NOW,
      hint: { until: NOW + 30, policy: POLICY },
    });
    expect(rec.cooldownUntil).toBe(0);
  });

  it("瞬时错误也不清零已有冷却", () => {
    const cooling = health({ cooldownUntil: NOW + 600 });
    const rec = noteFailure(cooling, {
      kind: "timeout",
      status: 504,
      error: "上游超时",
      now: NOW,
      hint: { until: NOW + 30, policy: POLICY, untilSource: "gateway" },
    });
    expect(rec.cooldownUntil).toBe(NOW + 600);
  });

  it("保留原口径:timeout + 上游明确的 until → 照样冷到那一刻", () => {
    const rec = noteFailure(health(), {
      kind: "timeout",
      status: 504,
      error: "上游超时",
      now: NOW,
      hint: { until: NOW + 120, policy: POLICY, untilSource: "upstream" },
    });
    expect(rec.cooldownUntil).toBe(NOW + 120);
  });

  it("对照：非瞬时的 rate_limit + until 仍按上游时刻冷却", () => {
    const rec = noteFailure(health(), {
      kind: "rate_limit",
      status: 429,
      error: "上游限流",
      now: NOW,
      hint: { until: NOW + 30, policy: POLICY, untilSource: "upstream" },
    });
    expect(rec.cooldownUntil).toBe(NOW + 30);
  });

  it("对照：非瞬时的 upstream + until 仍按上游时刻冷却", () => {
    const rec = noteFailure(health(), {
      kind: "upstream",
      status: 503,
      error: "Service Unavailable",
      now: NOW,
      hint: { until: NOW + 30, policy: POLICY, untilSource: "upstream" },
    });
    expect(rec.cooldownUntil).toBe(NOW + 30);
  });
});
