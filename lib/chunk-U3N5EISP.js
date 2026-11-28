import {
  AUTH_STORAGE_KEY,
  CHECKIN_PROVIDERS,
  CODEARTS_BASE_CN,
  CODEARTS_MODELS_PATH,
  CheckinCredentialError,
  CheckinError,
  CheckinRegionError,
  DEVICE_CENTER_PREFIX,
  MINIMAX_MODELS,
  MINIMAX_QUOTA_TIMEOUT_MS,
  QODER_REGIONS,
  QODER_REGION_CONFIGS,
  QoderClient,
  QoderUpstreamError,
  REGION_BASES,
  SensenovaAuthFlow,
  TRAE_CODE_CROWDED,
  UpstreamError,
  build_headers,
  build_refresh_headers,
  checkinSupported,
  clampDay,
  codeartsIdentityHeaders,
  countJsonlLines,
  credentialKey,
  dayAdd,
  decrypt_storage_value,
  detect_region_from_token,
  expiresAtOf,
  fingerprint,
  fpOf,
  getAllConnectors,
  getQoderClient,
  isQoderRegion,
  jwt_claim,
  jwt_expiry_epoch_s,
  markCodeartsCheckin,
  membersFromInput,
  minimaxAccountOf,
  minimaxRefreshToken,
  minimaxSigninClaim,
  minimaxSigninStatus,
  monthAxis,
  needsRefresh,
  normalize_region,
  normalize_region2,
  number_of,
  orderRawLevels,
  panelClaimedToday,
  panelTodayPoints,
  parseDbMembers,
  parse_pool_usage,
  parse_refresh_response,
  parse_refresh_response2,
  pct,
  probeWorkbuddyAccount,
  probe_codearts_quota,
  probe_minimax_quota,
  probe_trae_quota,
  probe_workbuddy_quota,
  quotaHub,
  rangeDays,
  realModelMapOf,
  resolve_api_base,
  resolve_identity,
  round1,
  sensenova_username,
  serializeReasoningEfforts,
  signCodeartsRequest,
  splitRef,
  syncSensenovaPool,
  todayLocal,
  traeCheckinClaim,
  traeCheckinStatus,
  wbCheckinClaim,
  wbCheckinStatus,
  wbRegionOf
} from "./chunk-HO5EIHRE.js";
import {
  ORDER_STRATEGIES,
  computeTps,
  cooldownDefaultsJson,
  dayKey,
  defaultConcurrencyOf,
  endpointIdOf,
  monotonic,
  normalizeStrategy,
  parseContentMode,
  rulesDefaultsJson,
  wallNow,
  windowProfilesDefaultsJson
} from "./chunk-7NII7QAL.js";

// core/config/provider-labels.ts
var PROVIDER_DISPLAY_NAMES = Object.freeze({
  trae: "Trae",
  workbuddy: "WorkBuddy",
  qoder: "Qoder",
  minimax: "MiniMax",
  sensenova: "SenseNova",
  // CodeArts 是第七种协议(签名网关),渠道页卡头/签到标签都用它;漏了就会在
  // 界面上显示裸 id「codearts」,与其余渠道的人话名不一致。
  codearts: "CodeArts",
  openrouter: "OpenRouter"
});
function providerDisplayName(provider) {
  if (provider === "") return "";
  return Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY_NAMES, provider) ? PROVIDER_DISPLAY_NAMES[provider] : provider;
}

// core/connectors/codearts-ide.ts
import { createHash } from "node:crypto";
var CODEARTS_IDE_DELIVERY_PATH = "/v1/ops/delivery?channel=IDE";
var CODEARTS_IDE_CLAIM_PATH = "/v1/ops/claim";
var CODEARTS_IDE_CONFIRM_PATH = "/v1/ops/confirm";
var CODEARTS_IDE_CHECKIN_TYPE = "USER_LOGIN";
var CODEARTS_IDE_CONFLICT_CODE = 40001;
var CODEARTS_IDE_SIGNED_STATUSES = /* @__PURE__ */ new Set(["CONFIRMED", "CONSUMED"]);
var CODEARTS_IDE_TIMEOUT_MS = 2e4;
function identityHeaders(account) {
  return {
    ...codeartsIdentityHeaders({
      accessKey: account.accessKey,
      ...account.domainId ? { domainId: account.domainId } : {}
    }),
    "Agent-Type": "PromptCenter"
  };
}
async function ideGet(account, path, label, opts) {
  const base = (opts.baseUrl || CODEARTS_BASE_CN).replace(/\/+$/, "");
  const url = `${base}${path}`;
  const signed = signCodeartsRequest({
    accessKey: account.accessKey,
    secretKey: account.secretKey,
    ...account.securityToken ? { securityToken: account.securityToken } : {},
    method: "GET",
    url,
    headers: identityHeaders(account)
  });
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CODEARTS_IDE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetchFn(url, { method: "GET", headers: signed.headers, signal: controller.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CheckinError(
      controller.signal.aborted ? `${label}超时(${timeoutMs}ms)` : `${label}连接失败: ${msg}`
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new CheckinError(`${label} HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CheckinError(`${label}响应不是 JSON(HTTP ${resp.status})`);
  }
}
async function idePost(account, path, body, label, opts) {
  const base = (opts.baseUrl || CODEARTS_BASE_CN).replace(/\/+$/, "");
  const url = `${base}${path}`;
  const bodyText = JSON.stringify(body);
  const signed = signCodeartsRequest({
    accessKey: account.accessKey,
    secretKey: account.secretKey,
    ...account.securityToken ? { securityToken: account.securityToken } : {},
    method: "POST",
    url,
    headers: identityHeaders(account),
    body: bodyText
  });
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CODEARTS_IDE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetchFn(url, { method: "POST", headers: signed.headers, body: bodyText, signal: controller.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CheckinError(
      controller.signal.aborted ? `${label}超时(${timeoutMs}ms)` : `${label}连接失败: ${msg}`
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new CheckinError(`${label} HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CheckinError(`${label}响应不是 JSON(HTTP ${resp.status})`);
  }
}
async function codeartsIdeCampaigns(account, opts = {}) {
  const payload = await ideGet(account, CODEARTS_IDE_DELIVERY_PATH, "活动列表", opts);
  const code = typeof payload["code"] === "number" ? payload["code"] : Number(payload["code"]);
  if (code !== 0) {
    throw new CheckinError(`活动列表业务失败(code ${payload["code"]})`);
  }
  const data = payload["data"];
  const items = data !== null && typeof data === "object" && Array.isArray(data["items"]) ? data["items"] : null;
  if (items === null) throw new CheckinError("活动列表缺少 data.items(上游应答形态变了)");
  const out = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw;
    const campaignId = Number(item["campaignId"]);
    if (!Number.isFinite(campaignId) || campaignId <= 0) continue;
    const extra = item["extra"] !== null && typeof item["extra"] === "object" ? item["extra"] : null;
    const isoSecondsOf = (v) => {
      if (typeof v !== "string" || v.trim() === "") return null;
      const ms = Date.parse(v);
      return Number.isFinite(ms) ? Math.floor(ms / 1e3) : null;
    };
    out.push({
      campaignId,
      title: typeof item["title"] === "string" ? item["title"] : "",
      type: typeof item["type"] === "string" ? item["type"] : "",
      benefitAmount: Number(item["benefitAmount"]) || 0,
      claimable: item["claimable"] === true,
      status: typeof item["status"] === "string" ? item["status"] : null,
      startAt: isoSecondsOf(extra?.["startTime"]),
      endAt: isoSecondsOf(extra?.["endTime"])
    });
  }
  return out;
}
function pickIdeCheckinCampaign(campaigns) {
  return campaigns.find((c) => c.type.toUpperCase() === CODEARTS_IDE_CHECKIN_TYPE) ?? campaigns.find((c) => c.title.includes("签到"));
}
async function codeartsIdeCheckin(account, opts = {}) {
  const confirm = opts.confirm !== false;
  const campaigns = await codeartsIdeCampaigns(account, opts);
  const campaign = pickIdeCheckinCampaign(campaigns);
  if (campaign === void 0) {
    return { ok: false, code: -1, message: "没有签到活动(USER_LOGIN)", credit: 0, expireAt: null, already: false };
  }
  const today = typeof campaign.status === "string" ? campaign.status.toUpperCase() : "";
  if (CODEARTS_IDE_SIGNED_STATUSES.has(today)) {
    return { ok: false, code: 0, message: "今日已签到(已确认入账)", credit: campaign.benefitAmount, expireAt: null, already: true };
  }
  if (today === "CLAIMED") {
    if (!confirm) {
      return { ok: false, code: -1, message: "干跑:已领取但未确认", credit: 0, expireAt: null, already: true };
    }
    const ack = await idePost(account, CODEARTS_IDE_CONFIRM_PATH, { campaignId: campaign.campaignId }, "领取确认", opts);
    const code = typeof ack["code"] === "number" ? ack["code"] : -1;
    if (code !== 0) {
      return { ok: false, code, message: `补确认被拒(code ${code}) —— 积分未入账`, credit: 0, expireAt: null, already: true };
    }
    const data = ack["data"] ?? {};
    return {
      ok: true,
      code: 0,
      message: "补确认成功,积分应已入账",
      credit: Number(data["totalAmount"]) || campaign.benefitAmount,
      expireAt: isoToSeconds(data["expireAt"]),
      already: true
    };
  }
  if (!confirm) {
    return {
      ok: false,
      code: -1,
      message: `可领取 ${campaign.benefitAmount} 积分(干跑,未写)`,
      credit: campaign.benefitAmount,
      expireAt: null,
      already: false
    };
  }
  const claim = await idePost(
    account,
    CODEARTS_IDE_CLAIM_PATH,
    { campaignId: campaign.campaignId, channel: "IDE" },
    "领取",
    opts
  );
  const claimCode = typeof claim["code"] === "number" ? claim["code"] : -1;
  if (claimCode === CODEARTS_IDE_CONFLICT_CODE) {
    return { ok: false, code: claimCode, message: "今日已签(上游回报并发冲突/重复领取)", credit: 0, expireAt: null, already: true };
  }
  if (claimCode !== 0) {
    const msg = typeof claim["message"] === "string" ? claim["message"] : "";
    return { ok: false, code: claimCode, message: `claim 被拒(code ${claimCode})${msg ? `:${msg}` : ""}`, credit: 0, expireAt: null, already: false };
  }
  const claimData = claim["data"] ?? {};
  const claimStatus = typeof claimData["status"] === "string" ? claimData["status"] : "";
  const credit = Number(claimData["totalAmount"]) || campaign.benefitAmount;
  const expireAt = isoToSeconds(claimData["expireAt"]);
  if (claimStatus === "CLAIMED") {
    const ack = await idePost(account, CODEARTS_IDE_CONFIRM_PATH, { campaignId: campaign.campaignId }, "领取确认", opts);
    const confirmCode = typeof ack["code"] === "number" ? ack["code"] : -1;
    if (confirmCode !== 0) {
      const msg = typeof ack["message"] === "string" ? ack["message"] : "";
      return {
        ok: false,
        code: confirmCode,
        message: `claim 成功但 confirm 被拒(code ${confirmCode})${msg ? `:${msg}` : ""} —— 积分未入账`,
        credit,
        expireAt,
        already: false
      };
    }
    const confirmData = ack["data"] ?? {};
    return {
      ok: true,
      code: 0,
      message: `领取成功,获得 ${credit} 积分${expireAt !== null ? "(次日同期作废,签到积分只有24小时)" : ""}`,
      credit,
      expireAt: isoToSeconds(confirmData["expireAt"]) ?? expireAt,
      already: false
    };
  }
  return { ok: false, code: -1, message: `claim 返回异常状态 ${claimStatus}`, credit, expireAt, already: false };
}
function isoToSeconds(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1e3) : null;
}

// panel/minimax-renew.ts
var inflight = /* @__PURE__ */ new Map();
async function renewMinimaxAccount(account, deps) {
  const key = `${deps.provider}/${deps.username}`;
  const running = inflight.get(key);
  if (running !== void 0) return running;
  const run = (async () => {
    const stored = await deps.vault.get(deps.provider, deps.username).catch(() => null);
    const refreshToken = stored?.refreshSecret ?? "";
    if (!refreshToken) return null;
    let res;
    try {
      res = await minimaxRefreshToken({
        refreshToken,
        region: account.region === "global" ? "global" : "cn"
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const revoked = /invalid_grant|no longer be used|invalid.?refresh|expired/i.test(detail);
      throw new CheckinError(
        `minimax 自动续期失败: ${detail} —— ` + (revoked ? "该账号的 refresh_token 已作废,需重新授权:node scripts/minimax-device-login.mjs" : "请检查网络后重试(若持续失败,同样需要重新授权)")
      );
    }
    await deps.vault.rotate(deps.provider, deps.username, {
      secret: res.accessToken,
      refreshSecret: res.refreshToken ?? void 0,
      expiresAt: res.expiresInSec !== null && Number.isFinite(res.expiresInSec) ? Math.floor(Date.now() / 1e3) + res.expiresInSec : void 0
    });
    const merged = {
      ...account,
      token: res.accessToken,
      bearer: account.bearer ? res.accessToken : null
    };
    return merged;
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}
async function minimaxAccountFor(vault, provider, username) {
  const stored = await vault.get(provider, username).catch(() => null);
  if (stored === null) return null;
  const token = await vault.secret(provider, username).catch(() => null);
  if (!token) return null;
  const raw = stored.raw ?? {};
  const account = minimaxAccountOf({
    token,
    region: raw["region"] == null ? null : String(raw["region"]),
    extra: raw
  });
  return {
    account,
    httpOptions: {
      onAuthExpired: (acct) => renewMinimaxAccount(acct, { vault, provider, username })
    }
  };
}

// panel/sensenova-pool.ts
function generalPoolOf(pools) {
  if (!pools) return null;
  for (const p of pools) {
    if (p && p.pool_type !== "dedicated") return p;
  }
  return null;
}
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function generalPoolSummary(pools) {
  const p = generalPoolOf(pools);
  if (p === null) return null;
  return {
    remaining: numOrNull(p.w5_remaining),
    limit: numOrNull(p.w5_limit),
    weekRemaining: numOrNull(p.w7_remaining),
    weekLimit: numOrNull(p.w7_limit),
    w5ResetAt: numOrNull(p.w5_reset_at),
    w7ResetAt: numOrNull(p.w7_reset_at)
  };
}

// panel/checkin-order.ts
var TRAE_PRIORITY_SETTING_KEY = "checkin.trae.priority.accounts";
function parsePriorityList(raw) {
  const out = [];
  for (const part of String(raw ?? "").split(",")) {
    const v = part.trim();
    if (v === "" || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}
function isPriorityLabel(label, priority) {
  const text = (label ?? "").trim().toLowerCase();
  if (text === "") return false;
  return priority.some((p) => p !== "" && text.includes(p.trim().toLowerCase()));
}
function prioritizeCheckinAccounts(accounts, priority) {
  const cleaned = priority.map((p) => p.trim()).filter((p) => p !== "");
  if (cleaned.length === 0) return accounts.slice();
  const first = [];
  const rest = [];
  for (const acc of accounts) {
    (isPriorityLabel(acc.username, cleaned) ? first : rest).push(acc);
  }
  return [...first, ...rest];
}

// panel/trae-claim-status.ts
function traeClaimStatusOf(res) {
  if (res.claimed) return "claimed";
  if (res.auth_failed === true) return "failed";
  if (res.already_checked_in || res.device_checked_in) return "already";
  if (!res.enabled) return "skipped";
  if (res.would_claim) return "dry_run";
  return "failed";
}
function traeClaimMessageOf(res) {
  if (res.claimed) {
    const credits = res.checkin?.credits ?? 0;
    const retries = res.retries ?? 0;
    return `领取成功${credits > 0 ? `,当前积分 ${credits}` : ""}${retries > 0 ? `(上游拥挤,重试 ${retries} 次后成功)` : ""}`;
  }
  if (res.auth_failed === true) return res.message;
  if (res.code === TRAE_CODE_CROWDED) {
    return "上游当前拥挤(高峰限流),稍后重试即可 —— 账号本身没有问题";
  }
  return res.message;
}

// core/connectors/discover.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createHash as createHash2 } from "node:crypto";
function traeCliCandidates(home) {
  const h = home ?? homedir() ?? "";
  return [
    { edition: "cn", path: join(h, ".trae-cn", "trae-jwt-token") },
    { edition: "sg", path: join(h, ".trae", "trae-jwt-token") }
  ];
}
var TRAE_DESKTOP_EDITION_NAMES = {
  cn: ["Trae CN", "trae-cn"],
  sg: ["Trae"],
  solo: ["TRAE SOLO CN", "trae-solo-cn"],
  "solo-sg": ["TRAE SOLO"]
};
function traeDesktopRoot(platformName = platform()) {
  switch (platformName) {
    case "win32": {
      const appdata = process.env.APPDATA?.trim() || "";
      if (appdata) return appdata;
      const h = homedir() || "";
      return h ? join(h, "AppData", "Roaming") : null;
    }
    case "darwin": {
      const h = homedir() || "";
      return h ? join(h, "Library", "Application Support") : null;
    }
    case "linux": {
      const xdg = process.env.XDG_CONFIG_HOME?.trim() || "";
      if (xdg) return xdg;
      const h = homedir() || "";
      return h ? join(h, ".config") : null;
    }
    default:
      return null;
  }
}
function traeDesktopCandidates(home, platformName = platform()) {
  const root = home ?? traeDesktopRoot(platformName);
  if (!root) return [];
  const out = [];
  for (const [edition, names] of Object.entries(TRAE_DESKTOP_EDITION_NAMES)) {
    for (const name of names) {
      out.push({ edition, path: join(root, name, "User", "globalStorage", "storage.json") });
    }
  }
  return out;
}
function userRegionOf(value) {
  if (typeof value === "string") return value.toLowerCase();
  if (value && typeof value === "object" && "region" in value) {
    const r = value.region;
    if (typeof r === "string") return r.toLowerCase();
  }
  return null;
}
function traeRegionOf(credential, edition) {
  const ur = userRegionOf(credential.userRegion);
  if (ur) return normalize_region(ur);
  const host = credential.host ?? null;
  if (host && typeof host === "string") {
    if (host.includes(".trae.ai")) return "ai";
    if (host.includes(".trae.cn") || host.includes(".trae.com.cn")) return "cn";
  }
  return edition === "sg" || edition === "solo-sg" ? "ai" : "cn";
}
function hostDomainOf(host) {
  if (!host || typeof host !== "string") return null;
  const bare = host.replace(/^[a-z]+:\/\//i, "").split("/")[0].split("?")[0];
  return bare || null;
}
function toEpochMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value >= 1e11 ? value : value * 1e3;
}
function parseTraeDesktopStorage(path, edition) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`storage.json 不可读: ${path}`);
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error(`storage.json 非 JSON: ${path}`);
  }
  const rawAuth = root[AUTH_STORAGE_KEY];
  if (typeof rawAuth !== "string" || !rawAuth.trim()) {
    throw new Error(`storage.json 未登录:无 ${AUTH_STORAGE_KEY} 条目`);
  }
  let credJson;
  if (rawAuth.trimStart().startsWith("{")) {
    credJson = rawAuth;
  } else {
    credJson = decrypt_storage_value(rawAuth);
  }
  let cred;
  try {
    cred = JSON.parse(credJson);
  } catch {
    throw new Error(`storage.json auth 条目非 JSON: ${path}`);
  }
  const token = typeof cred.token === "string" && cred.token ? cred.token : typeof cred.accessToken === "string" && cred.accessToken ? cred.accessToken : null;
  if (!token) throw new Error(`storage.json 未登录:无 token`);
  const account = cred.account;
  const username = account && typeof account === "object" && typeof account.username === "string" ? account.username : null;
  const user_id = typeof cred.userId === "string" ? cred.userId : null;
  const host = typeof cred.host === "string" ? cred.host : null;
  const refresh_token = typeof cred.refreshToken === "string" ? cred.refreshToken : null;
  const region = traeRegionOf({ userRegion: cred.userRegion, host }, edition);
  const token_expires_at_ms = toEpochMs(
    typeof cred.expiredAt === "number" ? cred.expiredAt : typeof cred.expiredAt === "string" && cred.expiredAt ? Date.parse(cred.expiredAt) : cred.expiresAt
  );
  let device_id = null;
  let machine_id = null;
  for (const [k, v] of Object.entries(root)) {
    if (k.startsWith(DEVICE_CENTER_PREFIX) && typeof v === "string") {
      device_id = k.slice(DEVICE_CENTER_PREFIX.length);
      break;
    }
  }
  const telemetry = root.telemetry;
  if (telemetry && typeof telemetry === "object") {
    if (!device_id && typeof telemetry.devDeviceId === "string") {
      device_id = telemetry.devDeviceId;
    }
    if (typeof telemetry.machineId === "string") {
      machine_id = telemetry.machineId;
    }
  }
  const domain = hostDomainOf(host);
  const hintParts = [`来源:桌面版 storage.json(${edition})`];
  if (host) hintParts.push(`host ${host}`);
  if (domain) hintParts.push(domain);
  return {
    provider: "trae",
    username: username ?? user_id ?? "trae-desktop",
    token,
    region,
    source: "desktop",
    edition,
    hint: hintParts.join("; "),
    user_id: user_id ?? null,
    token_expires_at_ms,
    host: host ?? null,
    extra: {
      refresh_token,
      device_id,
      machine_id,
      host,
      domain,
      last_refresh: null
    }
  };
}
function base64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}
function parseJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64urlDecode(parts[1]));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}
function parseTraeCliToken(path, edition) {
  let text;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`token 文件不可读: ${path}`);
  }
  if (!text) throw new Error(`token 文件为空: ${path}`);
  let token = text;
  if (text.startsWith("{")) {
    try {
      const env = JSON.parse(text);
      const t = typeof env.token === "string" ? env.token : typeof env.accessToken === "string" ? env.accessToken : typeof env.jwt === "string" ? env.jwt : null;
      if (t) token = t;
    } catch {
    }
  }
  const payload = parseJwtPayload(token);
  if (!payload) throw new Error(`token 非 3 段 JWT: ${path}`);
  const data = payload.data;
  const user_id = data && typeof data === "object" && typeof data.user_id === "string" ? data.user_id : null;
  if (!user_id) throw new Error(`JWT 无 data.user_id: ${path}`);
  const host = "https://api.trae.cn";
  return {
    provider: "trae",
    username: user_id,
    token,
    region: traeRegionOf({ host }, edition),
    source: "cli",
    edition,
    hint: `来源:CLI token 文件(${edition})`,
    user_id,
    token_expires_at_ms: toEpochMs(payload.exp),
    host,
    extra: { host, last_refresh: null }
  };
}
function hashToken(token) {
  if (!token) return "null";
  return createHash2("sha256").update(token).digest("hex").slice(0, 12);
}
function discoverTraeAccounts(options = {}) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (acc) => {
    if (!acc) return;
    const key = `${acc.source}\0${acc.edition ?? ""}\0${acc.user_id ?? hashToken(acc.token)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(acc);
  };
  if (options.desktop !== false) {
    for (const { edition, path } of traeDesktopCandidates(options.home, options.platformName)) {
      if (!existsSync(path)) continue;
      try {
        push(parseTraeDesktopStorage(path, edition));
      } catch {
      }
    }
  }
  if (options.cli !== false) {
    for (const { edition, path } of traeCliCandidates(options.home)) {
      if (!existsSync(path)) continue;
      try {
        push(parseTraeCliToken(path, edition));
      } catch {
      }
    }
  }
  return out;
}

// panel/refresh.ts
import { createSign, randomBytes } from "node:crypto";
var REFRESH_PROVIDERS = ["trae", "workbuddy", "minimax"];
var REFRESH_MARGIN_S = 300;
var REFRESH_TIMEOUT_MS = 2e4;
var TRAE_DEFAULT_HOST_CN = "https://api.trae.cn";
var TRAE_DEFAULT_HOST_AI = "https://api.trae.ai";
var TRAE_CLOUDIDE_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";
var TRAE_SOLO_PATH = "/trae/api/v3/oauth/ExchangeToken";
var TRAE_CN_CLIENT_ID = "ono9krqynydwx5";
var TRAE_SOLO_CLIENT_ID = "en1oxy7wnw8j9n";
var WB_CN_CHAT_BASE = "https://copilot.tencent.com";
var WB_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
var WB_CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
var WB_CN_BILLING_BASE = "https://www.codebuddy.cn";
var WB_GLOBAL_DOMAINS = ["workbuddy.ai", "codebuddy.ai"];
var RefreshError = class extends Error {
};
var RefreshCredentialError = class extends RefreshError {
};
function refreshSupported(provider) {
  return REFRESH_PROVIDERS.includes(provider);
}
function strOf(raw, key) {
  const v = raw[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function jwtPayloadOf(token) {
  if (token.split(".").length < 2) return null;
  try {
    const seg = token.split(".")[1];
    const padded = seg + "=".repeat(-seg.length % 4);
    const parsed = JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function traeRefreshHost(cred) {
  const host = strOf(cred.raw, "host");
  if (host) return host.replace(/\/+$/, "");
  const region = (strOf(cred.raw, "region") ?? "").toLowerCase();
  return region === "ai" || region === "sg" || region === "global" ? TRAE_DEFAULT_HOST_AI : TRAE_DEFAULT_HOST_CN;
}
function traeContractOf(cred) {
  const edition = (strOf(cred.raw, "edition") ?? "cn").toLowerCase();
  if (edition === "solo" || edition === "solo-sg") {
    return { path: TRAE_SOLO_PATH, clientId: TRAE_SOLO_CLIENT_ID, deviceInfo: true };
  }
  return { path: TRAE_CLOUDIDE_PATH, clientId: TRAE_CN_CLIENT_ID, deviceInfo: false };
}
function traeUserId(cred) {
  const uid = strOf(cred.raw, "uid");
  if (uid) return uid;
  const userId = strOf(cred.raw, "user_id");
  if (userId) return userId;
  const token = cred.secret ?? "";
  if (token.split(".").length >= 2) {
    const payload = jwtPayloadOf(token);
    const data = payload?.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const key of ["user_id", "id"]) {
        const v = data[key];
        if (v !== void 0 && v !== null && String(v).trim()) return String(v).trim();
      }
    }
  }
  throw new RefreshCredentialError(
    "trae 账号没有 user_id/uid,且无法从 token 里解出 —— 无法构造刷新请求。"
  );
}
function traeDeviceProof(path, clientId, refreshToken, privateKeyPem) {
  const timestamp = String(Date.now());
  const nonce = Buffer.from(randomBytes(16)).toString("base64url").replace(/=+$/, "");
  const message = ["POST", path, clientId, refreshToken, timestamp, nonce].join("\n");
  const signer = createSign("SHA256");
  signer.update(message, "utf8");
  const signature = signer.sign(privateKeyPem, "base64");
  return { Signature: signature, Timestamp: timestamp, Nonce: nonce };
}
function wbRegionOf2(domain) {
  let d = domain.trim().toLowerCase();
  if (d.startsWith("www.")) d = d.slice(4);
  for (const g of WB_GLOBAL_DOMAINS) {
    if (d === g || d.endsWith(`.${g}`)) return "global";
  }
  return "cn";
}
function wbBillingBase(domain) {
  if (wbRegionOf2(domain) !== "global") return WB_CN_BILLING_BASE;
  return domain.toLowerCase().includes("codebuddy.ai") ? "https://www.codebuddy.ai" : "https://www.workbuddy.ai";
}
function wbChatBase(domain) {
  if (wbRegionOf2(domain) !== "global") return WB_CN_CHAT_BASE;
  return domain.toLowerCase().includes("codebuddy.ai") ? "https://www.codebuddy.ai" : "https://www.workbuddy.ai";
}
function wbDomainOf(cred) {
  const domain = strOf(cred.raw, "domain");
  if (domain) return domain;
  const regionRaw = strOf(cred.raw, "region");
  const region = regionRaw ? regionRaw.toLowerCase() : detect_region_from_token(cred.secret ?? "");
  return region === "cn" ? "copilot.tencent.com" : "https://www.workbuddy.ai";
}
async function postJson(url, headers, body) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REFRESH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: body !== void 0 ? JSON.stringify(body) : void 0,
      signal: abort.signal
    });
  } catch (err) {
    throw new RefreshError(`刷新请求失败:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new RefreshError(`刷新端点返回 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new RefreshError("刷新应答不是合法 JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RefreshError("刷新应答不是 JSON 对象");
  }
  return payload;
}
async function refreshTraeToken(cred) {
  if (!cred.refreshSecret) {
    throw new RefreshCredentialError("无 refresh token,请在客户端重新登录后重新发现");
  }
  const contract = traeContractOf(cred);
  const userId = traeUserId(cred);
  const refreshToken = cred.refreshSecret.trim();
  const body = {
    ClientID: contract.clientId,
    ClientSecret: "",
    RefreshToken: refreshToken,
    UserID: userId
  };
  const extra = {};
  if (contract.deviceInfo) {
    const deviceId = strOf(cred.raw, "device_id");
    const machineId = strOf(cred.raw, "machine_id");
    if (!deviceId || !machineId) {
      throw new RefreshCredentialError(
        "TRAE SOLO 刷新需要 device_id 与 machine_id,凭据里没有。请在客户端重新登录后重新导入。"
      );
    }
    const keypair = cred.raw["device_keypair"];
    const pem = keypair && typeof keypair === "object" ? keypair["private_key_pem"] : void 0;
    if (typeof pem !== "string" || pem.length === 0) {
      throw new RefreshCredentialError(
        "TRAE SOLO 刷新需要 device_keypair(设备绑定密钥对),凭据里没有。请在客户端重新登录后重新导入凭据。"
      );
    }
    body["DeviceInfo"] = {
      DeviceID: deviceId,
      MachineID: machineId,
      PlatformCode: "SOLO_PC",
      DeviceType: "PC",
      DeviceName: strOf(cred.raw, "device_name") ?? "as-one",
      ClientVersion: strOf(cred.raw, "build_version") ?? ""
    };
    body["DeviceProof"] = traeDeviceProof(contract.path, contract.clientId, refreshToken, pem);
    extra["device_keypair"] = keypair;
  }
  const payload = await postJson(traeRefreshHost(cred) + contract.path, { "Content-Type": "application/json" }, body);
  const parsed = parse_refresh_response(payload);
  if (!Number.isFinite(parsed.expiresAt)) {
    throw new RefreshError("trae 刷新应答未返回 TokenExpireAt");
  }
  return {
    accessToken: parsed.accessToken,
    expiresAtMs: Math.round(parsed.expiresAt * 1e3),
    refreshToken: parsed.refreshToken,
    extra
  };
}
async function refreshWorkbuddyToken(cred) {
  if (!cred.refreshSecret) {
    throw new RefreshCredentialError("无 refresh token,请在客户端重新登录后重新发现");
  }
  const domain = wbDomainOf(cred);
  const origin = wbBillingBase(domain);
  const uid = strOf(cred.raw, "uid") ?? (cred.secret ? jwt_claim(cred.secret, "sub") || void 0 : void 0);
  const enterpriseId = strOf(cred.raw, "enterprise_id");
  const headers = {
    ...build_refresh_headers(cred.refreshSecret),
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": WB_CLIENT_UA,
    "X-Auth-Refresh-Source": "workbuddy"
  };
  if (uid) headers["X-User-Id"] = uid;
  if (enterpriseId) headers["X-Enterprise-Id"] = enterpriseId;
  const payload = await postJson(wbChatBase(domain) + WB_REFRESH_PATH, headers);
  const parsed = parse_refresh_response2(payload);
  return {
    accessToken: parsed.accessToken,
    // 上游可能不给 expiresIn → core 返回 Infinity;此时保留旧到期(既有语义)。
    expiresAtMs: Number.isFinite(parsed.expiresAt) ? Math.round(parsed.expiresAt * 1e3) : null,
    refreshToken: parsed.refreshToken
  };
}
async function refreshMinimaxToken(cred) {
  if (!cred.refreshSecret) {
    throw new RefreshCredentialError("无 refresh token,请在该账号导出的凭据里补上 refresh_token");
  }
  const region = (strOf(cred.raw, "region") ?? "").toLowerCase() === "global" ? "global" : "cn";
  const res = await minimaxRefreshToken({
    refreshToken: cred.refreshSecret,
    region
  });
  return {
    accessToken: res.accessToken,
    refreshToken: res.refreshToken ?? void 0,
    expiresAtMs: res.expiresInSec !== null && Number.isFinite(res.expiresInSec) ? Math.round(Date.now() + res.expiresInSec * 1e3) : null
  };
}

// panel/adopt-fields.ts
var SKIP_RAW_KEYS = /* @__PURE__ */ new Set(["provider", "token", "region"]);
function nonEmptyString(v) {
  if (typeof v !== "string") return void 0;
  const t = v.trim();
  return t === "" ? void 0 : t;
}
function adoptVaultFields(opts) {
  const raw = {
    source: "discover",
    // ⚠️ 字段名是 `_ms`，而入参是秒 —— 这里 ×1000；写错就是 1970 年。
    adopted_at_ms: Math.round(opts.nowSec * 1e3)
  };
  if (opts.region) raw.region = String(opts.region);
  const extra = opts.extra ?? {};
  for (const [k, v] of Object.entries(extra)) {
    if (v === void 0 || v === null || v === "") continue;
    if (SKIP_RAW_KEYS.has(k)) continue;
    raw[k] = v;
  }
  const ms = extra["token_expires_at_ms"];
  const expiresAt = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms / 1e3 : void 0;
  const refreshSecret = nonEmptyString(extra["refresh_token"]);
  return { raw, expiresAt, refreshSecret };
}

// panel/checkin-cache.ts
var cache = /* @__PURE__ */ new Map();
var CHECKIN_ERROR_RETRY_MS = 6e4;
var RESET_HOUR_BY_PROVIDER = {
  // qoder 签到活动明示「每日 10:00(UTC+8)刷新」(campaigns 实测)。
  qoder: 10
};
function checkinCycleKey(provider, nowMs = Date.now()) {
  const resetHour = RESET_HOUR_BY_PROVIDER[provider] ?? 0;
  const d = new Date(nowMs);
  if (resetHour > 0 && d.getHours() < resetHour) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function getCachedCheckin(provider, nowMs = Date.now()) {
  const hit = cache.get(provider);
  if (hit === void 0) return void 0;
  if (hit.cycle !== checkinCycleKey(provider, nowMs)) {
    cache.delete(provider);
    return void 0;
  }
  if (hit.failed && hit.retryAtMs > nowMs) return hit;
  if (hit.failed) {
    cache.delete(provider);
    return void 0;
  }
  return hit;
}
function setCachedCheckin(provider, value, failed, nowMs = Date.now()) {
  cache.set(provider, {
    cycle: checkinCycleKey(provider, nowMs),
    retryAtMs: failed ? nowMs + CHECKIN_ERROR_RETRY_MS : 0,
    failed,
    value
  });
}
function invalidateCheckinCache(provider) {
  if (provider === void 0) cache.clear();
  else cache.delete(provider);
}

// panel/constants.ts
var KNOWN_PROTOCOLS = ["openai", "anthropic", "workbuddy", "trae", "sensenova", "qoder", "minimax", "codearts"];
var REQUEST_LOG_CONTENT_MODES = [
  { value: "off", label: "不记录日志" },
  { value: "structure", label: "记录结构" },
  { value: "full", label: "记录完整正文" },
  { value: "edges", label: "记录正文首尾" }
];
var KIND_BY_PROTOCOL = {
  openai: "endpoint",
  // Anthropic Messages 是**自建端点**(base URL + key),没有签到/额度/账号池,
  // 与 openai 同类 → "endpoint"。
  anthropic: "endpoint",
  workbuddy: "channel",
  trae: "channel",
  sensenova: "channel",
  // Qoder 是 PAT 账号池(一个 PAT 一条凭据、还要做每日签到与额度读数),
  // 归 "channel" 而不是 "endpoint"。
  qoder: "channel",
  // MiniMax 有签到/额度/内置模型目录,同样是渠道;2026-11-08 接通聊天转发后
  // 仍是渠道 → 只是多了一条 `/mavis/api/v1/llm/v1/messages` 的出站路径。
  minimax: "channel",
  // CodeArts 是 AK/SK 账号池(一个 AK 一条凭据 + 每账号并发上限 3),
  // 归 "channel";推理走 `snap-access` 的签名网关,签到走 `/v1/ops/*`。
  codearts: "channel"
};
var CH_QUOTA_PROVIDERS = /* @__PURE__ */ new Set(["trae", "workbuddy", "minimax", "codearts"]);
var CH_CATALOG_PROVIDERS = /* @__PURE__ */ new Set(["trae", "workbuddy", "sensenova", "minimax", "qoder", "codearts"]);
var STRATEGY_LABELS = {
  "due-first": "最先到期 Due first",
  random: "随机 Random",
  "usage-balanced": "用量平衡 Usage balanced",
  "ordered-fallback": "按序降级链 Ordered fallback",
  "least-busy": "最少在途 Least busy",
  balanced: "平均使用 Balanced"
};
var CLIENT_CHANNELS = [
  { channel: "workbuddy", description: "WorkBuddy 客户端路径" },
  { channel: "trae", description: "Trae 客户端路径" },
  { channel: "sensenova", description: "SenseNova 客户端路径" }
];
var LDRIVE = process.env.AS_ONE_CLIENT_DRIVE || "L:";
var CLIENT_INSTALL_ROOTS = [
  { dir: "%LOCALAPPDATA%\\Programs", source: "candidates", label: "%LOCALAPPDATA%\\Programs" },
  { dir: "%PROGRAMFILES%", source: "program-files", label: "C:\\Program Files" },
  { dir: "%PROGRAMFILES(X86)%", source: "program-files-x86", label: "C:\\Program Files (x86)" },
  { dir: "%LOCALAPPDATA%", source: "localappdata", label: "%LOCALAPPDATA%" },
  { dir: LDRIVE + "\\", source: "ldrive", label: LDRIVE + " 盘约定" }
];
var CLIENT_CANDIDATES = {
  // Trae:官方默认 `C:\Program Files\Trae\Trae.exe`;国内版目录名是 `Trae CN`。
  trae: ["Trae\\Trae.exe", "Trae CN\\Trae CN.exe", "Trae.exe"],
  workbuddy: ["WorkBuddy\\WorkBuddy.exe", "WorkBuddy.exe"],
  // sensenova 无 exe 候选表。
  sensenova: []
};
var SETTING_FIELDS = [
  {
    key: "external_refresh.interval_hours",
    def: "5",
    kind: "float",
    // ⚠️ 单位只在输入框右侧显示一次(UNIT_BY_KEY)。标签里再写「(小时)」就重复了
    // —— 用户 2026-11 定案:要么统一有单位、要么统一没有,不要前后各来一遍。
    label: "外部数据刷新时间（小时）",
    min: 0.1,
    max: 168
  },
  {
    key: "scheduler.rules_p1",
    def: "",
    kind: "json",
    label: "调度规则 · 免费档(priority 1)"
  },
  {
    key: "scheduler.rules_p2",
    def: "",
    kind: "json",
    label: "调度规则 · 有到期时间的档(priority 2)"
  },
  {
    key: "scheduler.rules_p3",
    def: "",
    kind: "json",
    label: "调度规则 · 普通消耗档(priority 3)"
  },
  {
    key: "scheduler.rules_p4",
    def: "",
    kind: "json",
    label: "调度规则 · 高峰低优先(priority 4)"
  },
  {
    key: "scheduler.rules_p0",
    def: "",
    kind: "json",
    label: "调度规则 · 禁用档(priority 0)"
  },
  {
    key: "scheduler.window_profiles",
    def: "",
    kind: "json",
    label: "命名时段配置(星期 + 时段)"
  },
  {
    key: "scheduler.cooldown_overrides",
    def: "",
    kind: "json",
    label: "供应商级冷却覆盖(分钟)"
  },
  {
    key: "scheduler.pin_seconds",
    def: "900",
    kind: "float",
    label: "会话粘性时长（秒）",
    min: 0,
    max: 86400
  },
  {
    key: "retry.base_backoff_s",
    def: "1",
    kind: "float",
    label: "初始退避（秒）",
    min: 0.05,
    max: 60
  },
  {
    key: "retry.max_backoff_s",
    def: "15",
    kind: "float",
    label: "最大退避（秒）",
    min: 0.05,
    max: 300
  },
  {
    key: "retry.jitter_ratio",
    def: "0.2",
    kind: "float",
    label: "抖动比例（0-1）",
    min: 0,
    max: 1
  },
  {
    key: "retry.codes",
    def: "timeout,connection,429,500,502,503,504",
    kind: "str",
    label: "可重试错误码"
  },
  {
    key: "retry.logical_max",
    def: "1",
    kind: "int",
    // 标签保持单行(用户 2026-11):「(作为逻辑模型成员)」在 140px 标签列里会
    // 折成两行把行高撑到 64px,破坏整列的垂直节奏。
    label: "最大重试次数（逻辑）",
    min: 1,
    max: 20
  },
  {
    key: "retry.real_max",
    def: "10",
    kind: "int",
    label: "最大重试次数（次）",
    min: 0
  },
  {
    // 2026-11 用户定案:它是「失败后多久不选这个逻辑模型成员」,与供应商级冷却
    // 同一个决策语境 → **页面渲染在冷却卡里**(`section` 只影响分组显示,键名不变)。
    key: "retry.logical_cooldown",
    def: "15",
    kind: "int",
    label: "逻辑模型成员",
    min: 1,
    max: 1440,
    section: "cooldown"
  },
  // ⭐ 2026-10-18 重进设置页(同批改动):键名前缀是 `real` 但**归在 retry 段
  // 渲染** —— 它与 retry.* 同一决策语境。段名只是展示分组,不影响键本身。
  //
  // ⚠️ 2026-11-18 语义变更(用户定案):它现在表达**整个请求的总尝试时间**,
  // 不再是「单次上游调用愿意等多久」。所有换档 / 重试 / 连接器内部的 429
  // 等待都从这一个预算里扣；单次连接的超时取「剩余总预算」。
  {
    key: "real.wait_budget_s",
    def: "60",
    kind: "float",
    label: "请求总超时时间（秒）",
    min: 0,
    max: 3600,
    section: "retry"
  },
  // ⚠️ 2026-11-09 用户定案:「WorkBuddy 账号最小请求间隔」**不再是设置项** ——
  // 写死在 `@as-one/core/router/account-throttle` 的 `ACCOUNT_MIN_INTERVAL_MS`
  // (4 秒,抖动 25%)。它是账号安全下限,不是使用偏好:做成设置项意味着能被
  // 调成 0(关掉节流),而那正是导致 11140 封号、凭据被物理删除的行为。
  {
    key: "ui.recent_limit",
    def: "50",
    kind: "int",
    label: "实时日志最大显示条数",
    min: 1,
    max: 500
  },
  // ── 重路由车道(辅助请求换模型) ────────────────────────────────────────
  // 键名与 `src/reroute.ts` 的 REROUTE_SETTING_KEYS 逐字对应;**默认空 = 不重路由**。
  // 值填 as-one 里的抽象模型名(逻辑模型名),例如 free。
  {
    key: "route.compact",
    def: "",
    kind: "str",
    label: "压缩摘要"
  },
  {
    key: "route.vision",
    def: "",
    kind: "str",
    label: "图片解析(必须能看图)"
  },
  {
    key: "route.session_title",
    def: "",
    kind: "str",
    label: "会话标题"
  },
  // ── 子代理模型 ────────────────────────────────────────────────────────
  // 值为 as-one 逻辑模型名（也可直接写 `provider/model`）。
  // 默认模型只在**创建期**、调用方没显式指定模型时注入；并发拦截语义不变。
  // 替代模型只在**已创建的子代理会话**请求期遇到首帧前 CAPACITY 时临时使用。
  {
    key: "subagent.default_model",
    def: "",
    kind: "str",
    label: "子代理默认模型（留空=跟随父会话）"
  },
  {
    key: "subagent.fallback_model",
    def: "",
    kind: "str",
    label: "子代理并发超限替代模型（留空=不兜底）"
  },
  // ── 嵌入式组件:压缩增强(src/components/compaction) ───────────────────
  //
  // ⚠️ 2026-11 用户定案:压缩增强**不再是独立卡片**,只保留「压缩模式」一个下拉,
  // 并进「辅助请求路由」卡。其余三项全部退役:
  //   - `compaction.enabled`   → 恒启用(路由卡里选了逻辑模型就生效);
  //   - `compaction.logicalModel` → 复用同卡的 `route.compact`(逻辑模型名,唯一真源);
  //   - `compaction.tiers`     → 由该逻辑模型的 members 自动推导。
  // 用户原话:「逻辑模型和压缩模式已经提供了所有信息」。
  {
    key: "compaction.promptMode",
    def: "default",
    kind: "enum",
    label: "压缩模式",
    options: [
      // 2026-11 用户定案文案：「一次完成」强调 DSH 原生行为，
      // 「带锚点分块-合并」「分块-合并」直接描述做法（不再出现英文 quilt）。
      { value: "default", label: "一次完成（DSH 默认方式）" },
      { value: "anchored", label: "带锚点分块-合并" },
      { value: "quilt", label: "分块-合并" }
    ],
    section: "compaction"
  }
];

// panel/channels-methods.ts
function createChannelsMethods(ctx, deps) {
  const {
    chQuotaCache: chQuotaCache2,
    accountsWithKey,
    autoAdoptTrae,
    catalogCooldownStateOf,
    catalogFetchedAt,
    catalogRows,
    chAwaitCatalog,
    chAwaitQuota,
    chCreditsOf,
    chMaybeFetchQuota,
    channelAccountsOf,
    checkinAccountsOf,
    checkinBaseOf,
    checkinClaimOne,
    doRefreshRun,
    getClientPathsImpl,
    mergeCatalog,
    mergedChannelModels,
    modelsSourceOf,
    probeClientPath,
    probeProviderModels,
    rawStrOf,
    refreshAccountsOf,
    refreshInFlight,
    refreshLedger,
    refreshRowBase,
    safeExists,
    serializeReasoningEfforts: serializeReasoningEfforts2
  } = deps;
  function upsertRealModelRow(pid, bare, spec) {
    const row = ctx.db.realModel.get(pid, bare);
    const name = (spec.name ?? "").trim();
    const vision = spec.vision === void 0 ? void 0 : spec.vision ? 1 : 0;
    const ctxWin = spec.context_window === void 0 ? void 0 : spec.context_window;
    const maxOut = spec.max_output === void 0 ? void 0 : spec.max_output;
    const cat = catalogRows.get(pid)?.get(bare);
    const fallbackCtx = cat?.context_window ?? null;
    const fallbackOut = cat?.max_output ?? null;
    ctx.db.realModel.set({
      provider: pid,
      model: bare,
      name: name !== "" ? name : row?.name ?? bare,
      supports_vision: vision ?? (row?.supports_vision ?? 0),
      max_input_tokens: ctxWin === void 0 ? row?.max_input_tokens ?? fallbackCtx : ctxWin,
      max_output_tokens: maxOut === void 0 ? row?.max_output_tokens ?? fallbackOut : maxOut,
      hidden: 0,
      // ⚠️ 2026-11-08:并发是**每凭据**的;老行保留原值,新行按供应商缺省
      // (workbuddy=2,其余 1),别一律写 1。
      concurrency: row && row.concurrency > 0 ? row.concurrency : defaultConcurrencyOf(pid),
      supported_reasoning_efforts: cat === void 0 || cat.reasoning_efforts === null ? row?.supported_reasoning_efforts ?? null : serializeReasoningEfforts2(cat.reasoning_efforts),
      reasoning_allows_off: cat === void 0 || cat.reasoning_allows_off === null ? row?.reasoning_allows_off ?? null : cat.reasoning_allows_off
    });
    return !row;
  }
  async function runCatalogSegment(pid, forced, accounts) {
    if (!CH_CATALOG_PROVIDERS.has(pid)) {
      return {
        written: 0,
        count: 0,
        message: "模型目录:缺项(该渠道没有 upstream_catalog 的能力声明)",
        missing: ["catalog"],
        errors: {},
        catalog: { status: "missing", reason: "该渠道无上游目录协议", count: 0, source: null }
      };
    }
    if (accounts.length === 0) {
      return {
        written: 0,
        count: 0,
        message: `模型目录:${pid} 下没有账号,跳过`,
        missing: [],
        errors: {},
        catalog: { status: "skipped", reason: "没有账号", count: 0, source: null }
      };
    }
    const failures = [];
    let count = 0;
    let written = 0;
    let warns = [];
    const pulls = accounts.map((a) => a.cred.username);
    for (const username of pulls) {
      try {
        const res = await chAwaitCatalog(pid, username, forced);
        const pdef = ctx.registry.getProvider(pid);
        count = mergeCatalog(pid, res.entries, pdef?.baseUrl ?? null, pdef?.protocol ?? pid);
        warns = res.warnings;
        written += 1;
        break;
      } catch (err) {
        failures.push(`${username}:${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const allFailed = failures.length === pulls.length;
    const catalog = allFailed ? { status: "failed", reason: failures[0] ?? "全部账号失败", count: 0, source: null } : { status: "ok", reason: `上游 ${count} 个模型,已写入库`, count, source: "api" };
    const message = allFailed ? `模型目录没拉到(${failures[0] ?? "全部账号失败"})` : `模型目录 ${count} 个(来源:上游 API)${warns.length > 0 ? `(降级:${warns[0]})` : ""}`;
    return { written, count, message, missing: [], errors: {}, catalog };
  }
  async function runCheckinSegment(pid, accounts) {
    const protocol = ctx.registry.getProvider(pid)?.protocol?.toLowerCase() ?? "";
    const checkinCapable = checkinSupported(protocol);
    const summary = {
      supported: checkinCapable,
      claimed: 0,
      already: 0,
      skipped: 0,
      failed: 0,
      credit: 0,
      errors: [],
      message: null
    };
    let part = null;
    if (checkinCapable) {
      if (accounts.length === 0) {
        summary.message = `${pid} 下没有账号,跳过签到`;
      } else {
        try {
          const claim = await methods.checkinClaim(pid, true);
          const rows = claim.accounts ?? [];
          summary.claimed = rows.filter((r) => r.status === "claimed").length;
          summary.already = rows.filter((r) => r.status === "already").length;
          summary.skipped = rows.filter((r) => r.status === "skipped").length;
          summary.failed = rows.filter((r) => r.status === "failed").length;
          summary.credit = rows.reduce((s, r) => s + Number(r.credit ?? 0), 0);
          summary.errors = rows.filter((r) => r.status === "failed").map((r) => String(r.message ?? "").slice(0, 300));
        } catch (err) {
          summary.message = `签到失败:${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
        }
      }
      if (summary.message) {
        part = summary.message;
      } else if (summary.claimed > 0) {
        const tail = summary.credit > 0 ? `,共 ${summary.credit} 积分` : "";
        part = `已签到领取 ${summary.claimed} 个账号${tail}`;
      } else if (summary.already > 0) {
        part = `今日已签到(${summary.already} 个账号,无需重复领取)`;
      } else if (summary.failed > 0) {
        part = `签到失败:${summary.errors[0] ?? "未知原因"}`;
      } else {
        part = "该渠道今日未领取(各账号被跳过,原因见渠道页各行)";
      }
    }
    return { summary, part };
  }
  async function runQuotaSegment(pid, forced, accounts) {
    const errors = {};
    if (!CH_QUOTA_PROVIDERS.has(pid)) {
      return {
        probed: 0,
        written: 0,
        message: "额度:缺项(该渠道无额度协议,仅 trae/workbuddy 有)",
        missing: ["quota"],
        errors,
        quota: { status: "missing", reason: "该渠道无额度协议" }
      };
    }
    if (accounts.length === 0) {
      return {
        probed: 0,
        written: 0,
        message: `${pid} 下没有账号,跳过额度`,
        missing: [],
        errors,
        quota: { status: "skipped", reason: "没有账号" }
      };
    }
    const probed = accounts.length;
    let written = 0;
    let noExpiry = 0;
    for (const acc of accounts) {
      const snap = await chAwaitQuota(pid, acc.cred.username, forced);
      const hasExpiry = snap !== null && snap !== void 0 && typeof snap.expires_at === "number" && snap.expires_at > 0;
      if (snap && snap.error === null && snap.remaining !== null) {
        if (hasExpiry) {
          written += 1;
        } else {
          noExpiry += 1;
          errors[credentialKey(pid, acc.cred.username)] = "已取到额度但缺到期时间(到期未知)";
        }
      } else {
        errors[credentialKey(pid, acc.cred.username)] = snap?.error ?? "无密钥";
      }
    }
    const quota = written === probed ? { status: "ok", reason: `已刷新 ${written} 个账号额度` } : {
      status: written === 0 ? "failed" : "partial",
      reason: noExpiry > 0 ? `${written} 成功 / ${probed - written} 失败(其中 ${noExpiry} 个缺到期时间)` : `${written} 成功 / ${probed - written} 失败`
    };
    const message = quota.status === "ok" ? `已刷新 ${written}/${probed} 个账号的额度` : noExpiry > 0 ? `刷新不完整:${noExpiry} 个账号没有到期时间 —— ${Object.values(errors)[0] ?? "无结果"}` : `刷新失败:${Object.values(errors)[0] ?? "无结果"}`;
    return { probed, written, message, missing: [], errors, quota };
  }
  const methods = {
    /**
     * 拉上游模型目录(**只读**动作)。
     *
     * ⚠️ `decl` 是给「**还没保存**的供应商」用的:用户在新建卡片里填了 base_url/协议、
     * 点「获取可用模型」时,provider 行还不存在。用本次表单给的地址去探测,但
     * **绝不因此建 provider 行**(2026-10-24 用户反馈「点击获取可用模型会导致提供商被创建」)
     * —— 声明落库只发生在「保存」({@link upsertModelProvider})。
     */
    async fetchModels(id, _force, decl) {
      const pid = String(id ?? "");
      const row = ctx.db.provider.get(pid);
      const saved = ctx.registry.getProvider(pid) ?? (row ? { id: row.id, baseUrl: row.base_url, protocol: row.protocol, envPrefix: row.env_prefix } : null);
      if (!saved && !decl) return { ok: false, message: `未知 provider ${pid}` };
      const baseUrl = String(decl?.baseUrl ?? "").trim() || saved?.baseUrl || "";
      const protocol = String(decl?.protocol ?? "").trim() || saved?.protocol || "openai";
      if (CH_CATALOG_PROVIDERS.has(pid)) {
        const accounts = await refreshAccountsOf(pid);
        if (accounts.length === 0) {
          return { ok: false, message: `${pid} 下没有账号,没有密钥可以拿去拉上游目录。` };
        }
        const failures = [];
        let result = null;
        const pulls = accounts.map((a) => a.cred.username);
        for (const username of pulls) {
          try {
            result = await chAwaitCatalog(pid, username, _force === true);
            break;
          } catch (err) {
            failures.push(`${username}:${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (result === null) {
          return {
            ok: false,
            message: `上游目录拉取失败(${failures.length} 个账号;示例:${failures[0] ?? "无账号"})`
          };
        }
        const warnNote = result.warnings.length > 0 ? `(降级:${result.warnings[0]})` : "";
        const entries = result.entries.map((e) => ({
          id: e.id,
          name: e.name,
          vision: e.vision,
          context_window: e.context_window,
          max_output: e.max_output
        }));
        mergeCatalog(pid, result.entries, baseUrl, protocol);
        const models2 = mergedChannelModels(pid);
        const registeredCount2 = models2.filter((m) => m.exposed).length;
        const extra2 = registeredCount2 > 0 ? "" : ";还没有登记任何模型(勾选后保存)";
        return {
          ok: true,
          fetched: true,
          count: entries.length,
          message: `上游返回 ${entries.length} 个模型${warnNote}${extra2}`,
          models: models2
        };
      }
      const base = baseUrl;
      if (!base) {
        return { ok: false, message: "这家没有 base_url:请求由本机私有协议适配器转成私有协议,没有统一的 /models 接口可探测。模型清单以库里已登记的为准。" };
      }
      let u;
      try {
        u = new URL(base);
      } catch {
        return { ok: false, message: `base_url 不是可探测的 http(s) 地址:${base}` };
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, message: `base_url 不是可探测的 http(s) 地址:${base}` };
      }
      const creds = await ctx.vault.list(pid);
      let bearerKey = null;
      for (const c of creds) {
        const secret = await ctx.vault.secret(pid, c.username);
        if (typeof secret === "string" && secret !== "") {
          bearerKey = secret;
          break;
        }
      }
      const root = base.replace(/\/+$/, "");
      const first = await probeProviderModels(`${root}/models`, bearerKey);
      let probe = first;
      if (!probe.ok) {
        return { ok: false, message: probe.message };
      }
      const catalogEntries = probe.entries;
      mergeCatalog(pid, catalogEntries, baseUrl, protocol);
      const models = mergedChannelModels(pid);
      const registeredCount = models.filter((m) => m.exposed).length;
      const extra = registeredCount > 0 ? "" : ";还没有登记任何模型(勾选后保存)";
      return {
        ok: true,
        fetched: true,
        count: catalogEntries.length,
        message: `上游返回 ${catalogEntries.length} 个模型${extra}`,
        models
      };
    },
    /**
     * 模型目录**整批保存** —— 对齐 `POST /providers/{id}/exposure`。
     *
     * As One 原来只有逐行 `setModelExposure(provider, model, exposed)`:它只翻
     * `hidden` 一个位,于是「名称 / 视觉 / 上下文 / 最大输出」这四个**声明字段
     * 改了存不住**(用户在表格里勾了视觉,保存后又被刷回上游那一份)。原因是
     * 提交体本来就带这四个字段,这里按同一口径整批写。
     *
     * ⚠️ 清单外 = 删行(不是隐藏):「提交清单 = 成员名单」是整批替换语义,
     * 取消勾选就是从 `real_model` 摘掉。
     *
     * ⭐ **2026-10-18(m04740)语义:删行即连锁摘除** —— 以前这里在「被逻辑模型
     * 引用」时**整批拒绝**并点名让用户先去「逻辑模型」页手动摘。那是
     * 引入连锁摘除**之前**的旧口径。现在的做法是:删之前先把这一档从所有逻辑
     * 模型的 `members` 里摘掉(保序,顺序即 priority 不变),再删行 ——
     * 用户不再需要先跑一趟别的页面,也不会留下指向空气的悬空档位。
     *
     * ⚠️ 提交 id 指向别家供应商时**静默忽略该行**(同款 `continue`),
     * 不再整批报错:一个客户端顺手把整张目录表发过来时,别家的行不该让它失败。
     */
    async setChannelModels(provider, models) {
      const pid = String(provider ?? "").trim();
      if (!pid) return { ok: false, message: "provider 不能为空" };
      const list = Array.isArray(models) ? models : [];
      const wanted = /* @__PURE__ */ new Map();
      for (const raw of list) {
        const full = String(raw?.id ?? "").trim();
        const slash = full.lastIndexOf("/");
        const owner = slash >= 0 ? full.slice(0, slash) : pid;
        const bare = slash >= 0 ? full.slice(slash + 1) : full;
        if (bare === "") return { ok: false, message: `模型 id 为空:${full || "(空)"}` };
        if (owner !== pid) continue;
        wanted.set(bare, raw);
      }
      const existing = ctx.db.realModel.listByProvider(pid);
      const stale = existing.filter((r) => !wanted.has(r.model));
      let strippedTotal = 0;
      for (const r of stale) {
        strippedTotal += deps.stripMemberFromLogicalModels(`${pid}/${r.model}`);
      }
      let added = 0;
      for (const [bare, spec] of wanted) {
        if (upsertRealModelRow(pid, bare, spec)) added += 1;
      }
      for (const r of stale) ctx.db.realModel.delete(pid, r.model);
      try {
        ctx.scheduler.invalidate();
      } catch {
      }
      ctx.syncRegistry();
      const parts = [`共 ${wanted.size} 个模型`];
      if (added > 0) parts.push(`新登记 ${added} 个`);
      if (stale.length > 0) parts.push(`删除 ${stale.length} 个`);
      if (strippedTotal > 0) parts.push(`从逻辑模型档链连锁摘除 ${strippedTotal} 处`);
      return {
        ok: true,
        provider: pid,
        count: wanted.size,
        changed: [...wanted.keys()].map((m) => `${pid}/${m}`),
        message: `模型表已更新:${parts.join(",")}`
      };
    },
    /**
     * 单行实时保存 —— 用户 2026-10-31 定案:四页(Trae/WorkBuddy/Qoder/SenseNova)
     * 删掉「撤销 / 保存」按钮,勾选、改名、改上下文窗口、改最大输出、勾视觉**当场落库**。
     *
     * ⚠️ 与 {@link setChannelModels} 刻意分离:那个是**整批替换**(清单外 = 删行),
     * 实时保存一次只带一行,套用整批语义会把用户没在看的模型全删掉。
     * 这里按 (provider, model) 单行 upsert;`patch.exposed === false` 才删这一行,
     * 并且**照旧先做连锁摘除**(与整批删行同口径,不留下指向空气的档位)。
     *
     * ⚠️ 只碰模型表:不动凭据、不打上游、不写请求日志。失败一律如实回 message。
     */
    async setChannelModel(provider, patch) {
      const pid = String(provider ?? "").trim();
      if (!pid) return { ok: false, message: "provider 不能为空" };
      const full = String(patch?.id ?? "").trim();
      if (full === "") return { ok: false, message: "模型 id 为空" };
      const slash = full.lastIndexOf("/");
      const owner = slash >= 0 ? full.slice(0, slash) : pid;
      const bare = slash >= 0 ? full.slice(slash + 1) : full;
      if (bare === "") return { ok: false, message: `模型 id 为空:${full}` };
      if (owner !== pid) {
        return { ok: true, provider: pid, count: 0, changed: [], message: "" };
      }
      const done = (result) => {
        if (pid === "qoder") {
          try {
            const keys = ctx.db.realModel.listByProvider(pid).map((r) => r.model);
            ctx.db.setting.set(
              "qoder.models",
              JSON.stringify({ version: 1, selected: { qoder: keys } })
            );
          } catch (err) {
            console.error("[as-one] qoder 勾选偏好同步失败:", err);
          }
        }
        return result;
      };
      if (patch.exposed === false) {
        const existed = ctx.db.realModel.get(pid, bare) !== null;
        if (!existed) {
          return done({ ok: true, provider: pid, count: 0, changed: [], message: "" });
        }
        const stripped = deps.stripMemberFromLogicalModels(`${pid}/${bare}`);
        ctx.db.realModel.delete(pid, bare);
        try {
          ctx.scheduler.invalidate();
        } catch {
        }
        ctx.syncRegistry();
        const tail = stripped > 0 ? `,从逻辑模型档链连锁摘除 ${stripped} 处` : "";
        return done({
          ok: true,
          provider: pid,
          count: 0,
          changed: [`${pid}/${bare}`],
          message: `已取消登记 ${pid}/${bare}${tail}`
        });
      }
      const added = upsertRealModelRow(pid, bare, patch);
      try {
        ctx.scheduler.invalidate();
      } catch {
      }
      ctx.syncRegistry();
      return done({
        ok: true,
        provider: pid,
        count: 1,
        changed: [`${pid}/${bare}`],
        message: added ? `已登记 ${pid}/${bare}` : `已更新 ${pid}/${bare}`
      });
    },
    /**
     * 单模型检测(对齐 `POST /providers/{id}/check-model`)。
     *
     * 只回答「这个模型有没有可调用账户」,**不打上游**。
     */
    async checkModel(provider, model) {
      const pid = String(provider ?? "").trim();
      const mid = String(model ?? "").trim();
      if (!pid || !mid) return { ok: false, message: "provider 与 model 都不能为空" };
      const bare = mid.includes("/") ? mid.slice(mid.lastIndexOf("/") + 1) : mid;
      const mv = deps.modelViewOf(pid, bare);
      if (!mv) return { ok: false, message: `未登记的模型:${pid}/${bare}` };
      const withKey = await accountsWithKey(pid);
      const usable = withKey.filter((a) => a.hasKey).length;
      const ok = usable > 0;
      return {
        ok,
        message: ok ? `${pid}/${bare} 可调用(该供应商下 ${usable} 个有密钥的账户)` : `${pid}/${bare} 没有可调用账户(该供应商下 ${withKey.length} 个账户,${usable} 个有密钥)`,
        provider: pid,
        changed: []
      };
    },
    /**
     * SenseNova 账号列表(对齐 `GET /sensenova/accounts` → `_sensenova_accounts`)。
     *
     * 凭据投影,**无明文**。
     */
    /**
     * 额度只读面(对齐 `GET /api/quota`)。
     *
     * 数据源是采集器的内存快照(不实时打上游)—— 面板上显示的是「上次采集到的
     * 额度」,不是此刻的。
     */
    async getQuota() {
      const out = { providers: [], total: 0, checked_at: null };
      for (const p of ctx.registry.listProviders()) {
        for (const acc of ctx.registry.listAccounts(p.id)) {
          const [, username] = splitRef(acc.credentialRef);
          const cached = chQuotaCache2.get(`${p.id}/${username}`);
          const snap = cached?.snapshot ?? null;
          if (snap === null) continue;
          out.providers.push({
            provider: p.id,
            credential: acc.credentialRef,
            remaining: snap.remaining,
            limit: snap.limit,
            checked_at: Math.round(snap.fetched_at || 0),
            error: snap.error
          });
          out.total += snap.remaining ?? 0;
          out.checked_at = Math.round(snap.fetched_at || 0);
        }
      }
      return out;
    },
    async checkModels(id) {
      const targets = id ? [String(id)] : ctx.registry.listProviders().filter((p) => p.protocol === "openai").map((p) => p.id);
      const checked = [];
      const missing = [];
      for (const pid of targets) {
        const withKey = await accountsWithKey(pid);
        const usable = withKey.filter((a) => a.hasKey).length;
        for (const m of mergedChannelModels(pid)) {
          checked.push(m);
          if (m.registered && usable === 0) missing.push(m.id);
        }
      }
      return {
        ok: true,
        message: missing.length > 0 ? `检查完成:${missing.length} 个模型无可调用账户(${missing.join(", ")})` : "检查完成:全部模型均有可调用账户",
        models: checked,
        count: checked.length
      };
    },
    // ── 渠道页(Trae / WorkBuddy) ───────────────────────────────────────────
    async getProviderPage(provider, _fresh) {
      const pid = String(provider ?? "");
      const adoptMsg = await autoAdoptTrae(pid);
      const pdef = ctx.registry.getProvider(pid);
      const accounts = await channelAccountsOf(pid);
      const withKey = await accountsWithKey(pid);
      const models = mergedChannelModels(pid);
      const clientPaths = await getClientPathsImpl();
      const cpRow = clientPaths.channels.find((c) => c.channel === pid);
      const searchedHints = cpRow?.saved_path ? [`已接入客户端: ${cpRow.saved_path}`] : [];
      const checkinProtocol = pdef?.protocol?.toLowerCase() ?? "";
      const checkinCapable = checkinSupported(checkinProtocol);
      const checkinBlock = {
        supported: false,
        active: null,
        checked_in: null,
        did_checked_in: null,
        daily_credit: null,
        extra_credits: null,
        streak_days: null,
        reason: checkinCapable ? "支持签到(经 checkinStatus/checkinClaim 调用;渠道页刷新不会自动签到)" : "该渠道不支持签到",
        error: null
      };
      let credits;
      if (CH_QUOTA_PROVIDERS.has(pid)) {
        const primary = withKey.find((a) => a.hasKey);
        if (!primary) {
          credits = {
            left: null,
            total: null,
            expires_at_ms: null,
            fetched_at_ms: 0,
            packages: [],
            expiring_soon: null,
            not_applicable: true,
            error: null
          };
        } else {
          const cached = chQuotaCache2.get(credentialKey(pid, primary.username));
          credits = cached ? chCreditsOf(cached.snapshot, cached.fetchedAtMs) : {
            left: null,
            total: null,
            expires_at_ms: null,
            fetched_at_ms: 0,
            packages: [],
            expiring_soon: null,
            not_applicable: false,
            error: "额度尚未拉取 —— 点上方「刷新」"
          };
          chMaybeFetchQuota(pid, primary.username, false);
        }
      } else {
        credits = {
          left: null,
          total: null,
          expires_at_ms: null,
          fetched_at_ms: 0,
          packages: [],
          expiring_soon: null,
          not_applicable: true,
          error: null
        };
      }
      const accountsWithCredits = CH_QUOTA_PROVIDERS.has(pid) ? accounts.map((a) => {
        const cached = chQuotaCache2.get(a.credential_key);
        return {
          ...a,
          credits: cached ? chCreditsOf(cached.snapshot, cached.fetchedAtMs) : null
        };
      }) : accounts;
      return {
        provider: pid,
        env_prefix: pdef?.envPrefix ?? `ONE_${pid.toUpperCase()}`,
        region: null,
        signed_in: accounts.length > 0,
        username: accounts[0]?.label ?? null,
        account: accounts[0]?.label ?? null,
        searched: searchedHints,
        credits,
        checkin: checkinBlock,
        maintenance: {
          enabled: refreshSupported(pid),
          interval_s: null,
          last_run_ts: null,
          result: null,
          error: null,
          reason: refreshSupported(pid) ? "令牌到期前可手动刷新(两段式:先干跑看清,再确认)" : "该渠道不需要令牌刷新"
        },
        models,
        // 契约值域是 modelsSourceLabel 认的那几个(api / mixed / router / error),
        // 判据逐条对齐来源标签的口径:
        // - 这一轮没拉到上游目录(或该渠道没有这条通路)→ "router"(仅已登记);
        // - 全是上游目录行 → "api";
        // - 上游目录 + 已登记(库里多出上游这一轮没有的模型)→ "mixed"。
        models_source: modelsSourceOf(pid, models),
        models_fetched_at_ms: catalogFetchedAt.get(pid) ?? null,
        models_count: models.length,
        message: [
          adoptMsg ? `${adoptMsg};` : "",
          CH_QUOTA_PROVIDERS.has(pid) ? "" : "该渠道无额度子系统,已展示该渠道的凭据与模型配置;签到经 checkinStatus/checkinClaim 调用"
        ].filter(Boolean).join(" "),
        // ⚠️ 目录的冷却状态**如实**给出(B2):页面要能说明「为什么刷新没打上游」。
        auto_refresh: catalogCooldownStateOf(pid),
        accounts: accountsWithCredits,
        client_paths: clientPaths.channels.filter((c) => c.channel === pid)
      };
    },
    async getChannelAccounts(provider) {
      const pid = String(provider ?? "");
      await autoAdoptTrae(pid);
      return channelAccountsOf(pid);
    },
    async checkinStatus(_provider, _index) {
      const pid = String(_provider ?? "");
      const pdef = ctx.registry.getProvider(pid);
      const protocol = pdef?.protocol?.toLowerCase() ?? "";
      const flat = (over) => ({
        active: null,
        checked_in: null,
        did_checked_in: null,
        daily_credit: null,
        extra_credits: null,
        streak_days: null,
        reason: null,
        error: null,
        ...over
      });
      if (!pdef || !checkinSupported(protocol)) {
        return flat({ supported: false, reason: pid ? "该渠道不支持签到" : "渠道为空,不支持签到" });
      }
      const accounts = await checkinAccountsOf(pid);
      const withToken = accounts.filter((a) => a.token !== null && a.token !== "");
      if (withToken.length === 0) {
        return flat({ supported: true, reason: "该渠道没有带令牌的凭据,无法查询签到" });
      }
      const acc = _index === void 0 ? withToken[0] : withToken.find((a) => a.index === _index);
      if (acc === void 0) {
        return flat({
          supported: true,
          reason: `账号序号不存在: ${String(_index)}(该渠道共 ${accounts.length} 个凭据)`
        });
      }
      try {
        if (protocol === "trae") {
          const st2 = await traeCheckinStatus(
            {
              index: acc.index,
              username: acc.username,
              token: acc.token,
              region: acc.region,
              // ⚠️ 不传 device_id(resolveTraeDevice 一律按 token 派生):
              // raw 里的真机指纹同机共享,会让多账号被上游判定成同一设备。
              // 只读 status 也会被设备维度影响 —— 用独立指纹才能如实反映
              // 每个账号「本设备视角」的可签状态(2026-11-09 用户实测定案)。
              extra: acc.extra
            },
            { baseUrl: checkinBaseOf(pdef) ?? void 0 }
          );
          return flat({
            supported: true,
            active: st2.enable,
            checked_in: st2.checked_in,
            did_checked_in: st2.did_checked_in,
            daily_credit: st2.credits,
            extra_credits: st2.extra_credits,
            code: st2.code,
            message: st2.message ? st2.message.slice(0, 300) : null
          });
        }
        if (protocol === "codearts") {
          const raw = acc.extra ?? {};
          const accessKey = String(raw["accessKey"] ?? "");
          const secretKey = String(raw["secretKey"] ?? "");
          if (accessKey === "" || secretKey === "") {
            return flat({
              supported: true,
              reason: "该账号缺少 accessKey/secretKey，无法查询签到"
            });
          }
          const res = await codeartsIdeCheckin(
            {
              accessKey,
              secretKey,
              ...typeof raw["securityToken"] === "string" && raw["securityToken"] !== "" ? { securityToken: raw["securityToken"] } : {},
              ...typeof raw["domainId"] === "string" && raw["domainId"] !== "" ? { domainId: raw["domainId"] } : {},
              label: acc.username
            },
            { ...checkinBaseOf(pdef) ? { baseUrl: checkinBaseOf(pdef) } : {}, confirm: false }
          );
          if (res.code === -1 && /没有签到活动/.test(res.message)) {
            return flat({ supported: true, reason: "该渠道当前没有签到活动" });
          }
          if (res.code === -1) {
            return flat({
              supported: true,
              active: true,
              checked_in: false,
              daily_credit: res.credit > 0 ? res.credit : null,
              reason: res.already ? res.message : `今日可领取${res.credit > 0 ? ` ${res.credit} 积分` : ""}(未签)`
            });
          }
          if (!res.already && res.code !== 0) {
            return flat({ supported: true, error: res.message });
          }
          return flat({
            supported: true,
            active: true,
            checked_in: res.already,
            daily_credit: res.credit > 0 ? res.credit : null,
            reason: res.already ? res.message : null
          });
        }
        if (protocol === "minimax") {
          const bound = await minimaxAccountFor(ctx.vault, pid, acc.username);
          if (bound === null) {
            return flat({ supported: true, reason: "该账号没有可用令牌" });
          }
          const panel = await minimaxSigninStatus(bound.account, {
            timeoutMs: MINIMAX_QUOTA_TIMEOUT_MS,
            ...bound.httpOptions
          });
          const claimed = panelClaimedToday(panel);
          const points = panelTodayPoints(panel);
          return flat({
            supported: true,
            active: true,
            checked_in: claimed,
            // panelTodayPoints 已改为「不论已签/未签都给当日真实积分」:
            // 已签读作「今天领到 X」,未签读作「今天可领 X」(两个字段同值,
            // 面板按 checked_in 的语境取用)。
            daily_credit: points,
            today_credit: points,
            reason: null,
            message: null
          });
        }
        const st = await wbCheckinStatus(
          { index: acc.index, username: acc.username, token: acc.token, domain: acc.domain, uid: acc.uid, enterprise_id: acc.enterprise_id },
          { baseUrl: checkinBaseOf(pdef) ?? void 0 }
        );
        return flat({
          supported: true,
          active: st.active,
          checked_in: st.today_checked_in,
          daily_credit: st.daily_credit > 0 ? st.daily_credit : null,
          // `today_credit` 是「今日可得上限」，未签时也可能等于 daily_credit；
          // 透传原始值给面板显示「今日积分」，签到判断仍只看 today_checked_in。
          today_credit: st.today_credit > 0 ? st.today_credit : null,
          streak_days: st.streak_days > 0 ? st.streak_days : null,
          reason: st.active ? null : `该渠道当前没有签到活动${st.end_time !== null ? `（截止 ${st.end_time}）` : ""}`
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof CheckinRegionError || err instanceof CheckinCredentialError) {
          return flat({ supported: true, reason: msg.slice(0, 300) });
        }
        return flat({ supported: true, error: msg.slice(0, 300) });
      }
    },
    async checkinClaim(_provider, _confirm, _index) {
      const pid = String(_provider ?? "");
      const pdef = ctx.registry.getProvider(pid);
      const protocol = pdef?.protocol?.toLowerCase() ?? "";
      const confirm = _confirm === true;
      const fail = (message2) => ({ ok: false, provider: pid, message: message2 });
      if (!pdef || !checkinSupported(protocol)) {
        return fail(pid ? "该渠道不支持签到" : "渠道为空,不支持签到");
      }
      const accounts = await checkinAccountsOf(pid);
      if (accounts.length === 0) {
        return fail("该渠道没有凭据,无法签到");
      }
      const targets = _index === void 0 ? accounts : accounts.filter((a) => a.index === _index);
      if (_index !== void 0 && targets.length === 0) {
        return fail(`账号序号不存在: ${_index}(该渠道共 ${accounts.length} 个凭据)`);
      }
      const rows = [];
      let traeDeviceSpent = false;
      for (const acc of targets) {
        if (traeDeviceSpent) {
          rows.push({
            index: acc.index,
            provider: pid,
            username: acc.username,
            region: acc.region,
            status: "skipped",
            message: "本设备今日已签(同机其它账号先签了);trae 按设备放行,一天只能签一个账号"
          });
          continue;
        }
        const row = await checkinClaimOne(pid, protocol, acc, checkinBaseOf(pdef) ?? void 0, confirm);
        rows.push(row);
        if (pid === "trae" && row.device_checked_in === true) traeDeviceSpent = true;
      }
      const claimedN = rows.filter((r) => r.status === "claimed").length;
      const alreadyN = rows.filter((r) => r.status === "already").length;
      const failedRows = rows.filter((r) => r.status === "failed");
      if (confirm && claimedN > 0) invalidateCheckinCache(pid);
      const ok = claimedN + alreadyN > 0 || !confirm && rows.some((r) => r.status === "dry_run" || r.status === "skipped");
      let message;
      if (ok) {
        if (!confirm) {
          message = "干跑结果(未发出领取请求)";
        } else {
          const creditSum = rows.reduce((s, r) => s + (r.credit ?? 0), 0);
          const parts = [`已领取 ${claimedN} 个账号`];
          if (alreadyN > 0) parts.push(`今日已签 ${alreadyN} 个`);
          if (creditSum > 0) parts.push(`积分合计 ${creditSum}`);
          const first = rows.find((r) => r.status === "claimed" || r.status === "already");
          if (first) parts.push(first.message);
          message = parts.join(" · ");
        }
      } else if (rows.length > 0) {
        message = failedRows.length > 0 ? `签到失败:${failedRows[0].message}`.slice(0, 300) : "该渠道今日未领取(各账号被跳过,原因见渠道页各行)";
      } else {
        message = "该渠道没有可用账号";
      }
      return {
        ok,
        provider: pid,
        index: _index,
        message,
        confirm,
        count: rows.length,
        claimed: claimedN,
        already: alreadyN,
        accounts: rows
      };
    },
    async refreshStatus(provider) {
      const pid = String(provider ?? "");
      const unsupported = {
        running: false,
        started_at_ms: null,
        last_run_at_ms: null,
        last_elapsed_s: null,
        last_ok: null,
        last_error: null,
        result: `${pid} 暂无刷新能力(REFRESH_PROVIDERS = trae/workbuddy)`,
        count: 0,
        accounts: []
      };
      if (!refreshSupported(pid)) return unsupported;
      const accounts = await refreshAccountsOf(pid);
      const rows = accounts.map(({ index, cred }) => refreshRowBase(index, cred));
      const entry = refreshLedger.get(pid);
      const running = [...refreshInFlight.keys()].some((k) => k.startsWith(`${pid}#`));
      return {
        running,
        started_at_ms: entry?.startedAtMs ?? null,
        last_run_at_ms: entry?.lastRunAtMs ?? null,
        last_elapsed_s: entry?.lastElapsedS ?? null,
        last_ok: entry?.lastOk ?? null,
        last_error: entry?.lastError ?? null,
        result: entry?.result ?? "尚未执行过凭据刷新",
        count: rows.length,
        accounts: rows,
        last_run_accounts: entry?.lastRunAccounts ?? []
      };
    },
    async refreshRun(provider, confirm, index) {
      const pid = String(provider ?? "");
      const want = confirm === true;
      const onlyIndex = typeof index === "number" && Number.isInteger(index) ? index : void 0;
      if (!refreshSupported(pid)) {
        return {
          ok: false,
          provider: pid,
          confirm: want,
          count: 0,
          refreshed: 0,
          accounts: [],
          message: `${pid}:该渠道无令牌刷新概念(REFRESH_PROVIDERS = trae/workbuddy)`
        };
      }
      const flightKey = `${pid}#${onlyIndex === void 0 ? "*" : String(onlyIndex)}`;
      const inflight2 = refreshInFlight.get(flightKey);
      if (inflight2) return inflight2;
      const run = doRefreshRun(pid, want, onlyIndex);
      refreshInFlight.set(flightKey, run);
      try {
        return await run;
      } finally {
        refreshInFlight.delete(flightKey);
      }
    },
    async syncChannel(provider, force) {
      const pid = String(provider ?? "");
      const forced = force !== false;
      const accounts = await refreshAccountsOf(pid);
      const checked = accounts.length;
      const protocol = ctx.registry.getProvider(pid)?.protocol?.toLowerCase() ?? "";
      const checkinCapable = checkinSupported(protocol);
      const catalog = await runCatalogSegment(pid, forced, accounts);
      const checkin = await runCheckinSegment(pid, accounts);
      const quota = await runQuotaSegment(pid, forced, accounts);
      const missing = [];
      if (catalog.catalog.status === "missing") missing.push("catalog");
      if (quota.quota.status === "missing") missing.push("quota");
      if (!checkinCapable) missing.push("checkin");
      const ok = quota.written > 0;
      const message = `${quota.message};${catalog.message}${checkin.part ? `;${checkin.part}` : ""}`;
      return {
        ok,
        provider: pid,
        forced,
        checked,
        probed: quota.probed,
        written: quota.written,
        count: checked,
        message,
        missing,
        errors: quota.errors,
        quota: quota.quota,
        catalog: catalog.catalog,
        checkin: checkin.summary,
        skipped: []
      };
    },
    /**
     * **只刷新额度/积分**(打开渠道页、点「刷新」共用这一条,2026-11-07 拆分语义)。
     *
     * ⚠️ 模型目录一律不拉(展开渠道卡片才拉),签到一律不跑(只有点「全部签到」才签)。
     * 返回口径:`quota.status` = ok / partial / failed / missing / skipped;
     * `errors` 为账号级 map(`"provider/username" → 原因`),成功时为空。
     */
    async syncChannelQuota(provider, force) {
      const pid = String(provider ?? "");
      const forced = force !== false;
      const qoderRefresh = deps.qoderQuotaRefresh?.() ?? null;
      if (pid === "qoder" && qoderRefresh) {
        const q = await qoderRefresh(forced);
        if (q !== null) {
          return {
            ok: q.written > 0,
            provider: pid,
            probed: q.probed,
            message: q.message,
            missing: [],
            errors: q.errors,
            quota: { status: q.written > 0 ? "ok" : "failed", reason: q.message }
          };
        }
      }
      const accounts = await refreshAccountsOf(pid);
      const quota = await runQuotaSegment(pid, forced, accounts);
      return {
        ok: quota.written > 0,
        provider: pid,
        probed: quota.probed,
        message: quota.message,
        missing: quota.missing,
        errors: quota.errors,
        quota: quota.quota
      };
    },
    /**
     * **只拉模型目录并落库**(展开渠道卡片时跑,2026-11-07 拆分语义)。
     *
     * ⚠️ 不签到、不刷额度 —— 展开卡片不该顺手打上游额度探针,也不该碰签到
     * (签到只在显式点「全部签到」时才跑)。
     */
    async syncChannelCatalog(provider, force) {
      const pid = String(provider ?? "");
      const forced = force !== false;
      const accounts = await refreshAccountsOf(pid);
      const catalog = await runCatalogSegment(pid, forced, accounts);
      return {
        ok: catalog.catalog.status === "ok",
        provider: pid,
        written: catalog.written,
        count: catalog.count,
        message: catalog.message,
        missing: catalog.missing,
        errors: catalog.errors,
        catalog: catalog.catalog
      };
    },
    /**
     * **批量只刷额度**(打开渠道页入口):对每个有额度能力的渠道各跑一次额度段。
     *
     * ⚠️ 逐渠道串行:每渠道内部的 per-account 探针共享 `chQuotaCache` 的冷却与单飞,
     * 上游压力与逐个调 `syncChannelQuota` 完全一致,只是把 N 次 IPC 收敛成 1 次。
     * 不拉模型目录、不签到 —— 这是「打开页面直接更新积分」的唯一含义。
     */
    async syncAllQuota(force) {
      const forced = force !== false;
      const rows = [];
      const errorsAll = {};
      const missingAll = /* @__PURE__ */ new Set();
      let probed = 0;
      let written = 0;
      const nonOpenAiProviders = () => {
        const out = new Set(CH_QUOTA_PROVIDERS);
        try {
          for (const row of ctx.db.provider.list()) {
            const proto = String(row.protocol ?? "").toLowerCase();
            if (proto !== "" && proto !== "openai") out.add(row.id);
          }
        } catch {
        }
        return [...out].sort();
      };
      for (const pid of nonOpenAiProviders()) {
        const accounts = await refreshAccountsOf(pid);
        const quota = await runQuotaSegment(pid, forced, accounts);
        probed += quota.probed;
        written += quota.written;
        Object.assign(errorsAll, quota.errors);
        for (const m of quota.missing) missingAll.add(m);
        rows.push({
          provider: pid,
          probed: quota.probed,
          written: quota.written,
          quota: quota.quota,
          message: quota.message,
          missing: quota.missing,
          errors: quota.errors
        });
      }
      if (deps.qoderQuotaRefresh) {
        const qoderRefresh = deps.qoderQuotaRefresh();
        const q = qoderRefresh === null ? null : await qoderRefresh(forced);
        if (q !== null) {
          probed += q.probed;
          written += q.written;
          Object.assign(errorsAll, q.errors);
          rows.push({
            provider: "qoder",
            probed: q.probed,
            written: q.written,
            quota: { status: q.written > 0 ? "ok" : "failed", reason: q.message },
            message: q.message,
            missing: [],
            errors: q.errors
          });
        }
      }
      const incomplete = rows.filter((r) => {
        if (typeof r["probed"] !== "number" || r["probed"] === 0) return false;
        const q = r["quota"];
        if (q?.status === "missing") return false;
        return r["written"] !== r["probed"];
      });
      const allRead = incomplete.length === 0;
      return {
        ok: written > 0 && allRead,
        count: rows.length,
        probed,
        written,
        message: rows.length > 0 ? allRead ? `已刷新 ${rows.length} 个渠道额度(${written} 个账号全部读到,含到期时间)` : `刷新不完整:${incomplete.length} 个渠道没有全部读到到期数据(${incomplete.map((r) => String(r["provider"])).join("/")}) —— ${written}/${probed} 个账号成功` : "没有可刷新额度的渠道(非 openai 渠道均无额度协议)",
        missing: [...missingAll],
        errors: errorsAll,
        channels: rows
      };
    },
    // ── 客户端路径 ──────────────────────────────────────────────────────────
    async getClientPaths() {
      return getClientPathsImpl();
    },
    async saveClientPath(channel, path) {
      const pid = String(channel ?? "");
      const key = `client_path.${pid}`;
      const raw = String(path ?? "");
      if (raw !== "" && !safeExists(raw)) {
        ctx.db.setting.set(key, raw);
        return {
          ok: true,
          channel: pid,
          message: `已保存 ${key}(⚠️ 该路径当前不存在,客户端装好后才会生效)`,
          changed: [key]
        };
      }
      ctx.db.setting.set(key, raw);
      return { ok: true, message: `已保存 ${key}`, changed: [key] };
    },
    async detectClientPath(channel) {
      const pid = String(channel ?? "");
      const saved = ctx.db.setting.get(`client_path.${pid}`)?.v ?? null;
      if (saved !== null && saved !== "") {
        return {
          ok: true,
          channel: pid,
          detected_path: saved,
          source: "saved",
          message: `使用已保存的客户端路径(设置 client_path.${pid})`
        };
      }
      const det = await probeClientPath(pid);
      if (!det.found || !det.detected_path) {
        return { ok: false, channel: pid, detected_path: null, message: det.message };
      }
      return { ok: true, channel: pid, detected_path: det.detected_path, source: det.source, message: det.message };
    },
    // ── 自动发现 / 接入(POST /providers/{id}/discover、/adopt) ───
    async discoverChannelAccounts(provider) {
      const pid = String(provider ?? "");
      switch (pid) {
        case "trae": {
          const found = await discoverTraeAccounts();
          return {
            ok: true,
            provider: pid,
            found: found.length > 0,
            accounts: found.map((a) => ({
              username: a.username,
              region: a.region ?? null,
              hint: `来源:${a.source}${a.edition ? `(${a.edition})` : ""}${a.host ? `, host=${a.host}` : ""}`,
              token: a.token,
              edition: a.edition ?? null,
              source: a.source,
              token_expires_at_ms: a.token_expires_at_ms ?? null,
              // ⚠️ **身份字段必须透传**(2026-11-09 修 bug):以前这里逐字段手挑,
              // 把 `user_id` / `host` / `extra`(device_id / machine_id /
              // refresh_token / domain)全丢了 —— adopt 拿不到,写进库的凭据
              // 就只有 3 个键,签到被上游持续回 9074。
              user_id: a.user_id ?? null,
              host: a.host ?? null,
              extra: a.extra ?? null
            })),
            message: found.length > 0 ? `发现 ${found.length} 个本机 Trae 登录态(CLI token / 桌面版 storage.json)` : "未发现 Trae 本机登录态(已扫描 CLI token 与桌面版 storage.json;未登录或未安装)"
          };
        }
        case "workbuddy":
          return {
            ok: true,
            provider: pid,
            found: false,
            accounts: [],
            // ⚠️ 2026-11-08 复核(WorkBuddy 重新显性化):这条路径**没有失效**,
            // 它是「按设计找不到东西」—— WorkBuddy 没有可扫描的本机登录态
            // (官方桌面端的令牌在加密存储里,公开项目也都没做离线解密)。
            // 所以这里如实说明**怎么接入**,而不是假装扫了一圈没扫到。
            message: "WorkBuddy 没有可自动发现的本机登录态(官方客户端令牌在加密存储里,离线读不出)。请从 WorkBuddy 客户端导出访问令牌,在「渠道」页手动添加账号 —— 凭据只写数据库,不存在可手改的凭据文件。"
          };
        case "sensenova":
          return {
            ok: true,
            provider: pid,
            found: false,
            accounts: [],
            message: "SenseNova 无本机客户端登录态,不适用自动发现"
          };
        default:
          return { ok: false, provider: pid, found: false, accounts: [], message: `未知渠道 ${pid}` };
      }
    },
    async adoptChannelAccount(provider, username, token, region, extra) {
      const pid = String(provider ?? "");
      const name = String(username ?? "").trim();
      const tok = String(token ?? "").trim();
      if (!pid || !name || !tok) {
        return { ok: false, provider: pid, message: "adopt 需要 provider/username/token" };
      }
      const fields = adoptVaultFields({ nowSec: wallNow(), region, extra });
      const raw = fields.raw;
      if (pid === "workbuddy") {
        const verdict = await probeWorkbuddyAccount({
          token: tok,
          ...region ? { region: String(region) } : {}
        });
        if (verdict.verdict === "banned") {
          return {
            ok: false,
            provider: pid,
            username: name,
            message: "该账号已被上游限制使用(code 11140),**未接入**。换一个账号,或确认账号在官方客户端里还能正常登录后再试:" + verdict.message
          };
        }
        raw.selfcheck = { verdict: verdict.verdict, atMs: wallNow() };
      }
      await ctx.vault.put({
        provider: pid,
        username: name,
        secret: tok,
        // undefined = 保留库里原值（不拿 null 去清空）。
        refreshSecret: fields.refreshSecret,
        expiresAt: fields.expiresAt,
        raw
      });
      ctx.syncRegistry();
      return {
        ok: true,
        provider: pid,
        username: name,
        message: `已接入 ${pid}/${name}(自动发现导入${region ? `, region=${region}` : ""})`,
        changed: [credentialKey(pid, name)]
      };
    }
  };
  return methods;
}

// panel/channels-sync.ts
import { existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";

// core/collector/catalog.ts
import { randomBytes as randomBytes2 } from "node:crypto";

// core/gateway/model-catalog.ts
var CONTEXT_KEYS = [
  "context_length",
  "max_input_tokens",
  "context_window",
  "max_model_len",
  "input_token_limit"
];
var OUTPUT_KEYS = [
  "max_completion_tokens",
  "max_output_tokens",
  "max_output_length",
  "completion_tokens_limit",
  "output_token_limit",
  "max_output"
];
var VISION_FLAG_KEYS = [
  "supports_vision",
  "vision",
  "supports_image_input"
];
var VISION_LIST_KEYS = [
  "input_modalities",
  "supported_input_modalities",
  "modalities",
  "input_types"
];
var MAX_UPSTREAM_MODELS = 500;
var MAX_MODEL_NAME = 200;
function capabilityInt(value) {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (Number.isNaN(value) || value === Infinity || value === -Infinity) return null;
    const number = Math.trunc(value);
    return number > 0 ? number : null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return number > 0 ? number : null;
  }
  return null;
}
function firstCapabilityInt(record2, keys) {
  for (const key of keys) {
    const number = capabilityInt(record2[key]);
    if (number !== null) return number;
  }
  return null;
}
function visionOf(record2) {
  for (const key of VISION_FLAG_KEYS) {
    if (record2[key] === true) return true;
  }
  for (const key of VISION_LIST_KEYS) {
    const kinds = record2[key];
    if (!Array.isArray(kinds)) continue;
    const values = new Set(kinds.map((k) => String(k).trim().toLowerCase()));
    if (values.has("image") || values.has("images") || values.has("vision") || values.has("multimodal")) {
      return true;
    }
  }
  return false;
}
function reasoning_field_of(raw) {
  for (const key of [
    "reasoning",
    "reasoning_config",
    "reasoningConfig",
    "thinking",
    "thinking_config",
    "thinkingConfig",
    // trae wire 目录:`{"default_level":"high","options":["light","high","extra_high"],
    // "support_thinking":true}`(2026-11-08 实测 get_detail_param)
    "reasoning_effort_config",
    "reasoningEffortConfig"
  ]) {
    const v = raw[key];
    if (v !== void 0 && v !== null && typeof v !== "boolean") return v;
  }
  for (const key of ["reasoning_efforts", "supported_reasoning_efforts", "supportedReasoningEfforts"]) {
    const v = raw[key];
    if (typeof v === "string" && v.trim() !== "") {
      const parts = v.split(/[,，;；|]/).map((s) => s.trim()).filter(Boolean);
      return parts.length > 0 ? { supportedEfforts: parts } : null;
    }
    const list = Array.isArray(v) ? v : [];
    if (list.length > 0) {
      const parts = list.map((x) => String(x ?? "").trim()).filter(Boolean);
      if (parts.length > 0) return { supportedEfforts: parts };
    }
  }
  return null;
}
function reasoning_efforts_of(reasoning, supports_reasoning = void 0) {
  if (reasoning !== null && reasoning !== void 0) {
    const r = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {};
    if (r["support_thinking"] === false || r["supports_thinking"] === false) return [];
    const rawList = Array.isArray(r["supportedEfforts"]) && r["supportedEfforts"] || Array.isArray(r["supported_efforts"]) && r["supported_efforts"] || Array.isArray(r["options"]) && r["options"] || Array.isArray(r["efforts"]) && r["efforts"] || [];
    const levels = orderRawLevels(rawList.map((x) => String(x ?? "")));
    if (levels.length > 0) return levels;
    const single = String(r["effort"] ?? r["default_effort"] ?? r["defaultEffort"] ?? "").trim();
    return single ? orderRawLevels([single]) : [];
  }
  return supports_reasoning === true ? null : [];
}
function reasoning_allows_off_of(reasoning) {
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return null;
  const r = reasoning;
  const v = r["canDisableThinking"];
  if (v === true) return true;
  if (v === false) return false;
  const mandatory = r["mandatory"];
  if (mandatory === true) return false;
  if (mandatory === false) return true;
  const efforts = Array.isArray(r["supportedEfforts"]) && r["supportedEfforts"] || Array.isArray(r["supported_efforts"]) && r["supported_efforts"] || Array.isArray(r["options"]) && r["options"] || [];
  for (const raw of efforts) {
    const name = String(raw ?? "").trim().toLowerCase();
    if (name === "none" || name === "off" || name === "disabled" || name === "disable") return true;
  }
  const supportThinking = r["support_thinking"] ?? r["supports_thinking"];
  if (supportThinking === true) return false;
  if (supportThinking === false) return null;
  return null;
}
function modelEntry(name, record2) {
  if (!record2 || typeof record2 !== "object" || Array.isArray(record2)) {
    return {
      id: name,
      context_window: null,
      max_output: null,
      vision: false,
      reasoning_efforts: null,
      reasoning_allows_off: null
    };
  }
  const r = record2;
  const reasoningField = reasoning_field_of(r);
  return {
    id: name,
    context_window: firstCapabilityInt(r, CONTEXT_KEYS),
    max_output: firstCapabilityInt(r, OUTPUT_KEYS),
    vision: visionOf(r),
    reasoning_efforts: reasoningField === null ? null : reasoning_efforts_of(reasoningField),
    reasoning_allows_off: reasoningField === null ? null : reasoning_allows_off_of(reasoningField)
  };
}
function parseModelEntries(payload) {
  let items;
  if (Array.isArray(payload)) {
    items = payload;
  } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    items = null;
    for (const key of ["data", "models", "items", "result"]) {
      const value = payload[key];
      if (Array.isArray(value)) {
        items = value;
        break;
      }
    }
  } else {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of items) {
    let name;
    let record2;
    if (typeof item === "string") {
      name = item.trim();
      record2 = null;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const r = item;
      name = String(r.id ?? r.model ?? r.name ?? "").trim();
      record2 = r;
    } else {
      continue;
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(modelEntry(name.slice(0, MAX_MODEL_NAME), record2));
    if (out.length >= MAX_UPSTREAM_MODELS) break;
  }
  return out;
}

// core/collector/catalog.ts
var CatalogError = class extends Error {
  kind = "catalog";
  constructor(message) {
    super(message);
    this.name = "CatalogError";
  }
};
function positive_int(value) {
  const num = number_of(value);
  if (num === null || !Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}
function nonempty_str(value) {
  return typeof value === "string" ? value.trim() : "";
}
function rate_of(value, allowZero = false) {
  const num = number_of(value);
  if (num === null || !Number.isFinite(num) || num < 0) return null;
  if (num === 0 && !allowZero) return null;
  return num;
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function is_list(value) {
  return Array.isArray(value) ? value : [];
}
var CATALOG_PROVIDERS = ["trae", "workbuddy", "sensenova", "minimax", "qoder", "codearts"];
var CATALOG_TIMEOUT_MS = 8e3;
function catalog_supported(provider_id) {
  const p = String(provider_id ?? "").trim().toLowerCase();
  return CATALOG_PROVIDERS.includes(p);
}
var TRAE_REMOTE_BASES = {
  cn: "https://solo.trae.cn/api/remote/v1",
  ai: "https://coresg-normal.trae.ai/api/remote/v1"
};
var TRAE_WIRE_PATH = "/api/ide/v1/get_detail_param";
var TRAE_WIRE_FUNCTIONS = {
  cn: ["solo_work_remote", "solo_work_lite", "solo_agent_remote", "chat_v3", "solo_coder"],
  ai: ["solo_work_remote", "solo_work_lite", "solo_agent_remote", "chat_v3"]
};
var TRAE_REMOTE_FUNCTIONS = [
  "solo_agent",
  "solo_agent_remote",
  "solo_work_remote",
  "solo_work_lite",
  "chat_v3",
  "solo_coder",
  "builder_v3"
];
function trae_region_dressing(region) {
  if (region === "ai") {
    return {
      referer: "https://coresg-normal.trae.ai/",
      timezone: "Asia/Singapore",
      language: "en"
    };
  }
  return {
    referer: "https://solo.trae.cn/",
    timezone: "Asia/Shanghai",
    language: "zh-cn"
  };
}
function trae_wire_body(fn) {
  return {
    function: fn,
    config_names: null,
    need_prompt: false,
    current_config_info: null,
    poly_prompt: true,
    mode_type: null,
    agent_type: null
  };
}
function wire_credit_multiplier(config) {
  const raw = config["display_contact_config"];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const consumption = record(record(parsed)["consumption_rate"]);
  if (consumption["enable"] !== true) return null;
  return rate_of(record(consumption["data"])["rate"]);
}
function parse_trae_wire_model(value) {
  const raw = record(value);
  const mid = nonempty_str(raw["config_name"]);
  if (!mid) return null;
  const display = record(raw["display_config"]);
  const details = raw["model_detail_list"];
  const detail = is_list(details).length > 0 ? record(is_list(details)[0]) : {};
  const tokens = record(raw["context_window_tokens"]);
  const context = positive_int(tokens["max"]) ?? positive_int(tokens["dev"]) ?? positive_int(detail["prompt_max_tokens"]);
  return {
    id: mid,
    name: nonempty_str(display["display_name"]) || mid,
    vision: raw["multimodal"] === true,
    context_window: context,
    max_output: positive_int(detail["max_tokens"]),
    rate: wire_credit_multiplier(raw),
    origin: "wire",
    callable: true,
    // trae 的能力字段散在 display_config 与 model_detail_list 里,字段名也没有共识,
    // 所以走通用探测(见 `reasoning_field_of`)—— 探不到就是 `[]`/`null`,不猜。
    reasoning_efforts: reasoning_efforts_of(
      reasoning_field_of(raw) ?? reasoning_field_of(display) ?? reasoning_field_of(detail)
    ),
    reasoning_allows_off: reasoning_allows_off_of(
      reasoning_field_of(raw) ?? reasoning_field_of(display) ?? reasoning_field_of(detail)
    )
  };
}
function parse_trae_remote_model(value) {
  const raw = record(value);
  const mid = nonempty_str(raw["name"]);
  if (!mid) return null;
  const tokens = record(raw["context_window_tokens"]);
  const context = positive_int(tokens["max"]) ?? positive_int(tokens["dev"]);
  let features = {};
  if (typeof raw["features"] === "string") {
    try {
      features = record(JSON.parse(raw["features"]));
    } catch {
      features = {};
    }
  }
  const consumption = record(features["consumption_rate"]);
  const rate = consumption["enable"] === true ? rate_of(record(consumption["data"])["rate"]) : null;
  return {
    id: mid,
    name: nonempty_str(raw["display_name"]) || mid,
    vision: raw["multimodal"] === true,
    context_window: context,
    // 远程目录不给输出上限 —— 宁可空着也不猜。
    max_output: null,
    rate,
    origin: "remote",
    callable: false,
    reasoning_efforts: reasoning_efforts_of(reasoning_field_of(raw) ?? reasoning_field_of(features)),
    reasoning_allows_off: reasoning_allows_off_of(
      reasoning_field_of(raw) ?? reasoning_field_of(features)
    )
  };
}
function prefer_stronger(neu, old) {
  if (old === void 0) return neu;
  const newCtx = neu.context_window ?? 0;
  const oldCtx = old.context_window ?? 0;
  if (newCtx > oldCtx) return neu;
  if (newCtx === oldCtx && (neu.max_output ?? 0) > (old.max_output ?? 0)) return neu;
  return old;
}
function display_key(name) {
  return (name || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}
function merge_trae(remote, wire) {
  const wireByDisplay = /* @__PURE__ */ new Map();
  for (const entry of Object.values(wire)) {
    if (!wireByDisplay.has(display_key(entry.id))) wireByDisplay.set(display_key(entry.id), entry);
    if (!wireByDisplay.has(display_key(entry.name))) wireByDisplay.set(display_key(entry.name), entry);
  }
  const entries = [];
  for (const up of Object.values(remote)) {
    let hit = wire[up.id];
    if (hit === void 0) {
      hit = wireByDisplay.get(display_key(up.id)) ?? wireByDisplay.get(display_key(up.name));
    }
    if (hit === void 0) {
      entries.push({ ...up, callable: false });
      continue;
    }
    entries.push({
      id: hit.id,
      name: up.name || hit.name,
      vision: Boolean(up.vision || hit.vision),
      context_window: hit.context_window ?? up.context_window,
      max_output: hit.max_output ?? up.max_output,
      rate: hit.rate ?? up.rate,
      origin: "wire",
      callable: true,
      // ⚠️ 思考档位只在 wire 行里有(2026-11-08:`reasoning_effort_config`),
      // 合成时**必须带过来** —— 漏了它,「从上游获取思考强度」对 trae 永远是
      // 「上游没给档位」,尽管上游明明给了 light/high/extra_high。
      reasoning_efforts: hit.reasoning_efforts ?? up.reasoning_efforts,
      reasoning_allows_off: hit.reasoning_allows_off ?? up.reasoning_allows_off
    });
  }
  entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return entries;
}
async function fetch_trae_catalog(account, opts = {}) {
  const region = normalize_region(account.region ?? void 0);
  const extras = account.extras ?? {};
  const identity = resolve_identity(account.token, extras);
  const chatBase = opts.baseUrl ?? account.baseUrl ?? resolve_api_base(void 0, region, extras);
  const warnings = [];
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const wireHeaders = build_headers(account.token, identity, randomBytes2(16).toString("hex"));
  wireHeaders["Accept"] = "application/json";
  const wire = {};
  for (const fn of TRAE_WIRE_FUNCTIONS[region] ?? TRAE_WIRE_FUNCTIONS.cn) {
    let payload;
    try {
      const res = await fetchFn(`${chatBase.replace(/\/+$/, "")}${TRAE_WIRE_PATH}`, {
        method: "POST",
        headers: wireHeaders,
        body: JSON.stringify(trae_wire_body(fn)),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status >= 400) throw new CatalogError(`HTTP ${res.status}`);
      payload = JSON.parse(await res.text());
    } catch (err) {
      warnings.push(`trae ${fn} 名单失败:${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const rows = record(payload)["config_info_list"];
    for (const raw of is_list(rows)) {
      const entry = parse_trae_wire_model(raw);
      if (entry === null) continue;
      wire[entry.id] = prefer_stronger(entry, wire[entry.id]);
    }
  }
  const remote = {};
  const dress = trae_region_dressing(region);
  const remoteHeaders = {
    Authorization: `Cloud-IDE-JWT ${account.token}`,
    Accept: "application/json",
    "x-trae-client-type": "web",
    "x-trae-user-timezone": dress.timezone,
    "x-preferenced-language": dress.language,
    Referer: dress.referer,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  };
  try {
    const base = TRAE_REMOTE_BASES[region] ?? TRAE_REMOTE_BASES.cn;
    const u = new URL(`${base.replace(/\/+$/, "")}/models`);
    u.searchParams.set("functions", TRAE_REMOTE_FUNCTIONS.join(","));
    const res = await fetchFn(u.toString(), { headers: remoteHeaders, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 400) throw new CatalogError(`HTTP ${res.status}`);
    const payload = JSON.parse(await res.text());
    const groups = record(record(payload)["data"])["list"];
    for (const group of is_list(groups)) {
      for (const raw of is_list(record(group)["models"])) {
        const entry = parse_trae_remote_model(raw);
        if (entry === null) continue;
        remote[entry.id] = prefer_stronger(entry, remote[entry.id]);
      }
    }
  } catch (err) {
    warnings.push(`trae 远程目录失败:${err instanceof Error ? err.message : String(err)}`);
  }
  let entries;
  if (Object.keys(remote).length === 0 && Object.keys(wire).length > 0) {
    warnings.push(
      "trae 远程目录没取到,改用 chat 名单;这份清单可能含 IDE 内部条目(custom_model_*/search_agent_*)"
    );
    entries = Object.values(wire).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  } else {
    entries = merge_trae(remote, wire);
  }
  return {
    provider: "trae",
    entries,
    source: entries.length > 0 ? "api" : "empty",
    fetched_at: Math.floor(Date.now() / 1e3),
    warnings
  };
}
var WORKBUDDY_GLOBAL_CONFIG_PATH = "/v3/config";
var WORKBUDDY_PERSONAL_MODELS_PATH = "/v2/enterprises/personal/models";
var WORKBUDDY_CLI_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
var WORKBUDDY_DESKTOP_UA = "WorkBuddy/5.5.2";
var CREDITS_RATE_RE = /x\s*([0-9.]+)/;
var NATIVE_MODALITY_BY_MODEL_ID = {
  "deepseek-v4-pro": "text",
  "glm-5.1": "text",
  "glm-5.2": "text",
  "glm-5.3": "text",
  hy3: "text",
  "hy4-preview": "text",
  "deepseek-v4.1-flash": "multimodal",
  "glm-5.3-flash": "multimodal",
  "glm-5v-turbo": "multimodal",
  "kimi-k2.6": "multimodal",
  "kimi-k2.7": "multimodal",
  "kimi-k3-1": "multimodal",
  "minimax-m3": "multimodal"
};
function workbuddy_vision_default(model_id, supports_images, disabled_multimodal = null) {
  if (supports_images === false || disabled_multimodal === true) return false;
  return NATIVE_MODALITY_BY_MODEL_ID[model_id] === "multimodal";
}
function parse_workbuddy_model(value) {
  const raw = record(value);
  const mid = nonempty_str(raw["id"]);
  if (!mid || raw["disabled"] === true) return null;
  const context = positive_int(raw["maxInputTokens"]);
  const output = positive_int(raw["maxOutputTokens"]);
  if (context === null || output === null) return null;
  const supportsImages = raw["disabledMultimodal"] === true ? false : typeof raw["supportsImages"] === "boolean" ? raw["supportsImages"] : null;
  let rate = null;
  const credits = raw["credits"];
  if (typeof credits === "string") {
    const m = CREDITS_RATE_RE.exec(credits);
    if (m) rate = rate_of(m[1], true);
  }
  return {
    id: mid,
    name: nonempty_str(raw["name"]) || mid,
    vision: workbuddy_vision_default(mid, supportsImages, raw["disabledMultimodal"]),
    context_window: context,
    max_output: output,
    rate,
    origin: "config",
    callable: true,
    reasoning_efforts: reasoning_efforts_of(raw["reasoning"], raw["supportsReasoning"]),
    reasoning_allows_off: reasoning_allows_off_of(raw["reasoning"])
  };
}
function select_cli_models(raw_models, agents) {
  const byId = /* @__PURE__ */ new Map();
  for (const raw of is_list(raw_models)) {
    const entry = parse_workbuddy_model(raw);
    if (entry !== null && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  let order = [];
  for (const agent of is_list(agents)) {
    const row = record(agent);
    if (row["name"] === "cli" && is_list(row["models"]).length > 0) {
      order = is_list(row["models"]).map(nonempty_str).filter(Boolean);
      break;
    }
  }
  if (order.length > 0) {
    const picked = [];
    for (const id of order) {
      const hit = byId.get(id);
      if (hit) picked.push(hit);
    }
    if (picked.length > 0) return picked;
  }
  return [...byId.values()];
}
async function fetch_workbuddy_catalog(account, opts = {}) {
  const realm = normalize_region2(
    (account.region ?? "").toString().trim() || detect_region_from_token(account.token)
  );
  const extras = account.extras ?? {};
  const domain = nonempty_str(extras["domain"]);
  const uid = nonempty_str(account.uid) || nonempty_str(extras["uin"]);
  const enterprise = nonempty_str(account.enterprise_id) || nonempty_str(extras["enterprise_id"]);
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const warnings = [];
  const readConfig = async (url, headers) => {
    let res;
    let text;
    try {
      res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new CatalogError(`连接失败:${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status >= 400) throw new CatalogError(`HTTP ${res.status}`);
    try {
      text = await res.text();
    } catch (err) {
      throw new CatalogError(`响应读取失败:${err instanceof Error ? err.message : String(err)}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new CatalogError("响应不是 JSON");
    }
    const root = record(payload);
    const code = root["code"];
    if (code !== void 0 && code !== null && Number(code) !== 0) {
      throw new CatalogError(`业务失败 code=${String(code)}:${nonempty_str(root["msg"])}`);
    }
    const data = record(root["data"]);
    const rows = select_cli_models(data["models"], data["agents"]);
    if (rows.length === 0) {
      throw new CatalogError("响应里没有可用模型(上下文 / 输出上限缺失或为 0)");
    }
    return rows;
  };
  let entries;
  if (realm === "cn") {
    const base = (opts.baseUrl ?? REGION_BASES.cn).replace(/\/+$/, "");
    const headers = {
      Authorization: `Bearer ${account.token}`,
      Accept: "application/json",
      "User-Agent": WORKBUDDY_CLI_UA,
      Origin: base,
      Referer: `${base}/`
    };
    if (uid) headers["X-User-Id"] = uid;
    if (enterprise) headers["X-Enterprise-Id"] = enterprise;
    try {
      entries = await readConfig(`${base}${WORKBUDDY_GLOBAL_CONFIG_PATH}`, headers);
    } catch (err) {
      warnings.push(
        `workbuddy ${WORKBUDDY_GLOBAL_CONFIG_PATH} 失败,回退 ${WORKBUDDY_PERSONAL_MODELS_PATH}:${err instanceof Error ? err.message : String(err)}`
      );
      entries = await readConfig(`${base}${WORKBUDDY_PERSONAL_MODELS_PATH}`, headers);
    }
  } else {
    const base = (opts.baseUrl ?? REGION_BASES.global).replace(/\/+$/, "");
    const headers = {
      Authorization: `Bearer ${account.token}`,
      Accept: "application/json",
      "User-Agent": WORKBUDDY_DESKTOP_UA,
      "X-Product": "SaaS",
      "X-Requested-With": "XMLHttpRequest",
      Connection: "close"
    };
    if (uid) headers["X-User-Id"] = uid;
    if (domain) headers["X-Domain"] = domain;
    entries = await readConfig(`${base}${WORKBUDDY_GLOBAL_CONFIG_PATH}`, headers);
  }
  return {
    provider: "workbuddy",
    entries,
    source: "api",
    fetched_at: Math.floor(Date.now() / 1e3),
    warnings
  };
}
var SENSENOVA_MODELS_PATH = "/v1/models";
var SENSENOVA_CATALOG_BASE = "https://token.sensenova.cn";
function sensenova_models_url(base = "") {
  const root = (base || "").trim().replace(/\/+$/, "") || SENSENOVA_CATALOG_BASE;
  return root.endsWith("/v1") ? `${root}/models` : `${root}${SENSENOVA_MODELS_PATH}`;
}
function parse_sensenova_model(value) {
  const raw = record(value);
  const mid = nonempty_str(raw["id"]);
  if (!mid) return null;
  const modalities = raw["input_modalities"];
  const vision = is_list(modalities).includes("image");
  const features = is_list(raw["supported_features"]);
  const supportsReasoning = features.includes("reasoning") || nonempty_str(raw["reasoning_efforts"]) !== null;
  return {
    id: mid,
    name: nonempty_str(raw["name"]) || mid,
    vision,
    context_window: positive_int(raw["context_length"]),
    max_output: positive_int(raw["max_output_length"]),
    rate: null,
    origin: "config",
    callable: true,
    reasoning_efforts: reasoning_efforts_of(
      reasoning_field_of(raw),
      supportsReasoning === true ? true : void 0
    ),
    reasoning_allows_off: reasoning_allows_off_of(reasoning_field_of(raw))
  };
}
async function fetch_sensenova_catalog(account, opts = {}) {
  if (!account.token) {
    throw new CatalogError("sensenova 没有可用 API key,拉不了模型目录");
  }
  const url = sensenova_models_url(opts.baseUrl ?? account.baseUrl ?? "");
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CATALOG_TIMEOUT_MS;
  let res;
  let text;
  try {
    res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${account.token}`,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new CatalogError(`连接失败:${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 400) throw new CatalogError(`HTTP ${res.status}`);
  try {
    text = await res.text();
  } catch (err) {
    throw new CatalogError(`响应读取失败:${err instanceof Error ? err.message : String(err)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CatalogError("响应不是 JSON");
  }
  const entries = [];
  for (const raw of is_list(record(payload)["data"])) {
    const entry = parse_sensenova_model(raw);
    if (entry !== null) entries.push(entry);
  }
  if (entries.length === 0) {
    throw new CatalogError("sensenova /v1/models 没有返回可用模型");
  }
  entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    provider: "sensenova",
    entries,
    source: "api",
    fetched_at: Math.floor(Date.now() / 1e3),
    warnings: []
  };
}
function fetch_minimax_catalog(_account, _opts = {}) {
  const entries = MINIMAX_MODELS.map((m) => ({
    // ⚠️ 登记键用**本地 id**(minimax-agent 等),不是上游串:
    // minimax-agent / m3.1-flash / m3.1-flash-thinking 三行的 upstream 相同
    // (MiniMax-M3.1-Flash,thinking 靠 thinking_config 区分),拿上游串当 id
    // 会在 real_model 里塌缩成一行。将来接 minimax GatewayAdapter 时,
    // 本地 id → 上游模型 + 变体的映射在这里的表里现成。
    id: m.id,
    name: m.name,
    vision: m.vision,
    context_window: m.context,
    max_output: m.output,
    rate: null,
    origin: "router",
    // image 行不是 chat 端点认的名单(参考实现的 /v1/models 也只放 chat 类)。
    callable: m.upstreamModel !== "",
    // switchable / forced = 支持思考;none = 无思考(空数组 = 明说不支持)。
    reasoning_efforts: m.reasoning === "none" ? [] : ["low", "medium", "high", "max"],
    // ⚠️ **一律不可关**(2026-11-08 真机):MiniMax 直连 LLM 对
    // `thinking:{type:"disabled"}`(以及 `reasoning.effort:"none"`)回
    // 400 `requires adaptive thinking`。所以即使是 switchable 也不能声明
    // allows_off —— 声明了只会让用户在界面上选到一个必定失败的「关闭」。
    reasoning_allows_off: m.reasoning === "none" ? null : false
  }));
  return {
    provider: "minimax",
    entries,
    source: "api",
    fetched_at: Math.floor(Date.now() / 1e3),
    warnings: []
  };
}
function qoder_entry_of(m) {
  const tc = record(m.raw?.["thinking_config"]);
  const enabled = record(tc["enabled"]);
  const effortKeys = Object.keys(record(enabled["efforts"]));
  const efforts = effortKeys.length > 0 ? reasoning_efforts_of({ supported_efforts: effortKeys }) ?? [] : (
    // 有思考能力但没有档位键(或压根不思考)→ 明说「没有可选档位」
    []
  );
  return {
    id: m.key,
    name: m.displayName,
    vision: m.isVl,
    context_window: m.maxContextTokens ?? m.maxInputTokens ?? null,
    max_output: m.maxOutputTokens ?? null,
    // 2026-11-15 渠道页统一的回归:原独立 QoderPage 直接读 QoderCatalogRow.priceFactor
    // 摆「倍率」列,迁到 ChannelPage 后这一列读的是 CatalogEntry.rate —— 这里原先
    // 硬编码 null,于是 qoder 全表显示「—」。上游字段 `price_factor` 的 0 表示
    // **免费**(不是缺失),所以 allowZero=true;优先连接器已解析的值,只给 raw 的
    // 调用方(老测试 / 直接构造)从 raw 兜底。
    rate: rate_of(m.priceFactor ?? m.raw?.["price_factor"], true),
    origin: "remote",
    callable: m.enable,
    reasoning_efforts: efforts,
    // 目录里有 `disabled` 才算能关;否则「能思考但关不掉」。
    reasoning_allows_off: tc["disabled"] === void 0 ? efforts.length > 0 ? false : null : true
  };
}
async function fetch_qoder_catalog(account, opts = {}) {
  const client = new QoderClient("qoder", opts.fetchFn === void 0 ? {} : { fetch: opts.fetchFn });
  const models = await client.fetchModels(
    account.token,
    AbortSignal.timeout(opts.timeoutMs ?? CATALOG_TIMEOUT_MS)
  );
  return {
    provider: "qoder",
    entries: models.map((m) => qoder_entry_of(m)),
    source: "api",
    fetched_at: Math.floor(Date.now() / 1e3),
    warnings: []
  };
}
function parse_codearts_model(value) {
  const raw = record(value);
  const mid = nonempty_str(raw["model_id"]);
  if (!mid) return null;
  return {
    id: mid,
    name: nonempty_str(raw["model_name"]) || mid,
    vision: raw["supports_images"] === true,
    context_window: positive_int(raw["context_window"]),
    max_output: positive_int(raw["max_tokens"]),
    rate: null,
    origin: "remote",
    callable: raw["enable"] !== false && raw["display_enabled"] !== false,
    // 上游目录不思考档位/可否关思考字段 → 未知(null),网关不拦。
    reasoning_efforts: null,
    reasoning_allows_off: null
  };
}
async function fetch_codearts_catalog(account, opts = {}) {
  const raw = account.extras ?? {};
  const accessKey = nonempty_str(raw["accessKey"]);
  const secretKey = nonempty_str(raw["secretKey"]);
  if (accessKey === "" || secretKey === "") {
    throw new CatalogError("codearts 账号缺少 accessKey / secretKey,拉不了模型目录");
  }
  const base = (opts.baseUrl || account.baseUrl || CODEARTS_BASE_CN).replace(/\/+$/, "");
  const url = `${base}${CODEARTS_MODELS_PATH}`;
  const signed = signCodeartsRequest({
    accessKey,
    secretKey,
    ...nonempty_str(raw["securityToken"]) !== "" ? { securityToken: String(raw["securityToken"]) } : {},
    method: "GET",
    url,
    headers: {
      ...codeartsIdentityHeaders({
        accessKey,
        ...nonempty_str(raw["domainId"]) !== "" ? { domainId: String(raw["domainId"]) } : {}
      }),
      // 签名后追加,不进 SignedHeaders。
      "Agent-Type": "PromptCenter"
    }
  });
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetchFn(url, { method: "GET", headers: signed.headers, signal: controller.signal });
  } catch (err) {
    throw new CatalogError(
      controller.signal.aborted ? `codearts 模型目录超时(${timeoutMs}ms)` : `codearts 模型目录连接失败:${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  if (resp.status >= 400) throw new CatalogError(`codearts ${CODEARTS_MODELS_PATH} HTTP ${resp.status}: ${text.slice(0, 300)}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CatalogError("codearts 模型目录响应不是 JSON");
  }
  const entries = [];
  for (const row of is_list(record(payload)["builtinModels"])) {
    const entry = parse_codearts_model(row);
    if (entry !== null) entries.push(entry);
  }
  if (entries.length === 0) {
    throw new CatalogError("codearts /v1/model/builtin 没有返回可用模型");
  }
  entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    provider: "codearts",
    entries,
    source: "api",
    fetched_at: Math.floor(Date.now() / 1e3),
    warnings: []
  };
}
async function fetch_catalog(provider_id, account, opts = {}) {
  const provider = String(provider_id ?? "").trim().toLowerCase();
  if (provider === "trae") return fetch_trae_catalog(account, opts);
  if (provider === "workbuddy") return fetch_workbuddy_catalog(account, opts);
  if (provider === "sensenova") return fetch_sensenova_catalog(account, opts);
  if (provider === "qoder") return fetch_qoder_catalog(account, opts);
  if (provider === "codearts") return fetch_codearts_catalog(account, opts);
  if (provider === "minimax") return Promise.resolve(fetch_minimax_catalog(account, opts));
  throw new CatalogError(`${provider} 没有可拉取的上游模型目录`);
}

// panel/channels-sync.ts
function nextSupportsVision(existing, entry) {
  return entry.vision ? 1 : existing;
}
function nextDeclaredCapability(existing, upstream) {
  if (existing !== null && existing !== void 0) return existing;
  return upstream ?? null;
}
function createChannelsSyncDomain(ctx, deps) {
  const { chQuotaCache: chQuotaCache2, chQuotaGate: chQuotaGate2, chQuotaInflight: chQuotaInflight2 } = deps;
  const chQuotaCooldownMs = () => {
    const raw = ctx.db.setting.get("external_refresh.interval_hours")?.v ?? "24";
    const hours = Number(raw);
    const h = Number.isFinite(hours) && hours > 0 ? hours : 24;
    return h * 3600 * 1e3;
  };
  const chQuotaFetch = async (pid, username) => {
    const key = credentialKey(pid, username);
    if (!CH_QUOTA_PROVIDERS.has(pid)) return null;
    const cred = await ctx.vault.get(pid, username);
    const token = cred?.secret ?? null;
    if (!token || !cred) return null;
    const raw = cred.raw ?? {};
    const account = {
      credentialKey: key,
      provider: pid,
      username,
      token,
      region: strOf(raw, "region"),
      uid: strOf(raw, "uid") ?? strOf(raw, "user_id"),
      enterprise_id: strOf(raw, "enterprise_id"),
      extras: raw
    };
    let snapshot;
    try {
      snapshot = pid === "trae" ? await probe_trae_quota(account) : pid === "minimax" ? await probe_minimax_quota(account, {
        // 401 时自动 refresh 续期并重试(2026-11-07):minimax token
        // 只有数小时寿命,过期后不续期就永远「未采集」。
        onAuthExpired: (acct) => renewMinimaxAccount(acct, { vault: ctx.vault, provider: pid, username })
      }) : pid === "codearts" ? await probe_codearts_quota(account) : await probe_workbuddy_quota(account);
    } catch (err) {
      snapshot = {
        credentialKey: key,
        remaining: null,
        limit: null,
        expires_at: null,
        fetched_at: Math.floor(Date.now() / 1e3),
        packs: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
    chQuotaCache2.set(key, { fetchedAtMs: Date.now(), snapshot });
    try {
      ctx.scheduler.invalidate();
    } catch {
    }
    return snapshot;
  };
  function catalogCooldownStateOf(pid) {
    const cooldownS = Math.round(chQuotaCooldownMs() / 1e3);
    let newest = 0;
    for (const [key, entry] of chCatalogCache.entries()) {
      if (!key.startsWith(`${pid}/`)) continue;
      if (entry.fetchedAtMs > newest) newest = entry.fetchedAtMs;
    }
    const ageS = newest > 0 ? Math.round((Date.now() - newest) / 1e3) : null;
    const nextInS = ageS === null ? null : Math.max(0, cooldownS - ageS);
    return {
      armed: false,
      cooldown_s: cooldownS,
      catalog_age_s: ageS,
      quota_age_s: null,
      catalog_next_in_s: nextInS,
      quota_next_in_s: null,
      cooling: ageS !== null && nextInS !== null && nextInS > 0,
      quota_exhausted: null
    };
  }
  const chMaybeFetchQuota = (pid, username, force = false) => {
    const key = credentialKey(pid, username);
    const now = Date.now();
    const cd = chQuotaCooldownMs();
    if (!force) {
      const cached = chQuotaCache2.get(key);
      if (cached && now - cached.fetchedAtMs < cd) return;
      if (now - (chQuotaGate2.get(key) ?? 0) < cd) return;
    }
    chQuotaGate2.set(key, now);
    if (!chQuotaInflight2.has(key)) {
      const p = chQuotaFetch(pid, username).finally(() => chQuotaInflight2.delete(key));
      chQuotaInflight2.set(key, p);
    }
  };
  const chAwaitQuota = async (pid, username, force = false) => {
    const key = credentialKey(pid, username);
    const now = Date.now();
    const cd = chQuotaCooldownMs();
    const cached = chQuotaCache2.get(key);
    if (!force && cached && now - cached.fetchedAtMs < cd) return cached.snapshot;
    if (!force && now - (chQuotaGate2.get(key) ?? 0) < cd) {
      if (cached) return cached.snapshot;
      const inflight2 = chQuotaInflight2.get(key);
      if (inflight2) return inflight2;
      return null;
    }
    chQuotaGate2.set(key, now);
    const p = chQuotaFetch(pid, username);
    chQuotaInflight2.set(key, p.finally(() => chQuotaInflight2.delete(key)));
    return p;
  };
  const catalogAccountOf = async (pid, username) => {
    const cred = await ctx.vault.get(pid, username);
    const token = cred?.secret ?? null;
    if (!token || !cred) return null;
    const raw = cred.raw ?? {};
    return {
      provider: pid,
      username,
      token,
      region: strOf(raw, "region"),
      uid: strOf(raw, "uid") ?? strOf(raw, "user_id"),
      enterprise_id: strOf(raw, "enterprise_id"),
      extras: raw,
      // provider.base_url 只给 openai 兼容端点用;trae/workbuddy 的目录主机
      // 在 core catalog.ts 内部按区域推导(刻意不读聊天端点,理由见该文件)。
      baseUrl: null
    };
  };
  const chCatalogCache = /* @__PURE__ */ new Map();
  const chCatalogGate = /* @__PURE__ */ new Map();
  const chCatalogInflight = /* @__PURE__ */ new Map();
  const chCatalogFetch = async (pid, username) => {
    const account = await catalogAccountOf(pid, username);
    if (account === null) throw new Error(`${pid}/${username} 没有可用密钥`);
    const pdef = ctx.registry.getProvider(pid);
    const result = await fetch_catalog(pid, account, {
      // openai 兼容端点(如 sensenova 的 token 站)可显式覆盖基址。
      baseUrl: catalog_supported(pid) ? void 0 : pdef?.baseUrl ?? void 0
    });
    chCatalogCache.set(`${pid}/${username}`, { fetchedAtMs: Date.now(), result });
    return result;
  };
  const chAwaitCatalog = async (pid, username, force = false) => {
    const key = `${pid}/${username}`;
    const now = Date.now();
    const cd = chQuotaCooldownMs();
    const cached = chCatalogCache.get(key);
    if (!force && cached && now - cached.fetchedAtMs < cd) return cached.result;
    if (!force && now - (chCatalogGate.get(key) ?? 0) < cd) {
      if (cached) return cached.result;
      const inflight2 = chCatalogInflight.get(key);
      if (inflight2) return inflight2;
      throw new Error("冷却中,请稍后再试");
    }
    chCatalogGate.set(key, now);
    const p = chCatalogFetch(pid, username).finally(() => chCatalogInflight.delete(key));
    chCatalogInflight.set(key, p);
    return p;
  };
  const catalogFetchedAt = /* @__PURE__ */ new Map();
  const catalogRows = /* @__PURE__ */ new Map();
  const catalogRowsOf = (pid) => catalogRows.get(pid) ?? /* @__PURE__ */ new Map();
  async function probeProviderModels(url, bearerKey) {
    const headers = { Accept: "application/json" };
    if (bearerKey !== null) headers["Authorization"] = `Bearer ${bearerKey}`;
    let res;
    let bodyText;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(1e4) });
    } catch (err) {
      const why = err instanceof Error ? `${err.name}:${err.message}` : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? `(${err.cause.message})` : "";
      return { ok: false, message: `打不到上游(10 秒后放弃):${why}${cause}` };
    }
    if (res.status >= 400) {
      return {
        ok: false,
        message: `上游返回 HTTP ${res.status} —— 这是**探测失败**,不代表上游没有模型(密钥不对/网关上线路由都可能这样)`
      };
    }
    try {
      bodyText = await res.text();
    } catch (err) {
      return { ok: false, message: `读上游响应失败:${err instanceof Error ? err.message : String(err)}` };
    }
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      const clip = bodyText.replace(/[^\x20-\x7e\u4e00-\u9fff\n]/g, "?").slice(0, 120);
      const isHtml = /^\s*</.test(bodyText);
      return {
        ok: false,
        message: isHtml ? `上游返回的不是 JSON 而是一个网页(HTTP ${res.status})。这通常说明**地址不对** —— 该端点返回的是管理台/登录页,不是模型列表接口;请核对 base_url 与路径(常见是少了 /v1)。原始响应开头:${clip}` : `上游返回的不是 JSON(HTTP ${res.status}),无法解析模型清单:${clip}`
      };
    }
    const parsed = parseModelEntries(payload);
    if (parsed === null) {
      return {
        ok: false,
        message: "上游回了 JSON,但认不出模型列表(期望 data / models 数组,或直接是字符串数组)"
      };
    }
    const entries = parsed.map((e) => ({
      id: e.id,
      name: e.id,
      vision: e.vision,
      context_window: e.context_window,
      max_output: e.max_output,
      rate: null,
      origin: "remote",
      callable: true
    }));
    return { ok: true, entries };
  }
  function serializeReasoningEfforts2(efforts) {
    if (efforts === null || efforts === void 0) return null;
    return JSON.stringify(efforts);
  }
  const mergeCatalog = (pid, entries, baseUrl, protocol) => {
    const prow = ctx.db.provider.get(pid);
    if (prow) ctx.db.provider.update({ id: pid, base_url: baseUrl, protocol });
    const rows = catalogRows.get(pid) ?? /* @__PURE__ */ new Map();
    for (const entry of entries) rows.set(entry.id, entry);
    catalogRows.set(pid, rows);
    for (const entry of entries) {
      const existing = ctx.db.realModel.get(pid, entry.id);
      if (!existing) continue;
      ctx.db.realModel.update({
        provider: pid,
        model: entry.id,
        // 已登记行的名称不动(用户可能改过)。
        name: existing.name,
        // 声明字段**默认**不覆盖用户写过的值:刷新的职责是「补进目录」,
        // 不是把用户改过的上下文/输出覆盖回上游那一份。
        //
        // ⚠️ 例外一:`supports_vision` 是**能力事实**,不是用户偏好 —— 判据见
        //   {@link nextSupportsVision}(目录说能读图就升到 1;说不支持则保留旧值,
        //   因为这份目录实测会漏报:deepseek-flash 被写成 ["text"] 却能读图)。
        //
        // ⚠️ 例外二(2026-11-06 用户反馈「sensenova 刷新不自动填上下文窗口」):
        //   `max_input_tokens` / `max_output_tokens` **为 null 时用上游值补上**。
        //   用户从没填过(库里是 null)→ 刷新拿到 context_window / max_output
        //   就顺手填进声明,让选择器/网关立刻用得上;用户填过(非 null)→ 仍保留
        //   用户值(刷新不覆盖手改)。用 `??` 而不是无条件覆盖,正是这个语义。
        supports_vision: nextSupportsVision(existing.supports_vision, entry),
        max_input_tokens: nextDeclaredCapability(existing.max_input_tokens, entry.context_window),
        max_output_tokens: nextDeclaredCapability(existing.max_output_tokens, entry.max_output),
        // 思考强度是**能力事实**:上游给了档位就覆盖(新档位立刻生效);
        // 上游这轮没给(`null` = 未知)**保留旧值** —— 表可能是用户手写/手动
        // 补进去的,刷新不该把它冲成 NULL(否则选择器和网关发送会一起消失)。
        supported_reasoning_efforts: entry.reasoning_efforts === null ? existing.supported_reasoning_efforts : serializeReasoningEfforts2(entry.reasoning_efforts),
        reasoning_allows_off: entry.reasoning_allows_off === null ? existing.reasoning_allows_off : entry.reasoning_allows_off
      });
    }
    catalogFetchedAt.set(pid, Date.now());
    return entries.length;
  };
  function modelsSourceOf(pid, models) {
    if (!catalogFetchedAt.has(pid) || catalogRowsOf(pid).size === 0) return "router";
    const fromUpstream = models.filter((m) => m.origin !== "router").length;
    if (fromUpstream === 0) return "router";
    return fromUpstream === models.length ? "api" : "mixed";
  }
  const chCreditsOf = (snapshot, fetchedAtMs) => {
    return {
      left: snapshot.remaining,
      total: snapshot.limit,
      expires_at_ms: snapshot.expires_at !== null ? snapshot.expires_at * 1e3 : null,
      fetched_at_ms: fetchedAtMs,
      packages: snapshot.packs.map((p) => ({
        package_name: p.name,
        remain: p.remain ?? 0,
        size: p.limit ?? 0,
        monthly: p.extra?.monthly === true,
        expires_at_ms: p.expires_at !== null ? p.expires_at * 1e3 : null,
        refresh_at_ms: p.extra?.refresh_at !== void 0 && p.extra.refresh_at !== null ? Number(p.extra.refresh_at) * 1e3 : null
      })),
      expiring_soon: (() => {
        if (snapshot.packs.length === 0) return null;
        const soonS = wallNow() + 3 * 86400;
        return snapshot.packs.some((p) => p.expires_at !== null && p.expires_at > 0 && p.expires_at <= soonS && p.counts_for_expiry);
      })(),
      not_applicable: false,
      error: snapshot.error
    };
  };
  function safeExists(p) {
    try {
      return existsSync2(p);
    } catch {
      return false;
    }
  }
  async function probeClientPath(channel) {
    const pid = String(channel ?? "");
    const table = CLIENT_CANDIDATES[pid] ?? [];
    const expandRoot = (template) => {
      let missing = false;
      const out = template.replace(/%([^%]+)%/g, (_m, name) => {
        const v = process.env[name]?.trim();
        if (!v) {
          missing = true;
          return "";
        }
        return v;
      });
      return missing || out.trim() === "" ? null : out;
    };
    const checked = [];
    for (const root of CLIENT_INSTALL_ROOTS) {
      const expanded = expandRoot(root.dir);
      if (expanded === null) continue;
      checked.push(root.label);
      for (const rel of table) {
        const p = join2(expanded, rel);
        if (safeExists(p)) {
          return {
            detected_path: p,
            found: true,
            source: root.source,
            message: `检测到 ${p}(${root.label})`
          };
        }
      }
    }
    if (table.length === 0) {
      return {
        detected_path: null,
        found: false,
        source: "none",
        message: pid === "sensenova" ? "SenseNova 无本机客户端(候选表为空)" : `${pid} 没有登记 exe 候选`
      };
    }
    return {
      detected_path: null,
      found: false,
      source: "none",
      message: `未检测到 ${pid} 客户端(已检查 ${checked.join(" / ") || "无可用安装根"};候选:${table.join(", ")})`
    };
  }
  async function getClientPathsImpl() {
    const channels = [];
    for (const { channel, description } of CLIENT_CHANNELS) {
      const savedRaw = ctx.db.setting.get(`client_path.${channel}`)?.v ?? null;
      let saved = savedRaw !== null && savedRaw !== "" ? savedRaw : null;
      let repaired = false;
      let note = null;
      const det = await probeClientPath(channel);
      const detected = det.found ? det.detected_path : null;
      const effective = saved ?? detected;
      channels.push({
        channel,
        description,
        saved_path: saved,
        detected_path: detected,
        effective_path: effective,
        exists: effective !== null && safeExists(effective),
        source: saved !== null ? "saved" : det.found ? "detected" : null,
        repaired,
        ...note !== null ? { note } : {}
      });
    }
    return {
      channels,
      // 配置已入库 —— 不再暴露 JSON 路径。
      config_file: ctx.dbPath
    };
  }
  return {
    chQuotaCooldownMs,
    chQuotaFetch,
    catalogCooldownStateOf,
    chMaybeFetchQuota,
    chAwaitQuota,
    catalogAccountOf,
    chCatalogCache,
    chCatalogGate,
    chCatalogInflight,
    chCatalogFetch,
    chAwaitCatalog,
    catalogFetchedAt,
    catalogRows,
    catalogRowsOf,
    probeProviderModels,
    serializeReasoningEfforts: serializeReasoningEfforts2,
    mergeCatalog,
    modelsSourceOf,
    chCreditsOf,
    safeExists,
    probeClientPath,
    getClientPathsImpl
  };
}

// panel/channels.ts
var chQuotaGate = /* @__PURE__ */ new Map();
var chQuotaInflight = /* @__PURE__ */ new Map();
var chQuotaCache = quotaHub;
function createChannelsDomain(ctx, deps) {
  let lastTraeAdoptScanMs = 0;
  const chSync = createChannelsSyncDomain(ctx, { chQuotaCache, chQuotaGate, chQuotaInflight });
  const {
    chQuotaCooldownMs,
    chQuotaFetch,
    catalogCooldownStateOf,
    chMaybeFetchQuota,
    chAwaitQuota,
    catalogAccountOf,
    chCatalogCache,
    chCatalogGate,
    chCatalogInflight,
    chCatalogFetch,
    chAwaitCatalog,
    catalogFetchedAt,
    catalogRows,
    catalogRowsOf,
    probeProviderModels,
    serializeReasoningEfforts: serializeReasoningEfforts2,
    mergeCatalog,
    modelsSourceOf,
    chCreditsOf,
    safeExists,
    probeClientPath,
    getClientPathsImpl
  } = chSync;
  let lastTraeAdoptMsg = "";
  const traeTokenBillingEligible = (token) => {
    try {
      const seg = token.split(".")[1];
      if (!seg) return false;
      const payload = JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
      return payload?.data?.source === "refresh_token";
    } catch {
      return false;
    }
  };
  const traeTokenWorks = async (token, extras) => {
    try {
      await probe_trae_quota({
        credentialKey: "trae-selfcheck",
        provider: "trae",
        username: "selfcheck",
        token,
        extras,
        region: "cn"
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP 401|code["\s:]*1001|authenticate you/i.test(msg)) return false;
      return true;
    }
  };
  const autoAdoptTrae = async (pid) => {
    if (pid !== "trae") return "";
    const nowMs = Date.now();
    if (nowMs - lastTraeAdoptScanMs < 3e4) return lastTraeAdoptMsg;
    lastTraeAdoptScanMs = nowMs;
    lastTraeAdoptMsg = "";
    let adopted = 0;
    let rejectedAuth = 0;
    try {
      const creds = await ctx.vault.list("trae").catch(() => []);
      if (creds.length === 0) return "";
      const found = discoverTraeAccounts();
      const ranked = [...found].sort(
        (a, b) => Number(traeTokenBillingEligible(b.token ?? "")) - Number(traeTokenBillingEligible(a.token ?? ""))
      );
      for (const acc of ranked) {
        if (!acc.token) continue;
        if (!traeTokenBillingEligible(acc.token)) {
          continue;
        }
        const uid = acc.user_id ?? acc.username ?? "";
        const match = creds.find((c) => {
          const rawUid = strOf(c.raw, "uid") ?? strOf(c.raw, "user_id");
          return uid !== "" && (rawUid === uid || c.username === uid) || c.username === acc.username;
        });
        if (!match) continue;
        const secret = await ctx.vault.secret("trae", match.username);
        if (secret === acc.token) continue;
        const selfExtras = { ...match.raw ?? {} };
        if (acc.extra && typeof acc.extra === "object") {
          for (const [k, v] of Object.entries(acc.extra)) {
            if (v !== null && v !== void 0) selfExtras[k] = v;
          }
        }
        const selfOk = await traeTokenWorks(acc.token, selfExtras);
        if (!selfOk) {
          rejectedAuth += 1;
          continue;
        }
        const raw = {
          ...match.raw ?? {},
          source: "discover",
          adopted_at_ms: wallNow() * 1e3,
          last_refresh: null
        };
        if (acc.region) raw.region = acc.region;
        if (acc.edition) raw.edition = acc.edition;
        if (acc.host) raw.host = acc.host;
        if (acc.user_id) {
          raw.user_id = acc.user_id;
          raw.uid = acc.user_id;
        }
        if (acc.token_expires_at_ms) raw.token_expires_at_ms = acc.token_expires_at_ms;
        if (acc.extra && typeof acc.extra === "object") {
          for (const [k, v] of Object.entries(acc.extra)) {
            if (v !== null && v !== void 0) raw[k] = v;
          }
        }
        const refreshToken = acc.extra && typeof acc.extra === "object" && typeof acc.extra.refresh_token === "string" ? acc.extra.refresh_token : void 0;
        await ctx.vault.put({
          provider: "trae",
          username: match.username,
          secret: acc.token,
          ...refreshToken !== void 0 ? { refreshSecret: refreshToken } : {},
          raw
        });
        adopted += 1;
      }
      const cliOnly = found.some((a) => a.token && !traeTokenBillingEligible(a.token)) && !found.some((a) => a.token && traeTokenBillingEligible(a.token));
      if (adopted === 0 && cliOnly) {
        lastTraeAdoptMsg = "trae 计费/签到接口只认桌面版 Trae 登录态;本机当前只有 CLI token(无法用于额度与签到,聊天仍可用)—— 请在 Trae 桌面客户端登录";
      }
      if (adopted === 0 && rejectedAuth > 0) {
        lastTraeAdoptMsg = "本机 Trae 桌面版登录态已被上游拒绝(计费/签到接口返回认证失败)—— 请在 Trae 桌面客户端重新登录,登录后本页会自动采用新令牌";
      }
    } catch {
    }
    if (adopted === 0) {
      return lastTraeAdoptMsg;
    }
    ctx.syncRegistry();
    lastTraeAdoptMsg = `已自动采用本机最新登录态(trae,${adopted} 个账号)`;
    return lastTraeAdoptMsg;
  };
  const accountsWithKeySync = (pid) => {
    const out = [];
    for (const account of ctx.registry.listAccounts(pid)) {
      const [p, u] = splitRef(account.credentialRef);
      out.push({
        credentialRef: account.credentialRef,
        username: u,
        hasKey: ctx.secretPresence.get(`${p}/${u}`) ?? false,
        keyFp: null
      });
    }
    return out;
  };
  const accountsWithKey = async (pid) => {
    const out = [];
    for (const account of ctx.registry.listAccounts(pid)) {
      const [p, u] = splitRef(account.credentialRef);
      const summary = await ctx.vault.describe(p, u);
      const secret = summary ? await ctx.vault.secret(p, u) : null;
      out.push({
        credentialRef: account.credentialRef,
        username: u,
        hasKey: summary !== null,
        keyFp: fpOf(secret)
      });
    }
    return out;
  };
  const channelAccountsOf = async (pid) => {
    const creds = await ctx.vault.list(pid);
    const out = [];
    for (let i = 0; i < creds.length; i++) {
      const s = creds[i];
      const secret = await ctx.vault.secret(pid, s.username);
      const region = typeof s.raw?.region === "string" ? s.raw.region : null;
      out.push({
        index: i,
        // 左侧只写用户名(用户 2026-10-30 定案),完整键另存 —— 见 ChannelAccount 注释。
        label: s.username,
        credential_key: s.key,
        key_fp: fpOf(secret),
        region,
        source: "credential 表",
        token_expires_at_ms: s.expiresAt !== null ? Math.round(s.expiresAt * 1e3) : null,
        refresh_expires_at_ms: null,
        last_refresh: null
      });
    }
    return out;
  };
  const checkinBaseOf = (pdef) => {
    if (!pdef) return null;
    const base = pdef.baseUrl?.trim().replace(/\/+$/, "");
    return base && base.length > 0 ? base : null;
  };
  const rawStrOf = (raw, key) => {
    const v = raw[key];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  };
  const checkinAccountsOf = async (pid) => {
    const creds = await ctx.vault.list(pid);
    const out = [];
    for (let i = 0; i < creds.length; i++) {
      const s = creds[i];
      const raw = s.raw ?? {};
      out.push({
        index: i,
        username: s.username,
        token: await ctx.vault.secret(pid, s.username),
        region: rawStrOf(raw, "region"),
        domain: rawStrOf(raw, "domain"),
        uid: rawStrOf(raw, "uid") ?? rawStrOf(raw, "user_id"),
        enterprise_id: rawStrOf(raw, "enterprise_id"),
        extra: raw
      });
    }
    const priority = parsePriorityList(ctx.db.setting.get(TRAE_PRIORITY_SETTING_KEY)?.v ?? "");
    return pid === "trae" ? prioritizeCheckinAccounts(out, priority) : out;
  };
  const checkinErrText = (err) => {
    if (err instanceof Error) {
      return `${err.constructor.name}: ${err.message}`.slice(0, 300);
    }
    return String(err).slice(0, 300);
  };
  const checkinClaimOne = async (pid, protocol, acc, base, confirm) => {
    const baseRow = { index: acc.index, provider: pid, username: acc.username, region: acc.region };
    if (protocol === "codearts") {
      const raw = acc.extra ?? {};
      const accessKey = String(raw["accessKey"] ?? "");
      const secretKey = String(raw["secretKey"] ?? "");
      if (accessKey === "" || secretKey === "") {
        return {
          ...baseRow,
          status: "failed",
          message: "该账号缺少 accessKey/secretKey，无法签到"
        };
      }
      try {
        const res = await codeartsIdeCheckin(
          {
            accessKey,
            secretKey,
            ...typeof raw["securityToken"] === "string" && raw["securityToken"] !== "" ? { securityToken: raw["securityToken"] } : {},
            ...typeof raw["domainId"] === "string" && raw["domainId"] !== "" ? { domainId: raw["domainId"] } : {},
            label: acc.username
          },
          {
            ...base ? { baseUrl: base } : {},
            confirm
          }
        );
        const status = res.ok ? "claimed" : res.already ? "already" : res.code === CODEARTS_IDE_CONFLICT_CODE ? "already" : res.code === -1 && res.message.includes("干跑") ? "dry_run" : "failed";
        if (confirm && (status === "claimed" || status === "already")) {
          try {
            markCodeartsCheckin(ctx.db, acc.username, {
              claimedAtMs: Date.now(),
              expireAtMs: res.expireAt,
              credit: res.credit
            });
          } catch (err) {
            console.error(
              `[as-one] codearts 签到时间落库失败(${acc.username}): ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        return {
          ...baseRow,
          status,
          message: res.message,
          ...res.credit > 0 ? { credit: res.credit } : {}
        };
      } catch (err) {
        return { ...baseRow, status: "failed", message: checkinErrText(err) };
      }
    }
    if (protocol === "minimax") {
      const bound = await minimaxAccountFor(ctx.vault, pid, acc.username);
      if (bound === null) {
        return { ...baseRow, status: "failed", message: "该账号没有可用令牌" };
      }
      const account = bound.account;
      const httpOpts = { timeoutMs: MINIMAX_QUOTA_TIMEOUT_MS, ...bound.httpOptions };
      try {
        const st = await minimaxSigninStatus(account, httpOpts);
        if (panelClaimedToday(st)) {
          const got = panelTodayPoints(st);
          return {
            ...baseRow,
            status: "already",
            message: got > 0 ? `今日已签,当日积分 ${got}` : "今日已签"
          };
        }
        const due = panelTodayPoints(st);
        if (!confirm) {
          return {
            ...baseRow,
            status: "dry_run",
            would_claim: true,
            daily_credit: due,
            message: `未签到,今日可领 ${due} 积分(未确认,不写)`
          };
        }
        const res = await minimaxSigninClaim(account, httpOpts);
        if (res.result === 2) {
          return { ...baseRow, status: "already", message: "今日已签(上游回报重复领取)" };
        }
        if (res.result === 1) {
          return {
            ...baseRow,
            status: "claimed",
            credit: res.points,
            message: `领取成功,获得 ${res.points} 积分${res.dayNo > 0 ? `(第 ${res.dayNo} 天)` : ""}`
          };
        }
        return { ...baseRow, status: "failed", message: `领取返回异常结果 ${res.result}` };
      } catch (err) {
        return { ...baseRow, status: "failed", message: checkinErrText(err) };
      }
    }
    if (protocol === "trae") {
      if (!acc.token) {
        return { ...baseRow, status: "failed", message: "该账号没有可用令牌" };
      }
      try {
        const res = await traeCheckinClaim(
          {
            index: acc.index,
            username: acc.username,
            token: acc.token,
            region: acc.region,
            // ⚠️ 不传 device_id(resolveTraeDevice 一律按 token 派生):
            // raw 里的真机指纹同机共享,会让多账号被上游判定成同一设备,
            // 每日签到只有第一个能领(2026-11-09 用户实测定案)。
            extra: acc.extra
          },
          { baseUrl: base ?? void 0, confirm }
        );
        const status = traeClaimStatusOf(res);
        const message = traeClaimMessageOf(res);
        return {
          ...baseRow,
          status,
          message,
          would_claim: res.would_claim || void 0,
          credit: res.checkin.credits || void 0,
          // 供 checkinClaim 做**设备级短路**:同机多账号时,第一个签上之后
          // 后面的账号直接 skipped,不再打上游(2026-11-10 实测定案)。
          device_checked_in: res.device_checked_in || void 0
        };
      } catch (err) {
        return { ...baseRow, status: "failed", message: checkinErrText(err) };
      }
    }
    if (wbRegionOf(acc.domain) !== "cn") {
      return { ...baseRow, status: "skipped", message: "国际版无签到(订阅制,额度走 payStatus)" };
    }
    if (!acc.token) {
      return { ...baseRow, status: "failed", message: "该账号没有可用令牌" };
    }
    if (!confirm) {
      try {
        const st = await wbCheckinStatus(
          { index: acc.index, username: acc.username, token: acc.token, domain: acc.domain, uid: acc.uid, enterprise_id: acc.enterprise_id },
          { baseUrl: base }
        );
        if (st.today_checked_in) {
          return {
            ...baseRow,
            status: "already",
            message: `今日已签到${st.streak_days > 0 ? ` · 连续 ${st.streak_days} 天` : ""}`,
            streak_days: st.streak_days
          };
        }
        return {
          ...baseRow,
          status: "dry_run",
          message: st.active ? `未签到,今日可领 ${st.daily_credit} 积分(未确认,不写)` : "该渠道当前没有签到活动(未确认,不写)",
          would_claim: st.active,
          credit: st.daily_credit > 0 ? st.daily_credit : void 0,
          streak_days: st.streak_days
        };
      } catch (err) {
        return { ...baseRow, status: "failed", message: checkinErrText(err) };
      }
    }
    try {
      const res = await wbCheckinClaim(
        { index: acc.index, username: acc.username, token: acc.token, domain: acc.domain, uid: acc.uid, enterprise_id: acc.enterprise_id },
        { baseUrl: base }
      );
      if (res.already) {
        return { ...baseRow, status: "already", message: `今日已签到（${res.message}）` };
      }
      const message = `领取成功${res.credit > 0 ? `,获得 ${res.credit} 积分` : ""}${res.streak_days > 0 ? ` · 连续 ${res.streak_days} 天` : ""}`;
      return { ...baseRow, status: "claimed", message, credit: res.credit, streak_days: res.streak_days };
    } catch (err) {
      return { ...baseRow, status: "failed", message: checkinErrText(err) };
    }
  };
  const catalogModel = (mv, accountsCount, usableCount, exposed) => ({
    id: `${mv.provider}/${mv.model}`,
    name: mv.name ?? mv.model,
    exposed,
    listed: !mv.hidden,
    hidden: mv.hidden,
    available: true,
    vision: mv.supportsVision,
    context_window: mv.maxInputTokens,
    max_output: mv.maxOutputTokens,
    rate: null,
    registered: mv.registered,
    callable: mv.registered && usableCount > 0,
    origin: null,
    endpoints: accountsCount,
    usable_endpoints: usableCount,
    default_vision: null,
    default_context: null,
    default_output: null,
    supported_reasoning_efforts: mv.supportedReasoningEfforts,
    reasoning_allows_off: mv.reasoningAllowsOff
  });
  const mergedChannelModels = (pid) => {
    const withKey = accountsWithKeySync(pid);
    const accountsCount = withKey.length;
    const usableCount = withKey.filter((a) => a.hasKey).length;
    const registryMap = deps.realModelMap(pid);
    const upstream = catalogRowsOf(pid);
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const [model, up] of [...upstream.entries()].sort(
      ([a], [b]) => a < b ? -1 : a > b ? 1 : 0
    )) {
      seen.add(model);
      const mv = registryMap.get(`${pid}/${model}`);
      out.push({
        id: `${pid}/${model}`,
        name: mv?.name && mv.name.length > 0 ? mv.name : up.name && up.name.length > 0 ? up.name : model,
        exposed: mv !== void 0,
        // 勾选 ⇔ 表里有这一行
        hidden: mv ? mv.hidden : null,
        listed: mv !== void 0,
        available: mv !== void 0 || up.vision !== void 0,
        vision: mv ? mv.supportsVision : up.vision,
        // 库里空 + 上游有值 → 用上游值顶上(与紧邻的 max_output 同一口径)。
        // 2026-11-16 用户反馈 workbuddy/hy4flash-free:上游 /v3/config 明明给了
        // maxInputTokens=960000,库里却是 NULL,目录拉取也没有补回去 —— 这里原先
        // 只有 max_output 做了 `mv 空 → up 顶上`,context_window 却直接取
        // `mv ? mv.maxInputTokens : null`,于是已登记但窗口为空的行永远显示空,
        // UI/网关跟着拿不到窗口。沿用 max_output 的 `||` 口径:0 视为坏值,
        // 同样落到上游值(而不是把 0 当成合法窗口发出去)。
        context_window: (mv?.maxInputTokens ?? null) || up.context_window || null,
        max_output: (mv?.maxOutputTokens ?? null) || up.max_output || null,
        // 倍率来自上游目录解析(workbuddy credits / trae consumption_rate);
        // 目录没给(或解析失败)才是 null,不硬编码丢弃。
        rate: up.rate ?? null,
        registered: mv !== void 0,
        callable: true,
        origin: up.origin ?? "remote",
        endpoints: mv ? accountsCount : 0,
        usable_endpoints: mv ? usableCount : 0,
        default_vision: up.vision,
        default_context: up.context_window,
        default_output: up.max_output,
        // 能力事实取**库里已登记行的值**(上游目录这一轮没给时目录项本身就是 null,
        // 不会把库里的学习结果冲掉)。
        supported_reasoning_efforts: mv ? mv.supportedReasoningEfforts : up.reasoning_efforts ?? null,
        reasoning_allows_off: mv ? mv.reasoningAllowsOff : up.reasoning_allows_off ?? null
      });
    }
    for (const mv of [...registryMap.values()].sort(
      (a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0
    )) {
      if (seen.has(mv.model)) continue;
      seen.add(mv.model);
      out.push({
        id: `${pid}/${mv.model}`,
        name: mv.name ?? mv.model,
        exposed: true,
        // 在表里 ⇒ 一律勾着
        hidden: mv.hidden,
        listed: true,
        available: true,
        vision: mv.supportsVision,
        context_window: mv.maxInputTokens,
        max_output: mv.maxOutputTokens,
        rate: null,
        registered: true,
        callable: true,
        origin: "router",
        endpoints: accountsCount,
        usable_endpoints: usableCount,
        default_vision: null,
        default_context: null,
        default_output: null,
        supported_reasoning_efforts: mv.supportedReasoningEfforts,
        reasoning_allows_off: mv.reasoningAllowsOff
      });
    }
    return out;
  };
  const refreshLedger = /* @__PURE__ */ new Map();
  const refreshInFlight = /* @__PURE__ */ new Map();
  const refreshAccountsOf = async (pid) => {
    const creds = await ctx.vault.list(pid);
    const out = [];
    for (let i = 0; i < creds.length; i++) {
      const full = await ctx.vault.get(pid, creds[i].username);
      if (full) out.push({ index: i, cred: full });
    }
    return out;
  };
  const refreshRowBase = (index, cred) => ({
    index,
    account: credentialKey(cred.provider, cred.username),
    username: cred.username,
    uid: strOf(cred.raw, "uid"),
    region: strOf(cred.raw, "region"),
    has_refresh_token: cred.refreshSecret !== null && cred.refreshSecret !== void 0,
    token_expires_at_ms: (() => {
      const sec = expiresAtOf(cred);
      return sec !== null ? Math.round(sec * 1e3) : null;
    })(),
    needs_refresh: cred.refreshSecret ? needsRefresh(cred, { marginSeconds: REFRESH_MARGIN_S }) : false
  });
  const refreshOne = async (pid, index, cred, confirm) => {
    const base = refreshRowBase(index, cred);
    if (!cred.secret) {
      return { ...base, status: "failed", message: "该账号没有可用令牌" };
    }
    if (!cred.refreshSecret) {
      return { ...base, status: "skipped", message: "无 refresh token,请在客户端重新登录后重新发现" };
    }
    if (!confirm) {
      return {
        ...base,
        status: "dry_run",
        needs_refresh: needsRefresh(cred, { marginSeconds: REFRESH_MARGIN_S }),
        old_token_fp: fingerprint(cred.secret),
        message: "可刷新(未确认,未发出上游请求)"
      };
    }
    const oldFp = fingerprint(cred.secret);
    let outcome;
    try {
      outcome = pid === "trae" ? await refreshTraeToken(cred) : pid === "minimax" ? await refreshMinimaxToken(cred) : await refreshWorkbuddyToken(cred);
    } catch (err) {
      const msg = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
      return { ...base, status: "failed", old_token_fp: oldFp, message: msg.slice(0, 300) };
    }
    let saved = true;
    let saveError = "";
    try {
      const expiresSec = typeof outcome.expiresAtMs === "number" && Number.isFinite(outcome.expiresAtMs) ? outcome.expiresAtMs / 1e3 : void 0;
      await ctx.vault.rotate(pid, cred.username, {
        secret: outcome.accessToken,
        refreshSecret: outcome.refreshToken,
        expiresAt: expiresSec
      });
      if (outcome.extra && Object.keys(outcome.extra).length > 0) {
        const updated = await ctx.vault.get(pid, cred.username);
        if (updated) {
          await ctx.vault.put({ provider: pid, username: cred.username, raw: { ...updated.raw, ...outcome.extra } });
        }
      }
    } catch (err) {
      saved = false;
      saveError = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    }
    const status = saved ? "refreshed" : "refreshed_unsaved";
    const messages = saved ? ["已写入数据库"] : [`落盘凭据失败: ${saveError}`, "已写入数据库"];
    return {
      ...base,
      status,
      old_token_fp: oldFp,
      new_token_fp: fingerprint(outcome.accessToken),
      token_expires_at_ms: typeof outcome.expiresAtMs === "number" && Number.isFinite(outcome.expiresAtMs) ? Math.round(outcome.expiresAtMs) : null,
      message: messages.join("; ")
    };
  };
  const doRefreshRun = async (pid, confirm, onlyIndex) => {
    const startedAt = Date.now();
    const prevEntry = refreshLedger.get(pid);
    refreshLedger.set(pid, {
      ...prevEntry ?? {
        startedAtMs: null,
        lastRunAtMs: null,
        lastElapsedS: null,
        lastOk: null,
        lastError: null,
        result: null,
        lastRunAccounts: []
      },
      startedAtMs: startedAt
    });
    const accounts = await refreshAccountsOf(pid);
    const targets = onlyIndex === void 0 ? accounts : accounts.filter((a) => a.index === onlyIndex);
    const rows = [];
    for (const t of targets) {
      rows.push(await refreshOne(pid, t.index, t.cred, confirm));
    }
    const elapsedS = Math.round((Date.now() - startedAt) / 100) / 10;
    const refreshed = rows.filter((r) => r.status === "refreshed" || r.status === "refreshed_unsaved").length;
    const ok = refreshed > 0 || !confirm && rows.length > 0;
    const message = confirm ? rows.length > 0 ? "已刷新" : `没有匹配的账号(index=${onlyIndex})` : "干跑结果(未发出上游请求)";
    refreshLedger.set(pid, {
      startedAtMs: startedAt,
      lastRunAtMs: startedAt,
      lastElapsedS: elapsedS,
      lastOk: ok,
      lastError: !ok && rows.length > 0 ? rows.find((r) => r.status === "failed")?.message ?? null : null,
      result: `${ok ? "成功" : "失败"}:${message}(${refreshed}/${rows.length} 个账号)`,
      lastRunAccounts: rows
    });
    return {
      ok,
      provider: pid,
      confirm,
      count: rows.length,
      refreshed,
      message,
      accounts: rows
    };
  };
  return {
    accountsWithKeySync,
    accountsWithKey,
    mergedChannelModels,
    chCatalogCache,
    chQuotaCache,
    chCatalogGate,
    chAwaitCatalog,
    mergeCatalog,
    methods: createChannelsMethods(ctx, {
      realModelMap: deps.realModelMap,
      modelViewOf: deps.modelViewOf,
      stripMemberFromLogicalModels: deps.stripMemberFromLogicalModels,
      // Qoder 额度刷新口子(2026-11-09):原样透传,渠道域不自己解引用 ——
      // 装配层用 getter 延迟绑定,创建顺序不再是约束。
      qoderQuotaRefresh: deps.qoderQuotaRefresh,
      // 27 个渠道域闭包(与 assembly-channels-methods.ts 的 ChannelsMethodsDeps 对齐)
      chQuotaCache,
      accountsWithKey,
      autoAdoptTrae,
      catalogCooldownStateOf,
      catalogFetchedAt,
      catalogRows,
      chAwaitCatalog,
      chAwaitQuota,
      chCreditsOf,
      chMaybeFetchQuota,
      channelAccountsOf,
      checkinAccountsOf,
      checkinBaseOf,
      checkinClaimOne,
      doRefreshRun,
      getClientPathsImpl,
      mergeCatalog,
      mergedChannelModels,
      modelsSourceOf,
      probeClientPath,
      probeProviderModels,
      rawStrOf,
      refreshAccountsOf,
      refreshInFlight,
      refreshLedger,
      refreshRowBase,
      safeExists,
      serializeReasoningEfforts: serializeReasoningEfforts2
    })
  };
}

// panel/sensenova.ts
function ratiosOfQuota(quota) {
  const ratioOf = (remaining, limit) => {
    if (typeof remaining !== "number" || typeof limit !== "number" || limit <= 0) return null;
    return Math.min(1, Math.max(0, remaining / limit));
  };
  const pools = quota?.pools ?? [];
  const general = pools.find((p) => p.pool_type === "default");
  if (general === void 0) return { w5: null, w7: null };
  return {
    w5: ratioOf(general.w5_remaining, general.w5_limit),
    w7: ratioOf(general.w7_remaining, general.w7_limit)
  };
}
function createSensenovaDomain(ctx, deps) {
  const snUserOf = (name) => {
    const s = String(name ?? "").trim();
    const slash = s.indexOf("/");
    if (slash >= 0 && s.slice(0, slash) === "sensenova") return s.slice(slash + 1);
    return sensenova_username(s);
  };
  const snLoginState = {
    chain: Promise.resolve(),
    lastDoneAtMs: 0,
    running: 0,
    waitMs: 2e3
  };
  const snSerialized = (fn) => {
    snLoginState.running++;
    const run = snLoginState.chain.then(async () => {
      const gapMs = Math.max(0, snLoginState.lastDoneAtMs + snLoginState.waitMs - Date.now());
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      try {
        return await fn();
      } finally {
        snLoginState.lastDoneAtMs = Date.now();
        snLoginState.running--;
      }
    });
    snLoginState.chain = run.then(() => void 0, () => void 0);
    return run;
  };
  const snRefreshState = { running: 0 };
  const snLedger = {
    startedAtMs: null,
    lastRunAtMs: null,
    lastElapsedS: null,
    lastOk: null,
    lastError: null,
    result: null,
    lastRunAccounts: []
  };
  const snCred = (username) => ctx.vault.get("sensenova", username);
  const snStorePassword = async (username, password) => {
    if (!password) return;
    await ctx.vault.put({ provider: "sensenova", username, refreshSecret: password });
  };
  const snStoreKey = async (username, apiKey) => {
    await ctx.vault.put({ provider: "sensenova", username, secret: apiKey });
  };
  const snAuthFlow = async (username) => {
    const account = `sensenova/${username}`;
    const cred = await snCred(username);
    const rawJwt = cred?.raw?.console_jwt;
    const rawRefresh = cred?.raw?.console_refresh_token;
    const hasRefresh = typeof rawRefresh === "string" && rawRefresh !== "";
    if (typeof rawJwt === "string" && rawJwt !== "") {
      const exp = jwt_expiry_epoch_s(rawJwt);
      if (exp === null || exp > wallNow() + 30) {
        const f2 = new SensenovaAuthFlow();
        f2.jwtCache.set(
          sensenova_username(account),
          rawJwt
        );
        return f2;
      }
    }
    if (hasRefresh) {
      try {
        const f2 = new SensenovaAuthFlow();
        const fresh = await f2.refreshConsoleJwt(account, rawRefresh);
        await snStoreConsoleJwt(username, fresh);
        return f2;
      } catch {
      }
    }
    const pwd = cred?.refreshSecret ?? null;
    if (!pwd) {
      throw new UpstreamError(
        "auth",
        "既没有可用的控制台令牌/续期凭证,也没有已保存密码 —— 请点「登录并抓 key」输一次密码(之后会存下来)",
        false,
        401
      );
    }
    const f = await snSerialized(async () => {
      const nf = new SensenovaAuthFlow();
      await nf.login(account, username, pwd);
      return nf;
    });
    const jwt = f.jwtFor(account);
    if (jwt) {
      try {
        await snStoreConsoleJwt(username, jwt);
      } catch {
      }
    }
    const rt = f.refreshTokenFor(account);
    if (rt) {
      try {
        await snStoreConsoleRefreshToken(username, rt);
      } catch {
      }
    }
    return f;
  };
  const SN_KEY_PROBE_WAIT_S = 12;
  const snProbeKey = async (apiKey, waitForNew = false) => {
    if (!apiKey) return "invalid";
    const deadline = Date.now() + SN_KEY_PROBE_WAIT_S * 1e3;
    for (; ; ) {
      let status = 0;
      try {
        const res = await fetch("https://token.sensenova.cn/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
        });
        status = res.status;
      } catch {
        return "unknown";
      }
      if (status === 200) return "ok";
      if (status !== 401 && status !== 403) return "unknown";
      if (!waitForNew || Date.now() >= deadline) return "invalid";
      await new Promise((r) => setTimeout(r, 2e3));
    }
  };
  const snRepairInflight = /* @__PURE__ */ new Map();
  const snRepairKeyRun = async (username, reason) => {
    const cred = await snCred(username);
    const current = cred?.secret?.trim() ?? "";
    if (current !== "") {
      const verdict = await snProbeKey(current);
      if (verdict === "ok") {
        return {
          ok: false,
          message: `API key 实测可用(探针 200),本次失败原因不是 key:${reason} —— 未改动凭据`,
          created: false,
          dropped: []
        };
      }
      if (verdict === "unknown") {
        return {
          ok: false,
          message: `探不清 API key 是否有效(非 401/403 响应或网络不通),不擅自删 key:${reason} —— 未改动凭据`,
          created: false,
          dropped: []
        };
      }
    }
    try {
      const account = `sensenova/${username}`;
      const flow = await snAuthFlow(username);
      let staleIds = [];
      if (current !== "") {
        const keys = await flow.list_api_keys(account).catch(() => []);
        staleIds = keys.filter((k) => k.api_key === current).map((k) => k.id);
      }
      const r = await flow.ensure_api_key_replacing(account, staleIds);
      const verdict = r.created ? await snProbeKey(r.apiKey, true) : await snProbeKey(r.apiKey);
      await snStoreKey(username, r.apiKey);
      await deps.syncSensenovaPool(ctx.vault);
      const msg = staleIds.length > 0 ? `原 API key 已失效,已新建 1 把并删除失效的那把(${r.dropped.length}/${staleIds.length} 个已删)` : r.created ? "账号下没有可用 API key,已新建 1 把" : "已重新取回账号下的 API key";
      if (r.created && verdict !== "ok") {
        return {
          ok: true,
          message: `${msg};已等 ${SN_KEY_PROBE_WAIT_S}s 仍${verdict === "unknown" ? "探不清" : "未生效"},请稍候重试`,
          created: r.created,
          dropped: r.dropped
        };
      }
      return { ok: true, message: msg, created: r.created, dropped: r.dropped };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `修复 API key 失败:${detail}`, created: false, dropped: [] };
    }
  };
  const snRepairKey = async (username, reason) => {
    const existing = snRepairInflight.get(username);
    if (existing) return existing;
    const p = snRepairKeyRun(username, reason).catch(
      (err) => ({
        ok: false,
        message: `修复 API key 异常:${err instanceof Error ? err.message : String(err)}`,
        created: false,
        dropped: []
      })
    ).finally(() => snRepairInflight.delete(username));
    snRepairInflight.set(username, p);
    return p;
  };
  const snStoreConsoleRefreshToken = async (username, token) => {
    const existing = await snCred(username);
    await ctx.vault.put({
      provider: "sensenova",
      username,
      raw: { ...existing?.raw ?? {}, console_refresh_token: token }
    });
  };
  const snStoreConsoleJwt = async (username, jwt) => {
    const existing = await snCred(username);
    await ctx.vault.put({
      provider: "sensenova",
      username,
      raw: { ...existing?.raw ?? {}, console_jwt: jwt }
    });
  };
  const snQuotaCooldownMs = () => {
    const raw = ctx.db.setting.get("external_refresh.interval_hours")?.v ?? "5";
    const hours = Number(raw);
    const h = Number.isFinite(hours) && hours > 0 ? hours : 5;
    return h * 3600 * 1e3;
  };
  const snQuotaCache = /* @__PURE__ */ new Map();
  const snQuotaGate = /* @__PURE__ */ new Map();
  const snQuotaInflight = /* @__PURE__ */ new Map();
  const snQuotaError = /* @__PURE__ */ new Map();
  const snQuotaFetch = async (username) => {
    const account = `sensenova/${username}`;
    const bail = (reason) => {
      snQuotaError.set(username, reason);
      return null;
    };
    const cred = await snCred(username);
    const rawJwt = cred?.raw?.console_jwt;
    const rawRefresh = cred?.raw?.console_refresh_token;
    const hasRefresh = typeof rawRefresh === "string" && rawRefresh !== "";
    if (typeof rawJwt !== "string" || rawJwt === "") {
      if (hasRefresh) {
        try {
          const f = new SensenovaAuthFlow();
          const fresh = await f.refreshConsoleJwt(account, rawRefresh);
          await snStoreConsoleJwt(username, fresh);
          return fetchPoolWith(f, fresh);
        } catch (err) {
          return bail(
            `没有控制台令牌,自动续期也失败:${err instanceof Error ? err.message : String(err)} —— 请在下方「登录并抓 key」重新登录一次`
          );
        }
      }
      return bail("没有控制台令牌 —— 请在下方「登录并抓 key」");
    }
    const exp = jwt_expiry_epoch_s(rawJwt);
    const expired = exp !== null && exp <= wallNow() + 30;
    let flow = new SensenovaAuthFlow();
    let jwt = expired ? void 0 : rawJwt;
    if (expired) {
      if (hasRefresh) {
        try {
          const f = new SensenovaAuthFlow();
          jwt = await f.refreshConsoleJwt(account, rawRefresh);
          await snStoreConsoleJwt(username, jwt);
          flow = f;
        } catch (err) {
          jwt = void 0;
          void err;
        }
      }
      if (!jwt) {
        const pwd = cred?.refreshSecret ?? null;
        if (!pwd) {
          return bail(
            `控制台令牌已于 ${exp !== null ? new Date(exp * 1e3).toLocaleString() : "?"} 过期,且没有可用的续期凭证或已保存密码 —— 请「登录并抓 key」或「只保存密码」`
          );
        }
        try {
          flow = await snSerialized(async () => {
            const f = new SensenovaAuthFlow();
            await f.login(account, username, pwd);
            return f;
          });
          jwt = flow.jwtFor(account);
          if (jwt) await snStoreConsoleJwt(username, jwt);
        } catch (err) {
          return bail(
            `控制台令牌已过期,自动续期失败:${err instanceof Error ? err.message : String(err)} —— 请在下方「登录并抓 key」重新登录一次`
          );
        }
      }
    }
    if (!jwt) return bail("拿不到控制台令牌");
    return fetchPoolWith(flow, jwt);
    async function fetchPoolWith(f, token) {
      try {
        const raw = await f.fetch_pool_usage(account, token);
        const parsed = parse_pool_usage(raw);
        const sessionMs = 3 * 3600 * 1e3;
        const quota = {
          account: username,
          pools: parsed.pools.map((p) => ({
            pool_type: p.pool_type ?? "",
            name: p.pool_name ?? "(未命名)",
            w5_limit: p.w5?.limit ?? null,
            w5_used: p.w5?.used ?? null,
            w5_remaining: p.w5?.remaining ?? null,
            w5_reset_at: p.w5?.reset_at ?? null,
            w7_limit: p.w7?.limit ?? null,
            w7_used: p.w7?.used ?? null,
            w7_remaining: p.w7?.remaining ?? null,
            w7_reset_at: p.w7?.reset_at ?? null,
            grant_balance: p.grant_balance,
            grant_expiry: p.grant_expiry,
            grant_expiring_balance: p.grant_expiring_balance
          })),
          grant_balance: parsed.grant_total,
          plan: parsed.plan_name,
          fetched_at: Date.now(),
          remaining: parsed.remaining,
          expires_at: Date.now() + sessionMs
          // 过期为 JWT 换新需求,不是额度到期
        };
        snQuotaCache.set(username, { fetchedAtMs: Date.now(), quota });
        quotaHub.setPoolRatios(username, ratiosOfQuota(quota));
        snQuotaError.delete(username);
        return quota;
      } catch (err) {
        return bail(`拉取积分池失败:${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const snMaybeFetchQuota = (username) => {
    const now = Date.now();
    const cooldownMs = snQuotaCooldownMs();
    const cached = snQuotaCache.get(username);
    if (cached && now - cached.fetchedAtMs < cooldownMs) return;
    if (now - (snQuotaGate.get(username) ?? 0) < cooldownMs) return;
    snQuotaGate.set(username, now);
    if (!snQuotaInflight.has(username)) {
      const p = snQuotaFetch(username).finally(() => snQuotaInflight.delete(username));
      snQuotaInflight.set(username, p);
    }
  };
  const snLogin = async (account, username, password, fetchKey = true) => {
    const user = snUserOf(username || account);
    if (!user || !password) {
      return { ok: false, message: "账号与密码均为必填(密码不回显)" };
    }
    const t0 = Date.now();
    snLedger.startedAtMs = t0;
    const record2 = (ok, result, message, totalKeys) => {
      const now = Date.now();
      snLedger.startedAtMs = t0;
      snLedger.lastRunAtMs = now;
      snLedger.lastElapsedS = Math.round((now - t0) / 1e3 * 10) / 10;
      snLedger.lastOk = ok;
      snLedger.lastError = ok ? null : message;
      snLedger.result = result;
    };
    try {
      const flow = await snSerialized(async () => {
        const f = new SensenovaAuthFlow();
        await f.login(account, user, password);
        return f;
      });
      await snStorePassword(user, password);
      const jwt = flow.jwtFor(account);
      if (jwt) {
        try {
          await snStoreConsoleJwt(user, jwt);
        } catch {
        }
      }
      const refreshToken = flow.refreshTokenFor(account);
      if (refreshToken) {
        try {
          await snStoreConsoleRefreshToken(user, refreshToken);
        } catch {
        }
      }
      if (!fetchKey) {
        record2(true, "登录成功(按要求未抓取 API key)", "登录成功(按要求未抓取 API key)");
        return { ok: true, account, username: user, logged_in: true, key_updated: false, has_password: true, message: "登录成功(按要求未抓取 API key)" };
      }
      try {
        const { apiKey, total, created } = await flow.ensure_api_key(account);
        await snStoreKey(user, apiKey);
        const message = created ? `登录成功,账号下没有可用 API key,已自动新建 1 把(现共 ${total} 把)` : `登录成功,已抓取 API key(账号下共 ${total} 把)`;
        record2(true, message, message, total);
        void snQuotaFetch(user);
        return { ok: true, account, username: user, logged_in: true, key_updated: true, total_keys: total, has_password: true, message };
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        const message = e instanceof UpstreamError ? `登录成功,但抓 API key 失败:${detail}` : `登录成功,但抓 key 异常:${e instanceof Error ? e.constructor.name : typeof e}: ${detail}`;
        record2(false, message, message);
        return { ok: false, account, username: user, logged_in: true, key_updated: false, has_password: true, message };
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      let message;
      if (e instanceof UpstreamError && e.kind === "auth") {
        message = `登录失败:${detail.replace(/^登录失败[:：]\s*/, "")}`;
      } else {
        message = `登录异常:${e instanceof Error ? e.constructor.name : typeof e}: ${detail}`;
      }
      record2(false, message, message);
      return { ok: false, account, username: user, logged_in: false, key_updated: false, has_password: false, message };
    }
  };
  const methods = {
    // ── SenseNova 登录与账号管理(/sensenova/login、/refetch-key、/accounts)──
    /**
     * SenseNova 账号列表(对齐 `GET /sensenova/accounts`)。
     *
     * 凭据投影,**无明文**。
     */
    async getSensenovaAccounts() {
      const creds = await ctx.vault.list("sensenova").catch(() => []);
      const accounts = [];
      for (let i = 0; i < creds.length; i += 1) {
        const username = snUserOf(creds[i].username);
        const full = await ctx.vault.get("sensenova", creds[i].username);
        const secret = await ctx.vault.secret("sensenova", creds[i].username);
        accounts.push({
          index: i,
          account: username,
          username,
          // D2/D6:没有停用开关;不可用 = 删这一行
          enabled: true,
          has_key: Boolean(secret),
          key_hint: fpOf(secret),
          has_password: Boolean(full?.refreshSecret)
        });
      }
      return { accounts, count: accounts.length };
    },
    async getSensenovaStatus() {
      const pid = "sensenova";
      const pdef = ctx.registry.getProvider(pid);
      const creds = await ctx.vault.list(pid);
      const configAccounts = ctx.registry.listAccounts(pid);
      const enabledByRef = new Map(
        configAccounts.map((a) => [a.credentialRef, ctx.accountOverlay.get(a.credentialRef) ?? a.enabled])
      );
      const lastDay = deps.lastStatsDay();
      const snRows = lastDay ? ctx.db.statsDaily.range(lastDay, lastDay).filter((r) => r.provider === pid) : [];
      let requests = 0, fails = 0, prompt = 0, completion = 0, cached = 0;
      let latencySum = 0, ttftSum = 0, ttftReq = 0;
      for (const r of snRows) {
        requests += r.requests;
        fails += r.fails;
        prompt += r.prompt_tokens;
        completion += r.completion_tokens;
        cached += r.cached_tokens;
        latencySum += r.latency_sum_ms;
        ttftSum += r.ttft_sum_ms;
        ttftReq += r.ttft_requests;
      }
      const genMs = latencySum - ttftSum;
      const nowS = wallNow();
      const leases = ctx.ledger.detail();
      const accounts = [];
      for (let i = 0; i < creds.length; i++) {
        const cred = creds[i];
        const secret = await ctx.vault.secret(pid, cred.username);
        const full = await ctx.vault.get(pid, cred.username);
        const hasPassword = Boolean(full?.refreshSecret);
        const enabled = enabledByRef.get(cred.key) ?? true;
        const inflight2 = leases.filter((l) => l.endpointId.endsWith(`@${pid}/${cred.username}`)).length;
        let cooling = false;
        let cooldownRemaining = null;
        let lastError = null;
        let lastKind = null;
        let lastUsedAt = null;
        for (const mv of deps.realModelMap(pid).values()) {
          const epId = endpointIdOf(pid, mv.model, cred.username);
          const rec = ctx.health.get(epId);
          if (rec.cooldownUntil > 0 && rec.cooldownUntil > nowS) {
            cooling = true;
            const rem = Math.round((rec.cooldownUntil - nowS) * 10) / 10;
            if (cooldownRemaining === null || rem > cooldownRemaining) cooldownRemaining = rem;
          }
          if (rec.lastError) {
            lastError = rec.lastError || null;
            lastKind = rec.lastKind || null;
          }
          if (rec.updatedAt > 0 && (lastUsedAt === null || rec.updatedAt * 1e3 > lastUsedAt)) {
            lastUsedAt = Math.round(rec.updatedAt * 1e3);
          }
        }
        const q = snQuotaCache.get(cred.username);
        const quotaStale = q !== void 0 && Date.now() - q.fetchedAtMs > snQuotaCooldownMs();
        if (q === void 0 || quotaStale) snMaybeFetchQuota(cred.username);
        accounts.push({
          account: cred.username,
          username: cred.username,
          enabled,
          key_hint: fpOf(secret),
          has_password: hasPassword,
          has_key: secret !== null,
          slots: 0,
          inflight: inflight2,
          inflight_is_pool_total: null,
          parallel_cap: null,
          // ⚠️ 成功率恒 100%(用户 m11736):失败请求不再进统计 → `requests` 本身就是
          // 成功数,再算「成功数 / 总数」没有意义。字段保留是为了契约兼容,
          // 值不再有信息量 —— 面板也不再展示它。
          success_rate: requests > 0 ? 100 : null,
          avg_ttft_ms: ttftReq > 0 ? round1(ttftSum / ttftReq) : null,
          avg_tps: completion > 0 && genMs > 0 ? round1(completion / (genMs / 1e3)) : null,
          cache_hit_rate: prompt > 0 ? Math.min(1, cached / prompt) : null,
          requests,
          // 同 success_rate:失败请求不进统计,这里恒 0(历史行可能仍是旧值,不再展示)
          errors: 0,
          cooling,
          cooldown_remaining_s: cooldownRemaining,
          last_error: lastError,
          last_error_kind: lastKind,
          last_used_at: lastUsedAt,
          quota: q?.quota ?? null,
          quota_stale: quotaStale
        });
      }
      return {
        accounts,
        pool: null,
        base_url: pdef?.baseUrl ?? null,
        refresh: {
          // 登录队列在跑,或「刷新」在跑 —— 两者都是这一行状态要反映的忙碌态。
          running: snLoginState.running > 0 || snRefreshState.running > 0,
          started_at_ms: snLedger.startedAtMs,
          last_run_at_ms: snLedger.lastRunAtMs,
          last_elapsed_s: snLedger.lastElapsedS,
          last_ok: snLedger.lastOk,
          last_error: snLedger.lastError,
          result: snLedger.result,
          count: snLedger.lastRunAccounts.length,
          last_run_accounts: snLedger.lastRunAccounts
        },
        auto_refresh: null,
        uptime_s: Math.round((Date.now() - ctx.startedAtMs) / 1e3 * 10) / 10,
        note: null
      };
    },
    /**
     * SenseNova「刷新」—— 页面那个按钮以前只 `load()` 本地库(所以「刷了没反应」)。
     * 现在真干两件事(都是**不烧额度**的元数据/控制台接口):
     *   ① 上游模型目录:`token.sensenova.cn/v1/models`(API key 认证)→ 落 db.real_model;
     *   ② 积分池:清空冷却闸门重拉(JWT 过期且已存密码 → 串行免登录续期再拉)。
     */
    async sensenovaRefresh(_force, segments) {
      const pid = "sensenova";
      const force = _force !== false;
      const wantCatalog = segments?.catalog !== false;
      const wantQuota = segments?.quota !== false;
      const t0 = Date.now();
      snLedger.startedAtMs = t0;
      const record2 = (ok2, message2, rows2) => {
        const elapsed = Math.round((Date.now() - t0) / 1e3 * 10) / 10;
        snLedger.lastRunAtMs = Date.now();
        snLedger.lastElapsedS = elapsed;
        snLedger.lastOk = ok2;
        snLedger.lastError = ok2 ? null : message2;
        snLedger.result = `${ok2 ? "成功" : "失败"}:${message2}`;
        snLedger.lastRunAccounts = rows2;
        return { ok: ok2, provider: pid, count: rows2.length, message: message2, accounts: rows2 };
      };
      let creds;
      try {
        creds = await ctx.vault.list(pid);
      } catch (err) {
        return record2(false, `读取账号池失败:${err instanceof Error ? err.message : String(err)}`, []);
      }
      if (creds.length === 0) {
        return record2(false, "SenseNova 下没有账号,无法刷新", []);
      }
      snRefreshState.running += 1;
      const rows = [];
      const catalogErrs = [];
      const quotaErrs = [];
      let catalogCount = 0;
      let catalogWarn = "";
      let quotaOk = 0;
      try {
        const pdef = ctx.registry.getProvider(pid);
        for (let i = 0; i < creds.length; i++) {
          const username = creds[i].username;
          try {
            const preCred = wantCatalog ? await ctx.vault.get(pid, username) : null;
            if (wantCatalog && !preCred?.secret?.trim()) {
              const rep = await snRepairKey(username, "账号下没有 API key");
              if (rep.ok) {
                deps.chCatalogCache.delete(`${pid}/${username}`);
                deps.chCatalogGate.delete(`${pid}/${username}`);
              } else {
                catalogErrs.push(`${username}:${rep.message}`);
              }
            }
          } catch (err) {
            catalogErrs.push(`${username}:自动补 key 失败:${err instanceof Error ? err.message : String(err)}`);
          }
          if (wantCatalog) try {
            const res = await deps.chAwaitCatalog(pid, username, force);
            catalogCount = Math.max(
              catalogCount,
              deps.mergeCatalog(pid, res.entries, pdef?.baseUrl ?? null, pdef?.protocol ?? pid)
            );
            if (catalogWarn === "" && res.warnings.length > 0) catalogWarn = res.warnings[0];
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            const authFailed = /401|403|Unauthorized|Forbidden|invalid.*key|没有可用密钥/i.test(detail);
            if (authFailed) {
              try {
                const rep = await snRepairKey(username, detail);
                if (rep.ok) {
                  const res2 = await deps.chAwaitCatalog(pid, username, true);
                  catalogCount = Math.max(
                    catalogCount,
                    deps.mergeCatalog(pid, res2.entries, pdef?.baseUrl ?? null, pdef?.protocol ?? pid)
                  );
                } else {
                  catalogErrs.push(`${username}:${rep.message}`);
                }
              } catch (err2) {
                catalogErrs.push(
                  `${username}:重建 key 后仍失败:${err2 instanceof Error ? err2.message : String(err2)}`
                );
              }
            } else {
              catalogErrs.push(`${username}:${detail}`);
            }
          }
          let quota = null;
          if (wantQuota) {
            try {
              snQuotaGate.delete(username);
              quota = await snQuotaFetch(username);
              if (quota === null) quotaErrs.push(`${username}:${snQuotaError.get(username) ?? "未拉取到"}`);
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              quotaErrs.push(`${username}:拉取积分池异常:${detail}`);
              snQuotaError.set(username, detail);
            }
            if (quota !== null) quotaOk += 1;
          }
          const full = await ctx.vault.get(pid, username).catch(() => null);
          rows.push({
            index: i,
            account: `sensenova/${username}`,
            username,
            uid: strOf(full?.raw ?? {}, "uid"),
            region: strOf(full?.raw ?? {}, "region"),
            has_refresh_token: Boolean(full?.refreshSecret),
            token_expires_at_ms: null,
            needs_refresh: false,
            status: !wantQuota || quota ? "ok" : "failed",
            message: !wantQuota ? "仅刷新模型目录(未动积分池)" : quota ? `积分池已刷新(${quota.pools.length} 个池)` : snQuotaError.get(username) ?? "积分池未拉取到"
          });
        }
      } catch (err) {
        catalogErrs.push(`刷新中断:${err instanceof Error ? err.message : String(err)}`);
      } finally {
        snRefreshState.running -= 1;
      }
      const parts = [];
      if (wantCatalog) {
        parts.push(
          catalogCount > 0 ? `模型目录:上游 ${catalogCount} 个,已写入库${catalogWarn ? `(降级:${catalogWarn})` : ""}` : `模型目录:未拉到(${catalogErrs[0] ?? "无可用密钥"})`
        );
      }
      if (wantQuota) {
        parts.push(
          quotaOk > 0 ? `积分池:${quotaOk}/${creds.length} 个账号` : `积分池:未拉到(${quotaErrs[0] ?? "无账号"})`
        );
      }
      const message = parts.join("; ") || "未指定刷新内容";
      const ok = wantCatalog && catalogCount > 0 || wantQuota && quotaOk > 0;
      return record2(ok, message, rows);
    },
    async getSensenovaModels() {
      const pid = "sensenova";
      return deps.mergedChannelModels(pid).map((m) => ({
        id: m.id,
        name: m.name,
        context_window: m.context_window,
        max_output: m.max_output,
        input_modalities: m.vision ? ["text", "image"] : ["text"],
        vision_upstream: m.default_vision ?? m.vision,
        vision: m.vision,
        registered: m.registered,
        available: m.available
      }));
    },
    async setSensenovaExposure(provider, model, exposed) {
      const pid = String(provider ?? "").trim();
      const mid = String(model ?? "").trim();
      if (!pid || !mid) return { ok: false, message: "provider/model 不能为空" };
      const mv = deps.modelViewOf(pid, mid);
      if (!mv) return { ok: false, message: `未知模型 ${pid}/${mid}` };
      ctx.db.realModel.update({ provider: pid, model: mid, hidden: exposed ? 0 : 1 });
      ctx.syncRegistry();
      return {
        ok: true,
        message: exposed ? `已暴露 ${pid}/${mid}` : `已隐藏 ${pid}/${mid}`,
        changed: [`${pid}/${mid}`]
      };
    },
    async sensenovaLogin(account, username, password, fetchKey = true) {
      if (typeof fetchKey !== "boolean") fetchKey = true;
      const user = snUserOf(username != null && username !== "" ? username : String(account ?? ""));
      return snLogin(String(account ?? ""), user, String(password ?? ""), fetchKey);
    },
    async sensenovaSavePassword(account, username, password) {
      const user = snUserOf(String(username || account || ""));
      if (!user) return { ok: false, message: "账号与密码均为必填(密码不回显)" };
      await ctx.vault.put({ provider: "sensenova", username: user });
      await snStorePassword(user, String(password ?? ""));
      await deps.syncSensenovaPool(ctx.vault);
      const hasPassword = Boolean(password);
      const message = hasPassword ? "已保存密码(未登录)" : "空密码不写入,未清除已有密码";
      snLedger.lastRunAtMs = Date.now();
      snLedger.result = message;
      return {
        ok: true,
        account: `sensenova/${user}`,
        username: user,
        has_password: hasPassword,
        message
      };
    },
    async sensenovaRefetchKey(account) {
      const user = snUserOf(String(account ?? ""));
      if (!user) return { ok: false, message: "缺少账号" };
      const cred = await ctx.vault.get("sensenova", user);
      if (!cred?.refreshSecret && !cred?.raw?.console_refresh_token) {
        const msg = "该账号既没有保存密码也没有续期凭证,无法免登录重抓 —— 请点「登录并抓 key」输一次密码(之后会存下来,以后重抓与刷新都不再需要手输)";
        snLedger.lastRunAtMs = Date.now();
        snLedger.lastOk = false;
        snLedger.lastError = msg;
        snLedger.result = msg;
        return {
          ok: false,
          account: `sensenova/${user}`,
          has_key: cred?.secret != null,
          key_updated: false,
          message: msg
        };
      }
      const r = await snRepairKey(user, "手动重抓");
      snLedger.lastRunAtMs = Date.now();
      snLedger.lastOk = r.ok;
      snLedger.lastError = r.ok ? null : r.message;
      snLedger.result = r.message;
      return {
        ok: r.ok,
        account: `sensenova/${user}`,
        has_key: true,
        key_updated: r.created || r.dropped.length > 0,
        message: r.message
      };
    },
    async sensenovaAddAccount(username, password, apiKey) {
      const user = snUserOf(String(username ?? ""));
      if (!user) return { ok: false, message: "缺少用户名" };
      const key = String(apiKey ?? "").trim();
      const pwd = String(password ?? "");
      await ctx.vault.put({
        provider: "sensenova",
        username: user,
        ...key ? { secret: key } : {}
      });
      await snStorePassword(user, pwd);
      await deps.syncSensenovaPool(ctx.vault);
      const saved = {
        ok: true,
        created: true,
        account: `sensenova/${user}`,
        username: user,
        has_password: Boolean(pwd),
        has_key: Boolean(key),
        key_hint: key ? fpOf(key) : null
      };
      if (pwd) {
        const login = await snLogin(`sensenova/${user}`, user, pwd, true);
        if (login.ok) {
          return { ...saved, ...login, login_ok: true, logged_in: true, has_password: true };
        }
        return {
          ...saved,
          login_ok: false,
          logged_in: false,
          message: `账号已保存,但${login.message ?? "登录失败"}`
        };
      }
      return { ...saved, login_ok: false, logged_in: false };
    },
    async sensenovaRemoveAccount(account) {
      const user = snUserOf(String(account ?? ""));
      if (!user) return { ok: false, message: "缺少用户名" };
      const models = ctx.db.realModel.listByProvider("sensenova").length;
      const removed = await ctx.vault.remove("sensenova", user);
      await deps.syncSensenovaPool(ctx.vault);
      const accountsLeft = (await ctx.vault.list("sensenova")).length;
      snQuotaCache.delete(user);
      snQuotaGate.delete(user);
      snQuotaInflight.delete(user);
      const message = removed ? `已删除 sensenova/${user};该渠道 ${models} 个真实模型各少一个端点(端点 = 真实模型 × 凭据行,D5)。` : `sensenova/${user} 没有凭据行,未删除`;
      return {
        ok: removed,
        account: user,
        count: accountsLeft,
        removed_endpoints: models,
        message
      };
    },
    /**
     * 渠道卡折叠态的**缓存读数**(不打上游、不补拉):`snQuotaCache` 里有什么
     * 就返回什么。没拉过的账号不在结果里(卡头显示「未采集」)。
     */
    sensenovaQuotaCached() {
      const out = [];
      for (const [username, entry] of snQuotaCache) out.push({ username, ...entry });
      return out;
    }
  };
  return { snRepairKey, methods };
}

// panel/models.ts
function createModelsDomain(ctx, deps) {
  const logicalGroupsContaining = (provider, model) => {
    const out = [];
    const contains = (members) => members.some((m) => m.provider === provider && m.model === model);
    for (const row of ctx.db.logicalModel.list()) {
      if (contains(parseDbMembers(row.members))) out.push(row.name);
    }
    return [...new Set(out)];
  };
  const exposureOverlay = /* @__PURE__ */ new Map();
  const fetchUpstreamCatalog = async (pid) => {
    if (CH_CATALOG_PROVIDERS.has(pid)) {
      const accounts = await deps.accountsWithKey(pid);
      const username = accounts.find((a) => a.hasKey)?.username ?? accounts[0]?.username;
      if (!username) throw new Error(`${pid} 下没有账号,没有密钥可以拿去拉上游目录`);
      const result = await deps.chAwaitCatalog(pid, username, true);
      return result.entries;
    }
    const row = ctx.db.provider.get(pid);
    const base = String(row?.base_url ?? "").trim();
    if (!base) {
      throw new Error("这家没有 base_url:请求由本机私有协议适配器转成私有协议,没有统一的 /models 接口可探测");
    }
    let u;
    try {
      u = new URL(base);
    } catch {
      throw new Error(`base_url 不是可探测的 http(s) 地址:${base}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`base_url 不是可探测的 http(s) 地址:${base}`);
    }
    const creds = await ctx.vault.list(pid);
    let bearerKey = null;
    for (const c of creds) {
      const secret = await ctx.vault.secret(pid, c.username);
      if (typeof secret === "string" && secret !== "") {
        bearerKey = secret;
        break;
      }
    }
    const headers = { Accept: "application/json" };
    if (bearerKey !== null) headers["Authorization"] = `Bearer ${bearerKey}`;
    const root = base.replace(/\/+$/, "");
    let res;
    try {
      res = await fetch(`${root}/models`, { headers, signal: AbortSignal.timeout(1e4) });
    } catch (err) {
      const why = err instanceof Error ? `${err.name}:${err.message}` : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? `(${err.cause.message})` : "";
      throw new Error(`打不到上游(10 秒后放弃):${why}${cause}`);
    }
    if (res.status >= 400) throw new Error(`上游返回 HTTP ${res.status}`);
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new Error("上游返回的不是 JSON,无法解析模型清单");
    }
    const parsed = parseModelEntries(payload);
    if (!parsed) throw new Error("上游回了 JSON,但认不出模型列表(期望 data / models 数组)");
    return parsed;
  };
  const modelDayStats = (provider, model) => {
    const zero = {
      requests: 0,
      errors: 0,
      total: 0,
      prompt: 0,
      completion: 0,
      cached: 0,
      rate: null,
      avg_ttft: null,
      avg_tps: null,
      latency_day: null
    };
    const days = [...new Set(ctx.db.statsDaily.range("0000-01-01", "9999-12-31").filter((r) => r.provider === provider && r.model === model).map((r) => r.day))].sort().reverse();
    let rows = [];
    let pickedDay = null;
    for (const day of days) {
      const same = ctx.db.statsDaily.range(day, day).filter((r) => r.provider === provider && r.model === model);
      const ok = same.some(
        (r) => r.latency_sum_ms > 0 && r.ttft_sum_ms > 0 && r.ttft_requests > 0
      );
      if (ok) {
        rows = same;
        pickedDay = day;
        break;
      }
    }
    if (pickedDay === null || rows.length === 0) return zero;
    let requests = 0, errors = 0, prompt = 0, completion = 0, cached = 0;
    let latencySum = 0, ttftSum = 0, ttftReq = 0;
    for (const r of rows) {
      requests += r.requests;
      errors += r.fails;
      prompt += r.prompt_tokens;
      completion += r.completion_tokens;
      cached += r.cached_tokens;
      latencySum += r.latency_sum_ms;
      ttftSum += r.ttft_sum_ms;
      ttftReq += r.ttft_requests;
    }
    const genMs = latencySum - ttftSum;
    return {
      requests,
      errors,
      // ⚠️ total = prompt + completion(cached 是 prompt 子集,不双计)
      total: prompt + completion,
      prompt,
      completion,
      cached,
      rate: prompt > 0 ? Math.round(cached / prompt * 1e4) / 1e4 : null,
      avg_ttft: ttftReq > 0 ? round1(ttftSum / ttftReq) : null,
      avg_tps: completion > 0 && genMs > 0 ? round1(completion / (genMs / 1e3)) : null,
      latency_day: pickedDay
    };
  };
  const methods = {
    async getLogicalModels() {
      const rows = ctx.db.logicalModel.list();
      const names = rows.map((r) => r.name);
      const out = [];
      for (const name of [...names].sort()) {
        const row = ctx.db.logicalModel.get(name);
        const strategy = normalizeStrategy(row?.strategy).strategy;
        const members = parseDbMembers(row?.members ?? null);
        const memberEfforts = members.map(
          (m) => deps.realModelMap(m.provider).get(`${m.provider}/${m.model}`)?.supportedReasoningEfforts ?? null
        );
        const reasoningEfforts = (() => {
          if (memberEfforts.length === 0) return null;
          const known = memberEfforts.filter((e) => e !== null);
          if (known.some((e) => e.length === 0)) return [];
          if (known.length === 0) return null;
          let acc = [...known[0]];
          for (const e of known.slice(1)) {
            const set = new Set(e.map((s) => s.toLowerCase()));
            acc = acc.filter((s) => set.has(s.toLowerCase()));
          }
          return acc;
        })();
        const deployments = [];
        members.forEach((member, order) => {
          const mv = deps.modelViewOf(member.provider, member.model);
          const accounts = deps.accountsWithKeySync(member.provider).map((a) => {
            const depId = endpointIdOf(member.provider, member.model, a.username);
            const rec = ctx.health.get(depId);
            const inCd = rec.cooldownUntil > 0 && rec.cooldownUntil > wallNow();
            return {
              account_id: a.credentialRef,
              username: a.username,
              account_fp: a.keyFp,
              in_cooldown: inCd,
              cooldown_remaining_s: inCd ? Math.max(0, Math.round((rec.cooldownUntil - wallNow()) * 10) / 10) : 0,
              quota_remaining: null
              // 逻辑模型页不查额度(同位置给 null)
            };
          });
          const first = accounts[0];
          const hidden = mv?.hidden ?? false;
          deployments.push({
            provider: member.provider,
            model: member.model,
            real_model: member.model,
            real_model_id: `${member.provider}/${member.model}`,
            account_key: first?.username ?? null,
            account_fp: first?.account_fp ?? null,
            order,
            hidden,
            listed: !hidden,
            exposed: !hidden,
            exposed_note: hidden ? "hidden(仅不纳入模型列表,仍可调用)" : null,
            // ⚠️ 这里给**真实值**(恒 false 的话只是占位):逻辑模型页的
            // 「全视觉 / 有视觉」徽章全靠它,恒 false 会让徽章永远不出现。
            supports_vision: mv?.supportsVision ?? null,
            supported_reasoning_efforts: mv?.supportedReasoningEfforts ?? null,
            reasoning_allows_off: mv?.reasoningAllowsOff ?? null,
            endpoint_count: accounts.length,
            accounts,
            blackout: null,
            blackout_managed_by: "scheduler"
          });
        });
        out.push({
          model: name,
          // 显示名(用户 m44638):空串归一成 null,让 UI 与 /v1/models 回退到 model。
          display_name: (row?.display_name ?? "").trim() || null,
          deployments,
          count: deployments.length,
          routing_strategy: strategy,
          strategy_label: STRATEGY_LABELS[strategy] ?? strategy,
          order_respected: ORDER_STRATEGIES.has(strategy),
          members: members.map((m) => `${m.provider}/${m.model}`),
          // D14:`hidden` 列已删 → 「保留抽象模型」没有数据来源,恒 false。
          reserved: false,
          // v3 残留字段,恒 `[]`(同一口径;以前错填成了成员清单,
          // 两个字段语义不同,页面若按 fallback 渲染会重复显示一遍成员)。
          fallback_chain: [],
          entry_alias: null,
          hidden: false,
          reasoning_efforts: reasoningEfforts,
          strategy_groups: [{
            group_name: name,
            model_name: name,
            routing_strategy: strategy,
            real_models: deployments.map((d) => ({
              real_model: d.real_model_id,
              account_count: d.endpoint_count,
              orders: [d.order],
              supports_vision: d.supports_vision
            }))
          }]
        });
      }
      return out;
    },
    /**
     * 写逻辑模型 —— 对齐既有的写入语义。
     *
     * ⚠️ **逐档校验「已登记」**:逐成员查
     * `real_model`,未登记直接 400。不校验的话可以写进一条指向空气的档位 ——
     * 调度时 `endpointChain` 展开出 0 个端点,整条链静默少一档,而页面上
     * 看起来「配好了」。
     *
     * ⚠️ **允许空成员**(`members: []`):明确允许先建壳再逐档添加。
     * 以前这里直接拒「至少需要一个成员」,于是「新建 → 保存 → 再加档」这条
     * 正常使用路径走不通。
     */
    async writeLogicalModel(input) {
      const name = String(input?.model_name ?? "").trim();
      if (!name) return { ok: false, message: "逻辑模型名不能为空" };
      const members = membersFromInput(input ?? {});
      const dangling = [];
      for (const m of members) {
        if (!deps.modelViewOf(m.provider, m.model)) dangling.push(`${m.provider}/${m.model}`);
      }
      if (dangling.length > 0) {
        return {
          ok: false,
          message: `以下档位没有登记(先在对应渠道页勾选登记,再回来加档):${dangling.join("、")}`
        };
      }
      const existing = ctx.db.logicalModel.get(name);
      const strategyRaw = input?.routing_strategy ?? existing?.strategy ?? "random";
      const { strategy } = normalizeStrategy(strategyRaw);
      const membersJson = JSON.stringify(members);
      const dnGiven = input && Object.prototype.hasOwnProperty.call(input, "display_name");
      const dn = dnGiven ? String(input.display_name ?? "").trim() || null : void 0;
      if (existing) {
        ctx.db.logicalModel.update({ name, strategy, members: membersJson, display_name: dn });
      } else {
        ctx.db.logicalModel.insert({
          name,
          strategy,
          members: membersJson,
          ...dn ? { display_name: dn } : {}
        });
      }
      try {
        ctx.scheduler.invalidate();
      } catch {
      }
      ctx.syncRegistry();
      return {
        ok: true,
        message: members.length > 0 ? `已保存 ${name}(${members.length} 档,顺序即优先级)` : `已保存 ${name}(还没有档位 —— 保存后可以继续加档)`,
        changed: [name]
      };
    },
    async removeLogicalModel(name) {
      const modelName = String(name ?? "").trim();
      if (!ctx.db.logicalModel.get(modelName)) {
        return { ok: false, message: `逻辑模型 ${modelName} 不存在` };
      }
      ctx.db.logicalModel.delete(modelName);
      ctx.scheduler.invalidate();
      ctx.syncRegistry();
      return { ok: true, message: `已删除逻辑模型 ${modelName}`, changed: [modelName] };
    },
    async getDeployments() {
      const nowS = wallNow();
      const lastDay = deps.lastStatsDay();
      const out = [];
      const models = [...deps.realModelMap().values()].sort(
        (a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0
      );
      for (const mv of models) {
        const modelId = `${mv.provider}/${mv.model}`;
        const logicals = logicalGroupsContaining(mv.provider, mv.model);
        const withKey = await deps.accountsWithKey(mv.provider);
        const usableCount = withKey.filter((a) => a.hasKey).length;
        const stats = modelDayStats(mv.provider, mv.model);
        const endpointCount = ctx.registry.listAccounts(mv.provider).length;
        let inCd = false;
        let remaining = null;
        const keyedAccounts = withKey.filter((a) => a.hasKey);
        if (keyedAccounts.length > 0) {
          let coolingCount = 0;
          for (const account of keyedAccounts) {
            const depId = endpointIdOf(mv.provider, mv.model, account.username);
            const rec = ctx.health.get(depId);
            if (rec.cooldownUntil > 0 && rec.cooldownUntil > nowS) {
              coolingCount += 1;
              const left = Math.max(0, Math.round((rec.cooldownUntil - nowS) * 10) / 10);
              if (remaining === null || left > remaining) remaining = left;
            }
          }
          inCd = coolingCount > 0 && coolingCount === keyedAccounts.length;
        }
        const listed = !mv.hidden;
        const live = endpointCount > 0 && !inCd;
        out.push({
          deployment_id: modelId,
          real_model_id: modelId,
          provider: mv.provider,
          // 只给一个展示标签(provider 名),账号明细在
          // endpoint_count / usable_endpoint_count 里,不在行上摊开。
          account: mv.provider,
          model: mv.model,
          listed,
          hidden: mv.hidden,
          direct_exposed: listed,
          group_exposed: logicals.length > 0,
          exposed: listed || logicals.length > 0,
          direct_live: live,
          group_live: logicals.length > 0 && live,
          live,
          endpoint_count: endpointCount,
          usable_endpoint_count: usableCount,
          logical_models: logicals,
          supports_vision: mv.supportsVision,
          supported_reasoning_efforts: mv.supportedReasoningEfforts,
          supported_reasoning_efforts_raw: mv.supportedReasoningEffortsRaw,
          reasoning_allows_off: mv.reasoningAllowsOff,
          in_cooldown: inCd,
          cooldown_remaining_s: remaining,
          requests: stats.requests,
          errors: stats.errors,
          total_tokens: stats.total,
          prompt_tokens: stats.prompt,
          completion_tokens: stats.completion,
          cached_tokens: stats.cached,
          cache_hit_rate: stats.rate,
          avg_ttft_ms: stats.avg_ttft,
          avg_tps: stats.avg_tps,
          latency_day: stats.latency_day,
          concurrency: mv.concurrency
        });
      }
      out.sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : a.account < b.account ? -1 : 1);
      return {
        deployments: out,
        count: out.length,
        note: "一行 = 一个真实模型(端点 = 真实模型 × 该供应商名下的凭据行,自动推导);勾选只决定是否纳入模型列表,取消后仍可被调用"
      };
    },
    async setDeploymentExposure(deploymentId, kind, exposed, concurrency) {
      const changed = [];
      const modelId = String(deploymentId ?? "").split("@")[0] ?? "";
      const slash = modelId.indexOf("/");
      if (slash > 0) {
        const provider = modelId.slice(0, slash);
        const model = modelId.slice(slash + 1);
        if (ctx.db.realModel.get(provider, model) !== void 0) {
          ctx.db.realModel.update({ provider, model, hidden: exposed ? 0 : 1 });
          changed.push(`${modelId}::hidden=${exposed ? 0 : 1}`);
        }
      }
      const key = `${String(deploymentId ?? "")}::${String(kind ?? "all")}`;
      if (changed.length === 0) {
        exposureOverlay.set(key, Boolean(exposed));
        changed.push(key);
      }
      if (concurrency != null && Number.isFinite(concurrency)) {
        const capped = Math.min(1 << 20, Math.max(1, Math.trunc(concurrency)));
        const slash2 = modelId.indexOf("/");
        if (slash2 > 0) {
          const provider = modelId.slice(0, slash2);
          const model = modelId.slice(slash2 + 1);
          if (ctx.db.realModel.get(provider, model) !== void 0) {
            ctx.db.realModel.update({ provider, model, concurrency: capped });
            changed.push(`${modelId}::concurrency=${capped}`);
          }
        }
      }
      ctx.syncRegistry();
      return {
        ok: true,
        message: changed.length > 0 ? `已保存(${changed.join("; ")})` : "已记录",
        changed
      };
    },
    /**
     * 「思考强度选择器」落库入口 —— 把真实模型的思考能力写进
     * `real_model.supported_reasoning_efforts` / `reasoning_allows_off`。
     *
     * 三态语义与读侧({@link parseReasoningEfforts})一一对应:
     * - `efforts === null` → NULL(未设置:网关不发送该字段,DSH 里不出现档位);
     * - `efforts === []`   → `"[]"`(明说不支持思考,一律不发);
     * - 非空 → **上游原文**档位表(去重、按阶梯升序;`off` 由 `allowsOff` 单独表达)。
     *
     * 写完之后 `/v1/models`、DSH adapter 声明的 `reasoning.efforts`、网关的
     * 钳制算法读的是**同一份表** —— 不存在第二处真源,也不需要重启。
     */
    async setDeploymentReasoning(deploymentId, efforts, allowsOff) {
      const modelId = String(deploymentId ?? "").split("@")[0] ?? "";
      const slash = modelId.indexOf("/");
      if (slash <= 0) return { ok: false, message: `无法解析部署 id:${deploymentId}`, changed: [] };
      const provider = modelId.slice(0, slash);
      const model = modelId.slice(slash + 1);
      if (ctx.db.realModel.get(provider, model) === void 0) {
        return { ok: false, message: `真实模型不存在:${modelId}`, changed: [] };
      }
      const normalized = efforts === null ? null : orderRawLevels((Array.isArray(efforts) ? efforts : []).map((x) => String(x ?? "")));
      const allow = allowsOff === null || allowsOff === void 0 ? null : Boolean(allowsOff);
      ctx.db.realModel.update({
        provider,
        model,
        supported_reasoning_efforts: serializeReasoningEfforts(normalized),
        reasoning_allows_off: allow
      });
      ctx.syncRegistry();
      const allowText = allow === null ? "未设置" : allow ? "可关" : "不可关";
      return {
        ok: true,
        message: normalized === null ? "已清除思考强度(未设置,网关不拦不发)" : normalized.length === 0 ? "已标记为不支持思考(网关一律不发)" : `思考强度已保存:${normalized.join("/")}(${allowText})`,
        changed: [
          `${modelId}::supported_reasoning_efforts=${JSON.stringify(normalized)}`,
          `${modelId}::reasoning_allows_off=${allow === null ? "null" : allow ? "1" : "0"}`
        ]
      };
    },
    /**
     * 「尝试从上游获取」思考强度档位(2026-11-03 用户定案)。
     *
     * 背景:思考档位是**上游的能力事实**,不是用户偏好。手工填「low/high/max」
     * 那套预设既容易填错,又跟不上上游新增的档位 —— 所以 UI 上只留两个选项:
     * 「默认(数据库 null)」= 不管它,交给上游;「尝试从上游获取」= 现在去问上游一句。
     *
     * 落库口径与 {@link setDeploymentReasoning} 完全一致:
     * - 上游给了档位表 → 写规范阶梯子集(`reasoning_allows_off` 单独存);
     * - 上游明说不支持思考 → 写 `"[]"`;
     * - 上游没给 / 目录里没有这个模型 → 写 NULL(网关不拦也不发)。
     *
     * ⚠️ 探测是**只读**动作:绝不因此建 provider 行、绝不改已登记行的其它声明字段
     * (与渠道页「获取可用模型」同一口径)。
     */
    async fetchDeploymentReasoning(deploymentId) {
      const modelId = String(deploymentId ?? "").split("@")[0] ?? "";
      const slash = modelId.indexOf("/");
      if (slash <= 0) return { ok: false, message: `无法解析部署 id:${deploymentId}`, changed: [] };
      const provider = modelId.slice(0, slash);
      const model = modelId.slice(slash + 1);
      if (ctx.db.realModel.get(provider, model) === void 0) {
        return { ok: false, message: `真实模型不存在:${modelId}`, changed: [] };
      }
      let entries;
      try {
        entries = await fetchUpstreamCatalog(provider);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `拉上游目录失败:${why}`, changed: [] };
      }
      const hit = entries.find((e) => e.id === model);
      const efforts = hit?.reasoning_efforts ?? null;
      const allowsOff = hit?.reasoning_allows_off ?? null;
      const stored = efforts === null ? null : efforts.map((x) => String(x ?? "")).filter((x) => x !== "");
      ctx.db.realModel.update({
        provider,
        model,
        supported_reasoning_efforts: serializeReasoningEfforts(stored),
        reasoning_allows_off: allowsOff === null || allowsOff === void 0 ? null : Boolean(allowsOff)
      });
      ctx.syncRegistry();
      const where = hit ? `上游目录里有 ${model}` : `上游目录里没有 ${model}`;
      const allowText = allowsOff === null ? "未设置" : allowsOff ? "可关" : "不可关";
      const message = stored === null ? `${where},但上游没给思考档位 → 已存 NULL(网关不发送该字段)` : stored.length === 0 ? `${where},上游明说不支持思考 → 已存 [](网关一律不发)` : `${where},档位 ${stored.join("/")}(${allowText})→ 已落库`;
      return {
        ok: true,
        message,
        changed: [
          `${modelId}::supported_reasoning_efforts=${JSON.stringify(stored)}`,
          `${modelId}::reasoning_allows_off=${allowsOff === null ? "null" : allowsOff ? "1" : "0"}`
        ]
      };
    },
    async getModelProviders() {
      const provIds = /* @__PURE__ */ new Set();
      for (const p of ctx.registry.listProviders()) {
        if (p.protocol === "openai") provIds.add(p.id);
      }
      for (const row of ctx.db.provider.list()) {
        if (row.protocol === "openai") provIds.add(row.id);
      }
      const out = [];
      for (const id of [...provIds].sort()) {
        const pdef = ctx.registry.getProvider(id);
        const drow = ctx.db.provider.get(id);
        const withKey = await deps.accountsWithKey(id);
        const accountsCount = withKey.length;
        const usableCount = withKey.filter((a) => a.hasKey).length;
        const rmap = realModelMapOf(ctx.registry, ctx.db, id);
        const models = [...rmap.values()].sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0).map((mv) => ({
          id: `${id}/${mv.model}`,
          name: mv.name ?? mv.model,
          exposed: true,
          // 在表里 ⇒ 一律勾着
          hidden: mv.hidden,
          listed: true,
          available: true,
          vision: mv.supportsVision,
          context_window: mv.maxInputTokens,
          max_output: mv.maxOutputTokens,
          rate: null,
          registered: true,
          callable: true,
          origin: "router",
          endpoints: accountsCount,
          usable_endpoints: usableCount,
          default_vision: null,
          default_context: null,
          default_output: null,
          supported_reasoning_efforts: mv.supportedReasoningEfforts,
          reasoning_allows_off: mv.reasoningAllowsOff
        }));
        const registeredIds = models.filter((m) => m.registered).map((m) => m.id).sort();
        const listedIds = models.filter((m) => m.registered && m.hidden === false).map((m) => m.id).sort();
        out.push({
          id,
          base_url: pdef?.baseUrl ?? drow?.base_url ?? null,
          protocol: pdef?.protocol ?? drow?.protocol ?? "openai",
          credential_provider: id,
          // 凭据已入库(credential 表)—— 不再暴露文件路径。
          credential_file: null,
          env_prefix: pdef?.envPrefix ?? drow?.env_prefix ?? `ONE_${id.toUpperCase()}`,
          accounts_count: accountsCount,
          accounts_with_key: usableCount,
          // ⚠️ **不 filter** 掉 null:指纹数组与账号一一对应,过滤后下标错位。
          key_fingerprints: withKey.map((a) => a.keyFp),
          has_plaintext_keys: false,
          models,
          deployed_models: registeredIds,
          exposed: listedIds,
          listed: listedIds,
          is_channel: false
        });
      }
      return out;
    },
    /**
     * 新增/更新一个兼容供应商 —— 对齐既有的 upsert 语义。
     *
     * ⚠️ **`envPrefix` 与 `keys` 必须能写**:以前的签名只有
     * `(id, baseUrl, protocol)`,于是
     * - `env_prefix` 永远落到 `ONE_<ID>` 的默认值(用户改成别的值存不住);
     * - 页面上「密钥」输入框填的新 key **被静默丢弃**(`saveCard` 拿不到通道),
     *   用户以为保存成功了,实际一个字节都没动。
     *
     * 凭据池语义(`keys` 数组即**整池**、按位置
     * 对齐座位;**空串座位不删**(留空 = 不改,见下),只删多出来的尾部座位。
     */
    async upsertModelProvider(id, baseUrl, protocol, envPrefix, keys) {
      const pid = String(id ?? "").trim();
      if (!pid) return { ok: false, message: "provider id 不能为空" };
      const proto = String(protocol ?? "").trim() || "openai";
      if (!KNOWN_PROTOCOLS.includes(proto)) {
        return { ok: false, message: `未知协议 ${proto}` };
      }
      const env = String(envPrefix ?? "").trim();
      const existing = ctx.db.provider.get(pid);
      if (existing) {
        ctx.db.provider.update({
          id: pid,
          base_url: baseUrl,
          protocol: proto,
          ...env === "" ? {} : { env_prefix: env }
        });
      } else {
        ctx.db.provider.insert({
          id: pid,
          base_url: baseUrl,
          protocol: proto,
          ...env === "" ? {} : { env_prefix: env }
        });
      }
      const changed = [pid];
      if (Array.isArray(keys)) {
        const current = await ctx.vault.list(pid);
        for (let i = 0; i < keys.length; i += 1) {
          const value = String(keys[i] ?? "").trim();
          if (value === "") continue;
          const username = current[i]?.username ?? `${pid}-${i}`;
          await ctx.vault.put({ provider: pid, username, secret: value });
          changed.push(`${pid}/${username}`);
        }
        for (let i = keys.length; i < current.length; i += 1) {
          await ctx.vault.remove(pid, current[i].username);
          changed.push(`-${pid}/${current[i].username}`);
        }
        try {
          const map = await ctx.vault.secretsFor(pid);
          for (const p of ctx.registry.listAccounts(pid)) {
            const u = splitRef(p.credentialRef)[1];
            ctx.secretPresence.set(`${pid}/${u}`, map.has(u));
          }
        } catch {
        }
      }
      try {
        ctx.scheduler.invalidate();
      } catch {
      }
      ctx.syncRegistry();
      return {
        ok: true,
        message: `已写入供应商 ${pid}(${existing ? "更新" : "新增"})`,
        provider: pid,
        changed
      };
    },
    /**
     * 删除一个兼容供应商 —— 对齐 `DELETE /providers/{id}` 的**级联**语义。
     *
     * ⚠️ 以前只删 `provider` 表那一行,`real_model` 行和 vault 里的凭据全部残留 ——
     * 而页面上的确认文案写着「其登记的真实模型与凭据会一并移除」。那是**谎话**:
     * 用户删完再进模型总览,模型还在;凭据也还在库里躺着。
     *
     * 级联顺序:
     * 1. 先把该 provider 的每一个真实模型从所有逻辑模型档链里**连锁摘除**(保序);
     * 2. 删 `real_model` 行;
     * 3. 删 vault 里的凭据行;
     * 4. 删 `provider` 行。
     */
    async removeModelProvider(id) {
      const pid = String(id ?? "").trim();
      if (!ctx.db.provider.get(pid) && ctx.registry.getProvider(pid) === null) {
        return { ok: false, message: `provider ${pid} 不存在` };
      }
      const models = ctx.db.realModel.listByProvider(pid);
      let stripped = 0;
      for (const m of models) stripped += deps.stripMemberFromLogicalModels(`${pid}/${m.model}`);
      for (const m of models) ctx.db.realModel.delete(pid, m.model);
      let creds = 0;
      try {
        for (const c of await ctx.vault.list(pid)) {
          if (await ctx.vault.remove(pid, c.username)) creds += 1;
          ctx.secretPresence.delete(`${pid}/${c.username}`);
        }
      } catch {
      }
      if (ctx.db.provider.get(pid)) ctx.db.provider.delete(pid);
      try {
        ctx.scheduler.invalidate();
      } catch {
      }
      ctx.syncRegistry();
      const parts = [`已移除 ${pid}`];
      if (models.length > 0) parts.push(`真实模型 ${models.length} 个`);
      if (stripped > 0) parts.push(`档链连锁摘除 ${stripped} 处`);
      if (creds > 0) parts.push(`凭据 ${creds} 条`);
      if (models.length === 0 && creds === 0) parts.push("(该供应商下没有模型与凭据)");
      return {
        ok: true,
        message: parts.join(","),
        provider: pid,
        changed: [pid]
      };
    },
    async setModelExposure(provider, model, exposed) {
      const pid = String(provider ?? "").trim();
      const mid = String(model ?? "").trim();
      if (!pid || !mid) return { ok: false, message: "provider/model 不能为空" };
      if (!ctx.db.realModel.get(pid, mid)) {
        ctx.db.realModel.set({
          provider: pid,
          model: mid,
          name: null,
          supports_vision: 0,
          max_input_tokens: null,
          max_output_tokens: null,
          hidden: exposed ? 0 : 1,
          // ⚠️ 2026-11-08:并发是**每凭据**的;缺省按供应商查
          // (sensenova=1 / workbuddy=2 / 其余 3),手工登记的新模型别写死 1。
          concurrency: defaultConcurrencyOf(pid),
          // 手工登记的模型没有上游目录可依 → 空 = 不拦(网关不传/照上游的来)。
          supported_reasoning_efforts: null,
          reasoning_allows_off: null
        });
      }
      const mv = deps.modelViewOf(pid, mid);
      if (!mv) return { ok: false, message: `未知模型 ${pid}/${mid}` };
      ctx.db.realModel.update({ provider: pid, model: mid, hidden: exposed ? 0 : 1 });
      ctx.syncRegistry();
      return {
        ok: true,
        message: exposed ? `已暴露 ${pid}/${mid}` : `已隐藏 ${pid}/${mid}`,
        changed: [`${pid}/${mid}`]
      };
    }
  };
  return { methods };
}

// panel/overview.ts
import { existsSync as existsSync3, readdirSync, statSync } from "node:fs";
import { join as join3 } from "node:path";
function createOverviewDomain(ctx, deps) {
  const gatewayReady = () => ctx.gatewayState.error === null && ctx.gatewayState.gateway !== null;
  const gatewayReason = () => ctx.gatewayState.error ?? (ctx.gatewayState.gateway === null ? "网关未启动" : null);
  const isLogicalModelName = (name) => ctx.db.logicalModel.get(name) !== void 0;
  const providers = async () => {
    const configured = ctx.registry.listProviders();
    const knownIds = Array.from(/* @__PURE__ */ new Set([
      ...configured.map((p) => p.id),
      ...getAllConnectors().map((c) => c.vendorId),
      ...KNOWN_PROTOCOLS
    ]));
    const out = [];
    for (const id of knownIds) {
      const pdef = ctx.registry.getProvider(id);
      const accounts = ctx.registry.listAccounts(id);
      const envPrefix = pdef?.envPrefix ?? `ONE_${id.toUpperCase()}`;
      const accountInfos = await Promise.all(
        accounts.map(async (account, index) => {
          const [provider, username] = splitRef(account.credentialRef);
          const summary = await ctx.vault.describe(provider, username);
          return {
            index,
            env_var: `${envPrefix}_KEY${accounts.length > 1 ? `_${index + 1}` : ""}`,
            has_key: summary !== null,
            key_fp: summary?.key ?? null,
            label: account.credentialRef,
            source: "credential 表",
            enabled: ctx.accountOverlay.get(account.credentialRef) ?? account.enabled
          };
        })
      );
      const kind = KIND_BY_PROTOCOL[id] ?? (pdef ? KIND_BY_PROTOCOL[pdef.protocol] ?? "channel" : "channel");
      const isChannel = kind === "channel";
      out.push({
        provider: id,
        env_prefix: envPrefix,
        kind,
        base_url: pdef?.baseUrl ?? null,
        model_count: ctx.registry.listRealModels(id).length,
        exists: pdef !== void 0,
        readable: true,
        error: null,
        count: accounts.length,
        accounts: accountInfos,
        login: isChannel ? {
          logged_in: accountInfos.some((a) => a.has_key),
          reason: accountInfos.some((a) => a.has_key) ? null : "未配置密钥"
        } : null
      });
    }
    return out;
  };
  const recentLimit = () => {
    const raw = ctx.db.setting.get("ui.recent_limit")?.v ?? "50";
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(500, Math.max(1, Math.trunc(n))) : 50;
  };
  const toRecentRequests = (limit) => ctx.ledger.recentRows(limit).map((r) => {
    const tps = computeTps({
      completionTokens: r.completionTokens,
      latencyMs: r.latencyMs,
      ttftMs: r.ttftMs
    });
    return {
      seq: r.lease.seq,
      conv: String(r.lease.convNo),
      real_model_id: r.lease.realModelId,
      logical_model: r.lease.logicalModel || null,
      endpoint_id: r.lease.endpointId,
      stream: r.lease.stream,
      ok: r.ok,
      status: r.status ?? null,
      error: r.error ?? null,
      latency_ms: r.latencyMs ?? null,
      ttft_ms: r.ttftMs ?? null,
      prompt_tokens: r.promptTokens ?? null,
      completion_tokens: r.completionTokens ?? null,
      cached_tokens: r.cachedTokens ?? null,
      tps,
      finished_s_ago: Math.round((monotonic() - r.finishedAt) * 10) / 10
    };
  });
  const usageWindow = (range, sortedDays) => {
    const to = sortedDays.length > 0 ? sortedDays[sortedDays.length - 1] : todayLocal();
    const first = sortedDays.length > 0 ? sortedDays[0] : null;
    switch (range) {
      case "7":
        return { from: clampDay(dayAdd(to, -6), first), to };
      case "30":
        return { from: clampDay(dayAdd(to, -29), first), to };
      case "90":
        return { from: clampDay(dayAdd(to, -89), first), to };
      case "365":
        return { from: clampDay(dayAdd(to, -364), first), to };
      default: {
        if (sortedDays.length === 0) return { from: null, to: null };
        return { from: sortedDays[0], to: sortedDays[sortedDays.length - 1] };
      }
    }
  };
  function validateCooldownOverrides(parsed) {
    const KEY = "scheduler.cooldown_overrides";
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `${KEY} 应为对象 {"<provider>": 分钟},收到 ${Array.isArray(parsed) ? "array" : typeof parsed}`;
    }
    for (const [pid, minutes] of Object.entries(parsed)) {
      if (pid.trim() === "") return `${KEY} 有空 provider 名`;
      if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
        return `${KEY}.${pid} 必须是正数(分钟),收到 ${JSON.stringify(minutes)}`;
      }
    }
    return null;
  }
  function validateWindowProfiles(parsed) {
    const KEY = "scheduler.window_profiles";
    if (!Array.isArray(parsed)) {
      return `${KEY} 应为 JSON 数组,收到 ${parsed === null ? "null" : typeof parsed}`;
    }
    const seen = /* @__PURE__ */ new Set();
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (let i = 0; i < parsed.length; i += 1) {
      const n = i + 1;
      const item = parsed[i];
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return `${KEY} 第 ${n} 项应为对象,收到 ${Array.isArray(item) ? "array" : typeof item}`;
      }
      const p = item;
      const id = p["id"];
      if (typeof id !== "string" || id.trim() === "") {
        return `${KEY} 第 ${n} 项:id 必填且为非空字符串,收到 ${JSON.stringify(id)}`;
      }
      if (seen.has(id.trim())) return `${KEY} 第 ${n} 项:id ${JSON.stringify(id)} 重复`;
      seen.add(id.trim());
      const tag = `${KEY} 第 ${n} 项(id=${JSON.stringify(id)})`;
      const name = p["name"];
      if (name !== void 0 && name !== null && typeof name !== "string") {
        return `${tag}:name 必须是字符串`;
      }
      const segs = p["segments"];
      const rawSegs = segs !== void 0 && segs !== null ? segs : [{ weekdays: p["weekdays"], times: p["times"] }];
      if (!Array.isArray(rawSegs)) {
        return `${tag}:segments 必须是数组`;
      }
      for (let si = 0; si < rawSegs.length; si += 1) {
        const seg = rawSegs[si];
        const stag = `${tag} 第 ${si + 1} 段`;
        if (seg === null || typeof seg !== "object" || Array.isArray(seg)) {
          return `${stag}:必须是对象 {weekdays?, times?}`;
        }
        const s = seg;
        const weekdays = s["weekdays"];
        if (weekdays !== void 0 && weekdays !== null) {
          const ok = Array.isArray(weekdays) && weekdays.length > 0 && weekdays.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7);
          if (!ok) return `${stag}:weekdays 必须是 1..7 的整数列表,收到 ${JSON.stringify(weekdays)}`;
        }
        const times = s["times"];
        if (times !== void 0 && times !== null) {
          const okShape = Array.isArray(times) && times.every((x) => Array.isArray(x) && x.length === 2);
          if (!okShape) {
            return `${stag}:times 必须是 [["HH:MM","HH:MM"], ...] 形状,收到 ${JSON.stringify(times)}`;
          }
          for (const span of times) {
            if (typeof span[0] !== "string" || typeof span[1] !== "string" || !HHMM.test(span[0]) || !HHMM.test(span[1])) {
              return `${stag}:times 里的时段必须是 HH:MM 格式,收到 ${JSON.stringify(span)}`;
            }
            if (span[0] === span[1]) return `${stag}:时段 ${span[0]} 起止相同(空区间,永不命中)`;
          }
        }
      }
    }
    return null;
  }
  function validateRulesArray(parsed, priorityKey) {
    const KEY = priorityKey;
    if (!Array.isArray(parsed)) {
      return `${KEY} 应为 JSON 数组,收到 ${parsed === null ? "null" : typeof parsed}`;
    }
    for (let i = 0; i < parsed.length; i += 1) {
      const n = i + 1;
      const item = parsed[i];
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return `${KEY} 第 ${n} 条应为对象,收到 ${Array.isArray(item) ? "array" : typeof item}`;
      }
      const r = item;
      const provider = r["provider"];
      if (typeof provider !== "string" || provider.trim() === "") {
        return `${KEY} 第 ${n} 条:provider 必填且为非空字符串,收到 ${JSON.stringify(provider)}`;
      }
      const tag = `${KEY} 第 ${n} 条(provider=${JSON.stringify(provider)})`;
      if ("priority" in r && r["priority"] !== void 0 && r["priority"] !== null) {
        return `${tag}:键名即档位,元素里不要写 priority(档位由 scheduler.rules_p<priority> 的键名决定)`;
      }
      const model = r["model"];
      if (model !== void 0 && model !== null && (typeof model !== "string" || model.trim() === "")) {
        return `${tag}:model 必须是非空字符串,收到 ${JSON.stringify(model)}`;
      }
      for (const [field, why] of [
        ["logical", "时段规则一律全局生效,请删除该字段"],
        ["times", "时段已收进 window 嵌套对象:写 window:{times:[...]}"],
        ["weekdays", "星期限定已收进 window 嵌套对象:写 window:{weekdays:[...]}"],
        ["cooldown", "冷却覆盖已拆到独立设置键 scheduler.cooldown_overrides"]
      ]) {
        if (field in r) return `${tag}:${field} 字段已废弃:${why}`;
      }
      const expires = r["expires_at"];
      if (expires !== void 0 && expires !== null && (typeof expires !== "string" || expires.trim() === "")) {
        return `${tag}:expires_at 必须是非空字符串,收到 ${JSON.stringify(expires)}`;
      }
      const win = r["window"];
      if (win !== void 0 && win !== null) {
        if (win === null || typeof win !== "object" || Array.isArray(win)) {
          return `${tag}:window 必须是对象 {weekdays?, times?},收到 ${Array.isArray(win) ? "array" : typeof win}`;
        }
        const w = win;
        const winExtra = Object.keys(w).filter((k) => k !== "times" && k !== "weekdays" && k !== "profile").sort();
        if (winExtra.length > 0) {
          return `${tag}:window 有未知键:${winExtra.join(", ")}(只认 profile / times / weekdays)`;
        }
        const profile = w["profile"];
        if (profile !== void 0 && profile !== null) {
          if (typeof profile !== "string" || profile.trim() === "") {
            return `${tag}:window.profile 必须是非空字符串(引用 scheduler.window_profiles 里的 id),收到 ${JSON.stringify(profile)}`;
          }
          if (w["times"] !== void 0 || w["weekdays"] !== void 0) {
            return `${tag}:window.profile 与内联 times/weekdays 互斥,只留一种`;
          }
          if (typeof model !== "string" || model.trim() === "") {
            return `${tag}:引用时段的规则必须同时有非空 model(时段规则按 provider+model 精确匹配端点),收到 model=${JSON.stringify(model)}`;
          }
        }
        const times = w["times"];
        if (times !== void 0 && times !== null) {
          const okShape = Array.isArray(times) && times.length > 0 && times.every((span) => Array.isArray(span) && span.length === 2);
          if (!okShape) {
            return `${tag}:window.times 必须是 [["HH:MM","HH:MM"], ...] 形状的时段列表,收到 ${JSON.stringify(times)}`;
          }
          if (typeof model !== "string" || model.trim() === "") {
            return `${tag}:带 window.times 的规则必须同时有非空 model(时段规则按 provider+model 精确匹配端点),收到 model=${JSON.stringify(model)}`;
          }
        }
        const weekdays = w["weekdays"];
        if (weekdays !== void 0 && weekdays !== null) {
          const ok = Array.isArray(weekdays) && weekdays.length > 0 && weekdays.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7);
          if (!ok) return `${tag}:window.weekdays 必须是 1..7 的整数列表,收到 ${JSON.stringify(weekdays)}`;
        }
      }
    }
    return null;
  }
  const methods = {
    async getStatus() {
      const uptimeS = (Date.now() - ctx.startedAtMs) / 1e3;
      const nowS = wallNow();
      const dbLogicalRows = ctx.db.logicalModel.list();
      const logicalNames = dbLogicalRows.map((r) => r.name);
      const uniqueLogical = [...new Set(logicalNames)];
      const membersOf = (name) => {
        const row = ctx.db.logicalModel.get(name);
        return row ? parseDbMembers(row.members) : [];
      };
      const rows = [];
      const inLogical = /* @__PURE__ */ new Set();
      for (const name of uniqueLogical) {
        const members = membersOf(name);
        if (members.length === 0) continue;
        const keys = members.map((m) => `${m.provider}/${m.model}`);
        for (const k of keys) inLogical.add(k);
        rows.push(keys);
      }
      for (const mv of deps.realModelMap().values()) {
        const key = `${mv.provider}/${mv.model}`;
        if (inLogical.has(key)) continue;
        if (ctx.registry.listAccounts(mv.provider).length === 0) continue;
        rows.push([key]);
      }
      const coolingOf = (realModelKeys) => {
        for (const rmk of realModelKeys) {
          const slash = rmk.indexOf("/");
          const provider = rmk.slice(0, slash);
          const model = rmk.slice(slash + 1);
          const accounts = ctx.registry.listAccounts(provider);
          if (accounts.length === 0) continue;
          let cooling = 0;
          for (const acc of accounts) {
            const id = endpointIdOf(provider, model, splitRef(acc.credentialRef)[1]);
            const rec = ctx.health.get(id);
            if (rec.cooldownUntil > 0 && rec.cooldownUntil > nowS) cooling += 1;
          }
          if (cooling < accounts.length) return false;
        }
        return realModelKeys.length > 0;
      };
      const cooldownCount = rows.filter(coolingOf).length;
      return {
        ready: gatewayReady(),
        reason: gatewayReason(),
        uptime_s: Math.round(uptimeS * 10) / 10,
        deployments: rows.length,
        healthy_count: rows.length - cooldownCount,
        cooldown_count: cooldownCount,
        metrics_enabled: true,
        metrics_generated_at: null,
        providers: await providers()
      };
    },
    /**
     * 重启网关 —— **只保留给托盘菜单**(唯一入口)。
     *
     * 面板不再提供重启按钮(用户定案:重启网关唯一入口就是托盘菜单),这里刻意
     * 不暴露给 IPC:若仍被调用说明是旧渲染层残留,返回明确错误而不是静默成功。
     */
    async restartGateway() {
      const message = await ctx.restartGateway();
      const ok = ctx.gatewayState.error === null && ctx.gatewayState.gateway !== null;
      return { ok, message };
    },
    async getRuntime() {
      const limit = recentLimit();
      const leases = ctx.ledger.detail();
      const byLogical = /* @__PURE__ */ new Map();
      for (const l of leases) {
        const key = l.logicalModel || "";
        let group = byLogical.get(key);
        if (!group) {
          group = { logical_model: key, in_flight: 0, real_models: [], leases: [] };
          byLogical.set(key, group);
        }
        group.in_flight += 1;
        if (!group.real_models.includes(l.realModelId)) group.real_models.push(l.realModelId);
        group.leases.push({
          seq: l.seq,
          conv: String(l.convNo),
          real_model_id: l.realModelId,
          logical_model: l.logicalModel || null,
          endpoint_id: l.endpointId,
          stream: l.stream,
          elapsed_s: Math.round((monotonic() - l.startedAt) * 10) / 10
        });
      }
      const byLogicalArray = [...byLogical.entries()].map(([key, group]) => ({ ...group, logical_model: key })).sort((a, b) => a.logical_model === "" ? -1 : b.logical_model === "" ? 1 : a.logical_model < b.logical_model ? -1 : 1);
      return {
        ready: gatewayReady(),
        uptime_s: Math.round((Date.now() - ctx.startedAtMs) / 1e3 * 10) / 10,
        in_flight_total: ctx.ledger.total(),
        by_real_model: ctx.ledger.snapshot(),
        by_logical_model: byLogicalArray,
        leases: byLogicalArray.flatMap((g) => g.leases),
        recent: toRecentRequests(limit),
        recent_limit: limit
      };
    },
    async getUsageHistory(range, granularity, group, source = "all") {
      const rng = ["all", "7", "30", "90", "365"].includes(range) ? range : "all";
      const gran = granularity === "month" ? "month" : "day";
      const grp = group === "logical" ? "logical" : "model";
      const src = source === "gateway" || source === "external" ? source : "all";
      const statRow = (row, count, fails, gateway) => ({
        day: row.day,
        provider: row.provider,
        model: row.model,
        logical_model: row.logical_model ?? null,
        count,
        fails,
        prompt: row.prompt_tokens,
        completion: row.completion_tokens,
        cached: row.cached_tokens,
        gateway
      });
      const gatewayRows = src === "external" ? [] : ctx.db.statsDaily.range("0000-01-01", "9999-12-31").map((r) => statRow(r, r.requests, r.fails, true));
      const externalRows = src === "gateway" ? [] : ctx.db.statsExternalDaily.range("0000-01-01", "9999-12-31").map((r) => statRow(r, r.calls, 0, false));
      const allRows = [...gatewayRows, ...externalRows];
      const sortedDays = [...new Set(allRows.map((r) => r.day))].sort();
      const { from, to } = usageWindow(rng, sortedDays);
      const rows = from !== null && to !== null ? allRows.filter((r) => r.day >= from && r.day <= to) : [];
      const tokensOf = (row) => row.prompt + row.completion;
      const skipRow = (row) => grp === "logical" && row.gateway && !(row.logical_model ?? "").trim();
      const seriesKeyOf = (row) => grp === "model" ? `${row.provider}/${row.model}` : String(row.logical_model ?? "").trim() || `${row.provider}/${row.model}`;
      const seriesMeta = (key) => {
        if (grp === "model") {
          const idx2 = key.indexOf("/");
          return {
            name: idx2 >= 0 ? key.slice(idx2 + 1) : key,
            provider: idx2 >= 0 ? key.slice(0, idx2) : null,
            logical_model: null
          };
        }
        if (isLogicalModelName(key)) return { name: key, provider: null, logical_model: key };
        const idx = key.indexOf("/");
        if (idx >= 0) return { name: key, provider: key.slice(0, idx), logical_model: null };
        return { name: key, provider: null, logical_model: key };
      };
      const seriesAgg = /* @__PURE__ */ new Map();
      const provAgg = /* @__PURE__ */ new Map();
      const bucketTotals = /* @__PURE__ */ new Map();
      const activeDays = /* @__PURE__ */ new Set();
      const totals = { tokens: 0, requests: 0, fails: 0, prompt: 0, completion: 0, cached: 0 };
      const addTo = (agg, row, tokens) => {
        agg.tokens += tokens;
        agg.requests += row.count;
        agg.fails += row.fails;
        agg.prompt += row.prompt;
        agg.completion += row.completion;
        agg.cached += row.cached;
      };
      for (const row of rows) {
        if (skipRow(row)) continue;
        const bucketKey = gran === "month" ? row.day.slice(0, 7) : row.day;
        const tokens = tokensOf(row);
        if (tokens > 0 || row.count > 0) activeDays.add(row.day);
        addTo(totals, row, tokens);
        const skey = seriesKeyOf(row);
        let s = seriesAgg.get(skey);
        if (!s) {
          s = { tokens: 0, requests: 0, fails: 0, prompt: 0, completion: 0, cached: 0, buckets: /* @__PURE__ */ new Map() };
          seriesAgg.set(skey, s);
        }
        addTo(s, row, tokens);
        let sb = s.buckets.get(bucketKey);
        if (!sb) {
          sb = { tokens: 0, requests: 0, fails: 0, prompt: 0, completion: 0, cached: 0 };
          s.buckets.set(bucketKey, sb);
        }
        addTo(sb, row, tokens);
        let p = provAgg.get(row.provider);
        if (!p) {
          p = { tokens: 0, requests: 0, fails: 0, prompt: 0, completion: 0, cached: 0, models: /* @__PURE__ */ new Map() };
          provAgg.set(row.provider, p);
        }
        addTo(p, row, tokens);
        const mkey = `${row.provider}/${row.model}`;
        let pm = p.models.get(mkey);
        if (!pm) {
          pm = { tokens: 0, requests: 0, fails: 0, prompt: 0, completion: 0, cached: 0 };
          p.models.set(mkey, pm);
        }
        addTo(pm, row, tokens);
        let bt = bucketTotals.get(bucketKey);
        if (!bt) {
          bt = { tokens: 0, requests: 0, fails: 0, prompt: 0, completion: 0, cached: 0 };
          bucketTotals.set(bucketKey, bt);
        }
        addTo(bt, row, tokens);
      }
      const byTokensThenKey = (a, b) => b[1].tokens - a[1].tokens || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      const sortedSeries = [...seriesAgg.entries()].filter(([, agg]) => agg.tokens > 0).sort(byTokensThenKey);
      const TOP_MODELS = 10;
      const TOP_PROVIDERS = 5;
      const topSeries = sortedSeries.slice(0, TOP_MODELS);
      const displayKeys = new Set(topSeries.map(([k]) => k));
      const OTHER_MODEL_KEY = "\0other";
      const subModels = (seriesKey, aggTokens) => {
        const agg = seriesAgg.get(seriesKey);
        if (!agg) return [];
        const byModel = /* @__PURE__ */ new Map();
        for (const row of rows) {
          if (skipRow(row)) continue;
          if (seriesKeyOf(row) !== seriesKey) continue;
          const mk = `${row.provider}/${row.model}`;
          const cur = byModel.get(mk) ?? { tokens: 0, provider: row.provider };
          cur.tokens += tokensOf(row);
          byModel.set(mk, cur);
        }
        return [...byModel.entries()].map(([mk, v]) => ({
          name: mk.slice(mk.indexOf("/") + 1),
          provider: v.provider,
          tokens: v.tokens,
          percent: pct(v.tokens, aggTokens)
        })).sort((a, b) => b.tokens - a.tokens);
      };
      const series = topSeries.map(([key, agg]) => {
        const meta = seriesMeta(key);
        return {
          key,
          name: meta.name,
          provider: meta.provider,
          logical_model: meta.logical_model,
          tokens: agg.tokens,
          requests: agg.requests,
          cache_hit: agg.cached,
          cache_miss: Math.max(0, agg.prompt - agg.cached),
          percent: pct(agg.tokens, totals.tokens),
          is_other: false,
          models: subModels(key, agg.tokens)
        };
      });
      const foldedSeries = sortedSeries.slice(TOP_MODELS);
      if (foldedSeries.length > 0) {
        const foldedTokens = foldedSeries.reduce((sum, [, agg]) => sum + agg.tokens, 0);
        const foldedRequests = foldedSeries.reduce((sum, [, agg]) => sum + agg.requests, 0);
        series.push({
          key: OTHER_MODEL_KEY,
          name: "其他",
          provider: null,
          logical_model: null,
          tokens: foldedTokens,
          requests: foldedRequests,
          cache_hit: foldedSeries.reduce((sum, [, agg]) => sum + agg.cached, 0),
          cache_miss: foldedSeries.reduce((sum, [, agg]) => sum + Math.max(0, agg.prompt - agg.cached), 0),
          percent: pct(foldedTokens, totals.tokens),
          is_other: true,
          models: [],
          folded: foldedSeries.map(([key, agg]) => {
            const meta = seriesMeta(key);
            return {
              key,
              name: meta.name,
              provider: meta.provider,
              tokens: agg.tokens,
              requests: agg.requests,
              percent: pct(agg.tokens, totals.tokens),
              models: subModels(key, agg.tokens)
            };
          })
        });
        displayKeys.add(OTHER_MODEL_KEY);
      }
      const axis = from !== null && to !== null ? gran === "month" ? monthAxis(from, to) : rangeDays(from, to) : [];
      const buckets = axis.map((bk) => {
        const bt = bucketTotals.get(bk) ?? { tokens: 0, requests: 0, fails: 0, prompt: 0, completion: 0, cached: 0 };
        const bySeries = [...displayKeys].map((key) => ({
          key,
          tokens: key === OTHER_MODEL_KEY ? foldedSeries.reduce(
            (sum, [, agg]) => sum + (agg.buckets.get(bk)?.tokens ?? 0),
            0
          ) : seriesAgg.get(key)?.buckets.get(bk)?.tokens ?? 0
        }));
        const bySum = bySeries.reduce((sum, e) => sum + e.tokens, 0);
        return {
          key: bk,
          tokens: bt.tokens,
          requests: bt.requests,
          fails: bt.fails,
          cache_hit: bt.cached,
          cache_miss: Math.max(0, bt.prompt - bt.cached),
          // `_pct(cached, prompt)` 口径:round 4 位、prompt=0 → null。
          cache_hit_rate: bt.prompt > 0 ? Math.round(bt.cached / bt.prompt * 1e4) / 1e4 : null,
          by_series: bySeries,
          other: Math.max(0, bt.tokens - bySum)
        };
      });
      const providerRanked = [...provAgg.entries()].filter(([, agg]) => agg.tokens > 0).sort(byTokensThenKey);
      const providerModels = (pid, agg) => [...agg.models.entries()].filter(([, m]) => m.tokens > 0).map(([mk, m]) => ({
        name: mk.slice(mk.indexOf("/") + 1),
        provider: pid,
        tokens: m.tokens,
        percent: pct(m.tokens, agg.tokens)
      })).sort((a, b) => b.tokens - a.tokens);
      const providers2 = providerRanked.slice(0, TOP_PROVIDERS).map(([pid, agg]) => ({
        provider: pid,
        tokens: agg.tokens,
        requests: agg.requests,
        percent: pct(agg.tokens, totals.tokens),
        is_other: false,
        models: providerModels(pid, agg)
      }));
      const foldedProviders = providerRanked.slice(TOP_PROVIDERS);
      if (foldedProviders.length > 0) {
        const foldedTokens = foldedProviders.reduce((sum, [, agg]) => sum + agg.tokens, 0);
        const foldedRequests = foldedProviders.reduce((sum, [, agg]) => sum + agg.requests, 0);
        providers2.push({
          provider: "\0pother",
          tokens: foldedTokens,
          requests: foldedRequests,
          percent: pct(foldedTokens, totals.tokens),
          is_other: true,
          models: [],
          folded: foldedProviders.map(([pid, agg]) => ({
            provider: pid,
            key: pid,
            name: pid,
            tokens: agg.tokens,
            requests: agg.requests,
            percent: pct(agg.tokens, totals.tokens),
            models: providerModels(pid, agg)
          }))
        });
      }
      const usageTotals = {
        tokens: totals.tokens,
        requests: totals.requests,
        fails: totals.fails,
        prompt_tokens: totals.prompt,
        completion_tokens: totals.completion,
        cached_tokens: totals.cached,
        cache_hit: totals.cached,
        cache_miss: Math.max(0, totals.prompt - totals.cached),
        cache_hit_rate: totals.prompt > 0 ? Math.round(totals.cached / totals.prompt * 1e4) / 1e4 : null,
        active_days: activeDays.size
      };
      return {
        generated_at: (/* @__PURE__ */ new Date()).toISOString(),
        source: src === "gateway" ? "stats_daily" : src === "external" ? "stats_external_daily" : "stats_daily + stats_external_daily",
        scope: src,
        range: rng,
        granularity: gran,
        group: grp,
        from,
        to,
        last_day: sortedDays.length > 0 ? sortedDays[sortedDays.length - 1] : null,
        axis,
        totals: usageTotals,
        top: series[0] ?? null,
        series,
        buckets,
        providers: providers2
      };
    },
    /**
     * 指标页数据(对齐 `GET /metrics` → `_metrics_page`)。
     *
     * 数据源是 `stats_daily`(按天聚合,D20/D21);TTFT / TPS / 缓存命中率**一律
     * 从原料现算**。
     *
     * ⚠️ v4 的 `stats_daily` **没有凭据维度**,所以「端点」这一层退化成真实
     * 模型本身 —— 页面按 deployment 展示时不会凭空多出一行。
     */
    async getMetrics(days) {
      const span = Math.max(1, Math.min(365, Math.trunc(Number(days ?? 7))));
      const fromDay = dayAdd(todayLocal(), -(span - 1));
      const rows = ctx.db.statsDaily.range(fromDay, todayLocal());
      const perModel = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const mid = `${r.provider}/${r.model}`;
        const cur = perModel.get(mid) ?? {
          requests: 0,
          fails: 0,
          prompt: 0,
          completion: 0,
          cached: 0,
          latencySum: 0,
          ttftSum: 0,
          ttftReq: 0
        };
        cur.requests += r.requests;
        cur.fails += r.fails;
        cur.prompt += r.prompt_tokens;
        cur.completion += r.completion_tokens;
        cur.cached += r.cached_tokens;
        cur.latencySum += r.latency_sum_ms;
        cur.ttftSum += r.ttft_sum_ms;
        cur.ttftReq += r.ttft_requests;
        perModel.set(mid, cur);
      }
      const rowOf = (a) => {
        const avgLatencyMs = a.requests > 0 ? a.latencySum / a.requests : 0;
        const avgTtftMs = a.ttftReq > 0 ? a.ttftSum / a.ttftReq : null;
        const avgTps = computeTps({
          completionTokens: a.completion,
          latencyMs: avgLatencyMs,
          ttftMs: avgTtftMs
        });
        return {
          requests: a.requests,
          fails: a.fails,
          // ⚠️ total = prompt + completion(cached 是 prompt 子集,不双计)
          total: a.prompt + a.completion,
          prompt_tokens: a.prompt,
          completion_tokens: a.completion,
          cached_tokens: a.cached,
          cache_hit: a.cached,
          cache_miss: Math.max(0, a.prompt - a.cached),
          cache_hit_rate: a.prompt > 0 ? Math.round(a.cached / a.prompt * 1e4) / 1e4 : null,
          avg_ttft_ms: a.ttftReq > 0 ? round1(a.ttftSum / a.ttftReq) : null,
          avg_tps: avgTps,
          latency_day: null
        };
      };
      const models = [...perModel.entries()].sort((a, b) => b[1].requests - a[1].requests).map(([mid, agg]) => {
        const row = rowOf(agg);
        return {
          model: mid,
          overall: row,
          buckets: [row],
          deployments: [{
            deployment: mid,
            deployment_id: mid,
            overall: row,
            buckets: [row]
          }]
        };
      });
      return {
        enabled: true,
        generated_at: (/* @__PURE__ */ new Date()).toISOString(),
        uptime_s: Math.round((Date.now() - ctx.startedAtMs) / 1e3),
        source: "stats_daily",
        models
      };
    },
    async getRecentRequests(limit) {
      const n = limit === void 0 ? recentLimit() : Math.min(500, Math.max(1, Math.trunc(Number(limit))));
      return toRecentRequests(n);
    },
    /**
     * 某 DSH 会话**当前请求**的真实模型(输入框内徽标用)。
     *
     * 两段取数,对应两种真实状态:
     *
     * 1. **在途**(`ctx.ledger.detail()` 里租约的 `sessionId` 命中)→ 这就是
     *    「当前这次请求正在用谁」,是账本里的**精确值**,不是推断。租约在
     *    `router.commit` 时建立、`router.finish` 时释放,窗口恰好等于请求时长。
     * 2. **空闲** → 会话亲和 pin(`router.pins`)指向的端点;再拿选中的模型去
     *    `scheduler.chain()` 把 `endpointId` 翻回「哪台真实模型」。pin 只在
     *    **仍在候选链里**时才算数(规则改过之后旧 pin 可能指向已下线的成员)。
     *
     * 数据源一律是**内存账本 / 路由表**,不是 JSONL 明细日志 —— 后者在
     * 「不记录日志」档位下完全不写(用户定案 `off` = 明细全停写),拿它当数据源
     * 会让徽标在用户关掉日志后凭空消失。
     *
     * ⚠️ 都查不到就返回 `null`(新会话没跑过 / 规则全变 / 后端未就绪)→ 界面
     * **什么都不画**。编一个「上次是 X」比如实空着更糟 —— 上一版就是那么做的,
     * 用户看到的因此永远是过去式(2026-11-01 定案改掉)。
     */
    async getSessionCurrentRoute(sessionId, model) {
      const wanted = String(sessionId ?? "");
      if (wanted === "") return null;
      const routeOf = (realModelId, logical, inFlight) => {
        const slash = realModelId.indexOf("/");
        const provider = slash > 0 ? realModelId.slice(0, slash) : "";
        const modelId = slash > 0 ? realModelId.slice(slash + 1) : realModelId;
        let displayName = null;
        try {
          displayName = ctx.db.realModel.get(provider, modelId)?.name ?? null;
        } catch {
          displayName = null;
        }
        let logicalLabel = null;
        if (logical !== null && logical !== "") {
          try {
            logicalLabel = (ctx.db.logicalModel.get(logical)?.display_name ?? "").trim();
          } catch {
            logicalLabel = null;
          }
          logicalLabel = logicalLabel === "" ? logical : logicalLabel;
        }
        const providerLabel = provider === "" ? null : providerDisplayName(provider);
        return {
          logical_model: logical === "" ? null : logical,
          logical_display_name: logicalLabel,
          real_model_id: realModelId,
          provider,
          model: modelId,
          display_name: displayName === "" ? null : displayName,
          provider_display_name: providerLabel,
          is_logical: logical !== null && logical !== "" && logical !== realModelId,
          in_flight: inFlight
        };
      };
      const lease = ctx.ledger.detail().find((row) => row.sessionId === wanted);
      if (lease !== void 0) {
        return routeOf(lease.realModelId, lease.logicalModel, true);
      }
      const selected = String(model ?? "");
      if (selected === "") return null;
      const pinned = ctx.router.pins.get(wanted);
      if (pinned === null) return null;
      let chain;
      try {
        chain = ctx.scheduler.chain(selected);
      } catch {
        return null;
      }
      const hit = chain.find((item) => item.endpoint.endpointId === pinned);
      if (hit === void 0) return null;
      return routeOf(`${hit.endpoint.provider}/${hit.endpoint.model}`, selected, false);
    },
    async getUsageSummary() {
      return methods.getUsageHistory("all", "day", "model");
    },
    async getRequestLogStatus() {
      return methods.getRequestLog();
    },
    async listProviders() {
      return providers();
    },
    async setAccountEnabled(providerId, index, enabled) {
      const accounts = ctx.registry.listAccounts(String(providerId ?? ""));
      const account = accounts[Number(index)];
      if (!account) return;
      ctx.setAccountEnabled(account.credentialRef, Boolean(enabled));
    },
    async getSettings() {
      const sections = {};
      for (const spec of SETTING_FIELDS) {
        let value = ctx.db.setting.get(spec.key)?.v ?? null;
        if (value === null || value === "") {
          const seed = spec.key.startsWith("scheduler.rules_p") ? rulesDefaultsJson(Number(spec.key.slice("scheduler.rules_p".length))) : spec.key === "scheduler.cooldown_overrides" ? cooldownDefaultsJson() : spec.key === "scheduler.window_profiles" ? windowProfilesDefaultsJson() : spec.def;
          ctx.db.setting.set(spec.key, seed);
          value = seed;
        }
        const dot = spec.key.indexOf(".");
        const section = spec.section ?? (dot > 0 ? spec.key.slice(0, dot) : spec.key);
        const group = sections[section] ?? (sections[section] = {});
        group[spec.key] = value;
      }
      const masterKey = ctx.keyProvider.getKey() ?? null;
      const specs = SETTING_FIELDS.map((f) => ({
        key: f.key,
        kind: f.kind,
        label: f.label,
        ...f.min === void 0 ? {} : { min: f.min },
        ...f.max === void 0 ? {} : { max: f.max },
        ...f.section === void 0 ? {} : { section: f.section },
        ...f.options === void 0 ? {} : { options: f.options.map((o) => ({ ...o })) }
      }));
      return {
        sections,
        specs,
        master_key: masterKey,
        master_key_note: masterKey ? null : "未设置 ONE_API_KEY:当前无鉴权"
      };
    },
    /**
     * 写设置 —— **逐项按规格校验**(`_settings_save` 同款):
     * 未知键拒绝、越界拒绝、JSON 形状不合法拒绝。
     *
     * ⚠️ 为什么必须**先验再落库**:所有这些都是「存进去也不生效」的形状 ——
     * 越界的刷新间隔被运行期夹回默认、坏 JSON 被引擎整段回落、`times` 规则
     * 没有 `model` 永远命中不了任何端点。用户改了半天发现「没生效」,就是一个
     * 静默死开关;保存时报错才能让他当场知道。
     */
    async saveSettings(payload) {
      const byKey = new Map(SETTING_FIELDS.map((f) => [f.key, f]));
      const incoming = [];
      for (const section of Object.keys(payload ?? {})) {
        const fields = payload[section] ?? {};
        if (fields === null || typeof fields !== "object") continue;
        for (const fieldKey of Object.keys(fields)) {
          const fullKey = fieldKey.includes(".") ? fieldKey : `${section}.${fieldKey}`;
          const spec = byKey.get(fullKey);
          if (!spec) {
            return { ok: false, message: `未知设置项:${fullKey}` };
          }
          incoming.push({ spec, raw: fields[fieldKey] });
        }
      }
      const writes = [];
      for (const { spec, raw } of incoming) {
        if (spec.kind === "bool") {
          const truthy = raw === true || raw === 1 || raw === "1" || raw === "true" || raw === "True";
          writes.push({ key: spec.key, value: truthy ? "1" : "0" });
          continue;
        }
        if (spec.kind === "int" || spec.kind === "float") {
          const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();
          const num = Number(text);
          if (text === "" || !Number.isFinite(num)) {
            return { ok: false, message: `${spec.key} 必须是数字,收到:${JSON.stringify(raw)}` };
          }
          if (spec.kind === "int") {
            if (!Number.isInteger(num)) {
              return { ok: false, message: `${spec.key} 必须是整数,收到:${text}` };
            }
            if (spec.min !== void 0 && num < spec.min) {
              return { ok: false, message: `${spec.key} 不能小于 ${spec.min},收到:${num}` };
            }
            if (spec.max !== void 0 && num > spec.max) {
              return { ok: false, message: `${spec.key} 不能大于 ${spec.max},收到:${num}` };
            }
            writes.push({ key: spec.key, value: String(num) });
            continue;
          }
          if (spec.min !== void 0 && num < spec.min) {
            return { ok: false, message: `${spec.key} 不能小于 ${spec.min},收到:${num}` };
          }
          if (spec.max !== void 0 && num > spec.max) {
            return { ok: false, message: `${spec.key} 不能大于 ${spec.max},收到:${num}` };
          }
          writes.push({ key: spec.key, value: String(num) });
          continue;
        }
        if (spec.kind === "json") {
          let parsed;
          if (typeof raw === "object" && raw !== null) {
            parsed = raw;
          } else {
            try {
              parsed = JSON.parse(String(raw ?? ""));
            } catch (exc) {
              return {
                ok: false,
                message: `${spec.key} 不是合法 JSON:${exc instanceof Error ? exc.message : String(exc)}`
              };
            }
          }
          if (spec.key.startsWith("scheduler.rules_p")) {
            const bad = validateRulesArray(parsed, spec.key);
            if (bad !== null) return { ok: false, message: bad };
            writes.push({ key: spec.key, value: JSON.stringify(parsed, null, 2) });
            continue;
          }
          if (spec.key === "scheduler.cooldown_overrides") {
            const bad = validateCooldownOverrides(parsed);
            if (bad !== null) return { ok: false, message: bad };
            writes.push({ key: spec.key, value: JSON.stringify(parsed, null, 2) });
            continue;
          }
          if (spec.key === "scheduler.window_profiles") {
            const bad = validateWindowProfiles(parsed);
            if (bad !== null) return { ok: false, message: bad };
            writes.push({ key: spec.key, value: JSON.stringify(parsed, null, 2) });
            continue;
          }
          writes.push({ key: spec.key, value: JSON.stringify(parsed, null, 2) });
          continue;
        }
        writes.push({ key: spec.key, value: String(raw ?? "") });
      }
      for (const w of writes) ctx.db.setting.set(w.key, w.value);
      try {
        ctx.scheduler.invalidate();
      } catch {
      }
      if (writes.some((w) => w.key.startsWith("scheduler.rules") || w.key === "scheduler.window_profiles")) {
        ctx.syncRegistry();
      }
      const changed = writes.map((w) => w.key);
      return {
        ok: true,
        message: changed.length > 0 ? `已保存 ${changed.length} 项设置` : "没有需要保存的设置",
        changed
      };
    },
    async getRequestLog() {
      const rawEnabled = ctx.db.setting.get("request_log.enabled")?.v ?? "1";
      const rawMode = ctx.db.setting.get("request_log.content_mode")?.v;
      const mode = parseContentMode(rawMode, "off");
      const logsDir = join3(ctx.dataDir, "logs");
      let logFiles = [];
      try {
        logFiles = readdirSync(logsDir).filter((f) => /^requests-\d{8}\.jsonl$/.test(f)).sort();
      } catch {
      }
      const recent = logFiles.slice(-30);
      let sizeBytes = 0;
      let written = 0;
      for (const f of recent) {
        try {
          sizeBytes += statSync(join3(logsDir, f)).size;
          written += countJsonlLines(join3(logsDir, f));
        } catch {
        }
      }
      const counters = ctx.db.statsDaily.counters(dayKey(Date.now() - 864e5));
      return {
        enabled: rawEnabled === "1",
        content_mode: mode,
        // 逐字对齐既有的中文说明。
        content_modes: REQUEST_LOG_CONTENT_MODES,
        path: logsDir,
        size_bytes: sizeBytes,
        // `written` = 日志文件里真实的**条目数**(D20:逐请求明细不入库,
        // 库里只有按天聚合的 stats_daily —— 「已写几条」只能从文件数)。
        // `log_files` 一并给出文件名,便于核对「大小与条数对不对得上」。
        counters: { ...counters, written },
        log_files: recent,
        last_error: null
      };
    },
    async setRequestLog(patch) {
      const mode = patch?.content_mode;
      if (mode !== void 0) {
        const text = String(mode);
        if (!["off", "structure", "full", "edges"].includes(text)) {
          return {
            ok: false,
            message: `content_mode 只能是 off/structure/full/edges,收到:'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
          };
        }
        ctx.db.setting.set("request_log.content_mode", text);
      }
      if (patch?.enabled !== void 0) {
        ctx.db.setting.set("request_log.enabled", patch.enabled ? "1" : "0");
      }
      return {
        ok: true,
        enabled: (ctx.db.setting.get("request_log.enabled")?.v ?? "1") === "1",
        content_mode: ctx.db.setting.get("request_log.content_mode")?.v ?? "off",
        message: "已保存请求日志设置"
      };
    },
    /**
     * SenseNova「刷新」—— 页面那个按钮以前只 `load()` 本地库(所以「刷了没反应」)。
     * 现在真干两件事(都是**不烧额度**的元数据/控制台接口):
     *   ① 上游模型目录:`token.sensenova.cn/v1/models`(API key 认证)→ 落 db.real_model;
     *   ② 积分池:清空冷却闸门重拉(JWT 过期且已存密码 → 串行免登录续期再拉)。
     */
    // ── SenseNova 登录与账号管理(/sensenova/login、/refetch-key、/accounts) ──
    // ── 数据目录 ────────────────────────────────────────────────────────────
    async getDataDir() {
      const logsDir = join3(ctx.dataDir, "logs");
      return {
        data_dir: ctx.dataDir,
        credentials_dir: ctx.dataDir,
        logs: existsSync3(logsDir) ? logsDir : "",
        state: "ok"
      };
    }
  };
  return { methods };
}

// panel/qoder.ts
var CACHE_TTL_MS = 5 * 60 * 1e3;
function ensureQoderProviderRow(db, region) {
  const cfg = QODER_REGION_CONFIGS[region];
  const row = db.provider.get(region);
  if (row === void 0) {
    db.provider.insert({
      id: region,
      base_url: cfg.gateway,
      protocol: "qoder",
      env_prefix: `ONE_${region.toUpperCase().replace(/-/g, "_")}`
    });
    return;
  }
  if (row.protocol !== "qoder") {
    db.provider.update({ id: region, protocol: "qoder" });
  }
}
function stripMemberFromLogicalModels(db, provider, model) {
  let removed = 0;
  for (const row of db.logicalModel.list()) {
    const parsed = parseDbMembers(row.members);
    const kept = parsed.filter((m) => !(m.provider === provider && m.model === model));
    if (kept.length === parsed.length) continue;
    db.logicalModel.update({ name: row.name, members: JSON.stringify(kept) });
    removed += parsed.length - kept.length;
  }
  return removed;
}
function healDefaultTierWindow(stored, model) {
  const maxTier = model.maxContextTokens;
  const defaultTier = model.maxInputTokens;
  if (stored === null || stored === void 0) {
    return maxTier ?? defaultTier ?? null;
  }
  if (maxTier !== void 0 && defaultTier !== void 0 && stored === defaultTier && maxTier > defaultTier) {
    return maxTier;
  }
  return stored;
}
function healQoderWindows(db, region, models) {
  const byKey = new Map(models.map((m) => [m.key, m]));
  let healed = 0;
  for (const row of db.realModel.listByProvider(region)) {
    const m = byKey.get(row.model);
    if (m === void 0) continue;
    const next = healDefaultTierWindow(row.max_input_tokens, m);
    if (next === null || next === row.max_input_tokens) continue;
    db.realModel.set({ ...row, max_input_tokens: next });
    healed += 1;
  }
  return healed;
}
function syncSelectedRealModels(db, region, models, wanted) {
  ensureQoderProviderRow(db, region);
  const byKey = new Map(models.map((m) => [m.key, m]));
  let added = 0;
  let kept = 0;
  const skipped = [];
  for (const key of wanted) {
    const m = byKey.get(key);
    if (m === void 0) {
      skipped.push(key);
      continue;
    }
    const row = db.realModel.get(region, key);
    db.realModel.set({
      provider: region,
      model: key,
      name: row?.name ?? m.displayName,
      supports_vision: row?.supports_vision ?? (m.isVl ? 1 : 0),
      // 上下文窗口:库里没有才按上游补,且优先取 `context_config` 的**最大档**
      // (用户 2026-10-31:m37040 显示 200000 而上游 1M 档白扔 —— 取最大档)。
      //
      // ⚠️ 还要**自愈**「旧版默认档残留」:早期同步把上游 `max_input_tokens`
      // (只是 `is_default` 那一档)写进了库,而 `row?.x ?? …` 让这个旧值永远
      // 压住后面两个候选 —— 于是 m37040 那次修复对**已登记行**完全不生效。
      // 实测 qfmodel 卡在 180000(默认档)而上游同模型有 1M 档,连带把 auto
      // 逻辑模型的窗口(取各成员最小值)也压成 180000。
      // 判据刻意收窄:只有「库值**恰好等于**上游默认档、且上游确有更大的档」
      // 才升级 —— 用户手改过的其它值(如 500000)原样保留,不会被误覆盖。
      max_input_tokens: healDefaultTierWindow(row?.max_input_tokens, m),
      max_output_tokens: row?.max_output_tokens ?? m.maxOutputTokens ?? null,
      // ⚠️ **hidden 保留库里的现值,不写死 0**(2026-11-11 用户报
      // 「调整 qoder 模型列表会导致所有模型 hidden 重置」)。
      // 以前写死 `0`,于是每次勾选/取消任何一个模型,sync 就把 qoder 全部行
      // 的 hidden 抹成 0 —— 用户手改的隐藏状态全没了。
      // 修复:已登记行沿用 `row.hidden`;新行才落 0(上游 qoder 目录本身
      // 不提供 hidden 概念,`QoderCatalogModel` 没有该字段)。
      hidden: row?.hidden ?? 0,
      // ⚠️ 2026-11-08:并发是**每凭据**的;新行按供应商缺省(qoder 等 = 3),别写死。
      concurrency: row !== void 0 && row.concurrency > 0 ? row.concurrency : defaultConcurrencyOf(region),
      // 非思考模型写 `"[]"`(网关一律不传 reasoning_effort);
      // 思考模型写 null(不拦,交给上游)。
      supported_reasoning_efforts: row?.supported_reasoning_efforts ?? (m.isReasoning ? null : "[]"),
      reasoning_allows_off: row?.reasoning_allows_off ?? null
    });
    if (row === void 0) added += 1;
    else kept += 1;
  }
  let removed = 0;
  let stripped = 0;
  for (const row of db.realModel.listByProvider(region)) {
    if (wanted.has(row.model)) continue;
    stripped += stripMemberFromLogicalModels(db, region, row.model);
    db.realModel.delete(region, row.model);
    removed += 1;
  }
  return { added, kept, skipped, removed, stripped };
}
function createQoderDomain(ctx) {
  const catalogs = /* @__PURE__ */ new Map();
  const lastCredits = /* @__PURE__ */ new Map();
  const SELECTION_KEY = "qoder.models";
  let selection = loadSelection();
  function loadSelection() {
    const raw = ctx.db.setting.get(SELECTION_KEY)?.v ?? null;
    if (raw === null || raw === "") return { version: 1, selected: {} };
    try {
      const parsed = JSON.parse(raw);
      const selected = {};
      for (const [region, keys] of Object.entries(parsed.selected ?? {})) {
        if (!isQoderRegion(region)) continue;
        if (!Array.isArray(keys)) continue;
        selected[region] = keys.filter((k) => typeof k === "string");
      }
      return { version: 1, selected };
    } catch {
      return { version: 1, selected: {} };
    }
  }
  function saveSelection() {
    try {
      ctx.db.setting.set(SELECTION_KEY, JSON.stringify(selection));
    } catch (err) {
      console.error("[as-one] qoder 模型勾选落库失败:", err);
    }
  }
  function visualSelection(region) {
    const stored = selection.selected[region] ?? [];
    if (stored.length > 0) return new Set(stored);
    const entry = catalogs.get(region);
    if (entry === void 0) return /* @__PURE__ */ new Set();
    return new Set(
      entry.models.filter((m) => m.isDefault || m.enable).map((m) => m.key)
    );
  }
  function applySelectionToDb(region, wanted) {
    const applied = syncSelectedRealModels(
      ctx.db,
      region,
      catalogs.get(region)?.models ?? [],
      wanted
    );
    try {
      ctx.scheduler.invalidate();
    } catch {
    }
    ctx.syncRegistry();
    return applied;
  }
  async function accountsOf(region) {
    const all = await ctx.vault.list(region);
    return all.filter((c) => c.provider === region);
  }
  async function patTargetsOf(region, account) {
    const rows = await accountsOf(region);
    const candidates = account === void 0 || account === "" ? rows : rows.filter((r) => r.username === account);
    const out = [];
    for (const row of candidates) {
      if (isDisabled(row.provider, row.username)) continue;
      const cred = await ctx.vault.get(row.provider, row.username);
      const pat = cred?.secret ?? "";
      if (pat !== "") out.push({ name: row.username, pat });
    }
    return out;
  }
  async function patOf(region, account) {
    const [first] = await patTargetsOf(region, account);
    return first ?? null;
  }
  function isDisabled(provider, username) {
    return ctx.accountOverlay.get(`${provider}/${username}`) === false;
  }
  function errorTextOf(error) {
    if (error instanceof QoderUpstreamError) return error.message;
    if (error instanceof Error) return error.message;
    return String(error);
  }
  async function refreshCatalog(region, force = false) {
    const cached = catalogs.get(region);
    if (!force && cached !== void 0 && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) return cached;
    const pat = await patOf(region);
    if (pat === null) {
      const entry = {
        fetchedAtMs: cached?.fetchedAtMs ?? 0,
        models: cached?.models ?? [],
        error: "没有可用的 PAT 账号（先在账号池里添加一个 pt-… 凭据）"
      };
      catalogs.set(region, entry);
      return entry;
    }
    try {
      const models = await getQoderClient(region).fetchModels(pat.pat);
      healQoderWindows(ctx.db, region, models);
      const entry = { fetchedAtMs: Date.now(), models, error: null };
      catalogs.set(region, entry);
      return entry;
    } catch (error) {
      const entry = {
        fetchedAtMs: cached?.fetchedAtMs ?? 0,
        models: cached?.models ?? [],
        error: errorTextOf(error)
      };
      catalogs.set(region, entry);
      return entry;
    }
  }
  function toCatalogRows(region, entry) {
    const selected = new Set(selection.selected[region] ?? []);
    return entry.models.map((m) => ({
      region,
      key: m.key,
      displayName: m.displayName,
      selected: selected.size === 0 ? m.isDefault || m.enable : selected.has(m.key),
      upstreamEnabled: m.enable,
      isDefault: m.isDefault,
      isReasoning: m.isReasoning,
      isVl: m.isVl,
      isFree: m.isFree,
      priceFactor: m.priceFactor ?? null,
      maxInputTokens: m.maxInputTokens ?? null,
      maxContextTokens: m.maxContextTokens ?? null,
      maxOutputTokens: m.maxOutputTokens ?? null
    }));
  }
  return {
    methods: {
      async getQoderAccounts() {
        const clients = QODER_REGIONS.map((region) => getQoderClient(region));
        const accounts = [];
        for (const region of QODER_REGIONS) {
          const rows = await accountsOf(region);
          const catalog = catalogs.get(region);
          const lastError = clients.find((c) => c.region === region)?.recentErrors()[0] ?? null;
          for (const row of rows) {
            const cred = await ctx.vault.get(row.provider, row.username);
            const raw = row.raw ?? {};
            accounts.push({
              region,
              account: row.username,
              enabled: !isDisabled(region, row.username),
              hasPat: (cred?.secret ?? "") !== "",
              patHint: fpOf(cred?.secret),
              uid: typeof raw["uid"] === "string" ? raw["uid"] : null,
              userType: typeof raw["userType"] === "string" ? raw["userType"] : null,
              expiresAt: row.expiresAt ?? null,
              models: catalog?.models.length ?? 0,
              lastError: lastError?.body ?? null
            });
          }
        }
        return { accounts, count: accounts.length };
      },
      async getQoderStatus() {
        const regions = [];
        for (const region of QODER_REGIONS) {
          const config = QODER_REGION_CONFIGS[region];
          const client = getQoderClient(region);
          const rows = await accountsOf(region);
          const catalog = catalogs.get(region);
          const errors = client.recentErrors();
          regions.push({
            region,
            label: config.label,
            gateway: config.gateway,
            openapi: config.openapi,
            accounts: rows.length,
            enabledAccounts: rows.filter((r) => !isDisabled(region, r.username)).length,
            catalogModels: catalog?.models.length ?? 0,
            catalogFetchedAtMs: catalog?.fetchedAtMs ?? null,
            catalogError: catalog?.error ?? null,
            lastError: errors[0] ?? null,
            requiresDeviceRisk: config.requiresDeviceRisk
          });
        }
        return { checkedAtMs: Date.now(), regions };
      },
      async getQoderModels(region) {
        const target = isQoderRegion(region) ? region : void 0;
        const out = [];
        for (const r of target === void 0 ? QODER_REGIONS : [target]) {
          const entry = await refreshCatalog(r);
          out.push(...toCatalogRows(r, entry));
        }
        return out;
      },
      async qoderRefreshCatalog(region) {
        const target = isQoderRegion(region) ? region : void 0;
        const changed = [];
        const messages = [];
        for (const r of target === void 0 ? QODER_REGIONS : [target]) {
          const entry = await refreshCatalog(r, true);
          if (entry.error !== null) {
            messages.push(`${QODER_REGION_CONFIGS[r].label}: ${entry.error}`);
            continue;
          }
          changed.push(`${r}:${entry.models.length}`);
          messages.push(`${QODER_REGION_CONFIGS[r].label}: ${entry.models.length} 个模型`);
        }
        return {
          ok: messages.every((m) => !m.includes("失败")),
          message: messages.join("；") || "目录刷新完成",
          changed
        };
      },
      async qoderSetModelEnabled(region, key, enabled) {
        if (!isQoderRegion(region)) return { ok: false, message: `未知区域: ${region}` };
        const modelKey = String(key ?? "").trim();
        if (modelKey === "") return { ok: false, message: "模型键不能为空" };
        const entry = await refreshCatalog(region);
        const next = visualSelection(region);
        if (enabled) next.add(modelKey);
        else next.delete(modelKey);
        const applied = applySelectionToDb(region, next);
        selection = { version: 1, selected: { ...selection.selected, [region]: [...next] } };
        saveSelection();
        const parts = [enabled ? `已勾选 ${modelKey}` : `已取消 ${modelKey}`];
        if (applied.added > 0) parts.push(`新登记 ${applied.added} 个端点`);
        if (applied.removed > 0) parts.push(`删除 ${applied.removed} 个端点`);
        if (applied.stripped > 0) parts.push(`从逻辑模型档链连锁摘除 ${applied.stripped} 处`);
        if (applied.skipped.length > 0) {
          parts.push(
            `目录里找不到 ${applied.skipped.join(",")},未登记(先点「刷新目录」)`
          );
        }
        if (entry.error !== null) parts.push(`目录刷新失败:${entry.error}`);
        return {
          ok: applied.skipped.length === 0 || !enabled,
          message: parts.join("；"),
          changed: [...next].map((k) => `${region}/${k}`)
        };
      },
      async qoderCredits(region, account) {
        if (!isQoderRegion(region)) return [];
        const rows = await accountsOf(region);
        const targets = account === void 0 || account === "" ? rows.map((r) => r.username) : [account];
        const out = [];
        for (const name of targets) {
          const cred = await ctx.vault.get(region, name);
          const pat = cred?.secret ?? "";
          if (pat === "") {
            out.push(emptyCredits(region, name, "该账号没有 PAT 凭据"));
            continue;
          }
          try {
            const usage = await getQoderClient(region).fetchUsage(pat);
            const view = creditsView(region, name, usage);
            out.push(view);
            lastCredits.set(`${region}/${name}`, view);
            const key = credentialKey(region, name);
            const nowSec = Math.floor(Date.now() / 1e3);
            quotaHub.set(key, {
              fetchedAtMs: nowSec * 1e3,
              snapshot: {
                credentialKey: key,
                remaining: view.addOnQuota?.remaining ?? null,
                limit: view.addOnQuota?.total ?? null,
                // UI 估算的签到积分到期；null/0 = 未知，table() 不写 expires_at。
                expires_at: view.expiresAt && view.expiresAt > 0 ? view.expiresAt : null,
                fetched_at: nowSec,
                packs: [],
                error: view.error
              }
            });
            try {
              ctx.scheduler.invalidate();
            } catch {
            }
          } catch (error) {
            out.push(emptyCredits(region, name, errorTextOf(error)));
          }
        }
        return out;
      },
      /** 折叠态卡头用的**缓存读数**(不打上游):`region/account` → 最近一次 credits。 */
      qoderCreditsCached() {
        return [...lastCredits.values()];
      },
      /**
       * 签到 —— **整个账号池逐个签**,不是只签第一个。
       *
       * 页面把「签到」并进了子标题行的刷新按钮(一次点击要对全部账号生效),
       * 而这里以前走的是 `patOf`(只返回第一个可用账号):双账号时第二个永远
       * 签不到,第一个若昨天已领,页面还会显示「签到 0/1」—— 看起来就是
       * 「插件不能签到」。
       */
      async qoderCheckin(region, account) {
        if (!isQoderRegion(region)) return [];
        const targets = await patTargetsOf(region, account);
        if (targets.length === 0) {
          return [
            {
              region,
              account: account ?? "",
              status: "unavailable",
              amount: null,
              validityDays: null,
              nextRefreshAtMs: null,
              message: "没有可用的 PAT 账号"
            }
          ];
        }
        return checkinEach(region, targets, (pat) => getQoderClient(region).claimDailyCredits(pat)).then(
          (views) => {
            if (views.some((v) => v.status === "claimed" || v.status === "already-claimed")) {
              invalidateCheckinCache("qoder");
            }
            return views;
          }
        );
      },
      async qoderCampaigns(region, account) {
        if (!isQoderRegion(region)) return { campaigns: [], error: `未知区域: ${region}` };
        const pat = await patOf(region, account);
        if (pat === null) return { campaigns: [], error: "没有可用的 PAT 账号" };
        try {
          const campaigns = await getQoderClient(region).fetchCampaigns(pat.pat);
          return { campaigns, error: null };
        } catch (error) {
          return { campaigns: [], error: errorTextOf(error) };
        }
      },
      async qoderAddAccount(region, name, pat) {
        if (!isQoderRegion(region)) return { ok: false, message: `未知区域: ${region}（只支持 qoder / qoder-global）` };
        const username = String(name ?? "").trim();
        const token = String(pat ?? "").trim();
        if (username === "") return { ok: false, message: "账号名不能为空" };
        if (token === "") return { ok: false, message: "PAT 不能为空（应以 pt- 开头）" };
        ensureQoderProviderRow(ctx.db, region);
        await ctx.vault.put({ provider: region, username, secret: token, raw: { kind: "pat" } });
        ctx.setAccountEnabled(`${region}/${username}`, true);
        try {
          const models = await getQoderClient(region).fetchModels(token);
          catalogs.set(region, { fetchedAtMs: Date.now(), models, error: null });
          return { ok: true, message: `已添加 ${username}（上游返回 ${models.length} 个模型）`, provider: region, username };
        } catch (error) {
          return {
            ok: false,
            message: `凭据已保存，但上游校验失败: ${errorTextOf(error)}`,
            provider: region,
            username
          };
        }
      },
      async qoderRemoveAccount(region, name) {
        if (!isQoderRegion(region)) return { ok: false, message: `未知区域: ${region}` };
        const removed = await ctx.vault.remove(region, name);
        ctx.accountOverlay.delete(`${region}/${name}`);
        return {
          ok: removed,
          message: removed ? `已删除 ${name}` : `没有找到账号 ${name}`,
          provider: region,
          username: name
        };
      },
      async qoderSetAccountEnabled(region, name, enabled) {
        if (!isQoderRegion(region)) return { ok: false, message: `未知区域: ${region}` };
        ctx.setAccountEnabled(`${region}/${name}`, Boolean(enabled));
        return { ok: true, message: `${name} 已${enabled ? "启用" : "停用"}`, provider: region, username: name };
      },
      /**
       * 连通性探针:真的发一次最小 chat（8 token 上限的流式请求），只取首帧。
       *
       * 为什么不复用 `getToken`:Qoder 的签名与报文体绑定，只有真发一次 body 才能
       * 证明「PAT → jobToken → cosy 会话 → 编码 → 签名 → SSE」整条链路通。这里
       * 只读首帧、立刻中止，成本与一次健康检查相当。
       */
      async qoderProbeChat(region, name) {
        if (!isQoderRegion(region)) return { ok: false, message: `未知区域: ${region}` };
        const pat = await patOf(region, name);
        if (pat === null) return { ok: false, message: "没有可用的 PAT 账号" };
        const controller = new AbortController();
        try {
          let head = "";
          for await (const chunk of getQoderClient(region).chatStream(
            pat.pat,
            {
              modelKey: (selection.selected[region] ?? [])[0] ?? "lite",
              messages: [{ role: "user", content: "ping" }]
            },
            controller.signal
          )) {
            head = chunk.content !== "" ? chunk.content : chunk.reasoning;
            break;
          }
          return { ok: true, message: `链路正常${head === "" ? "" : `（首帧: ${head.slice(0, 40)}）`}`, provider: region, username: pat.name };
        } catch (error) {
          return { ok: false, message: `链路探测失败: ${errorTextOf(error)}`, provider: region, username: pat.name };
        } finally {
          controller.abort();
        }
      },
      async qoderRecentErrors() {
        const errors = [];
        for (const region of QODER_REGIONS) errors.push(...getQoderClient(region).recentErrors());
        errors.sort((a, b) => b.atMs - a.atMs);
        return { errors: errors.slice(0, 8) };
      }
    }
  };
}
var QODER_DAILY_CHECKIN_CREDITS = 100;
var QODER_CHECKIN_VALIDITY_DAYS = 30;
function estimatedAddOnExpirySec(remaining, nowMs = Date.now()) {
  if (remaining === null || remaining === void 0 || !(remaining > 0)) return null;
  const n = Math.max(1, Math.ceil(remaining / QODER_DAILY_CHECKIN_CREDITS));
  const daysLeft = Math.max(1, QODER_CHECKIN_VALIDITY_DAYS + 1 - n);
  return Math.floor(nowMs / 1e3) + daysLeft * 86400;
}
function viewExpiresAt(usage, nowMs = Date.now()) {
  return estimatedAddOnExpirySec(usage.addOnQuota?.remaining ?? null, nowMs);
}
function creditsView(region, account, usage, nowMs = Date.now()) {
  return {
    region,
    account,
    ok: true,
    error: null,
    userType: usage.userType ?? null,
    expiresAt: viewExpiresAt(usage, nowMs),
    userQuota: usage.userQuota ? {
      total: usage.userQuota.total ?? null,
      used: usage.userQuota.used ?? null,
      remaining: usage.userQuota.remaining ?? null,
      percentage: usage.userQuota.percentage ?? null
    } : null,
    addOnQuota: usage.addOnQuota ? {
      total: usage.addOnQuota.total ?? null,
      used: usage.addOnQuota.used ?? null,
      remaining: usage.addOnQuota.remaining ?? null,
      percentage: usage.addOnQuota.percentage ?? null,
      detailUrl: usage.addOnQuota.detailUrl ?? null
    } : null,
    orgResourcePackage: usage.orgResourcePackage ? {
      used: usage.orgResourcePackage.used ?? null,
      cap: usage.orgResourcePackage.cap ?? null,
      remaining: usage.orgResourcePackage.remaining ?? null,
      percentage: usage.orgResourcePackage.percentage ?? null,
      available: usage.orgResourcePackage.available
    } : null,
    isQuotaExceeded: usage.isQuotaExceeded
  };
}
async function checkinEach(region, targets, claim) {
  const out = [];
  for (const t of targets) {
    try {
      const outcome = await claim(t.pat);
      if (outcome.status === "claimed") {
        out.push({
          region,
          account: t.name,
          status: "claimed",
          amount: outcome.amount ?? null,
          validityDays: outcome.validityDays ?? null,
          nextRefreshAtMs: outcome.nextRefreshAtMs ?? null,
          message: `已领取${outcome.amount === void 0 ? "" : ` ${outcome.amount} Credits`}`
        });
      } else if (outcome.status === "already-claimed") {
        out.push({
          region,
          account: t.name,
          status: "already-claimed",
          amount: null,
          validityDays: null,
          nextRefreshAtMs: outcome.nextRefreshAtMs ?? null,
          message: "今日已领取"
        });
      } else {
        out.push({
          region,
          account: t.name,
          status: "unavailable",
          amount: null,
          validityDays: null,
          nextRefreshAtMs: null,
          // 上游"没有下发活动"是账号资格/窗口问题，不是本次点击失败。
          // 文案必须说清，否则用户会理解成"点了签到没反应"。
          message: outcome.message === "上游今日没有下发可领取的签到活动" ? "该账号当前没有签到活动（上游未下发，非设备限制）" : outcome.message
        });
      }
    } catch (error) {
      out.push({
        region,
        account: t.name,
        status: "unavailable",
        amount: null,
        validityDays: null,
        nextRefreshAtMs: null,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return out;
}
function emptyCredits(region, account, error) {
  return {
    region,
    account,
    ok: false,
    error,
    userType: null,
    expiresAt: null,
    userQuota: null,
    addOnQuota: null,
    orgResourcePackage: null,
    isQuotaExceeded: false
  };
}

// panel/panel.ts
function createPanel(ctx, deps) {
  const getSetting = (key, fallback) => {
    const v = ctx.db.setting.get(key)?.v;
    return v === null || v === void 0 || v === "" ? fallback : v;
  };
  const lastStatsDay = () => {
    const row = ctx.db.raw.prepare("SELECT MAX(day) AS m FROM stats_daily").get();
    return row?.m ?? null;
  };
  const enabledAccounts = (pid) => ctx.registry.listAccounts(pid).filter((a) => ctx.accountOverlay.get(a.credentialRef) ?? a.enabled).map((a) => ({ username: splitRef(a.credentialRef)[1], credentialRef: a.credentialRef }));
  const realModelMap = (pid) => realModelMapOf(ctx.registry, ctx.db, pid);
  const modelViewOf = (provider, model) => realModelMap(provider).get(`${provider}/${model}`);
  const stripMemberFromLogicalModels2 = (targetRealModelId) => {
    let removed = 0;
    const [tp, tm] = [
      targetRealModelId.slice(0, targetRealModelId.indexOf("/")),
      targetRealModelId.slice(targetRealModelId.indexOf("/") + 1)
    ];
    for (const row of ctx.db.logicalModel.list()) {
      const parsed = parseDbMembers(row.members);
      const kept = parsed.filter((m) => !(m.provider === tp && m.model === tm));
      if (kept.length === parsed.length) continue;
      ctx.db.logicalModel.update({
        name: row.name,
        members: JSON.stringify(kept)
      });
      removed += parsed.length - kept.length;
    }
    return removed;
  };
  const chd = createChannelsDomain(ctx, {
    realModelMap,
    modelViewOf,
    stripMemberFromLogicalModels: stripMemberFromLogicalModels2,
    /**
     * Qoder 额度刷新(2026-11-09 用户报「qoder 不会自动更新」)。
     *
     * 用 getter 延迟解引用:`qd` 在下面才创建(顺序有讲究),直接传引用会是
     * undefined;而调用发生在用户点「刷新」时,那时 `qd` 早就就位了。
     *
     * 行为:逐账号打上游拉积分(`qoderCredits` 内部已有单飞与冷却),
     * 结果写进 qoder 域的 `lastCredits` —— 卡头 `channelOverview` 读的就是它。
     */
    qoderQuotaRefresh: () => async (force) => {
      try {
        const rows = await qd.methods.qoderCredits("qoder");
        let written = 0;
        let failed = 0;
        const errors = {};
        for (const r of rows) {
          if (r.error) {
            failed += 1;
            errors[`qoder/${r.account}`] = r.error;
          } else {
            written += 1;
          }
        }
        const probed = rows.length;
        const message = probed === 0 ? "qoder 下没有账号,跳过额度" : `已刷新 ${written}/${probed} 个账号的积分` + (failed > 0 ? `,${failed} 个失败` : "");
        return { probed, written, message, errors };
      } catch (e) {
        return {
          probed: 0,
          written: 0,
          message: `qoder 额度刷新失败:${errTextOf(e)}`,
          errors: { qoder: errTextOf(e) }
        };
      }
    }
  });
  const snn = createSensenovaDomain(ctx, {
    lastStatsDay,
    realModelMap,
    modelViewOf,
    mergedChannelModels: chd.mergedChannelModels,
    chCatalogCache: chd.chCatalogCache,
    chCatalogGate: chd.chCatalogGate,
    chAwaitCatalog: chd.chAwaitCatalog,
    mergeCatalog: chd.mergeCatalog,
    syncSensenovaPool: deps.syncSensenovaPool
  });
  const od = createOverviewDomain(ctx, { realModelMap });
  const qd = createQoderDomain(ctx);
  const md = createModelsDomain(ctx, {
    realModelMap,
    modelViewOf,
    stripMemberFromLogicalModels: stripMemberFromLogicalModels2,
    lastStatsDay,
    accountsWithKeySync: chd.accountsWithKeySync,
    accountsWithKey: chd.accountsWithKey,
    // 「尝试从上游获取」思考档位:trae/workbuddy/sensenova 的档位只在
    // 各自的目录端点里,得走渠道域这条现成的路。
    chAwaitCatalog: chd.chAwaitCatalog
  });
  const errTextOf = (err) => {
    if (err instanceof Error) return `${err.constructor.name}: ${err.message}`.slice(0, 300);
    return String(err).slice(0, 300);
  };
  const checkinLabelOf = (pid) => providerDisplayName(pid);
  const checkinOverviewImpl = async () => {
    const channels = [];
    const cachedChannel = async (provider, fetcher) => {
      const hit = getCachedCheckin(provider);
      if (hit !== void 0) return hit.value;
      let result;
      try {
        result = await fetcher();
      } catch (e) {
        result = {
          provider,
          label: checkinLabelOf(provider),
          supported: true,
          accounts: 0,
          countExact: false,
          checkedIn: null,
          pending: null,
          dailyCredit: null,
          perAccountCredit: null,
          streak: null,
          reason: null,
          error: errTextOf(e)
        };
      }
      if (result === null) return null;
      setCachedCheckin(provider, result, result.error !== null);
      return result;
    };
    for (const pid of CHECKIN_PROVIDERS) {
      if (pid === "minimax" || pid === "trae" || pid === "codearts") continue;
      const pdef = ctx.registry.getProvider(pid);
      const protocol = pdef?.protocol?.toLowerCase() ?? "";
      if (!pdef || !checkinSupported(protocol)) {
        continue;
      }
      {
        const row = await cachedChannel(pid, async () => {
          const accounts = await chd.methods.getChannelAccounts(pid).catch(() => []);
          if (accounts.length === 0) return null;
          try {
            const st = await chd.methods.checkinStatus(pid);
            const claimed = st.checked_in === true || st.did_checked_in === true ? true : st.checked_in === false || st.did_checked_in === false ? false : null;
            return {
              provider: pid,
              label: checkinLabelOf(pid),
              supported: true,
              accounts: accounts.length,
              countExact: false,
              checkedIn: claimed === null ? null : claimed ? 1 : 0,
              pending: claimed === null ? null : claimed ? 0 : 1,
              dailyCredit: st.daily_credit ?? st.today_credit ?? null,
              perAccountCredit: null,
              streak: st.streak_days ?? null,
              reason: st.reason ?? null,
              error: st.error ?? null
            };
          } catch (e) {
            return {
              provider: pid,
              label: checkinLabelOf(pid),
              supported: true,
              accounts: accounts.length,
              countExact: false,
              checkedIn: null,
              pending: null,
              dailyCredit: null,
              perAccountCredit: null,
              streak: null,
              reason: null,
              error: errTextOf(e)
            };
          }
        });
        if (row !== null) channels.push(row);
      }
    }
    if (ctx.registry.getProvider("codearts")) {
      const row = await cachedChannel("codearts", async () => {
        const accounts = await chd.methods.getChannelAccounts("codearts").catch(() => []);
        if (accounts.length === 0) return null;
        const rows = await ctx.vault.list("codearts");
        let checkedIn = 0;
        let pending = 0;
        let dailyCredit = 0;
        let error = null;
        let reason = null;
        const credits = [];
        for (const acc of accounts) {
          const full = rows.find((r) => r.username === acc.label);
          const raw = full?.raw ?? {};
          const accessKey = typeof raw["accessKey"] === "string" ? raw["accessKey"] : "";
          const secretKey = typeof raw["secretKey"] === "string" ? raw["secretKey"] : "";
          if (accessKey === "" || secretKey === "") {
            error = error ?? `账号 ${acc.label} 缺少 accessKey/secretKey`;
            continue;
          }
          try {
            const res = await codeartsIdeCheckin(
              {
                accessKey,
                secretKey,
                ...typeof raw["securityToken"] === "string" && raw["securityToken"] !== "" ? { securityToken: raw["securityToken"] } : {},
                ...typeof raw["domainId"] === "string" && raw["domainId"] !== "" ? { domainId: raw["domainId"] } : {},
                label: acc.label
              },
              { confirm: false }
            );
            if (res.code === -1 && /没有签到活动/.test(res.message)) {
              reason = reason ?? "该渠道当前没有签到活动";
              continue;
            }
            if (res.code === -1) {
              if (res.credit > 0) {
                credits.push(res.credit);
                dailyCredit += res.credit;
              }
              if (res.already) checkedIn += 1;
              else {
                pending += 1;
                reason = reason ?? `今日可领取${res.credit > 0 ? ` ${res.credit} 积分` : ""}(未签)`;
              }
              continue;
            }
            if (!res.already && res.code !== 0) {
              error = error ?? res.message;
              continue;
            }
            if (res.already) {
              checkedIn += 1;
              reason = reason ?? res.message;
            } else pending += 1;
            if (res.credit > 0) {
              credits.push(res.credit);
              dailyCredit += res.credit;
            }
          } catch (e) {
            error = error ?? errTextOf(e);
          }
        }
        return {
          provider: "codearts",
          label: checkinLabelOf("codearts"),
          supported: true,
          accounts: accounts.length,
          countExact: true,
          checkedIn,
          pending,
          dailyCredit: dailyCredit > 0 ? dailyCredit : null,
          perAccountCredit: credits.length > 1 && new Set(credits).size === 1 ? credits[0] : null,
          streak: null,
          reason,
          error
        };
      });
      if (row !== null) channels.push(row);
    }
    if (ctx.registry.getProvider("trae")) {
      const row = await cachedChannel("trae", async () => {
        const accounts = await chd.methods.getChannelAccounts("trae").catch(() => []);
        if (accounts.length === 0) return null;
        let checkedIn = 0;
        let pending = 0;
        let dailyCredit = 0;
        let error = null;
        let deviceBlocked = 0;
        for (const acc of accounts) {
          const st = await chd.methods.checkinStatus("trae", acc.index).catch((e) => {
            error = errTextOf(e);
            return null;
          });
          if (st === null) continue;
          if (st.error) {
            error = error ?? st.error;
            continue;
          }
          const points = st.daily_credit ?? st.today_credit ?? 0;
          const claimed = st.checked_in === true ? true : st.checked_in === false ? false : null;
          if (claimed === true) {
            checkedIn += 1;
            if (points > 0) dailyCredit += points;
          } else if (claimed === false) {
            pending += 1;
          }
          if (st.checked_in !== true && st.did_checked_in === true) deviceBlocked += 1;
        }
        return {
          provider: "trae",
          label: checkinLabelOf("trae"),
          supported: true,
          accounts: accounts.length,
          // ⚠️ **不显示账号数**(2026-11-11 用户定案)。
          //
          // trae 按**设备**放行每日签到:同一台机器上的多个账号,一天只有第一个
          // 能签上,其余全是 9095「本设备今日已签」。这是上游硬限制,绕不过去。
          //
          // 所以「已签 1/2」这种比例**没有意义** —— 那个「未签的 1」永远签不上,
          // 显示成 2 分之 1 只会让人以为「再点点就好了」。改成只报**结果**:
          // 签上了就是「已签 +100」,没签上就是「未签」,不说分母。
          countExact: false,
          checkedIn,
          pending,
          dailyCredit: dailyCredit > 0 ? dailyCredit : null,
          // 不显示「×N」:同上,账号数不是这行的有效信息。
          perAccountCredit: null,
          streak: null,
          // 设备限制：**不在界面上解释**（2026-11-18 用户定案：签到行只显示
          // 「是否签到 + 积分」，解释性文案一律不写）。签没签上已经由
          // checkedIn 表达，deviceBlocked 只影响计数，不再作为 reason 展示。
          reason: null,
          error
        };
      });
      if (row !== null) channels.push(row);
    }
    if (ctx.registry.getProvider("minimax")) {
      const row = await cachedChannel("minimax", async () => {
        const summaries = await ctx.vault.list("minimax");
        let checkedIn = 0;
        let pending = 0;
        let dailyCredit = 0;
        let error = null;
        const perAccountPoints = [];
        for (const s of summaries) {
          const bound = await minimaxAccountFor(ctx.vault, "minimax", s.username);
          if (bound === null) {
            error = error ?? `账号 ${s.username} 没有可用令牌`;
            continue;
          }
          try {
            const panel2 = await minimaxSigninStatus(bound.account, {
              timeoutMs: MINIMAX_QUOTA_TIMEOUT_MS,
              ...bound.httpOptions
            });
            const points = panelTodayPoints(panel2);
            if (points > 0) {
              dailyCredit += points;
              perAccountPoints.push(points);
            }
            if (panelClaimedToday(panel2)) checkedIn += 1;
            else pending += 1;
          } catch (e) {
            error = errTextOf(e);
          }
        }
        return {
          provider: "minimax",
          label: checkinLabelOf("minimax"),
          supported: true,
          accounts: summaries.length,
          countExact: true,
          checkedIn,
          pending,
          dailyCredit: dailyCredit > 0 ? dailyCredit : null,
          // 多账号且各账号积分完全一致 → 给统一单账号值(前端显示 `400×2`)
          perAccountCredit: perAccountPoints.length > 1 && new Set(perAccountPoints).size === 1 ? perAccountPoints[0] : null,
          streak: null,
          reason: null,
          error
        };
      });
      if (row !== null) channels.push(row);
    }
    return { channels };
  };
  const channelOverviewImpl = async () => {
    const cards = [];
    const accountsOfProvider = async (pid) => {
      const out = [];
      for (const acc of ctx.registry.listAccounts(pid)) {
        const [, username] = splitRef(acc.credentialRef);
        const cached = chd.chQuotaCache.get(`${pid}/${username}`);
        const snap = cached?.snapshot ?? null;
        out.push({
          label: username,
          left: snap?.remaining ?? null,
          expiresAtMs: snap?.expires_at ? snap.expires_at * 1e3 : null,
          // trae/workbuddy 的到期来自上游包里真实到期(minimax 走自己的分支)
          expiresEstimated: false,
          fetchedAtMs: cached?.fetchedAtMs ?? 0
        });
      }
      return out;
    };
    for (const pid of ["trae", "workbuddy"]) {
      const accounts = await accountsOfProvider(pid);
      cards.push({
        provider: pid,
        label: checkinLabelOf(pid),
        signedIn: accounts.length > 0,
        accounts,
        note: null
      });
    }
    {
      const accounts = await accountsOfProvider("minimax");
      cards.push({
        provider: "minimax",
        label: checkinLabelOf("minimax"),
        signedIn: accounts.length > 0,
        accounts,
        note: null
      });
    }
    {
      const accounts = await accountsOfProvider("codearts");
      cards.push({
        provider: "codearts",
        label: checkinLabelOf("codearts"),
        signedIn: accounts.length > 0,
        accounts,
        note: null
      });
    }
    {
      const cached = qd.methods.qoderCreditsCached();
      const accounts = cached.map((c) => ({
        label: c.account,
        left: c.userQuota?.remaining != null || c.addOnQuota?.remaining != null ? (c.userQuota?.remaining ?? 0) + (c.addOnQuota?.remaining ?? 0) : null,
        expiresAtMs: c.expiresAt !== null ? c.expiresAt * 1e3 : null,
        // qoder 的到期是签到积分 FIFO 阶梯**估算**(2026-11-05 定案)
        expiresEstimated: true,
        fetchedAtMs: 0
      }));
      if (accounts.length === 0) {
        for (const acc of ctx.registry.listAccounts("qoder")) {
          const [, username] = splitRef(acc.credentialRef);
          accounts.push({ label: username, left: null, expiresAtMs: null, expiresEstimated: true, fetchedAtMs: 0 });
        }
      }
      cards.push({
        provider: "qoder",
        label: checkinLabelOf("qoder"),
        signedIn: accounts.length > 0,
        accounts,
        note: null
      });
    }
    {
      const cached = new Map(
        snn.methods.sensenovaQuotaCached().map((c) => [c.username, c])
      );
      const names = ctx.registry.listAccounts("sensenova").map((acc) => splitRef(acc.credentialRef)[1]);
      const known = new Set(names);
      const labels = [...names, ...[...cached.keys()].filter((u) => !known.has(u))];
      const accounts = labels.map((username) => {
        const hit = cached.get(username);
        const pool = generalPoolSummary(hit?.quota.pools ?? null);
        return {
          label: username,
          left: pool?.remaining ?? null,
          expiresAtMs: pool?.w5ResetAt ? pool.w5ResetAt * 1e3 : null,
          expiresEstimated: false,
          fetchedAtMs: hit?.fetchedAtMs ?? 0
        };
      });
      cards.push({
        provider: "sensenova",
        label: checkinLabelOf("sensenova"),
        signedIn: accounts.length > 0,
        accounts,
        note: null
      });
    }
    return { cards };
  };
  const panel = {
    // ── 总览 ───────────────────────────────────────────────────────────────
    ...chd.methods,
    ...snn.methods,
    ...md.methods,
    ...od.methods,
    ...qd.methods,
    // ── 签到总览 / 一键全部签到(总览页「每日签到」卡)────────────────────
    checkinOverview: () => checkinOverviewImpl(),
    channelOverview: () => channelOverviewImpl(),
    /**
     * 调度排序诊断（只读）：某个逻辑模型**真实**的成员排序 + 账号行序。
     *
     * 为什么要有它：「路由不对」这类问题从请求日志只能看到「最后选了谁」，
     * 看不到「为什么它排第一」。而 `chQuotaCache` 是模块级缓存，独立脚本
     * 新起进程读到的是空表 —— 必须在**运行中的进程**里看才准。
     */
    getSchedulerPlan: async (logicalName) => {
      await ctx.awaitQuota?.();
      const now = Math.floor(Date.now() / 1e3);
      const plan = ctx.scheduler.planMembers(logicalName, { now, force: true });
      const chain = ctx.scheduler.chain(logicalName);
      return {
        logical_model: logicalName,
        at: now,
        members: plan.map((m) => ({
          provider: m.provider,
          model: m.model,
          expires_at: m.expiresAt,
          expires_at_local: m.expiresAt ? new Date(m.expiresAt * 1e3).toLocaleString("zh-CN") : null,
          reason: m.reason,
          priority: m.priority,
          free: m.free
        })),
        // 账号层：chain 的行序就是实际选账号的顺序
        accounts: chain.map((item, i) => ({
          position: i + 1,
          provider: item.endpoint.provider,
          model: item.endpoint.model,
          username: item.endpoint.username,
          endpoint_id: item.endpoint.endpointId
        })),
        // 调度器读到的额度键（判断「是不是没数据」最直接）
        quota_keys: Object.keys(ctx.scheduler["repo"]?.quotas?.() ?? {}).sort()
      };
    },
    checkinAll: async (confirm) => {
      const confirmOn = confirm === true;
      const parts = [];
      let anyOk = false;
      const failedDetails = [];
      for (const pid of CHECKIN_PROVIDERS) {
        const pdef = ctx.registry.getProvider(pid);
        const protocol = pdef?.protocol?.toLowerCase() ?? "";
        if (!pdef || !checkinSupported(protocol)) continue;
        const accounts = await chd.methods.getChannelAccounts(pid).catch(() => []);
        if (accounts.length === 0) continue;
        try {
          const r = await chd.methods.checkinClaim(pid, confirmOn);
          if (r.ok) {
            anyOk = true;
          } else {
            failedDetails.push(`${checkinLabelOf(pid)}：${r.message ?? "签到失败（上游未给原因）"}`);
          }
          parts.push(`${checkinLabelOf(pid)}:${r.message ?? (r.ok ? "签到完成" : "签到失败")}`);
        } catch (e) {
          failedDetails.push(`${checkinLabelOf(pid)}：${errTextOf(e)}`);
          parts.push(`${checkinLabelOf(pid)}:${errTextOf(e)}`);
        }
      }
      invalidateCheckinCache();
      const channels = (await checkinOverviewImpl()).channels;
      let message;
      if (failedDetails.length > 0) {
        message = failedDetails.join("；");
      } else if (parts.length === 0) {
        message = "没有可签到的渠道(未配置或没有账号)";
      } else {
        message = "";
      }
      return {
        ok: anyOk,
        message,
        channels
      };
    }
    // ── 用量 ───────────────────────────────────────────────────────────────
    // ── 逻辑模型 ───────────────────────────────────────────────────────────
    // ⚠️ 逻辑模型唯一真源 = db.logical_model(用户指示:删除后必须从页面消失、
    // 调度必须跟着 db 走;没有任何 JSON 播种源)。
    // ── 模型总览(部署) ──────────────────────────────────────────────────────
    // ── 供应商(其他供应商) ──────────────────────────────────────────────────
    // ── 设置 ────────────────────────────────────────────────────────────────
    // ── 请求日志 ────────────────────────────────────────────────────────────
    // ── 旧兼容方法 ──────────────────────────────────────────────────────────
  };
  return { panel, snRepairKey: snn.snRepairKey };
}
function dispatchPanel(panel, method, args) {
  const a = args ?? [];
  switch (method) {
    // 总览
    case "getStatus":
      return panel.getStatus();
    case "getRuntime":
      return panel.getRuntime();
    // 网关运维:重启入口只在托盘菜单,面板不暴露(用户定案 m03639)
    // case "restartGateway": return panel.restartGateway();
    // 用量
    case "getUsageHistory":
      return panel.getUsageHistory(
        String(a[0] ?? "all"),
        String(a[1] ?? "day"),
        String(a[2] ?? "model"),
        String(a[3] ?? "all")
      );
    // 逻辑模型
    case "getLogicalModels":
      return panel.getLogicalModels();
    case "writeLogicalModel":
      return panel.writeLogicalModel(a[0] ?? {});
    case "removeLogicalModel":
      return panel.removeLogicalModel(String(a[0] ?? ""));
    // 模型总览(部署)
    case "getDeployments":
      return panel.getDeployments();
    case "setDeploymentExposure":
      return panel.setDeploymentExposure(
        String(a[0] ?? ""),
        String(a[1] ?? "all"),
        Boolean(a[2]),
        a[3] == null ? void 0 : Number(a[3])
      );
    case "setDeploymentReasoning":
      return panel.setDeploymentReasoning(
        String(a[0] ?? ""),
        Array.isArray(a[1]) ? a[1].map((v) => String(v ?? "")) : null,
        a[2] === void 0 || a[2] === null ? null : Boolean(a[2])
      );
    case "fetchDeploymentReasoning":
      return panel.fetchDeploymentReasoning(String(a[0] ?? ""));
    // 供应商(其他供应商)
    case "getModelProviders":
      return panel.getModelProviders();
    case "upsertModelProvider":
      return panel.upsertModelProvider(
        String(a[0] ?? ""),
        a[1] === void 0 || a[1] === null ? null : String(a[1]),
        String(a[2] ?? "openai"),
        a[3] === void 0 || a[3] === null ? void 0 : String(a[3]),
        Array.isArray(a[4]) ? a[4].map((v) => String(v ?? "")) : void 0
      );
    case "removeModelProvider":
      return panel.removeModelProvider(String(a[0] ?? ""));
    case "fetchModels":
      return panel.fetchModels(
        String(a[0] ?? ""),
        a[1] === void 0 ? void 0 : Boolean(a[1]),
        a[2] ?? null
      );
    case "setModelExposure":
      return panel.setModelExposure(String(a[0] ?? ""), String(a[1] ?? ""), Boolean(a[2]));
    case "checkModels":
      return panel.checkModels(a[0] === void 0 ? void 0 : String(a[0]));
    case "getMetrics":
      return panel.getMetrics(a[0] === void 0 ? void 0 : Number(a[0]));
    case "checkModel":
      return panel.checkModel(String(a[0] ?? ""), String(a[1] ?? ""));
    case "getSensenovaAccounts":
      return panel.getSensenovaAccounts();
    case "getQuota":
      return panel.getQuota();
    // 渠道页(Trae / WorkBuddy)
    case "getProviderPage":
      return panel.getProviderPage(String(a[0] ?? ""), a[1] === void 0 ? void 0 : Boolean(a[1]));
    case "getChannelAccounts":
      return panel.getChannelAccounts(String(a[0] ?? ""));
    case "checkinStatus":
      return panel.checkinStatus(
        String(a[0] ?? ""),
        a[1] === void 0 || a[1] === null ? void 0 : Number(a[1])
      );
    case "checkinClaim":
      return panel.checkinClaim(
        String(a[0] ?? ""),
        Boolean(a[1]),
        a[2] === void 0 ? void 0 : Number(a[2])
      );
    case "checkinOverview":
      return panel.checkinOverview();
    case "checkinAll":
      return panel.checkinAll(Boolean(a[0]));
    case "channelOverview":
      return panel.channelOverview();
    case "getSchedulerPlan":
      return panel.getSchedulerPlan(String(a[0] ?? ""));
    case "refreshStatus":
      return panel.refreshStatus(String(a[0] ?? ""));
    case "refreshRun":
      return panel.refreshRun(
        String(a[0] ?? ""),
        Boolean(a[1]),
        a[2] === void 0 ? void 0 : Number(a[2])
      );
    case "syncChannel":
      return panel.syncChannel(String(a[0] ?? ""), a[1] === void 0 ? void 0 : Boolean(a[1]));
    // ⚠️ 拆分后的额度通道(2026-11-07):打开页面/点刷新只刷额度,不再隐式拉目录或签到。
    case "syncChannelQuota":
      return panel.syncChannelQuota(String(a[0] ?? ""), a[1] === void 0 ? void 0 : Boolean(a[1]));
    // ⚠️ 拆开后的模型目录:展开渠道卡片才拉,不刷额度、不签到。
    case "syncChannelCatalog":
      return panel.syncChannelCatalog(String(a[0] ?? ""), a[1] === void 0 ? void 0 : Boolean(a[1]));
    // ⚠️ 打开渠道页的批量额度刷新(对所有有额度能力的渠道各自跑额度段)。
    case "syncAllQuota":
      return panel.syncAllQuota(a[0] === void 0 ? void 0 : Boolean(a[0]));
    case "setChannelModels":
      return panel.setChannelModels(
        String(a[0] ?? ""),
        Array.isArray(a[1]) ? a[1] : []
      );
    // 单行实时保存(用户 2026-10-31 定案:四页删掉保存按钮,改成就地落库)
    case "setChannelModel":
      return panel.setChannelModel(String(a[0] ?? ""), a[1] ?? {});
    // 客户端路径
    case "getClientPaths":
      return panel.getClientPaths();
    case "saveClientPath":
      return panel.saveClientPath(String(a[0] ?? ""), String(a[1] ?? ""));
    case "detectClientPath":
      return panel.detectClientPath(String(a[0] ?? ""));
    case "discoverChannelAccounts":
      return panel.discoverChannelAccounts(String(a[0] ?? ""));
    case "adoptChannelAccount":
      return panel.adoptChannelAccount(
        String(a[0] ?? ""),
        String(a[1] ?? ""),
        String(a[2] ?? ""),
        a[3] === void 0 ? void 0 : String(a[3]),
        // 第五参 = 发现阶段的身份字段(2026-11-09):不传就退回「只有 3 个键」的
        // 残缺凭据,签到时上游会持续回 9074。
        a[4] !== null && typeof a[4] === "object" && !Array.isArray(a[4]) ? a[4] : void 0
      );
    // 设置
    case "getSettings":
      return panel.getSettings();
    case "saveSettings":
      return panel.saveSettings(a[0] ?? {});
    // 请求日志
    case "getRequestLog":
      return panel.getRequestLog();
    case "setRequestLog":
      return panel.setRequestLog(a[0] ?? {});
    // SenseNova
    case "getSensenovaStatus":
      return panel.getSensenovaStatus();
    case "getSensenovaModels":
      return panel.getSensenovaModels();
    case "setSensenovaExposure":
      return panel.setSensenovaExposure(String(a[0] ?? ""), String(a[1] ?? ""), Boolean(a[2]));
    case "sensenovaRefresh":
      return panel.sensenovaRefresh(
        a[0] === void 0 ? void 0 : Boolean(a[0]),
        a[1] !== null && typeof a[1] === "object" ? a[1] : void 0
      );
    case "sensenovaLogin":
      return panel.sensenovaLogin(
        String(a[0] ?? ""),
        a[1] === null ? null : String(a[1] ?? ""),
        String(a[2] ?? ""),
        a[3] === void 0 ? true : Boolean(a[3])
      );
    case "sensenovaSavePassword":
      return panel.sensenovaSavePassword(String(a[0] ?? ""), String(a[1] ?? ""), String(a[2] ?? ""));
    case "sensenovaRefetchKey":
      return panel.sensenovaRefetchKey(String(a[0] ?? ""));
    case "sensenovaAddAccount":
      return panel.sensenovaAddAccount(
        String(a[0] ?? ""),
        a[1] === void 0 ? void 0 : String(a[1]),
        a[2] === void 0 ? void 0 : String(a[2])
      );
    case "sensenovaRemoveAccount":
      return panel.sensenovaRemoveAccount(String(a[0] ?? ""));
    // Qoder(cosy 协议,双区域)。region 一律先过字符串化,未知区域由域内拒绝。
    case "getQoderAccounts":
      return panel.getQoderAccounts();
    case "getQoderStatus":
      return panel.getQoderStatus();
    case "getQoderModels":
      return panel.getQoderModels(a[0] === void 0 || a[0] === null ? void 0 : String(a[0]));
    case "qoderRefreshCatalog":
      return panel.qoderRefreshCatalog(a[0] === void 0 || a[0] === null ? void 0 : String(a[0]));
    case "qoderSetModelEnabled":
      return panel.qoderSetModelEnabled(String(a[0] ?? ""), String(a[1] ?? ""), Boolean(a[2]));
    case "qoderCredits":
      return panel.qoderCredits(String(a[0] ?? ""), a[1] === void 0 || a[1] === null ? void 0 : String(a[1]));
    case "qoderCheckin":
      return panel.qoderCheckin(String(a[0] ?? ""), a[1] === void 0 || a[1] === null ? void 0 : String(a[1]));
    case "qoderCampaigns":
      return panel.qoderCampaigns(String(a[0] ?? ""), a[1] === void 0 || a[1] === null ? void 0 : String(a[1]));
    case "qoderAddAccount":
      return panel.qoderAddAccount(String(a[0] ?? ""), String(a[1] ?? ""), String(a[2] ?? ""));
    case "qoderRemoveAccount":
      return panel.qoderRemoveAccount(String(a[0] ?? ""), String(a[1] ?? ""));
    case "qoderSetAccountEnabled":
      return panel.qoderSetAccountEnabled(String(a[0] ?? ""), String(a[1] ?? ""), Boolean(a[2]));
    case "qoderProbeChat":
      return panel.qoderProbeChat(String(a[0] ?? ""), a[1] === void 0 || a[1] === null ? void 0 : String(a[1]));
    case "qoderRecentErrors":
      return panel.qoderRecentErrors();
    // 数据目录
    case "getDataDir":
      return panel.getDataDir();
    // 旧兼容(保留,防止旧调用点炸)
    case "listProviders":
      return panel.listProviders();
    case "setAccountEnabled":
      return panel.setAccountEnabled(String(a[0] ?? ""), Number(a[1]), Boolean(a[2]));
    case "getRecentRequests":
      return panel.getRecentRequests(a[0] === void 0 ? void 0 : Number(a[0]));
    case "getSessionCurrentRoute":
      return panel.getSessionCurrentRoute(String(a[0] ?? ""), a[1] === void 0 ? void 0 : String(a[1]));
    case "getRequestLogStatus":
      return panel.getRequestLogStatus();
    case "getUsageSummary":
      return panel.getUsageSummary();
    default:
      return Promise.resolve({ ok: false, message: "未知面板方法" });
  }
}

// src/panel-host.ts
function createPanelHost(rt, options = {}) {
  const port = options.gatewayPort ?? 4e3;
  const gatewayHost = options.gatewayHost ?? "127.0.0.1";
  const gatewayState = {
    gateway: {
      port,
      close: async () => void 0
    },
    error: null
  };
  const ctx = {
    db: rt.db,
    registry: rt.registry,
    vault: rt.vault,
    scheduler: rt.scheduler,
    router: rt.router,
    ledger: rt.ledger,
    health: rt.health,
    keyProvider: rt.keyProvider,
    gatewayState,
    gatewayHost,
    restartGateway: async () => "插件模式:网关由宿主 DSH 进程托管,面板不能重启它(重载插件即重建路由)",
    startedAtMs: rt.startedAtMs,
    // 额度就绪门跟着 runtime 走：面板诊断读调度排序前要先等它，否则会把
    // 「还没刷新过」显示成「调度坏了」（2026-11-18 数据统一）。
    awaitQuota: async () => {
      await rt.awaitQuota?.();
    },
    accountOverlay: rt.accountOverlay,
    setAccountEnabled: rt.setAccountEnabled,
    dataDir: rt.dataDir,
    dbPath: rt.dbPath,
    secretPresence: rt.secretPresence,
    syncRegistry: rt.syncRegistry
  };
  const bundle = createPanel(ctx, { syncSensenovaPool });
  rt.setSensenovaKeyRepair(bundle.snRepairKey);
  return {
    panel: bundle.panel,
    dispatch: (method, args) => dispatchPanel(bundle.panel, method, args),
    ctx,
    bundle
  };
}

export {
  createPanelHost
};
//# sourceMappingURL=chunk-U3N5EISP.js.map
