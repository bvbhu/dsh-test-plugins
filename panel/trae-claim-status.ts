/**
 * trae 领取结果 → 面板行(status + 文案)的**唯一**映射点。
 *
 * 独立成模块的原因(2026-11-22):这段判断原先内联在 `panel/channels.ts` 里,
 * 出过一个把「登录失效」显示成「无签到活动」的缺陷 ——
 * 上游用 `HTTP 200 + code 1001 + enable:false` 表达认证失败,而映射只看
 * `!res.enabled` → `skipped`,汇总再压成「该渠道今日无签到活动(未领取)」。
 * 抽出来 + 单测,保证「认证失败」永远排在「未启用」之前。
 */
import { TRAE_CODE_CROWDED } from "../core/connectors/checkin.js";

export type TraeClaimStatus = "claimed" | "already" | "skipped" | "dry_run" | "failed";

/** `TraeClaimResult` 的结构子集(只取映射需要的字段,便于单测)。 */
export interface TraeClaimLike {
  claimed: boolean;
  enabled: boolean;
  would_claim: boolean;
  already_checked_in?: boolean;
  device_checked_in?: boolean;
  auth_failed?: boolean;
  code: number | null;
  message: string;
  retries?: number;
  checkin?: { credits?: number };
}

/**
 * 行状态。
 *
 * ⚠️ 顺序有意义:`auth_failed` 必须在 `!enabled` **之前**判断 ——
 * 两者都会带 `enabled:false`,但认证失败必须显示成 failed(让用户去重登),
 * 而不是 skipped(看起来像今天没有活动)。
 */
export function traeClaimStatusOf(res: TraeClaimLike): TraeClaimStatus {
  if (res.claimed) return "claimed";
  if (res.auth_failed === true) return "failed";
  if (res.already_checked_in || res.device_checked_in) return "already";
  if (!res.enabled) return "skipped";
  if (res.would_claim) return "dry_run";
  return "failed";
}

/** 行文案(领取成功要说清领到了什么;9074 要说清「账号本身没问题」)。 */
export function traeClaimMessageOf(res: TraeClaimLike): string {
  if (res.claimed) {
    const credits = res.checkin?.credits ?? 0;
    const retries = res.retries ?? 0;
    return (
      `领取成功${credits > 0 ? `,当前积分 ${credits}` : ""}` +
      `${retries > 0 ? `(上游拥挤,重试 ${retries} 次后成功)` : ""}`
    );
  }
  // 认证失败:上游原文已由 core 组装好(含 code),这里原样透出。
  if (res.auth_failed === true) return res.message;
  if (res.code === TRAE_CODE_CROWDED) {
    return "上游当前拥挤(高峰限流),稍后重试即可 —— 账号本身没有问题";
  }
  return res.message;
}
