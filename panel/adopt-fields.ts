/**
 * adopt（把本机登录态写进凭据库）的字段构造 —— 纯函数，便于单测。
 *
 * ## 历史 bug（都出在这段「看起来只是搬字段」的逻辑里）
 *
 * 1. **身份字段全丢**（2026-11-09）：只写 `{source, adopted_at_ms, region}`，
 *    把发现阶段解析好的 `device_id` / `user_id` / `refresh_token` 全丢了，
 *    于是签到被上游持续回 9074。
 * 2. **时间单位错**（同日）：`adopted_at_ms` 写的是 `wallNow()`（秒）。
 * 3. **不写 `expires_at` / `refresh_secret`**（2026-11-22）：采纳后库里
 *    「令牌是新的、过期时间还是旧的、refresh token 为空」。后果有两层：
 *    - 面板刷新路径 `refreshOne` 先判 `!cred.refreshSecret` → 直接 skipped
 *      「无 refresh token」，于是账号再也不会自动续期；
 *    - `shouldRefresh` 也依赖 `refreshSecret`，加上 `expires_at` 陈旧，
 *      面板对同一个账号给出自相矛盾的状态。
 *    实测事故：本机 trae 桌面端早已重新登录，库里仍是 11-08 的旧令牌，
 *    直到签到被上游回 `code 1001（认证失败）` 才暴露。
 *
 * 所以本模块把三件事定死：身份字段整包透传（不含 token）、到期时间**毫秒→秒**、
 * refresh token 落 `refresh_secret`。
 */

export interface AdoptVaultFields {
  /** 写进 `raw_json` 的身份字段（不含 `provider` / `token` / `region`）。 */
  raw: Record<string, unknown>;
  /**
   * 令牌到期时刻，单位 **秒**（`vault.put` 的约定）；`undefined` = 不知道，
   * 交给 `vault.put` 保留库里原值（不拿 null 去清空）。
   */
  expiresAt: number | undefined;
  /** 桌面版登录态里的 refresh token；`undefined` = 没有，保留库里原值。 */
  refreshSecret: string | undefined;
}

/** `raw_json` 里不重复保存的键：token 走 secret 列，region 由入参决定。 */
const SKIP_RAW_KEYS: ReadonlySet<string> = new Set(["provider", "token", "region"]);

function nonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function adoptVaultFields(opts: {
  /** epoch **秒**（`wallNow()` 的返回值就是秒）。 */
  nowSec: number;
  region?: string | null;
  extra?: Record<string, unknown> | null;
}): AdoptVaultFields {
  const raw: Record<string, unknown> = {
    source: "discover",
    // ⚠️ 字段名是 `_ms`，而入参是秒 —— 这里 ×1000；写错就是 1970 年。
    adopted_at_ms: Math.round(opts.nowSec * 1000),
  };
  if (opts.region) raw.region = String(opts.region);
  const extra = opts.extra ?? {};
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === "") continue;
    if (SKIP_RAW_KEYS.has(k)) continue;
    raw[k] = v;
  }
  // 到期时间：discover 给的是毫秒（`token_expires_at_ms`），vault 要秒。
  const ms = extra["token_expires_at_ms"];
  const expiresAt =
    typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms / 1000 : undefined;
  // refresh token 走 `refresh_secret` 列：`vault.shouldRefresh` 与面板的
  // `refreshOne` 都只认这一列，raw 里留一份不够（它们不会去读 raw）。
  const refreshSecret = nonEmptyString(extra["refresh_token"]);
  return { raw, expiresAt, refreshSecret };
}
