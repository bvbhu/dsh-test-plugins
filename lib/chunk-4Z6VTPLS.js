import {
  DEFAULT_FACTOR,
  DEFAULT_PROVIDER_PROTOCOL,
  DEFAULT_SCHEDULER_STRATEGY,
  MAX_CONTEXT_SHRINKS,
  PROVIDER_PROTOCOLS,
  RULES_PRIORITY_KEYS,
  RequestLogWriter,
  RetryPolicy,
  Scheduler,
  counterForModel,
  createContentModeResolver,
  defaultConcurrencyOf,
  describeMaskedOverflow,
  effectiveWindowTokens,
  endpointIdOf,
  estimateRequestTokens,
  fitForEndpoint,
  isContextOverflow,
  isMaskedOverflow,
  isProviderProtocol,
  isRateLimitOversize,
  isStickyNoSwitchProvider,
  logRequests,
  normalizeExpiresSeconds,
  normalizeStrategy,
  noteContextOverflow,
  notePromptUsage,
  promptScale,
  rerouteSettingsFrom,
  rulesKeyOf,
  splitModelId,
  systemWallClock,
  validRules
} from "./chunk-7NII7QAL.js";
import {
  CACHE_ROUTING_KEY_FIELD,
  EnvKeyProvider,
  RAW_BODY_MAX,
  UpstreamError,
  UpstreamErrorKind,
  allBusyError
} from "./chunk-KJWR6LSK.js";

// src/compact-trigger.ts
function createCompactTrigger(resolve) {
  const pending = /* @__PURE__ */ new Set();
  const inflight = /* @__PURE__ */ new Set();
  return {
    noteInternalSwitch(sessionId) {
      if (sessionId) pending.add(sessionId);
    },
    async onAgentRequest(payload, next) {
      const config = await next();
      const raw = payload?.agent?.session?.sessionId;
      const sessionId = typeof raw === "string" ? raw : "";
      if (!sessionId || !pending.has(sessionId)) return config;
      pending.delete(sessionId);
      if (inflight.has(sessionId)) return config;
      inflight.add(sessionId);
      try {
        const host = resolve();
        if (host.compaction && !payload.signal?.aborted) {
          await host.compaction.compactIfNeeded(payload.agent, "pressure", payload.signal);
        }
      } catch (error) {
        resolve().warn?.("[as-one] internal-switch compaction failed", error);
      } finally {
        inflight.delete(sessionId);
      }
      return config;
    }
  };
}
var activeHost = {};
function setCompactHost(host) {
  activeHost = host;
}
var internalSwitch = createCompactTrigger(() => activeHost);

// src/setup.ts
import { mkdirSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";

// core/db/database.ts
import { DatabaseSync } from "node:sqlite";

// core/db/schema.ts
var SCHEMA_V7 = `
-- ============================================================
-- provider 表
-- ============================================================
CREATE TABLE IF NOT EXISTS provider (
    id                  TEXT PRIMARY KEY,            -- 'workbuddy' / 'trae' / 'sensenova' ...
    base_url            TEXT,                        -- OpenAI 兼容端点的 api_base
    protocol            TEXT NOT NULL DEFAULT 'openai',  -- openai | workbuddy | trae | sensenova
    env_prefix          TEXT                         -- 账号密钥的环境变量前缀,如 WORKBUDDY_TOKEN
);
CREATE INDEX IF NOT EXISTS ix_provider_protocol ON provider(protocol);

-- ============================================================
-- credential 表
-- ============================================================
CREATE TABLE IF NOT EXISTS credential (
    provider       TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
    username       TEXT NOT NULL,
    secret         TEXT,
    refresh_secret TEXT,
    expires_at     REAL,                              -- ⚠️ 单位是秒(epoch seconds),不是毫秒
    raw_json       TEXT,
    PRIMARY KEY (provider, username)
);

-- ============================================================
-- real_model 表
-- ============================================================
CREATE TABLE IF NOT EXISTS real_model (
    provider          TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
    model             TEXT NOT NULL,
    name              TEXT,
    supports_vision   INTEGER NOT NULL DEFAULT 0,
    max_input_tokens  INTEGER,
    max_output_tokens INTEGER,
    hidden            INTEGER NOT NULL DEFAULT 0,
    -- ⚠️ 列默认 1 只是「INSERT 没给值」时的形状兜底,**不是**供应商策略:
    -- 真源是 config/concurrency-defaults.ts 的 defaultConcurrencyOf(provider)
    -- (2026-11-08:sensenova=1 / workbuddy=2 / 其余 3)。所有正常写入路径都显式给值,
    -- 这里刻意不改成 3 —— 裸插 sensenova 行时给 1 比给 3 安全。
    concurrency       INTEGER NOT NULL DEFAULT 1,
    -- 该模型**支持**的思考强度(上游模型目录给的档位表,如 ["low","high","max"])。
    -- JSON 数组字符串;NULL = 上游没给 / 还没回源。
    -- ⚠️ 语义(2026-10-24 用户定案 m09328):**空(NULL 或 [])就不传
    -- reasoning_effort**;非空时也只放行名单里的值。上游报「不支持该思考强度」
    -- 时网关丢参重试,重试成功即把本列**清空**(学习结果,下次不再发)。
    supported_reasoning_efforts TEXT,
    -- 该模型**是否允许关闭思考**(off)。1 = 允许(原样发 off);
    -- 0 = 不允许(退到最低思考档 low);NULL = 上游没说(按「允许」处理,
    -- 交给上游自己拒 —— 总比擅自把「关闭思考」改成「low」好)。
    -- 实测只有 workbuddy 的 reasoning.canDisableThinking 给这个信号。
    reasoning_allows_off INTEGER,
    PRIMARY KEY (provider, model)
);
CREATE INDEX IF NOT EXISTS ix_real_model_hidden ON real_model(hidden);

-- ============================================================
-- logical_model 表
-- ============================================================
CREATE TABLE IF NOT EXISTS logical_model (
    name       TEXT PRIMARY KEY,
    -- 2026-10-26 用户 m15445 定案:缺省策略改为随机(与 DEFAULT_SCHEDULER_STRATEGY 一致)。
    -- ⚠️ 仅对**新建**库生效:CREATE TABLE IF NOT EXISTS 不会改已存在的表。
    strategy   TEXT NOT NULL DEFAULT 'random',
    members    TEXT NOT NULL DEFAULT '[]',            -- JSON 数组,顺序即优先级
    -- 2026-11-01 用户 m44638:逻辑模型的人话显示名(NULL = 直接用 name)。
    -- name 是调用标识(进 /v1/models 的 id、客户端请求串),不能为了好看改它;
    -- 显示名走这一列,撞名时由 listModelEntries 追加 provider 区分。
    -- ⚠️ 这段注释里不要写反引号 —— 整个 schema 是一个模板字符串,反引号会截断它。
    display_name TEXT
);

-- ============================================================
-- stats_daily 表
-- ============================================================
CREATE TABLE IF NOT EXISTS stats_daily (
    day               TEXT NOT NULL,                  -- 'YYYY-MM-DD'
    logical_model     TEXT,                           -- NULL 表示"任何 logical_model"聚合行
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    requests          INTEGER NOT NULL DEFAULT 0,
    fails             INTEGER NOT NULL DEFAULT 0,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    latency_sum_ms    INTEGER NOT NULL DEFAULT 0,     -- 毫秒累加值
    ttft_sum_ms       INTEGER NOT NULL DEFAULT 0,     -- 毫秒累加值
    ttft_requests     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, logical_model, provider, model)
);
CREATE INDEX IF NOT EXISTS ix_stats_provider_model ON stats_daily(provider, model);

-- ============================================================
-- stats_external_daily 表 —— **网关外**用量(DSH 直连其它 provider)
-- ============================================================
-- 为什么单开一张表而不是塞进 stats_daily:
--   1. 语义不同:这里没有逻辑模型(恒无 logical_model),也没有账号/延迟/TTFT
--      —— 那些是网关独有的观测;
--   2. 计数不同:calls 是**上游调用次数**(step/start + 重试),而 stats_daily 的
--      requests 是**客户端请求数**,同名相加会永远对不上账;
--   3. 唯一性:所有列 NOT NULL,主键才真正生效(SQLite 对含 NULL 的主键不做唯一约束,
--      stats_daily 的 NULL 聚合行因此只能靠 UPDATE→INSERT 兜,跨进程有 TOCTOU 窗口)。
CREATE TABLE IF NOT EXISTS stats_external_daily (
    day               TEXT NOT NULL,                  -- 'YYYY-MM-DD'
    provider          TEXT NOT NULL,                  -- DSH 里的 provider id(非 as-one)
    model             TEXT NOT NULL,                  -- 真实模型名
    calls             INTEGER NOT NULL DEFAULT 0,     -- 上游调用次数(不是客户端请求数)
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,     -- 含 cached(与 stats_daily 同口径)
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    last_seen         INTEGER NOT NULL DEFAULT 0,     -- epoch ms
    PRIMARY KEY (day, provider, model)
);

-- ============================================================
-- setting 表
-- ============================================================
CREATE TABLE IF NOT EXISTS setting (
    k TEXT PRIMARY KEY,
    v TEXT
);
INSERT OR IGNORE INTO setting (k, v) VALUES ('version', '4');

-- ============================================================
-- subagent_model_pending 表 —— as-one 自有扩展(休眠子代理的待切换模型)
-- ============================================================
-- 用户定案 A(2026-11-24):continuable 子代理休眠时没有 live Session,不能
-- 直接 append model/selection;若用 subagents.prompt 唤醒并拦截,宿主会在
-- turn 结束时向父会话投递 source.kind='subagent-settled' 结算通知(污染父会话)。
-- 因此把「目标选择」持久化在本表:切换当刻 UI 立即显示目标模型,真正写入
-- child Session 延迟到该子代理**下次真实唤醒**(agent/created)时 drain。
-- 进程重启后行还在,不会丢;drain 完即删,不留陈旧选择。
CREATE TABLE IF NOT EXISTS subagent_model_pending (
    session_id       TEXT PRIMARY KEY,            -- 子代理会话 id
    provider         TEXT NOT NULL,
    model            TEXT NOT NULL,
    reasoning_effort TEXT,                        -- NULL = 用 provider 默认档
    changed_at       INTEGER NOT NULL             -- epoch ms,写入时刻(不用 updated_at:D1 幽灵列回归防护禁止)
);
`;

// core/db/database.ts
function assertNonNullable(v, what) {
  if (v === void 0 || v === null) {
    throw new Error(`as-one-db: missing required value: ${what}`);
  }
  return v;
}
function toBind(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}
function openDatabase(target) {
  const raw = new DatabaseSync(target);
  if (target !== ":memory:") {
    raw.exec("PRAGMA journal_mode = WAL;");
  }
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  raw.exec(SCHEMA_V7);
  const ensureColumn = (table, column, ddl) => {
    const cols = raw.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name);
    if (!cols.includes(column)) raw.exec(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  };
  ensureColumn(
    "real_model",
    "supported_reasoning_efforts",
    "supported_reasoning_efforts TEXT"
  );
  ensureColumn(
    "real_model",
    "reasoning_allows_off",
    "reasoning_allows_off INTEGER"
  );
  ensureColumn(
    "logical_model",
    "display_name",
    "display_name TEXT"
  );
  function insertRow(table, row) {
    const cols = Object.entries(row).filter(([, v]) => v !== void 0);
    if (cols.length === 0) {
      throw new Error(`as-one-db: insert into ${table} with no columns`);
    }
    const names = cols.map(([k]) => `"${k}"`).join(", ");
    const marks = cols.map(() => "?").join(", ");
    const values = cols.map(([, v]) => toBind(v));
    raw.prepare(`INSERT INTO ${table} (${names}) VALUES (${marks})`).run(...values);
  }
  function updateRow(table, row, keySql, keyParams) {
    const cols = Object.entries(row).filter(([k, v]) => v !== void 0 && !k.startsWith("$key"));
    const setClause = cols.map(([k]) => `"${k}" = ?`).join(", ");
    if (setClause.length === 0) {
      throw new Error(`as-one-db: update ${table} with no settable columns`);
    }
    const values = [...cols.map(([, v]) => toBind(v)), ...keyParams];
    raw.prepare(`UPDATE ${table} SET ${setClause} WHERE ${keySql}`).run(...values);
  }
  function deleteRow(table, keySql, keyParams) {
    raw.prepare(`DELETE FROM ${table} WHERE ${keySql}`).run(...keyParams);
  }
  const db = {
    raw,
    close() {
      raw.close();
    },
    dataVersion() {
      const row = raw.prepare("PRAGMA data_version").get();
      return Number(row?.data_version ?? 0);
    },
    provider: {
      get(id) {
        return raw.prepare("SELECT * FROM provider WHERE id = ?").get(id);
      },
      list() {
        return raw.prepare("SELECT * FROM provider").all();
      },
      insert(row) {
        insertRow("provider", row);
      },
      update(row) {
        const id = assertNonNullable(row.id, "provider.id");
        const { id: _id, ...rest } = row;
        updateRow("provider", rest, "id = ?", [id]);
      },
      delete(id) {
        deleteRow("provider", "id = ?", [id]);
      }
    },
    credential: {
      get(provider, username) {
        return raw.prepare("SELECT * FROM credential WHERE provider = ? AND username = ?").get(provider, username);
      },
      listByProvider(provider) {
        return raw.prepare("SELECT * FROM credential WHERE provider = ? ORDER BY username").all(provider);
      },
      list() {
        return raw.prepare("SELECT * FROM credential").all();
      },
      insert(row) {
        insertRow("credential", row);
      },
      set(row) {
        const cols = Object.entries(row).filter(([, v]) => v !== void 0);
        const names = cols.map(([k]) => `"${k}"`).join(", ");
        const marks = cols.map(() => "?").join(", ");
        const updates = cols.map(([k]) => `"${k}" = excluded."${k}"`).join(", ");
        const values = cols.map(([, v]) => toBind(v));
        raw.prepare(
          `INSERT INTO credential (${names}) VALUES (${marks})
					 ON CONFLICT (provider, username) DO UPDATE SET ${updates}`
        ).run(...values);
      },
      update(row) {
        const provider = assertNonNullable(row.provider, "credential.provider");
        const username = assertNonNullable(row.username, "credential.username");
        const { provider: _p, username: _u, ...rest } = row;
        updateRow(
          "credential",
          rest,
          "provider = ? AND username = ?",
          [provider, username]
        );
      },
      delete(provider, username) {
        deleteRow("credential", "provider = ? AND username = ?", [provider, username]);
      },
      secretsFor(provider) {
        const rows = raw.prepare("SELECT username, secret FROM credential WHERE provider = ?").all(provider);
        const out = {};
        for (const r of rows) out[r.username] = r.secret;
        return out;
      }
    },
    realModel: {
      get(provider, model) {
        return raw.prepare("SELECT * FROM real_model WHERE provider = ? AND model = ?").get(provider, model);
      },
      list() {
        return raw.prepare("SELECT * FROM real_model").all();
      },
      listByProvider(provider) {
        return raw.prepare("SELECT * FROM real_model WHERE provider = ? ORDER BY model").all(provider);
      },
      set(row) {
        const cols = Object.entries(row).filter(([, v]) => v !== void 0);
        const names = cols.map(([k]) => `"${k}"`).join(", ");
        const marks = cols.map(() => "?").join(", ");
        const updates = cols.map(([k]) => `"${k}" = excluded."${k}"`).join(", ");
        const values = cols.map(([, v]) => toBind(v));
        raw.prepare(
          `INSERT INTO real_model (${names}) VALUES (${marks})
					 ON CONFLICT (provider, model) DO UPDATE SET ${updates}`
        ).run(...values);
      },
      update(row) {
        const provider = assertNonNullable(row.provider, "real_model.provider");
        const model = assertNonNullable(row.model, "real_model.model");
        const { provider: _p, model: _m, ...rest } = row;
        updateRow("real_model", rest, "provider = ? AND model = ?", [
          provider,
          model
        ]);
      },
      delete(provider, model) {
        deleteRow("real_model", "provider = ? AND model = ?", [provider, model]);
      }
    },
    logicalModel: {
      get(name) {
        return raw.prepare("SELECT * FROM logical_model WHERE name = ?").get(name);
      },
      list() {
        return raw.prepare("SELECT * FROM logical_model").all();
      },
      insert(row) {
        insertRow("logical_model", row);
      },
      update(row) {
        const name = assertNonNullable(row.name, "logical_model.name");
        const { name: _n, ...rest } = row;
        updateRow("logical_model", rest, "name = ?", [name]);
      },
      delete(name) {
        deleteRow("logical_model", "name = ?", [name]);
      }
    },
    statsDaily: {
      range(dayFrom, dayTo, logicalModel) {
        let sql = "SELECT * FROM stats_daily WHERE day >= ? AND day <= ?";
        const params = [dayFrom, dayTo];
        if (logicalModel !== void 0) {
          sql += " AND logical_model IS ?";
          params.push(logicalModel);
        }
        sql += " ORDER BY day, logical_model, provider, model";
        return raw.prepare(sql).all(...params);
      },
      record(delta) {
        const {
          day,
          logical_model,
          provider,
          model,
          requests = 0,
          fails = 0,
          prompt_tokens = 0,
          cached_tokens = 0,
          completion_tokens = 0,
          latency_sum_ms = 0,
          ttft_sum_ms = 0,
          ttft_requests = 0
        } = delta;
        assertNonNullable(day, "stats_daily.day");
        assertNonNullable(provider, "stats_daily.provider");
        assertNonNullable(model, "stats_daily.model");
        if (logical_model === void 0 || logical_model === null) {
          raw.exec("BEGIN IMMEDIATE");
          try {
            const upd = raw.prepare(
              `UPDATE stats_daily SET
								requests = requests + ?,
								fails = fails + ?,
								prompt_tokens = prompt_tokens + ?,
								cached_tokens = cached_tokens + ?,
								completion_tokens = completion_tokens + ?,
								latency_sum_ms = latency_sum_ms + ?,
								ttft_sum_ms = ttft_sum_ms + ?,
								ttft_requests = ttft_requests + ?
							 WHERE day = ? AND logical_model IS NULL AND provider = ? AND model = ?`
            ).run(
              requests,
              fails,
              prompt_tokens,
              cached_tokens,
              completion_tokens,
              latency_sum_ms,
              ttft_sum_ms,
              ttft_requests,
              day,
              provider,
              model
            );
            if (Number(upd.changes) === 0) {
              raw.prepare(
                `INSERT INTO stats_daily
									(day, logical_model, provider, model, requests, fails, prompt_tokens,
									 cached_tokens, completion_tokens, latency_sum_ms, ttft_sum_ms, ttft_requests)
								 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).run(
                day,
                provider,
                model,
                requests,
                fails,
                prompt_tokens,
                cached_tokens,
                completion_tokens,
                latency_sum_ms,
                ttft_sum_ms,
                ttft_requests
              );
            }
            raw.exec("COMMIT");
          } catch (err) {
            try {
              raw.exec("ROLLBACK");
            } catch {
            }
            throw err;
          }
          return;
        }
        raw.prepare(
          `INSERT INTO stats_daily
						(day, logical_model, provider, model, requests, fails, prompt_tokens,
						 cached_tokens, completion_tokens, latency_sum_ms, ttft_sum_ms, ttft_requests)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (day, logical_model, provider, model) DO UPDATE SET
						requests = requests + excluded.requests,
						fails = fails + excluded.fails,
						prompt_tokens = prompt_tokens + excluded.prompt_tokens,
						cached_tokens = cached_tokens + excluded.cached_tokens,
						completion_tokens = completion_tokens + excluded.completion_tokens,
						latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
						ttft_sum_ms = ttft_sum_ms + excluded.ttft_sum_ms,
						ttft_requests = ttft_requests + excluded.ttft_requests`
        ).run(
          day,
          logical_model ?? null,
          provider,
          model,
          requests,
          fails,
          prompt_tokens,
          cached_tokens,
          completion_tokens,
          latency_sum_ms,
          ttft_sum_ms,
          ttft_requests
        );
      },
      insert(row) {
        insertRow("stats_daily", row);
      },
      /**
       * 聚合表整体规模(面板「请求日志」counters):
       * - stats_rows:stats_daily 总行数(COUNT(*));
       * - last_24h:近 24h 请求数(day >= 传入的边界日,即 dayKey(now-86400s));
       * - errors:累计失败数(SUM(fails))。
       */
      counters(dayFrom24h) {
        const statsRows = raw.prepare("SELECT COUNT(*) AS n FROM stats_daily").get();
        const last24h = raw.prepare("SELECT COALESCE(SUM(requests), 0) AS n FROM stats_daily WHERE day >= ?").get(dayFrom24h);
        const errors = raw.prepare("SELECT COALESCE(SUM(fails), 0) AS n FROM stats_daily").get();
        return {
          stats_rows: Number(statsRows?.n ?? 0),
          last_24h: Number(last24h?.n ?? 0),
          errors: Number(errors?.n ?? 0)
        };
      }
    },
    statsExternalDaily: {
      range(dayFrom, dayTo) {
        return raw.prepare(
          "SELECT * FROM stats_external_daily WHERE day >= ? AND day <= ? ORDER BY day, provider, model"
        ).all(dayFrom, dayTo);
      },
      record(delta) {
        const {
          day,
          provider,
          model,
          calls = 0,
          prompt_tokens = 0,
          cached_tokens = 0,
          completion_tokens = 0,
          last_seen = 0
        } = delta;
        assertNonNullable(day, "stats_external_daily.day");
        assertNonNullable(provider, "stats_external_daily.provider");
        assertNonNullable(model, "stats_external_daily.model");
        raw.prepare(
          `INSERT INTO stats_external_daily
							(day, provider, model, calls, prompt_tokens, cached_tokens, completion_tokens, last_seen)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (day, provider, model) DO UPDATE SET
							calls = calls + excluded.calls,
							prompt_tokens = prompt_tokens + excluded.prompt_tokens,
							cached_tokens = cached_tokens + excluded.cached_tokens,
							completion_tokens = completion_tokens + excluded.completion_tokens,
							last_seen = MAX(last_seen, excluded.last_seen)`
        ).run(
          day,
          provider,
          model,
          calls,
          prompt_tokens,
          cached_tokens,
          completion_tokens,
          last_seen
        );
      }
    },
    setting: {
      get(key) {
        return raw.prepare("SELECT * FROM setting WHERE k = ?").get(key);
      },
      entries(prefix) {
        return raw.prepare("SELECT * FROM setting WHERE substr(k, 1, ?) = ? ORDER BY k").all(prefix.length, prefix);
      },
      set(key, value) {
        raw.prepare(
          "INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v"
        ).run(key, value);
      },
      delete(key) {
        deleteRow("setting", "k = ?", [key]);
      }
    },
    subagentModelPending: {
      get(sessionId) {
        return raw.prepare("SELECT * FROM subagent_model_pending WHERE session_id = ?").get(sessionId);
      },
      set(row) {
        raw.prepare(
          `INSERT INTO subagent_model_pending
						(session_id, provider, model, reasoning_effort, changed_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT (session_id) DO UPDATE SET
						provider = excluded.provider,
						model = excluded.model,
						reasoning_effort = excluded.reasoning_effort,
						changed_at = excluded.changed_at`
        ).run(
          row.session_id,
          row.provider,
          row.model,
          row.reasoning_effort,
          row.changed_at
        );
      },
      delete(sessionId) {
        deleteRow("subagent_model_pending", "session_id = ?", [sessionId]);
      }
    }
  };
  return db;
}

// core/config/store.ts
import { realpathSync, watch } from "node:fs";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
var StoreError = class extends Error {
  /** 出错的文件路径。 */
  path;
  /** 底层 errno 代码(``ENOENT`` / ``EPERM`` / ``EBUSY`` …),无则 ``null``。 */
  code;
  /** 是否「文件不存在」(与语法/权限错误区分对待)。 */
  missing;
  constructor(path, message, options) {
    super(message, options?.cause !== void 0 ? { cause: options.cause } : void 0);
    this.name = "StoreError";
    this.path = path;
    this.code = options?.code ?? null;
    this.missing = options?.missing ?? false;
  }
};
var nodeFs = {
  writeFileSync: (p, d) => writeFileSync(p, d, "utf8"),
  renameSync,
  readFileSync: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  },
  statSync: (p) => {
    try {
      return statSync(p);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  },
  readdirSync
};
function readJsonFile(path, fs = nodeFs) {
  let text;
  try {
    text = fs.readFileSync(path);
  } catch (err) {
    throw new StoreError(path, `读取失败:${err.message}`, {
      code: err.code,
      cause: err
    });
  }
  if (text === null) return { ok: false, missing: true, error: "文件不存在" };
  if (text.trim() === "") return { ok: false, missing: true, error: "空文件按不存在处理" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, missing: false, error: err.message };
  }
}
var DEFAULT_TMP_PREFIX = ".as-one-tmp-";
var sleepImpl = (ms) => {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
  }
};
function writeJsonFileAtomic(path, value, options = {}) {
  const fs = options.fs ?? nodeFs;
  const tmpPrefix = options.tmpPrefix ?? `${DEFAULT_TMP_PREFIX}${basename(path)}-`;
  const renameRetries = Math.max(1, options.renameRetries ?? 3);
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? 20);
  const verify = options.verify ?? true;
  let text;
  try {
    text = JSON.stringify(value, null, 2) + "\n";
  } catch (err) {
    throw new StoreError(path, `序列化失败(未写入磁盘):${err.message}`, { cause: err });
  }
  cleanStaleTmpFiles(path, fs, tmpPrefix);
  const tmp = join(dirname(path), `${tmpPrefix}${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.writeFileSync(tmp, text);
    fsyncFile(tmp);
  } catch (err) {
    tryRemove(tmp);
    throw new StoreError(path, `写临时文件失败:${err.message}`, {
      code: err.code,
      cause: err
    });
  }
  let lastErr = null;
  for (let attempt = 0; attempt < renameRetries; attempt++) {
    try {
      fs.renameSync(tmp, path);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < renameRetries) sleepImpl(retryBaseMs * 2 ** attempt);
    }
  }
  if (lastErr !== null) {
    tryRemove(tmp);
    throw new StoreError(
      path,
      `重命名失败(已重试 ${renameRetries} 次):${lastErr.message}`,
      { code: lastErr.code, cause: lastErr }
    );
  }
  if (verify) {
    const back = fs.readFileSync(path);
    if (back === null || back !== text) {
      throw new StoreError(path, "回读校验失败:写入后内容与期望不一致(磁盘/杀软拦截?)");
    }
  }
}
function cleanStaleTmpFiles(path, fs, tmpPrefix) {
  try {
    const dir = dirname(path);
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(tmpPrefix)) tryRemove(join(dir, entry));
    }
  } catch {
  }
}
function fsyncFile(path) {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
  }
}
function tryRemove(path) {
  try {
    rmSync(path, { force: true, maxRetries: 1 });
  } catch {
  }
}
function toLongPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}
function watchJsonFile(path, onChange, onError, options = {}) {
  const debounceMs = Math.max(0, options.debounceMs ?? 100);
  const dir = toLongPath(dirname(path));
  const file = basename(path);
  let lastKnown = null;
  let closed = false;
  let timer = null;
  const schedule = () => {
    if (closed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      fire();
    }, debounceMs);
  };
  const fire = () => {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      if (options.onReadError === "emit-null" && lastKnown !== null) {
        lastKnown = null;
        onChange(
          ""
          /* 空串 = 解析必然失败,交给调用方 */
        );
      }
      return;
    }
    if (!options.emitUnchanged && text === lastKnown) return;
    lastKnown = text;
    onChange(text);
  };
  let watcher = null;
  try {
    watcher = watch(dir, (_eventType, filename) => {
      if (closed) return;
      if (filename !== null && filename !== file) return;
      schedule();
    });
  } catch (err) {
    const storeErr = new StoreError(path, `无法监听目录:${err.message}`, {
      code: err.code,
      cause: err
    });
    if (options.onWatchError === "error") onError?.(storeErr);
    return {
      close: () => {
        closed = true;
      },
      get lastKnown() {
        return null;
      }
    };
  }
  try {
    lastKnown = readFileSync(path, "utf8");
  } catch {
  }
  return {
    close: () => {
      if (closed) return;
      closed = true;
      if (timer !== null) clearTimeout(timer);
      watcher?.close();
      watcher = null;
    },
    get lastKnown() {
      return lastKnown;
    }
  };
}

// core/config/providers.ts
var ConfigValidationError = class extends Error {
  issues;
  constructor(issues, message) {
    super(
      message ?? `provider 配置加载失败(${issues.length} 个问题): ${issues.map((i) => `[${i.path}] ${i.message}`).join("; ")}`
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
};
function emptySnapshot() {
  return {
    providers: /* @__PURE__ */ new Map(),
    realModels: /* @__PURE__ */ new Map(),
    accounts: /* @__PURE__ */ new Map(),
    logicalModels: /* @__PURE__ */ new Map(),
    schedulerRules: []
  };
}
function splitModelId2(value) {
  const idx = value.indexOf("/");
  if (idx < 0) return [null, value];
  return [value.slice(0, idx), value.slice(idx + 1)];
}
function parseExpiryDate(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return null;
  if (hour > 23 || minute > 59 || second > 61) return null;
  const t = new Date(year, month - 1, day, hour, minute, second, 0);
  return Math.floor(t.getTime() / 1e3);
}
function isHhMm(value) {
  if (typeof value !== "string") return false;
  const parts = value.trim().split(":");
  if (parts.length !== 2) return false;
  return /^-?\d+$/.test(parts[0].trim()) && /^-?\d+$/.test(parts[1].trim());
}
function isValidSpans(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (span) => Array.isArray(span) && span.length === 2 && isHhMm(span[0]) && isHhMm(span[1])
  );
}
function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function isPositiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function asBool(value, fallback) {
  if (value === void 0 || value === null) return { ok: true, value: fallback };
  if (typeof value === "boolean") return { ok: true, value };
  return { ok: false, value: fallback };
}
function asNullableString(value, fallback) {
  if (value === void 0) return { ok: true, value: fallback };
  if (value === null) return { ok: true, value: null };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, value: fallback };
}
function normalizeMembers(raw, path, issues) {
  if (raw === void 0) return [];
  if (!Array.isArray(raw)) {
    issues.push({ path, message: `members 不是数组,按空档链处理` });
    return [];
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  raw.forEach((item, i) => {
    const itemPath = `${path}[${i}]`;
    let provider = null;
    let model = null;
    if (typeof item === "string") {
      [provider, model] = splitModelId2(item);
    } else if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const obj = item;
      if (typeof obj.provider === "string" && obj.provider !== "" && typeof obj.model === "string" && obj.model !== "") {
        provider = obj.provider;
        model = obj.model;
      } else {
        [provider, model] = splitModelId2(
          typeof obj.real_model_id === "string" ? obj.real_model_id : typeof obj.id === "string" ? obj.id : ""
        );
      }
    }
    if (!provider || !model) {
      issues.push({ path: itemPath, message: `members 条目缺少 provider/model,已忽略:${JSON.stringify(item)}` });
      return;
    }
    const key = `${provider}/${model}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ provider, model });
  });
  return out;
}
function validateProviderEntry(raw, index, issues) {
  const path = `providers[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({ path, message: `provider[${index}] 不是对象,已跳过` });
    return null;
  }
  const obj = raw;
  if (typeof obj.id !== "string" || obj.id === "") {
    issues.push({ path, message: `providers[${index}] 缺非空 id,已跳过` });
    return null;
  }
  const providerId = obj.id;
  if (obj.protocol === void 0) {
  } else if (!isProviderProtocol(obj.protocol)) {
    issues.push({
      path: `${path}.protocol`,
      message: `未知协议 ${JSON.stringify(obj.protocol)},已跳过 provider ${providerId}`
    });
    return null;
  }
  const baseUrl = asNullableString(obj.baseUrl, null);
  if (!baseUrl.ok) {
    issues.push({ path: `${path}.baseUrl`, message: `baseUrl 必须是字符串或 null,按 null 处理` });
  }
  const envPrefix = asNullableString(obj.envPrefix, null);
  if (!envPrefix.ok) {
    issues.push({ path: `${path}.envPrefix`, message: `envPrefix 必须是字符串或 null,按 null 处理` });
  }
  const realModels = [];
  const modelSeen = /* @__PURE__ */ new Set();
  const rawModels = Array.isArray(obj.realModels) ? obj.realModels : [];
  if (obj.realModels !== void 0 && !Array.isArray(obj.realModels)) {
    issues.push({ path: `${path}.realModels`, message: `realModels 不是数组,按空处理` });
  }
  rawModels.forEach((m, j) => {
    const mPath = `${path}.realModels[${j}]`;
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      issues.push({ path: mPath, message: `realModels[${j}] 不是对象,已跳过` });
      return;
    }
    const mo = m;
    if (typeof mo.model !== "string" || mo.model === "") {
      issues.push({ path: mPath, message: `realModels[${j}] 缺非空 model,已跳过` });
      return;
    }
    const key = `${providerId}/${mo.model}`;
    if (modelSeen.has(key)) {
      issues.push({ path: mPath, message: `重复的真实模型 ${key},已保留后者(与 DB upsert 同口径)` });
    } else {
      modelSeen.add(key);
    }
    const name = asNullableString(mo.name, null);
    if (!name.ok) issues.push({ path: `${mPath}.name`, message: `name 必须是字符串或 null,按 null 处理` });
    const vision = asBool(mo.supportsVision, false);
    if (!vision.ok) issues.push({ path: `${mPath}.supportsVision`, message: `supportsVision 必须是布尔,按 false 处理` });
    const hidden = asBool(mo.hidden, false);
    if (!hidden.ok) issues.push({ path: `${mPath}.hidden`, message: `hidden 必须是布尔,按 false 处理` });
    const maxIn = mo.maxInputTokens === void 0 ? null : isPositiveInt(mo.maxInputTokens) ? mo.maxInputTokens : (issues.push({ path: `${mPath}.maxInputTokens`, message: `maxInputTokens 必须是正整数,按 null 处理` }), null);
    const maxOut = mo.maxOutputTokens === void 0 ? null : isPositiveInt(mo.maxOutputTokens) ? mo.maxOutputTokens : (issues.push({ path: `${mPath}.maxOutputTokens`, message: `maxOutputTokens 必须是正整数,按 null 处理` }), null);
    const concurrency = mo.concurrency === void 0 ? null : isPositiveInt(mo.concurrency) ? mo.concurrency : (issues.push({ path: `${mPath}.concurrency`, message: `concurrency 必须是正整数,按 null(不覆盖)处理` }), null);
    realModels.push({
      provider: providerId,
      model: mo.model,
      name: name.value,
      supportsVision: vision.value,
      maxInputTokens: maxIn,
      maxOutputTokens: maxOut,
      hidden: hidden.value,
      concurrency
    });
  });
  const accounts = [];
  const accountSeen = /* @__PURE__ */ new Set();
  const rawAccounts = Array.isArray(obj.accounts) ? obj.accounts : [];
  if (obj.accounts !== void 0 && !Array.isArray(obj.accounts)) {
    issues.push({ path: `${path}.accounts`, message: `accounts 不是数组,按空处理` });
  }
  rawAccounts.forEach((a, j) => {
    const aPath = `${path}.accounts[${j}]`;
    if (typeof a !== "object" || a === null || Array.isArray(a)) {
      issues.push({ path: aPath, message: `accounts[${j}] 不是对象,已跳过` });
      return;
    }
    const ao = a;
    if (typeof ao.credentialRef !== "string" || ao.credentialRef === "") {
      issues.push({ path: aPath, message: `accounts[${j}] 缺非空 credentialRef,已跳过` });
      return;
    }
    if (!ao.credentialRef.startsWith(`${providerId}/`)) {
      issues.push({
        path: `${aPath}.credentialRef`,
        message: `credentialRef ${JSON.stringify(ao.credentialRef)} 与所在 provider ${providerId} 不一致,已跳过`
      });
      return;
    }
    if (accountSeen.has(ao.credentialRef)) {
      issues.push({ path: aPath, message: `重复的账户 ${ao.credentialRef},已保留后者` });
    } else {
      accountSeen.add(ao.credentialRef);
    }
    const enabled = asBool(ao.enabled, true);
    if (!enabled.ok) issues.push({ path: `${aPath}.enabled`, message: `enabled 必须是布尔,按 true 处理` });
    const cooldown = ao.cooldownOverrideMinutes === void 0 ? null : ao.cooldownOverrideMinutes === null || isPositiveNumber(ao.cooldownOverrideMinutes) ? ao.cooldownOverrideMinutes : (issues.push({ path: `${aPath}.cooldownOverrideMinutes`, message: `cooldownOverrideMinutes 必须是正数或 null,按 null 处理` }), null);
    const pinTtl = ao.sessionPinTtlSeconds === void 0 ? null : ao.sessionPinTtlSeconds === null || isPositiveNumber(ao.sessionPinTtlSeconds) ? ao.sessionPinTtlSeconds : (issues.push({ path: `${aPath}.sessionPinTtlSeconds`, message: `sessionPinTtlSeconds 必须是正数或 null,按 null 处理` }), null);
    accounts.push({
      credentialRef: ao.credentialRef,
      enabled: enabled.value,
      cooldownOverrideMinutes: cooldown,
      sessionPinTtlSeconds: pinTtl
    });
  });
  return {
    id: providerId,
    baseUrl: baseUrl.value,
    protocol: obj.protocol === void 0 ? DEFAULT_PROVIDER_PROTOCOL : obj.protocol,
    envPrefix: envPrefix.value,
    realModels,
    accounts
  };
}
function validateLogicalModelEntry(raw, index, issues) {
  const path = `logicalModels[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({ path, message: `logicalModels[${index}] 不是对象,已跳过` });
    return null;
  }
  const obj = raw;
  if (typeof obj.name !== "string" || obj.name === "") {
    issues.push({ path, message: `logicalModels[${index}] 缺非空 name,已跳过` });
    return null;
  }
  const rawStrategy = obj.strategy;
  const { strategy, fellBack } = rawStrategy == null ? { strategy: DEFAULT_SCHEDULER_STRATEGY, fellBack: false } : normalizeStrategy(rawStrategy);
  if (fellBack) {
    issues.push({
      path: `${path}.strategy`,
      message: `未知策略 ${JSON.stringify(obj.strategy)},已退回默认 ${DEFAULT_SCHEDULER_STRATEGY}(同 repo.normalize_strategy 口径)`
    });
  }
  const members = normalizeMembers(obj.members, `${path}.members`, issues);
  return { name: obj.name, strategy, members };
}
function validateSchedulerRule(raw, path, issues) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({ path, message: `${path} 不是对象,已忽略` });
    return null;
  }
  const obj = raw;
  const provider = obj.provider;
  if (typeof provider !== "string" || provider.trim() === "") {
    issues.push({ path, message: `${path} 缺非空 provider,已忽略` });
    return null;
  }
  const rule = { provider };
  if (obj.model !== void 0) {
    if (typeof obj.model === "string" && obj.model.trim() !== "") {
      rule.model = obj.model;
    } else {
      issues.push({ path: `${path}.model`, message: `model ${JSON.stringify(obj.model)} 不是非空字符串,按「无 model」处理` });
    }
  }
  if (obj.expiresAt !== void 0) {
    if (parseExpiryDate(obj.expiresAt) !== null) {
      rule.expiresAt = obj.expiresAt;
    } else {
      issues.push({ path: `${path}.expiresAt`, message: `expiresAt ${JSON.stringify(obj.expiresAt)} 无法解析成 YYYY-MM-DD,按「无到期」处理` });
    }
  }
  const window = {};
  const winSrc = typeof obj.window === "object" && obj.window !== null && !Array.isArray(obj.window) ? obj.window : null;
  if (obj.window !== void 0 && winSrc === null) {
    issues.push({ path: `${path}.window`, message: `window ${JSON.stringify(obj.window)} 不是对象,按「无时段」处理` });
  }
  const timesRaw = winSrc !== null ? winSrc.times : obj.times;
  if (timesRaw !== void 0) {
    if (isValidSpans(timesRaw)) {
      window.times = timesRaw.map(([a, b]) => [a, b]);
    } else {
      issues.push({ path: `${path}.times`, message: `times ${JSON.stringify(timesRaw)} 不是合法 spans([["HH:MM","HH:MM"], ...]),按「无时段」处理` });
    }
  }
  const wdRaw = winSrc !== null ? winSrc.weekdays : obj.weekdays;
  if (wdRaw !== void 0) {
    if (Array.isArray(wdRaw) && wdRaw.length > 0 && wdRaw.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
      window.weekdays = wdRaw;
    } else {
      issues.push({ path: `${path}.weekdays`, message: `weekdays ${JSON.stringify(wdRaw)} 不是 1..7 的整数列表,按「每天」处理` });
    }
  }
  if (window.times !== void 0 || window.weekdays !== void 0) rule.window = window;
  if (obj.cooldown !== void 0) {
    issues.push({ path: `${path}.cooldown`, message: `cooldown 字段已迁到 setting「scheduler.cooldown_overrides」,此处已忽略` });
  }
  if (obj.logical !== void 0) {
    issues.push({ path: `${path}.logical`, message: `logical 字段已废弃(时段规则一律全局生效),已忽略` });
  }
  if (obj.priority !== void 0) {
    if (Number.isInteger(obj.priority) && obj.priority >= 0) {
      rule.priority = obj.priority;
    } else {
      issues.push({ path: `${path}.priority`, message: `priority ${JSON.stringify(obj.priority)} 不是非负整数,按「未设置」处理` });
    }
  }
  return rule;
}
function loadProviderConfig(raw) {
  const issues = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigValidationError(
      [{ path: "$", message: `配置根节点不是对象(${raw === null ? "null" : typeof raw})` }],
      "provider 配置根节点不是对象"
    );
  }
  const root = raw;
  if (root.version !== 1) {
    throw new ConfigValidationError(
      [{ path: "$.version", message: `无法识别的 version ${JSON.stringify(root.version)}(只支持 1)` }],
      `provider 配置 version 无法识别:${JSON.stringify(root.version)}`
    );
  }
  const snapshot = emptySnapshot();
  const providers = snapshot.providers;
  const realModels = snapshot.realModels;
  const accounts = snapshot.accounts;
  const logicalModels = snapshot.logicalModels;
  const rawProviders = Array.isArray(root.providers) ? root.providers : [];
  if (root.providers !== void 0 && !Array.isArray(root.providers)) {
    issues.push({ path: "$.providers", message: `providers 不是数组,按空处理` });
  }
  rawProviders.forEach((entry, i) => {
    const validated = validateProviderEntry(entry, i, issues);
    if (!validated) return;
    const prevProvider = snapshot.providers.get(validated.id);
    if (prevProvider) {
      issues.push({ path: `providers[${i}]`, message: `重复的 provider ${validated.id},已保留后者` });
    }
    providers.set(validated.id, {
      id: validated.id,
      baseUrl: validated.baseUrl,
      protocol: validated.protocol,
      envPrefix: validated.envPrefix
    });
    for (const model of validated.realModels) {
      realModels.set(`${model.provider}/${model.model}`, model);
    }
    for (const account of validated.accounts) {
      accounts.set(account.credentialRef, account);
    }
  });
  const rawLogical = Array.isArray(root.logicalModels) ? root.logicalModels : [];
  if (root.logicalModels !== void 0 && !Array.isArray(root.logicalModels)) {
    issues.push({ path: "$.logicalModels", message: `logicalModels 不是数组,按空处理` });
  }
  rawLogical.forEach((entry, i) => {
    const validated = validateLogicalModelEntry(entry, i, issues);
    if (!validated) return;
    const prev = snapshot.logicalModels.get(validated.name);
    if (prev) {
      issues.push({ path: `logicalModels[${i}]`, message: `重复的逻辑模型 ${validated.name},已保留后者` });
    }
    logicalModels.set(validated.name, validated);
  });
  const rawRules = Array.isArray(root.schedulerRules) ? root.schedulerRules : [];
  if (root.schedulerRules !== void 0 && !Array.isArray(root.schedulerRules)) {
    issues.push({ path: "$.schedulerRules", message: `schedulerRules 不是数组,按空处理` });
  }
  const rules = [];
  rawRules.forEach((entry, i) => {
    const validated = validateSchedulerRule(entry, `$.schedulerRules[${i}]`, issues);
    if (validated) rules.push(validated);
  });
  snapshot.schedulerRules = rules;
  return { snapshot, issues };
}
var ProviderRegistry = class _ProviderRegistry {
  constructor(filePath, snapshot, issues) {
    this.filePath = filePath;
    this.snapshot = snapshot;
    this.configIssues = issues;
  }
  filePath;
  snapshot;
  configIssues;
  listeners = /* @__PURE__ */ new Set();
  watcher = null;
  closed = false;
  /**
   * 加载 provider 配置文件。
   *
   * - 文件不存在 → 空注册表(首次安装,不算错误);
   * - JSON 语法错误 / 版本不认识 / 根节点不是对象 → 抛
   *   {@link ConfigValidationError}(issues 里带具体路径与原因);
   * - 结构问题 → 坏条目跳过 + ``registry.issues`` 可查。
   */
  static async load(filePath) {
    const result = readJsonFile(filePath);
    if (!result.ok) {
      if (result.missing) return new _ProviderRegistry(filePath, emptySnapshot(), []);
      throw new ConfigValidationError(
        [{ path: "$", message: `JSON 解析失败:${result.error}` }],
        `provider 配置文件无法解析`
      );
    }
    const { snapshot, issues } = loadProviderConfig(result.value);
    return new _ProviderRegistry(filePath, snapshot, issues);
  }
  /** 配置文件路径。 */
  get path() {
    return this.filePath;
  }
  /** 加载期产生的 issues(坏条目跳过 / 宽容忽略等;空数组 = 干净)。 */
  get issues() {
    return this.configIssues;
  }
  // ---------------------------------------------------------------- 查找
  /** 按 vendor(= provider id)查找 provider 定义;不存在 → ``null``。 */
  getProvider(vendorId) {
    return this.snapshot.providers.get(vendorId) ?? null;
  }
  /** 全部 provider 定义(按 id 升序,镜像 repo.providers() 的 ORDER BY id)。 */
  listProviders() {
    return [...this.snapshot.providers.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  /** 按协议过滤 provider(``openai`` / ``workbuddy`` / ``trae`` / ``sensenova``)。 */
  listProvidersByProtocol(protocol) {
    return this.listProviders().filter((p) => p.protocol === protocol);
  }
  /** 按 ``credentialRef``(``"<provider>/<username>"``)查找账户配置。 */
  getAccount(credentialRef) {
    return this.snapshot.accounts.get(credentialRef) ?? null;
  }
  /** 全部账户配置(可选按 provider 过滤;按 credentialRef 升序)。 */
  listAccounts(provider) {
    return [...this.snapshot.accounts.values()].filter((a) => provider === void 0 ? true : a.credentialRef.startsWith(`${provider}/`)).sort((a, b) => a.credentialRef < b.credentialRef ? -1 : a.credentialRef > b.credentialRef ? 1 : 0);
  }
  /** 已启用的账户(``enabled: false`` 的停用账户;参考实现无此维度 —— 见 AccountConfig 注释)。 */
  listEnabledAccounts(provider) {
    return this.listAccounts(provider).filter((a) => a.enabled);
  }
  /** 按 ``(provider, model)`` 查找真实模型定义。 */
  getRealModel(provider, model) {
    return this.snapshot.realModels.get(`${provider}/${model}`) ?? null;
  }
  /** 全部真实模型(可选按 provider 过滤)。 */
  listRealModels(provider) {
    return [...this.snapshot.realModels.values()].filter(
      (m) => provider === void 0 ? true : m.provider === provider
    );
  }
  /** 按名称查找逻辑模型(档链)。 */
  getLogicalModel(name) {
    return this.snapshot.logicalModels.get(name) ?? null;
  }
  /** 全部逻辑模型(按 name 升序)。 */
  listLogicalModels() {
    return [...this.snapshot.logicalModels.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  /** 档链成员(**数组顺序 = priority**;不存在 → 空数组)。 */
  membersOf(name) {
    return this.snapshot.logicalModels.get(name)?.members ?? [];
  }
  /** 档链策略(缺省 ``random`` —— 2026-10-26 用户 m15445 定案,镜像 repo.strategy_of 的 default 参数)。 */
  strategyOf(name) {
    return this.snapshot.logicalModels.get(name)?.strategy ?? DEFAULT_SCHEDULER_STRATEGY;
  }
  /** 调度规则(已归一化 + priority 推导;数组顺序 = 配置顺序)。 */
  listSchedulerRules() {
    return this.snapshot.schedulerRules;
  }
  /** 按 provider 过滤的调度规则(``cooldown`` 覆盖 / 免费档 / 时段规则等)。 */
  listSchedulerRulesFor(provider) {
    return this.snapshot.schedulerRules.filter((r) => r.provider === provider);
  }
  // ---------------------------------------------------------------- 热重载
  /**
   * 从**已有快照**构造(数据库投影路径)。
   *
   * 桌面端用户裁定(m28134):数据库是唯一真源,JSON 退化为导入/导出。
   * 于是注册表不再从文件加载,而是由装配层把
   * ``snapshotFromDb(db)``(见 db/registry-projection.ts)的结果喂进来。
   *
   * ``filePath`` 只用于诊断信息(日志/``registry.path``),不再被读取。
   */
  static fromSnapshot(snapshot, options = {}) {
    return new _ProviderRegistry(options.filePath ?? "<db>", snapshot, options.issues ?? []);
  }
  /**
   * 原地换快照(数据库写入之后调用)。
   *
   * 与 {@link reload} 的区别:不读文件、不抛错 —— 快照由调用方负责正确性
   * (装配层刚从库里投影出来)。换完发射 ``reloaded``,让订阅者
   * (面板缓存 / 调度器)知道该失效。
   */
  refreshFromSnapshot(snapshot, issues = []) {
    this.snapshot = snapshot;
    this.configIssues = issues;
    this.emit({ type: "reloaded", issues });
  }
  /**
   * 手动重新加载(``fs.watch`` 热重载失败时也会走这条路)。
   *
   * 成功 → 原子换快照 + 返回 ``{ reloaded: true }``;
   * 失败 → **保留上次好快照** + 返回 ``{ reloaded: false }`` 并发射
   * ``error`` 事件(热重载铁律:坏文件不炸运行中的系统)。
   */
  async reload() {
    try {
      const registry = await _ProviderRegistry.load(this.filePath);
      this.snapshot = registry.snapshot;
      this.configIssues = registry.issues;
      this.emit({ type: "reloaded", issues: this.configIssues });
      return { reloaded: true, issues: this.configIssues };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const issue = { path: "$", message: `热重载失败,保留上次好快照:${error.message}` };
      this.emit({ type: "error", error, issues: [issue] });
      return { reloaded: false, issues: [issue] };
    }
  }
  /**
   * 启动 ``fs.watch`` 防抖热重载(默认 100ms 防抖,见 store.ts)。
   *
   * @returns 句柄,``close()`` 停止监听。
   */
  async watch(options = {}) {
    if (this.watcher) return { close: () => this.watcher?.close() };
    const watcher = watchJsonFile(
      this.filePath,
      (text) => {
        void this.applyText(text);
      },
      (err) => {
        this.emit({
          type: "error",
          error: err,
          issues: [{ path: "$", message: `文件监听失败:${err.message}` }]
        });
      },
      { debounceMs: options.debounceMs }
    );
    this.watcher = watcher;
    return {
      close: () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      }
    };
  }
  /** 订阅热重载事件(``reloaded`` / ``error``);返回退订函数。 */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** 停止监听(幂等)。 */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }
  // ---------------------------------------------------------------- 内部
  /** 应用 watch 回调拿到的文件文本(解析 + 校验 + 原子换快照)。 */
  async applyText(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      this.emit({
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
        issues: [{ path: "$", message: `热重载解析失败,保留上次好快照:${err.message}` }]
      });
      return;
    }
    try {
      const { snapshot, issues } = loadProviderConfig(raw);
      this.snapshot = snapshot;
      this.configIssues = issues;
      this.emit({ type: "reloaded", issues });
    } catch (err) {
      this.emit({
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
        issues: [{ path: "$", message: `热重载校验失败,保留上次好快照:${err.message}` }]
      });
    }
  }
  emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }
};

// core/config/credentials.ts
import { createHash } from "node:crypto";
var CredentialError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options?.cause !== void 0 ? { cause: options.cause } : void 0);
    this.name = "CredentialError";
    this.code = code;
  }
};
var CredentialConfigError = class extends CredentialError {
  constructor(message, options) {
    super("credential-config", message, options);
    this.name = "CredentialConfigError";
  }
};
var UnsupportedBackendOperation = class extends CredentialError {
  constructor(operation) {
    super("unsupported-backend-operation", `后端不支持写操作:${operation}(凭据由宿主管理)`);
    this.name = "UnsupportedBackendOperation";
  }
};
function credentialKey(provider, username) {
  return `${provider}/${username}`;
}
function expiresAtOf(cred) {
  const fromColumn = normalizeExpiresSeconds(cred.expiresAt);
  if (fromColumn !== null) return fromColumn;
  for (const key of ["token_expires_at_ms", "expires_at"]) {
    const value = normalizeExpiresSeconds(cred.raw[key]);
    if (value !== null) return value;
  }
  return null;
}
function needsRefresh(cred, options = {}) {
  if (!cred.refreshSecret) return false;
  const expires = expiresAtOf(cred);
  if (expires === null) return true;
  const now = options.now ?? systemWallClock();
  return expires - (options.marginSeconds ?? 300) <= now;
}
function fingerprint(value) {
  if (!value) return null;
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}
function parseRaw(raw) {
  if (raw === null || raw === void 0) return {};
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return {};
    try {
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw;
}
function toCredential(row) {
  return {
    provider: row.provider,
    username: row.username,
    secret: row.secret,
    refreshSecret: row.refresh_secret,
    expiresAt: row.expires_at,
    raw: parseRaw(row.raw_json)
  };
}
function toStored(cred) {
  return {
    provider: cred.provider,
    username: cred.username,
    secret: cred.secret,
    refresh_secret: cred.refreshSecret,
    expires_at: cred.expiresAt,
    // ⚠️ `raw_json` 落盘成 **JSON 字符串**,与 DB 列语义一致
    // (`credentials.py` 那一列就是 TEXT,读侧 `json.loads`)。以前这里直接写对象,
    // 于是同一个文件里两种形态并存 —— 读侧只认一种,于是另一种的数据「静默丢失」。
    // 现在写读都用「JSON 字符串」这一种,`parseRaw` 两种都吃(兼容旧文件)。
    raw_json: JSON.stringify(cred.raw ?? {})
  };
}
var FileCredentialBackend = class {
  constructor(filePath) {
    this.filePath = filePath;
  }
  filePath;
  name = "file";
  writable = true;
  rows = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  loaded = null;
  unsubscribeWatch = null;
  closed = false;
  /** 路径注入点:文件路径由调用方给(测试 = 临时目录)。 */
  get path() {
    return this.filePath;
  }
  onChange(listener) {
    this.listeners.add(listener);
    void this.ensureLoaded();
    return () => this.listeners.delete(listener);
  }
  /** 停止 watch(进程退出 / 测试清理用)。 */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeWatch?.();
    this.unsubscribeWatch = null;
  }
  async list() {
    await this.ensureLoaded();
    return [...this.rows.values()];
  }
  async get(provider, username) {
    await this.ensureLoaded();
    return this.rows.get(credentialKey(provider, username)) ?? null;
  }
  async put(record) {
    await this.ensureLoaded();
    this.rows.set(credentialKey(record.provider, record.username), record);
    this.persist();
  }
  async remove(provider, username) {
    await this.ensureLoaded();
    const existed = this.rows.delete(credentialKey(provider, username));
    if (existed) this.persist();
    return existed;
  }
  // ---------------------------------------------------------------- 内部
  ensureLoaded() {
    if (!this.loaded) this.loaded = this.doLoad();
    return this.loaded;
  }
  async doLoad() {
    const result = readJsonFile(this.filePath);
    if (!result.ok) {
      if (result.missing) {
        this.rows = /* @__PURE__ */ new Map();
        this.startWatch();
        return;
      }
      throw new CredentialConfigError(`凭据文件无法解析:${result.error}`, { cause: result.error });
    }
    const doc = result.value;
    const rows = Array.isArray(doc.credentials) ? doc.credentials : [];
    const next = /* @__PURE__ */ new Map();
    for (const row of rows) {
      if (!isStoredCredential(row)) {
        console.warn("[config/credentials] 跳过非法凭据行:", row);
        continue;
      }
      next.set(credentialKey(row.provider, row.username), row);
    }
    this.rows = next;
    this.startWatch();
  }
  /** 原子写整个文件(临时文件 + rename + 回读校验,见 store.ts)。 */
  persist() {
    const doc = {
      version: 1,
      credentials: [...this.rows.values()]
    };
    writeJsonFileAtomic(this.filePath, doc);
  }
  /** 启动 ``fs.watch``:外部改文件 → 重载 + diff 发射 ``external`` 事件。 */
  startWatch() {
    if (this.unsubscribeWatch || this.closed) return;
    const watcher = watchJsonFile(
      this.filePath,
      (text) => {
        void this.reloadFromText(text);
      },
      () => {
      }
    );
    this.unsubscribeWatch = () => watcher.close();
  }
  /** 从文件文本重载并 diff(与内存里现有行比对,只发射真变化)。 */
  async reloadFromText(text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return;
    }
    const rows = Array.isArray(doc.credentials) ? doc.credentials : [];
    const next = /* @__PURE__ */ new Map();
    for (const row of rows) {
      if (!isStoredCredential(row)) continue;
      next.set(credentialKey(row.provider, row.username), row);
    }
    const events = [];
    for (const [key, row] of next) {
      const prev = this.rows.get(key);
      if (!prev || !sameStored(prev, row)) {
        events.push({ type: "external", provider: row.provider, username: row.username });
      }
    }
    for (const key of this.rows.keys()) {
      if (!next.has(key)) {
        const prev = this.rows.get(key);
        events.push({ type: "external", provider: prev.provider, username: prev.username });
      }
    }
    this.rows = next;
    if (events.length > 0) this.emit(events);
  }
  emit(events) {
    for (const listener of [...this.listeners]) listener(events);
  }
};
function isStoredCredential(value) {
  if (typeof value !== "object" || value === null) return false;
  const row = value;
  return typeof row.provider === "string" && row.provider !== "" && typeof row.username === "string" && (row.secret === null || row.secret === void 0 || typeof row.secret === "string") && (row.refresh_secret === null || row.refresh_secret === void 0 || typeof row.refresh_secret === "string") && (row.expires_at === null || row.expires_at === void 0 || typeof row.expires_at === "number" && Number.isFinite(row.expires_at));
}
function sameStored(a, b) {
  return a.provider === b.provider && a.username === b.username && a.secret === b.secret && a.refresh_secret === b.refresh_secret && a.expires_at === b.expires_at && JSON.stringify(a.raw_json ?? null) === JSON.stringify(b.raw_json ?? null);
}
var CredentialVault = class {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.clock = options.clock ?? systemWallClock;
    if (backend.onChange) {
      this.unsubscribeBackend = backend.onChange((events) => this.emit(events));
    }
  }
  backend;
  listeners = /* @__PURE__ */ new Set();
  clock;
  unsubscribeBackend = null;
  /** 后端标识(``memory`` / ``file`` / ``dsh`` …)。 */
  get backendName() {
    return this.backend.name;
  }
  // ---------------------------------------------------------------- 读
  /** 完整凭据记录(含密钥)—— **仅进程内**使用,绝不进日志 / 响应。 */
  async get(provider, username) {
    const row = await this.backend.get(provider, username);
    return row ? toCredential(row) : null;
  }
  /** 凭据摘要(**不含密钥**;面板 / 日志 / 健康快照唯一出口)。 */
  async describe(provider, username) {
    const cred = await this.get(provider, username);
    return cred ? toSummary(cred) : null;
  }
  /**
   * 凭据清单(**不含密钥**),按 ``(provider, username)`` 排序 ——
   * 镜像 repo.py L696-704 ``credentials()`` 的 ``ORDER BY provider, username``。
   */
  async list(provider) {
    const rows = await this.backend.list();
    return rows.map(toCredential).filter((cred) => provider === void 0 ? true : cred.provider === provider).sort((a, b) => (a.provider === b.provider ? 0 : a.provider < b.provider ? -1 : 1) || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0)).map(toSummary);
  }
  /**
   * **唯一明文出口** —— 取某条凭据的 secret(镜像 repo.py L716-721
   * ``credential_secret``)。调用方必须自己拿去做 HTTP 头,
   * 且**永不**把它写进日志 / 响应 / 错误消息。
   */
  async secret(provider, username) {
    const row = await this.backend.get(provider, username);
    return row?.secret ?? null;
  }
  /**
   * 某 provider 全部凭据的 ``{username: secret}``(镜像 repo.py L723-730
   * ``secrets_for``,面板探测 / 连接器用)。
   *
   * ⚠️ **有意偏差**:``str(r["secret"])`` 会把
   * NULL 变成字符串 ``"None"``(Python 语义);TS 侧**跳过** secret 为
   * null 的行 —— 探测结果里出现 "None" 字符串是明确的 bug 特征。
   */
  async secretsFor(provider) {
    const rows = await this.backend.list();
    const out = /* @__PURE__ */ new Map();
    for (const row of rows) {
      if (row.provider === provider && row.secret !== null) {
        out.set(row.username, row.secret);
      }
    }
    return out;
  }
  /** 令牌到期时刻(epoch 秒,``null`` = 未知)—— 委托 {@link expiresAtOf}。 */
  async expiresAt(provider, username) {
    const cred = await this.get(provider, username);
    return cred ? expiresAtOf(cred) : null;
  }
  /** 是否该刷新(见 {@link needsRefresh};可注入 ``now`` 便于测试)。 */
  async shouldRefresh(provider, username, options = {}) {
    const cred = await this.get(provider, username);
    if (!cred) return false;
    return needsRefresh(cred, { ...options, now: this.clock() });
  }
  // ---------------------------------------------------------------- 写
  /**
   * 登记 / 覆盖一条凭据(镜像 ``upsert_credential`` + ``save_tokens``):
   *
   * - ``provider`` 必填非空(空 provider 无法兜底 username);
   * - ``username`` 空 → 兜底成 provider 名(repo.py L675);
   * - 每个字段:**给了(非 undefined)就覆盖**,``null`` 显式清空,
   *   ``undefined`` 保留原值 —— 与 save_tokens「refresh_token 只在拿到
   *   新值时覆盖」(L267-268)同哲学;
   * - ``expiresAt`` 单位是**秒**(写入前不替调用方猜单位)。
   */
  async put(input) {
    this.assertWritable("put");
    const provider = requireNonEmpty(input.provider, "provider");
    const username = (input.username ?? "").trim() || provider;
    const existingRow = await this.backend.get(provider, username);
    const existing = existingRow ? toCredential(existingRow) : null;
    const merged = {
      provider,
      username,
      secret: input.secret !== void 0 ? input.secret : existing?.secret ?? null,
      refreshSecret: input.refreshSecret !== void 0 ? input.refreshSecret : existing?.refreshSecret ?? null,
      expiresAt: input.expiresAt !== void 0 ? input.expiresAt : existing?.expiresAt ?? null,
      raw: input.raw != null ? input.raw : existing?.raw ?? {}
    };
    await this.backend.put(toStored(merged));
    this.emit([{ type: "put", provider, username }]);
    return merged;
  }
  /**
   * 热轮换 —— 刷新结果写回(镜像 ``save_tokens``,credentials.py L260-327):
   *
   * - ``secret`` 立即覆盖(无宽限期,见文件头「热轮换语义」);
   * - ``refreshSecret`` **只在拿到新值时覆盖**(上游可能不轮换,L267-268);
   * - ``expiresAt`` 给了就覆盖,并把 ``raw_json`` 里的到期字段
   *   (``token_expires_at_ms`` / ``expires_at``,若存在)同步成**毫秒**
   *   (L293-298 —— 否则库里两处并存且不一致,下次直接读 raw 的代码会拿到
   *   过期数据);
   * - 发射 ``rotate`` 事件(在途请求手里仍是旧令牌字符串副本,用到失效为止)。
   */
  async rotate(provider, username, update) {
    this.assertWritable("rotate");
    const existing = await this.get(provider, username);
    if (!existing) {
      throw new CredentialConfigError(`轮换失败:凭据不存在 ${credentialKey(provider, username)}`);
    }
    const next = {
      ...existing,
      secret: update.secret !== void 0 ? update.secret : existing.secret,
      refreshSecret: update.refreshSecret !== void 0 ? update.refreshSecret : existing.refreshSecret,
      expiresAt: update.expiresAt !== void 0 ? update.expiresAt : existing.expiresAt
    };
    if (update.expiresAt !== void 0) {
      const stamp = update.expiresAt === null ? null : Math.trunc(update.expiresAt * 1e3);
      const raw = { ...next.raw };
      let touched = false;
      for (const key of ["token_expires_at_ms", "expires_at"]) {
        if (key in raw) {
          raw[key] = stamp;
          touched = true;
        }
      }
      if (touched) next.raw = raw;
    }
    await this.backend.put(toStored(next));
    this.emit([{ type: "rotate", provider, username }]);
    return next;
  }
  /** 删除一条凭据(镜像 repo.py L732-736 ``delete_credential``)。 */
  async remove(provider, username) {
    this.assertWritable("remove");
    const existed = await this.backend.remove(provider, username);
    if (existed) this.emit([{ type: "remove", provider, username }]);
    return existed;
  }
  // ---------------------------------------------------------------- 事件 / 生命周期
  /** 订阅变更(本进程写 + 后端推送);返回退订函数。 */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** 停止后端 watch(幂等)。 */
  close() {
    if (this.backend instanceof FileCredentialBackend) this.backend.close();
    this.unsubscribeBackend?.();
    this.unsubscribeBackend = null;
    this.listeners.clear();
  }
  // ---------------------------------------------------------------- 内部
  assertWritable(operation) {
    if (!this.backend.writable) throw new UnsupportedBackendOperation(operation);
  }
  emit(events) {
    for (const listener of [...this.listeners]) listener(events);
  }
};
function toSummary(cred) {
  return {
    provider: cred.provider,
    username: cred.username,
    key: credentialKey(cred.provider, cred.username),
    expiresAt: cred.expiresAt,
    raw: cred.raw
  };
}
function requireNonEmpty(value, field) {
  if (typeof value !== "string" || value === "") {
    throw new CredentialConfigError(`凭据字段 ${field} 必须是非空字符串`);
  }
  return value;
}

// core/db/credential-backend.ts
function rowToStored(row) {
  const out = {
    provider: row.provider,
    username: row.username,
    secret: row.secret ?? null,
    refresh_secret: row.refresh_secret ?? null,
    expires_at: row.expires_at ?? null
  };
  if (row.raw_json !== null) out.raw_json = row.raw_json;
  return out;
}
function storedToRow(record) {
  let rawJson = null;
  if (typeof record.raw_json === "string") rawJson = record.raw_json;
  else if (record.raw_json !== null && record.raw_json !== void 0) rawJson = JSON.stringify(record.raw_json);
  return {
    provider: record.provider,
    username: record.username,
    secret: record.secret ?? null,
    refresh_secret: record.refresh_secret ?? null,
    expires_at: record.expires_at ?? null,
    raw_json: rawJson
  };
}
var DbCredentialBackend = class {
  constructor(db) {
    this.db = db;
  }
  db;
  name = "db";
  writable = true;
  listeners = /* @__PURE__ */ new Set();
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async list() {
    return this.db.credential.list().map(rowToStored);
  }
  async get(provider, username) {
    const row = this.db.credential.get(provider, username);
    return row ? rowToStored(row) : null;
  }
  async put(record) {
    this.db.credential.set(storedToRow(record));
  }
  async remove(provider, username) {
    if (!this.db.credential.get(provider, username)) return false;
    this.db.credential.delete(provider, username);
    return true;
  }
  emit(events) {
    for (const listener of [...this.listeners]) listener(events);
  }
};

// core/db/registry-projection.ts
function toProtocol(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PROVIDER_PROTOCOLS.includes(text) ? text : "openai";
}
function realModelKey(provider, model) {
  return `${provider}/${model}`;
}
function parseMembersColumn(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of parsed) {
    let provider = "";
    let model = "";
    if (typeof item === "string") {
      const slash = item.indexOf("/");
      if (slash <= 0 || slash === item.length - 1) continue;
      provider = item.slice(0, slash).trim();
      model = item.slice(slash + 1).trim();
    } else if (item && typeof item === "object") {
      const rec = item;
      provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
      model = typeof rec.model === "string" ? rec.model.trim() : "";
    }
    if (!provider || !model) continue;
    const key = realModelKey(provider, model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, model });
  }
  return out;
}
function parseSchedulerRulesFromDb(db) {
  const out = [];
  let any = false;
  for (const p of RULES_PRIORITY_KEYS) {
    const row = db.setting.get(rulesKeyOf(p));
    if (row === null || row === void 0 || !row.v) continue;
    any = true;
    let parsed;
    try {
      parsed = JSON.parse(row.v);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const r of validRules(parsed)) {
      out.push({ ...r, priority: p });
    }
  }
  if (any) return out;
  const legacyRow = db.setting.get("scheduler.rules");
  return parseSchedulerRulesColumn(legacyRow?.v ?? null);
}
function parseSchedulerRulesColumn(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const container = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.rules) ? parsed.rules : [];
  return validRules(container);
}
function toRealModel(row) {
  return {
    provider: row.provider,
    model: row.model,
    name: row.name ?? null,
    supportsVision: Number(row.supports_vision) !== 0,
    maxInputTokens: row.max_input_tokens ?? null,
    maxOutputTokens: row.max_output_tokens ?? null,
    hidden: Number(row.hidden) !== 0,
    concurrency: row.concurrency ?? null
  };
}
function toLogicalModel(row) {
  const strategy = row.strategy === "random" ? "random" : "due-first";
  return {
    name: row.name,
    strategy,
    members: parseMembersColumn(row.members)
  };
}
function snapshotFromDb(db) {
  const providers = /* @__PURE__ */ new Map();
  for (const row of db.provider.list()) {
    providers.set(row.id, {
      id: row.id,
      baseUrl: row.base_url ?? null,
      protocol: toProtocol(row.protocol),
      envPrefix: row.env_prefix ?? null
    });
  }
  const realModels = /* @__PURE__ */ new Map();
  for (const row of db.realModel.list()) {
    realModels.set(realModelKey(row.provider, row.model), toRealModel(row));
  }
  const logicalModels = /* @__PURE__ */ new Map();
  for (const row of db.logicalModel.list()) {
    logicalModels.set(row.name, toLogicalModel(row));
  }
  const accounts = /* @__PURE__ */ new Map();
  for (const row of db.credential.list()) {
    const credentialRef = `${row.provider}/${row.username}`;
    accounts.set(credentialRef, {
      credentialRef,
      enabled: true,
      cooldownOverrideMinutes: null,
      sessionPinTtlSeconds: null
    });
  }
  const schedulerRules = parseSchedulerRulesFromDb(db);
  return {
    snapshot: { providers, realModels, accounts, logicalModels, schedulerRules },
    issues: []
  };
}

// core/router/clock.ts
var systemClock = {
  monoNow: () => performance.now() / 1e3,
  wallNow: () => Date.now() / 1e3
};

// core/router/types.ts
var UpstreamErrorKind2 = {
  /** 429 / 账号额度耗尽 —— 换下一台 */
  RateLimit: "rate_limit",
  /** 401 / 403 —— 账号失效,冷却并登记强制刷新 */
  Auth: "auth",
  /** 验证码等「不该重试」的 502 */
  AuthChallenge: "auth_challenge",
  /** 5xx —— 计入冷却,可重试 */
  Upstream: "upstream",
  /** 其余 4xx —— 请求本身有问题,原样返回不重试 */
  BadRequest: "bad_request",
  /** 超时 */
  Timeout: "timeout",
  /** 连不上 */
  Connection: "connection",
  /** 流已开始,无法再换号(响应已发出) */
  AlreadyStreaming: "already_streaming"
};
var TRANSIENT_KINDS = /* @__PURE__ */ new Set([
  UpstreamErrorKind2.Timeout,
  UpstreamErrorKind2.Connection,
  "client_disconnected"
]);
var SPORADIC_STATUS_GRACE = /* @__PURE__ */ new Map([["codearts", /* @__PURE__ */ new Set([502])]]);
function isSporadicGraceStatus(provider, status) {
  if (!provider) return false;
  const set = SPORADIC_STATUS_GRACE.get(provider.trim().toLowerCase());
  return set !== void 0 && set.has(status);
}
function withEndpointViews(seed) {
  const endpoint = seed;
  const descriptors = {
    realModelKey: {
      enumerable: false,
      configurable: false,
      get() {
        return realModelKeyOf(this.provider, this.model);
      }
    },
    username: {
      enumerable: false,
      configurable: false,
      get() {
        return this.credentialKey[1] ?? "";
      }
    },
    inCooldown: {
      enumerable: false,
      configurable: false,
      value(now) {
        const rec = this.health;
        if (rec !== null && rec !== void 0) {
          return healthInCooldown(rec, now);
        }
        return this.cooldownUntil > 0 && this.cooldownUntil > now;
      }
    }
  };
  return Object.defineProperties(endpoint, descriptors);
}
function emptyHealth() {
  return {
    fails: 0,
    cooldownUntil: 0,
    lastError: "",
    updatedAt: 0,
    lastKind: "",
    lastStatus: 0
  };
}
function noteFailure(health, opts = {}) {
  const now = opts.now ?? 0;
  const until = opts.hint?.until ?? null;
  const kind = opts.kind ?? "";
  const error = (opts.error ?? "").slice(0, 200);
  const status = Number.isFinite(opts.status ?? 0) ? Math.trunc(opts.status ?? 0) : 0;
  const next = {
    ...health,
    fails: health.fails + 1,
    lastError: error,
    lastKind: kind,
    lastStatus: status,
    updatedAt: now
  };
  const untilIsUpstream = opts.hint?.untilSource === "upstream";
  if (until !== null && Number.isFinite(until) && untilIsUpstream) {
    next.cooldownUntil = Number(until);
    return next;
  }
  if (TRANSIENT_KINDS.has(kind)) {
    return next;
  }
  if (until !== null && Number.isFinite(until)) {
    next.cooldownUntil = Number(until);
    return next;
  }
  if (health.fails === 0 && isSporadicGraceStatus(opts.provider, status) && !TRANSIENT_KINDS.has(kind)) {
    return next;
  }
  const floor = opts.hint?.policy ? Number(opts.hint.policy.cooldownFloorS) : 0;
  next.cooldownUntil = now + (Number.isFinite(floor) ? floor : 0);
  return next;
}
function noteSuccess(health, now) {
  return {
    ...health,
    fails: 0,
    cooldownUntil: 0,
    lastError: "",
    lastKind: "",
    lastStatus: 0,
    updatedAt: now
  };
}
function inCooldown(health, now) {
  if (health.cooldownUntil <= 0) {
    return false;
  }
  return health.cooldownUntil > now;
}
var healthInCooldown = inCooldown;
function planResult(item, reason, byAffinity = false) {
  return { item, reason, byAffinity };
}
var PREEMPT_ERROR = "preempted by direct request";
var DEFAULT_LEASE_SECONDS = 600;
var DEFAULT_RETAIN_SECONDS = 180;
var DEFAULT_MAX_RECENT = 200;
var DEFAULT_PIN_SECONDS = 900;
var DEFAULT_RECENT_LIMIT = 50;
var DEFAULT_LOGICAL_COOLDOWN_MIN = 15;
var PY_FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
var PY_INT_RE = /^[+-]?\d+$/;
function coerceRetryNumber(raw, fallback) {
  const text = raw === null || raw === void 0 ? "" : String(raw).trim();
  if (text === "" || !PY_FLOAT_RE.test(text)) {
    return fallback;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}
function parseStrictInt(raw, fallback, min = 1) {
  const text = raw === null || raw === void 0 ? "" : String(raw).trim();
  if (text === "" || !PY_INT_RE.test(text)) {
    return fallback;
  }
  const value = Number(text);
  return Number.isFinite(value) && value >= min ? value : fallback;
}
var CONV_ORDER_LIMIT = 2048;
var LOAD_AWARE_STRATEGIES = /* @__PURE__ */ new Set([
  "least-busy",
  "balanced"
]);
function realModelKeyOf(provider, model) {
  return `${provider}/${model}`;
}
function endpointIdOf2(provider, model, username) {
  return `${provider}/${model}@${provider}/${username}`;
}
function credentialKeyOf(data, provider) {
  const cred = data.credentialKey;
  if (Array.isArray(cred) && cred.length >= 2) {
    return [String(cred[0] || provider), String(cred[1])];
  }
  if (typeof cred === "string" && cred !== "") {
    const at = cred.indexOf("/");
    if (at >= 0) {
      const head = cred.slice(0, at);
      return [head || provider, cred.slice(at + 1)];
    }
    return [provider, cred];
  }
  const username = data.username ?? data.accountId ?? "";
  return [provider, String(username)];
}
function endpointFrom(data) {
  const provider = String(data.provider ?? data.providerId ?? "");
  const model = String(data.model ?? data.upstreamId ?? "");
  const credentialKey2 = credentialKeyOf(data, provider);
  const endpointId = data.endpointId && String(data.endpointId) !== "" ? String(data.endpointId) : endpointIdOf2(provider, model, credentialKey2[1]);
  const concurrencyRaw = data.concurrency ?? 1;
  return withEndpointViews({
    endpointId,
    provider,
    model,
    credentialKey: credentialKey2,
    protocol: data.protocol ?? "openai",
    baseUrl: data.baseUrl ?? null,
    region: data.region ?? null,
    concurrency: typeof concurrencyRaw === "number" && Number.isFinite(concurrencyRaw) ? Math.max(1, Math.trunc(concurrencyRaw)) : Number.parseInt(String(concurrencyRaw), 10) > 0 ? Number.parseInt(String(concurrencyRaw), 10) : 1,
    supportsVision: Boolean(data.supportsVision),
    maxInputTokens: data.maxInputTokens ?? null,
    maxOutputTokens: data.maxOutputTokens ?? null,
    cooldownUntil: Number(data.cooldownUntil) || 0,
    health: null
  });
}
function chainItemFrom(data) {
  return {
    endpoint: endpointFrom(data.endpoint),
    priority: Number(data.priority) || 0,
    blackout: data.blackout ?? null,
    strategy: data.strategy ?? "",
    // ⚠️ degraded 必须透传:least-busy / balanced 不看链序,只认这个标记。
    degraded: data.degraded === true,
    // ⚠️ direct 必须透传:丢了它,直连请求就走不上 m02240 的抢占语义
    // (plan 的 ignoreCooldown / commit 的 acquireDirect 都靠它判定)。
    direct: data.direct === true
  };
}
var SETTING_COOLDOWN_OVERRIDES = "scheduler.cooldown_overrides";
var SETTING_LOGICAL_COOLDOWN = "retry.logical_cooldown";
var SETTING_RECENT_LIMIT = "ui.recent_limit";

// core/router/health.ts
var HealthRegistry = class {
  items = /* @__PURE__ */ new Map();
  wallNow;
  constructor(opts = {}) {
    this.wallNow = opts.wallNow ?? (() => Date.now() / 1e3);
  }
  /**
   * 取(或建)**不落表**的记录 —— 只读查询不该让表无限增长。
   *
   * 返回的是**表内那条**(调用方若改了它,表就跟着变);表里没有则返回一个
   * 全新的空记录(表不变)。与 Python 版一致:调用方要落库得显式调 `put` / `note`。
   */
  get(endpointId) {
    const rec = this.items.get(endpointId);
    return rec === void 0 ? emptyHealth() : rec;
  }
  /** 表里是否**真的**有这条记录(`get` 会凭空造一条,这个方法不会)。 */
  known(endpointId) {
    return this.items.has(endpointId);
  }
  /** 显式写入一条记录(表内替换 / 新增)。 */
  put(endpointId, rec) {
    this.items.set(endpointId, rec);
  }
  /** 记一次成败(成功清零并解冻;失败 +1 并进入冷却)。 */
  note(endpointId, opts) {
    const now = opts.now ?? this.wallNow();
    const base = this.items.get(endpointId) ?? emptyHealth();
    const rec = opts.ok ? noteSuccess(base, now) : noteFailure(base, {
      error: opts.error,
      kind: opts.kind,
      status: opts.status,
      now,
      hint: { until: opts.until ?? null, policy: opts.policy ?? null },
      provider: opts.provider
    });
    this.items.set(endpointId, rec);
    return rec;
  }
  /** 强制解冻(凭据刷新成功后由维护循环调用)—— 直接删记录,回到「没有记录 = 可用」。 */
  clear(endpointId) {
    this.items.delete(endpointId);
  }
  /**
   * **批量解冻**:删掉所有满足 `pred` 的记录,返回删掉的条数。
   *
   * 用于「某个账号的凭据换新了 —— 它在**所有**真实模型上的冷却都该解除」
   * ({@link Router.thawAccount}):一把失效的 key 会在多个模型端点上各落
   * 一次冷却,只清当前这一台的话,换档到同账号的别的模型还是被挡着。
   *
   * ⚠️ 与 `clear` 同语义:**删记录 = 回到未知/可用**,不是「记一次成功」。
   * 换新凭据后若仍不灵,下一轮请求会重新落冷却 —— 不掩盖真实故障。
   */
  clearWhere(pred) {
    let n = 0;
    for (const key of [...this.items.keys()]) {
      let hit = false;
      try {
        hit = pred(key);
      } catch {
        hit = false;
      }
      if (!hit) continue;
      this.items.delete(key);
      n += 1;
    }
    return n;
  }
  /** 当前处于冷却中的记录(按 `endpointId` 排序,与面板契约形状一致)。 */
  cooled(now = this.wallNow()) {
    return [...this.items.entries()].filter(([, rec]) => inCooldown(rec, now)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, rec]) => rec);
  }
  /** 健康账本快照(排障 / 面板用)。 */
  snapshot(now = this.wallNow()) {
    const items = {};
    let cooling = 0;
    for (const key of [...this.items.keys()].sort()) {
      const rec = this.items.get(key);
      if (rec === void 0) {
        continue;
      }
      items[key] = rec;
      if (inCooldown(rec, now)) {
        cooling += 1;
      }
    }
    return { tracked: this.items.size, cooling, items };
  }
  /**
   * 丢掉「早就冷却完了又一直没被选中」的记录,避免表无限增长。
   * @returns 丢掉的条数
   */
  purgeExpired(now = this.wallNow()) {
    const stale = [...this.items.entries()].filter(([, rec]) => rec.fails > 0 && !inCooldown(rec, now)).map(([key]) => key);
    for (const key of stale) {
      this.items.delete(key);
    }
    return stale.length;
  }
};

// core/router/inflight-ledger.ts
var LEASE_EXPIRED_ERROR = "lease expired (no outcome reported)";
function archivedRow(lease, finishedAt) {
  return {
    lease,
    finishedAt,
    ok: false,
    status: 0,
    error: LEASE_EXPIRED_ERROR,
    latencyMs: 0,
    ttftMs: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0
  };
}
var InflightLedger = class {
  leaseSeconds;
  /** ⚠️ 已退役:保留期不再有行为,留着只为不破坏既有构造点。 */
  retainSeconds;
  maxRecent;
  maxRecentFn;
  clock;
  /**
   * 上次问到的容量。**只是「保留区还没到那个数就不可能超容」的短路**,
   * 不是权威值(权威值每次都问 {@link recentCapacity})。初值 0 保证第一次收尾
   * 一定真问一次 —— 否则配置比 `maxRecent` 小时会被这个短路挡住。
   */
  recentHint = 0;
  /**
   * `容量键 -> Map<leaseId, lease>`。
   *
   * ⚠️ 容量键 = **端点 id**(`provider/model@username`,见 {@link capacityKeyOf});只有
   * 调用方没给端点(旧调用点 / 单测)时才退回真实模型 id。计数按凭据各算一份 ——
   * 这就是「concurrency 是每个凭据的并发」的落点。
   */
  leases = /* @__PURE__ */ new Map();
  /** `leaseId -> 容量键`,让 `release` / `touch` O(1) 定位 */
  index = /* @__PURE__ */ new Map();
  /**
   * `leaseId -> 抢占通知回调`(m02240)。
   *
   * ⚠️ **不进 `InflightLease` 对象**:那个对象会经 `detail()` 交给面板序列化
   * (JSON 丢函数、IPC 上更糟)。回调只在**进程内**有意义,所以单独一张表。
   *
   * 表项在租约释放时同步删掉 —— 回调表必须和租约**同生共死**,否则一次
   * 抢占之后,那个回调会被后来的同号租约误触发(句柄复用 → 打断别人的请求)。
   */
  preemptHooks = /* @__PURE__ */ new Map();
  /** 对外展示用的运行序号(单调递增) */
  seq = 0;
  /** `sessionId -> 会话序号`(面板 `#对话#请求` 的左半段) */
  convOrder = /* @__PURE__ */ new Map();
  /** 会话序号分配游标。**只增不减**,所以淘汰不会让两个可见会话撞号。 */
  convSeq = 0;
  /** 保留区:已结束的请求(按结束时刻从旧到新)。只按**当前容量**清,没有时间窗。 */
  recent = [];
  constructor(opts = {}) {
    this.leaseSeconds = Number(opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS);
    this.retainSeconds = Number(opts.retainSeconds ?? DEFAULT_RETAIN_SECONDS);
    this.maxRecent = Math.max(1, Math.trunc(Number(opts.maxRecent ?? DEFAULT_MAX_RECENT)));
    this.maxRecentFn = opts.maxRecentFn ?? null;
    this.clock = opts.clock ?? systemClock;
  }
  /** 在途租约租期(秒)。 */
  get leaseSecondsValue() {
    return this.leaseSeconds;
  }
  /** 已退役:保留期不再有行为,留着只为不破坏既有调用点。 */
  get retainSecondsValue() {
    return this.retainSeconds;
  }
  // ------------------------------------------------------------- 容量核算
  /**
   * 容量键:端点 id 优先,缺省退回真实模型 id。
   *
   * ⚠️ 退回分支只为兼容**没传端点**的旧调用点与单测;生产路径(`Router.commit` /
   * `Planner.commit`)永远带 `endpointId` —— 少了端点就退回「所有凭据共用一个桶」,
   * 语义务必在调用方保证。
   */
  capacityKeyOf(realModelId, endpointId) {
    return endpointId !== void 0 && endpointId !== "" ? endpointId : realModelId;
  }
  /**
   * 该**容量键**(通常是端点)当前有几条在途租约。
   *
   * ⚠️ 与 Python 版一致:先清理过期租约再数 —— 一次只读查询不该让账本停在旧值上。
   */
  inFlight(capacityKey, now = this.clock.monoNow()) {
    this.purge(now);
    return this.leases.get(capacityKey)?.size ?? 0;
  }
  /**
   * 该容量键是否还有空位(`concurrency` 会被夹到 ≥1)。
   *
   * ⚠️ 键是**端点**,不是真实模型:同一个真实模型下不同凭据互不占槽
   * (concurrency=1 + 3 凭据 = 3 并发)。
   */
  hasRoom(capacityKey, concurrency, now = this.clock.monoNow()) {
    return this.inFlight(capacityKey, now) < Math.max(1, Math.trunc(concurrency));
  }
  /**
   * 该容量键上是否还有**可被抢占的逻辑租约**(m02240)。
   *
   * 直连请求专用:桶满了的时候,只有「还剩一条逻辑租约」才谈得上抢占 ——
   * 全是直连在途的话,`acquireDirect` 会返回 `null`(没有可让的对象),
   * 调用方按「无可用」处理。
   *
   * ⚠️ 只数**非直连**租约:直连之间不互抢(直连是「用户点名要这个真实模型」,
   * 抢另一个直连的槽位等于让两个点名请求互相打架,谁都不该赢)。
   *
   * ⚠️ 抢占粒度跟着容量键走(2026-11-08):只在该**端点**的桶里找受害者 ——
   * 直连请求要的是这个凭据的槽,踢别的凭据的租约不会给它腾出这个槽。
   */
  hasPreemptable(capacityKey, now = this.clock.monoNow()) {
    this.purge(now);
    const bucket = this.leases.get(capacityKey);
    if (bucket === void 0) {
      return false;
    }
    for (const lease of bucket.values()) {
      if (lease.direct !== true) {
        return true;
      }
    }
    return false;
  }
  // ------------------------------------------------------------- 租约生命周期
  /**
   * 占一条租约,返回句柄。**释放必须用这个句柄**({@link release})。
   *
   * @param realModelId 真实模型 id(`"provider/model"`,**仅用于展示聚合 / 抢占标记**)
   * @param endpointId 端点身份(`"provider/model@username"`)= **容量键**(按凭据计);
   *   缺省时退回 `realModelId`(旧调用点兼容,见 {@link capacityKeyOf})
   * @param logicalModel 客户端要的那个名字(可能是逻辑模型,也可能是直连真实模型)
   * @param sessionId 只用于内部分组,**绝不出现在对外响应里**
   */
  acquire(realModelId, opts = {}) {
    const now = opts.now ?? this.clock.monoNow();
    this.purge(now);
    this.seq += 1;
    const leaseId = `${this.seq}`;
    const lease = {
      leaseId,
      seq: this.seq,
      realModelId,
      endpointId: opts.endpointId ?? "",
      logicalModel: opts.logicalModel ?? "",
      sessionId: opts.sessionId ?? "",
      stream: opts.stream ?? false,
      direct: opts.direct === true,
      startedAt: now,
      expiresAt: now + this.leaseSeconds,
      convNo: this.convNo(opts.sessionId ?? "")
    };
    const capacityKey = this.capacityKeyOf(realModelId, opts.endpointId);
    let bucket = this.leases.get(capacityKey);
    if (bucket === void 0) {
      bucket = /* @__PURE__ */ new Map();
      this.leases.set(capacityKey, bucket);
    }
    bucket.set(leaseId, lease);
    this.index.set(leaseId, capacityKey);
    if (opts.onPreempt !== void 0) {
      this.preemptHooks.set(leaseId, opts.onPreempt);
    }
    return leaseId;
  }
  /**
   * **抢占式**获取(m02240):并发槽已满时,踢掉该**端点**(容量键)上**最新入队**的
   * 非直连(逻辑)租约,把容量让给直连请求。
   *
   * 语义(用户 2026 定案):
   * - 直连(真实模型直连)请求的优先级**高于**任何逻辑模型成员;
   * - 槽未满 → 普通 acquire(`direct: true`);
   * - 槽已满 → 找该桶里 `direct !== true` 且**最晚入队**的那条踢掉
   *   (最不影响其余逻辑请求的 FCFS 次序;最先到达者保留);
   * - 桶里全是直连在途 → 没有可让的对象,返回 `null`(调用方按「无可用」处理)。
   *
   * ⚠️ 抢占粒度 = 容量键(2026-11-08):只踢**同一凭据**上的逻辑租约。别的凭据的
   * 租约本来就不占这个槽,踢了也换不来空位(而且会平白打断一个没用满的号)。
   *
   * 被踢掉的逻辑租约会记一条失败({@link PREEMPT_ERROR}),并发槽即刻释放 ——
   * 账本记账不泄漏,调用方按既有重试策略重试。
   *
   * ⚠️ **受害方会被同步通知**(m02240):只释放账本槽位是不够的 ——
   * 受害方的 HTTP 请求还在真实上游占着连接,直连请求拿到的只是「账面上的
   * 空位」,上游照样限流。所以这里先调受害方的 `onPreempt` 回调(让它
   * 打断自己的上游调用、立刻退出),再释放槽位。
   *
   * ⚠️ **回调抛异常不影响抢占**:通知失败只意味着这次打断没生效,抢占本身
   * 照常进行(否则一次回调异常会让直连请求也失败 —— 那更糟)。
   */
  acquireDirect(realModelId, concurrency, opts = {}) {
    const now = opts.now ?? this.clock.monoNow();
    this.purge(now);
    const cap = Math.max(1, Math.trunc(concurrency));
    const capacityKey = this.capacityKeyOf(realModelId, opts.endpointId);
    const bucket = this.leases.get(capacityKey);
    if (bucket === void 0 || bucket.size < cap) {
      return this.acquire(realModelId, { ...opts, direct: true, now });
    }
    let victim = null;
    if (bucket !== void 0) {
      const ids = [...bucket.keys()].reverse();
      for (const id of ids) {
        const lease = bucket.get(id);
        if (lease === void 0) continue;
        if (lease.direct === true) continue;
        victim = lease;
        break;
      }
    }
    if (victim === null) {
      return null;
    }
    this.notifyPreempted(victim.leaseId);
    this.release(victim.leaseId, {
      now,
      outcome: {
        ok: false,
        status: 0,
        error: PREEMPT_ERROR,
        latencyMs: 0,
        ttftMs: null,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0
      }
    });
    return this.acquire(realModelId, { ...opts, direct: true, now });
  }
  /**
   * 通知「这条租约被挤掉了」(m02240)—— 回调表命中才通知。
   *
   * ⚠️ **吞掉回调异常**:通知失败只意味着这次打断没生效(受害方的上游调用
   * 还在跑),抢占本身必须照常完成 —— 否则受害方一个回调 bug 就能让直连
   * 请求也一起失败。
   */
  notifyPreempted(leaseId) {
    const hook = this.preemptHooks.get(leaseId);
    if (hook === void 0) {
      return;
    }
    try {
      hook(PREEMPT_ERROR);
    } catch {
    }
  }
  /**
   * 会话 → 会话序号(面板 `#对话#请求` 的左半段)。
   *
   * - 同一 `sessionId` 永远拿到同一个号 —— 这是「这几条是同一个会话」可读的唯一依据;
   * - 号从 1 起**按首次出现顺序递增**;游标单调不减,所以淘汰后新号不会重复用旧号;
   * - 空 `sessionId`(无法派生的请求)→ `0` = **不编号**(否则所有无 id 请求会共用
   *   一个伪会话号,`#对话` 那一列就永远显示同一个数);
   * - 淘汰:表超过 {@link CONV_ORDER_LIMIT} 条时丢掉**最旧**的一条(`Map` 保插入序)。
   *
   * ⚠️ **重启清零**是预期语义(与 v4「会话 pin 只在内存」同一口径,D18):
   * 这是运行期序号,不是持久身份。
   */
  convNo(sessionId) {
    if (!sessionId) {
      return 0;
    }
    const known = this.convOrder.get(sessionId);
    if (known !== void 0) {
      return known;
    }
    while (this.convOrder.size >= CONV_ORDER_LIMIT) {
      const oldest = this.convOrder.keys().next();
      if (oldest.done) {
        break;
      }
      this.convOrder.delete(oldest.value);
    }
    this.convSeq += 1;
    this.convOrder.set(sessionId, this.convSeq);
    return this.convSeq;
  }
  /**
   * 续期一条租约(流式每收到一个 chunk 调一次)。不存在返回 `false`。
   *
   * ⚠️ 这是「面板上的在途列表可信」的前提:没有它,跑满租期的长请求会在还活着的
   * 时候消失,用户会以为网关丢了请求 —— 同时账本误以为腾出了空位,并发上限被悄悄放大。
   */
  touch(leaseId, now = this.clock.monoNow()) {
    if (!leaseId) {
      return false;
    }
    const key = this.index.get(leaseId);
    if (key === void 0) {
      return false;
    }
    const bucket = this.leases.get(key);
    if (bucket === void 0) {
      return false;
    }
    const old = bucket.get(leaseId);
    if (old === void 0) {
      return false;
    }
    bucket.set(leaseId, { ...old, expiresAt: now + this.leaseSeconds });
    return true;
  }
  /**
   * 按**句柄**精确释放。已释放 / 已过期都是幂等的 `false`。
   *
   * @param outcome 收尾数据(token 数、TTFT、状态)。给了就同时进**保留区**;
   *   不给就只是释放 —— 调用方没数,我们也不瞎编。
   *
   * ⚠️ `leaseId` 是 {@link acquire} 返回的那个**字符串句柄**。为兼容尚未升级的
   * 调用点,传容量键(端点 id / 旧的真实模型 id)也能用 —— 那就退回「丢该桶里最旧
   * 的一条」(旧行为)。但**不要**依赖这条退路:它正是本方法要修掉的那个
   * 「不知道自己在丢谁的租约」。
   */
  release(leaseId, opts = {}) {
    if (!leaseId) {
      return false;
    }
    const now = opts.now ?? this.clock.monoNow();
    if (!this.index.has(leaseId)) {
      const bucket2 = this.leases.get(leaseId);
      if (bucket2 === void 0 || bucket2.size === 0) {
        return false;
      }
      let oldest = null;
      for (const l of bucket2.values()) {
        if (oldest === null || l.startedAt < oldest.startedAt) {
          oldest = l;
        }
      }
      if (oldest === null) {
        return false;
      }
      bucket2.delete(oldest.leaseId);
      this.index.delete(oldest.leaseId);
      this.preemptHooks.delete(oldest.leaseId);
      if (bucket2.size === 0) {
        this.leases.delete(leaseId);
      }
      return true;
    }
    const key = this.index.get(leaseId);
    if (key === void 0) {
      return false;
    }
    this.index.delete(leaseId);
    this.preemptHooks.delete(leaseId);
    const bucket = this.leases.get(key);
    if (bucket === void 0) {
      return false;
    }
    const lease = bucket.get(leaseId);
    bucket.delete(leaseId);
    if (bucket.size === 0) {
      this.leases.delete(key);
    }
    if (lease === void 0) {
      return false;
    }
    this.archive(lease, opts.outcome ?? null, now);
    return true;
  }
  /** 清掉某个**容量键**(端点)的**全部**租约(测试 / 维护用),返回清掉的条数。 */
  releaseBucket(capacityKey) {
    const bucket = this.leases.get(capacityKey);
    if (bucket === void 0) {
      return 0;
    }
    this.leases.delete(capacityKey);
    for (const leaseId of bucket.keys()) {
      this.index.delete(leaseId);
      this.preemptHooks.delete(leaseId);
    }
    return bucket.size;
  }
  // ------------------------------------------------------------- 保留区
  /**
   * 保留区**当前**容量 —— 优先问活来源(``ui.recent_limit``)。
   *
   * 容量提供函数缺失、抛错或给出 <1 时回落构造参数 `maxRecent`(默认
   * {@link DEFAULT_MAX_RECENT}):观测不该因为设置读不到而把账本拖垮,
   * 更不该让保留区变成无上限。
   */
  recentCapacity() {
    if (this.maxRecentFn !== null) {
      let cap = 0;
      try {
        cap = Math.trunc(Number(this.maxRecentFn()));
      } catch {
        cap = 0;
      }
      if (Number.isFinite(cap) && cap >= 1) {
        return cap;
      }
    }
    return this.maxRecent;
  }
  /**
   * 保留区砍回容量上限 —— **从头砍,因为它最旧**。
   *
   * `recentHint` 是短路:保留区条数还没到「上次问到的容量」就不可能超容,
   * 直接返回,省掉一次设置读库。用户把上限**调小**之后,下一次收尾就会重新问一次
   * 并立刻砍到位。
   */
  trimRecent() {
    if (this.recent.length <= this.recentHint) {
      return;
    }
    const cap = this.recentCapacity();
    this.recentHint = cap;
    while (this.recent.length > cap) {
      this.recent.shift();
    }
  }
  /**
   * 清掉过期租约(被租期扫掉的也要进保留区 —— 否则「刚才那条到底怎么了」
   * 在面板上永远是空白),再把保留区砍回容量。
   */
  purge(now = this.clock.monoNow()) {
    for (const [key, bucket] of this.leases) {
      for (const [leaseId, lease] of bucket) {
        if (lease.expiresAt > now) {
          continue;
        }
        this.archive(lease, null, now);
        bucket.delete(leaseId);
        this.index.delete(leaseId);
        this.preemptHooks.delete(leaseId);
      }
      if (bucket.size === 0) {
        this.leases.delete(key);
      }
    }
    this.trimRecent();
  }
  /** 收尾归档:保留区 + 砍容量。 */
  archive(lease, outcome, now) {
    if (outcome !== null) {
      this.recent.push({
        lease,
        finishedAt: now,
        ok: outcome.ok,
        status: outcome.status,
        error: outcome.error,
        latencyMs: outcome.latencyMs,
        ttftMs: outcome.ttftMs,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        cachedTokens: outcome.cachedTokens
      });
    } else {
      this.recent.push(archivedRow(lease, now));
    }
    this.trimRecent();
  }
  /**
   * 最近的已结束请求,**最新在前**。只按条数清(无时间窗,2026-10-15)。
   *
   * ⚠️ 降序键必须是 **`(finishedAt, seq)`** 而不是单独的 `finishedAt`:
   * 单调钟在同一毫秒里会给出**同一个值**,单键排序会退化成「按 FIFO 进出顺序」——
   * 一条刚结束的请求被排在几分钟前的旁边,面板上表现为「最新的不在最上面」。
   * `seq` 单调递增,正好作 tiebreaker。
   */
  recentRows(limit = 50) {
    this.purge();
    const out = [...this.recent];
    out.sort(
      (a, b) => a.finishedAt === b.finishedAt ? b.lease.seq - a.lease.seq : b.finishedAt - a.finishedAt
    );
    return limit > 0 ? out.slice(0, limit) : out;
  }
  /** 一条已结束请求距离现在多久(秒);`null` 时间由账本时钟提供。 */
  finishedAgoS(row, now = this.clock.monoNow()) {
    return Math.max(0, now - row.finishedAt);
  }
  // ------------------------------------------------------------- 观测
  /**
   * `{realModelId: 在途数}` —— **对外契约形状,键是真实模型**(不要改成端点)。
   *
   * ⚠️ 2026-11-08 容量键改成端点后,这里必须**逐条租约按 `lease.realModelId` 归并**:
   * 面板 `RuntimeSnapshot.by_real_model` / 趋势图 / 部署页的「在途」列都按真实模型
   * 展示,内部换键不能让统计变形(1 个模型 3 个凭据同时在跑 → 仍然是这个模型的 3)。
   */
  snapshot() {
    this.purge();
    const out = {};
    for (const bucket of this.leases.values()) {
      for (const lease of bucket.values()) {
        out[lease.realModelId] = (out[lease.realModelId] ?? 0) + 1;
      }
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  /** 全部在途租约(供面板展示)。**已按开始时刻排序**。 */
  detail() {
    this.purge();
    const out = [];
    for (const bucket of this.leases.values()) {
      out.push(...bucket.values());
    }
    out.sort((a, b) => a.startedAt - b.startedAt);
    return out;
  }
  /** 在途租约总数。 */
  total() {
    return Object.values(this.snapshot()).reduce((a, b) => a + b, 0);
  }
  /** 清账(测试 / 维护)。不给容量键(端点)就全清。 */
  reset(capacityKey) {
    if (capacityKey === void 0) {
      this.leases.clear();
      this.index.clear();
      this.preemptHooks.clear();
      this.recent.length = 0;
      this.recentHint = 0;
      this.seq = 0;
      this.convSeq = 0;
      this.convOrder.clear();
      return;
    }
    this.releaseBucket(capacityKey);
  }
};

// core/router/session-pin.ts
var SessionPinTable = class {
  ttl;
  clock;
  /** `sessionId -> { endpointId, expiresAt }`(单调钟) */
  pins = /* @__PURE__ */ new Map();
  constructor(ttlSeconds = DEFAULT_PIN_SECONDS, clock = systemClock) {
    this.ttl = Number(ttlSeconds);
    this.clock = clock;
  }
  /** 会话粘住租期(秒)。 */
  get ttlSeconds() {
    return this.ttl;
  }
  /** 取粘住的 `endpointId`;不存在或**已过期**返回 `null`(顺带删掉过期项)。 */
  get(sessionId) {
    if (!sessionId) {
      return null;
    }
    const now = this.clock.monoNow();
    const hit = this.pins.get(sessionId);
    if (hit === void 0) {
      return null;
    }
    if (hit.expiresAt <= now) {
      this.pins.delete(sessionId);
      return null;
    }
    return hit.endpointId;
  }
  /** 建立 / 续期粘住。空 `sessionId` 直接忽略(不编号、不粘住)。 */
  set(sessionId, endpointId, ttlSeconds) {
    if (!sessionId) {
      return;
    }
    this.pins.set(sessionId, {
      endpointId,
      // 按次可选 ttl:Router 活读设置项时逐次传入当前值,
      // 不传则用表构造时的默认。
      expiresAt: this.clock.monoNow() + (Number.isFinite(ttlSeconds) ? ttlSeconds : this.ttl)
    });
  }
  /**
   * 解除粘住。给了 `endpointId` 就**只在指向它时才解**。
   *
   * 「只在指向它时才解」防的是竞态:旧请求的失败回调晚到时,不能把会话从
   * **已经迁移到的新端点**上摘下来。
   */
  drop(sessionId, endpointId) {
    if (!sessionId) {
      return;
    }
    const hit = this.pins.get(sessionId);
    if (hit === void 0) {
      return;
    }
    if (endpointId && hit.endpointId !== endpointId) {
      return;
    }
    this.pins.delete(sessionId);
  }
  /** 当前未过期的粘住条数。 */
  count() {
    const now = this.clock.monoNow();
    let n = 0;
    for (const { expiresAt } of this.pins.values()) {
      if (expiresAt > now) {
        n += 1;
      }
    }
    return n;
  }
  /** `{sessionId: endpointId}` —— 值是**粘住的端点**,不是过期时刻。 */
  snapshot() {
    const now = this.clock.monoNow();
    const alive = {};
    for (const [sessionId, { endpointId, expiresAt }] of this.pins) {
      if (expiresAt > now) {
        alive[sessionId] = endpointId;
      }
    }
    return {
      ttlSeconds: this.ttl,
      active: Object.keys(alive).length,
      sessions: Object.fromEntries(Object.entries(alive).sort(([a], [b]) => a < b ? -1 : 1))
    };
  }
};

// core/router/router.ts
function parseCooldownOverrides(raw) {
  const out = {};
  if (!raw) {
    return out;
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return out;
  }
  for (const [provider, minutes] of Object.entries(parsed)) {
    if (typeof provider !== "string" || provider.trim() === "") {
      continue;
    }
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
      continue;
    }
    out[provider] = minutes;
  }
  return out;
}
var RULES_TTL_SECONDS = 5;
var systemRandom = {
  next: () => Math.random()
};
var Router = class {
  deps;
  ledger;
  health;
  pins;
  onCommit;
  pinSeconds;
  pinSecondsOf;
  clock;
  rng;
  /** `scheduler.rules` 的供应商冷却覆盖表(5s TTL 缓存,**挂在实例上**)。 */
  cdRules = null;
  cdRulesAt = 0;
  constructor(deps = null, options = {}) {
    if (deps !== null && typeof deps.getSetting === "function") {
      const source = deps;
      this.deps = { settings: source, applyCooldownRules: null };
    } else if (deps === null) {
      this.deps = { settings: null, applyCooldownRules: null };
    } else {
      this.deps = deps;
    }
    this.clock = options.clock ?? systemClock;
    this.pinSeconds = Number(options.pinSeconds ?? DEFAULT_PIN_SECONDS);
    this.pinSecondsOf = options.pinSecondsOf ?? null;
    this.pins = options.pins ?? new SessionPinTable(this.pinSeconds, this.clock);
    this.health = options.health ?? new HealthRegistry({ wallNow: () => this.clock.wallNow() });
    this.ledger = options.ledger ?? new InflightLedger({ maxRecentFn: () => this.recentLimit(), clock: this.clock });
    this.rng = options.rng ?? systemRandom;
    this.onCommit = options.onCommit ?? null;
  }
  // ------------------------------------------------------------------ 选路
  /**
   * 选出本次请求该用的端点。
   *
   * @param chain **已排好序、且已剔除时段禁用项**的端点链(时段判定属于调度器
   *   职责;这里只管「谁空闲、谁排前面」)。⚠️ **必须每个请求重新取** —— 健康状态
   *   是内存态且随时变,在别处缓存了 chain,冷却与在途就会停在旧值上。
   * @param sessionId 会话 id(客户端没带时由上层从首条 user 消息派生)
   * @param needsVision 请求是否带图片。为真时**只从视觉端点里挑** —— 普通端点
   *   接不住图片。带图规则(D30)**对一切调度策略生效**:链上有视觉端点时,
   *   视觉端点占住整条 pool;链上**没有**视觉端点时,pool 就是整条链
   *   (图像桥 / 连接器兜底的场景)。视觉端点全忙 / 全冷却时如实返回
   *   `all_busy` / `all_cooldown`,而不是把图丢给文本模型。
   * @param ignoreCooldown 为真时**无视端点冷却**参加选路 —— 冷却中的端点不再被
   *   跳过。这是**直连真实模型**(名字不在 `logical_model` 表)的请求语义:冷却挡不住
   *   「这一次」尝试,失败照常记冷却、后续请求照旧被冷却挡住,直到成功清零。
   *   逻辑模型档链**不许**传它(默认 `false` = 照旧跳过冷却端点)。
   */
  plan(opts) {
    const chain = opts.chain;
    const sessionId = opts.sessionId ?? "";
    const needsVision = opts.needsVision ?? false;
    const ignoreCooldown = opts.ignoreCooldown ?? false;
    const minInputTokens = typeof opts.minInputTokens === "number" && Number.isFinite(opts.minInputTokens) && opts.minInputTokens > 0 ? Math.floor(opts.minInputTokens) : 0;
    if (!chain || chain.length === 0) {
      return planResult(null, "all_blackout");
    }
    const now = this.clock.wallNow();
    const items = chain.map(
      (item) => withHealth(item, this.health.get(item.endpoint.endpointId))
    );
    let pool = items;
    if (needsVision) {
      const vision = items.filter((it) => it.endpoint.supportsVision);
      if (vision.length > 0) {
        pool = vision;
      }
    }
    if (minInputTokens > 0) {
      const fits = pool.filter((item) => {
        const window = item.endpoint.maxInputTokens;
        return window === null || window <= 0 || window >= minInputTokens;
      });
      if (fits.length > 0) pool = fits;
    }
    const pinned = this.pins.get(sessionId);
    if (pinned) {
      const wanted = pinned;
      let onChain = false;
      for (const item of pool) {
        if (item.endpoint.endpointId !== wanted) {
          continue;
        }
        onChain = true;
        if (inCooldown(item.endpoint.health ?? emptyHealthRecord(), now) && !ignoreCooldown) {
          this.pins.drop(sessionId, wanted);
          break;
        }
        if (this.ledger.hasRoom(item.endpoint.endpointId, item.endpoint.concurrency)) {
          return planResult(item, "affinity", true);
        }
        break;
      }
      if (!onChain) {
        this.pins.drop(sessionId, wanted);
      }
    }
    const strategy = chain[0]?.strategy ?? "";
    if (LOAD_AWARE_STRATEGIES.has(strategy)) {
      return this.planLoadAware(pool, strategy, ignoreCooldown);
    }
    const healthy = pool.filter(
      (item) => ignoreCooldown || !item.endpoint.inCooldown(now)
    );
    if (healthy.length === 0) {
      return planResult(null, "all_cooldown");
    }
    for (const item of healthy) {
      if (this.ledger.hasRoom(item.endpoint.endpointId, item.endpoint.concurrency)) {
        return planResult(item, "ordered");
      }
    }
    for (const item of healthy) {
      if (item.direct !== true) {
        continue;
      }
      if (this.ledger.hasPreemptable(item.endpoint.endpointId)) {
        return planResult(item, "ordered");
      }
    }
    return planResult(null, "all_busy");
  }
  // ------------------------------------------------------- 负载感知策略
  /**
   * `least-busy` / `balanced` 的裁决 —— 两者共用同一份「剩余空位」。
   *
   * ⚠️ 2026-11-08 起**按端点(凭据)分桶**,每桶 = **一个凭据的剩余空位**
   * (`concurrency - 该凭据 inFlight`)。这正是新的并发语义本身:桶与链路上的
   * 端点一一对应,`concurrency` 就是每个凭据的上限。
   *
   * 旧口径(D12)必须先按 `realModelKey` 归并,是因为账本对同一模型的各凭据返回
   * **同一个在途数** —— 逐项加权会让「凭据多的模型」拿到成倍权重、随后被
   * `hasRoom` 挡下(表现为明明还有空位却 all_busy)。现在账本按端点计数,
   * 逐端点分桶反而**正确**:3 个凭据 × concurrency=1 = 3 个桶,各算各的空位。
   *
   * - `least-busy`:取**在途最少**的桶(并列 → 配置序,由链序保证)
   * - `balanced` :按**剩余空位**加权随机 —— 每个空位等概率被选中,
   *   这就是「平均使用」的字面含义
   *
   * ⚠️ 两个策略都**不会**超过任何一个凭据的并发上限:加权用的是
   * `concurrency - inFlight`,等于 0 的桶根本不进候选。
   */
  planLoadAware(pool, strategy, ignoreCooldown) {
    const now = this.clock.wallNow();
    const buckets = /* @__PURE__ */ new Map();
    for (const item of pool) {
      if (item.endpoint.inCooldown(now) && !ignoreCooldown) {
        continue;
      }
      const key = item.endpoint.endpointId;
      const used = this.ledger.inFlight(key);
      const room = Math.max(0, item.endpoint.concurrency - used);
      const cur = buckets.get(key);
      if (cur === void 0) {
        buckets.set(key, { item, used, room });
      } else {
        cur.room = Math.min(cur.room, room);
        cur.used = Math.max(cur.used, used);
      }
    }
    if (buckets.size === 0) {
      if (pool.some((item) => item.endpoint.inCooldown(now)) && !ignoreCooldown) {
        return planResult(null, "all_cooldown");
      }
      return planResult(null, "all_busy");
    }
    const roomy = [...buckets.values()].filter((b) => b.room > 0);
    if (roomy.length === 0) {
      return planResult(null, "all_busy");
    }
    const preferred = roomy.filter((b) => b.item.degraded !== true);
    const candidates = preferred.length > 0 ? preferred : roomy;
    if (strategy === "least-busy") {
      candidates.sort((a, b) => a.used - b.used || a.item.priority - b.item.priority);
      return planResult(candidates[0].item, "least_busy");
    }
    const total = candidates.reduce((sum, b) => sum + b.room, 0);
    let pick = this.rng.next() * total;
    for (const b of candidates) {
      pick -= b.room;
      if (pick <= 0) {
        return planResult(b.item, "balanced");
      }
    }
    return planResult(candidates[candidates.length - 1].item, "balanced");
  }
  // ------------------------------------------------------- 落账 / 收尾
  /**
   * 选路成功后的落账:占在途租约(**容量键 = 端点/凭据**,见 `InflightLedger`;
   * `realModelId` 只用于展示聚合与抢占标记)+ 建立/续期会话 pin。
   *
   * @returns 租约句柄。**必须**原样交回 {@link finish} 才能精确释放。
   *
   * ⚠️ 会话 pin 只在**尚未指向任何端点**时才写(2026-10-13)。以前无条件覆盖:
   * 同一会话的 N 个并发请求会把 pin 依次推到第 N 档 —— 第 1 个占住首选后,
   * 第 2 个顺延到次选并**覆盖**掉 pin,第 3 个再推到第 3 档。于是下一轮顺序
   * 请求回到**最后**那一档,恰恰是刚被最重的并发请求占过的那台。亲和存在的
   * 唯一理由(长会话固定同一模型,prompt cache 才命中)因此被并发反向摧毁。
   *
   * ⚠️ **直连条目走抢占式 acquire**(m02240):`planItem.direct === true` 时
   * 用 {@link InflightLedger.acquireDirect} —— 并发槽被逻辑请求占满就踢掉
   * 该真实模型上**最新入队**的逻辑租约(记 PREEMPT_ERROR),把容量让给直连。
   * 无可抢占对象(全为直连在途)时返回 `""`,调用方按「无可用上游」处理。
   */
  commit(planItem, opts = {}) {
    if (planItem === null || planItem === void 0) {
      return "";
    }
    const ep = planItem.endpoint;
    const sessionId = opts.sessionId ?? "";
    const logicalName = opts.logicalName ?? "";
    let leaseId;
    if (planItem.direct === true) {
      const preempted = this.ledger.acquireDirect(
        ep.realModelKey,
        ep.concurrency,
        {
          endpointId: ep.endpointId,
          logicalModel: logicalName,
          sessionId,
          stream: opts.stream ?? false
        }
      );
      if (preempted === null) return "";
      leaseId = preempted;
    } else {
      leaseId = this.ledger.acquire(ep.realModelKey, {
        endpointId: ep.endpointId,
        logicalModel: logicalName,
        sessionId,
        stream: opts.stream ?? false,
        // ⚠️ 登记抢占回调:直连请求挤掉本租约时,靠它打断本请求的上游调用。
        onPreempt: opts.onPreempt
      });
    }
    if (!this.pins.get(sessionId)) {
      this.pins.set(
        sessionId,
        ep.endpointId,
        this.pinSecondsOf !== null ? this.pinSecondsOf() : void 0
      );
    }
    if (this.onCommit !== null) {
      try {
        this.onCommit(ep.realModelKey, logicalName);
      } catch {
      }
    }
    return leaseId;
  }
  /** 续期在途租约(流式每收到一个 chunk 调一次)。不存在返回 `false`。 */
  touch(leaseId) {
    return this.ledger.touch(leaseId);
  }
  /**
   * 请求结束:**释放在途租约** + 记成败;失败时额外解除会话 pin + 端点熔断。
   *
   * @param leaseId {@link commit} 返回的句柄。按句柄**精确**释放 —— 账本不再猜
   *   「该丢哪一条」。缺句柄(未升级的调用点)时退回清掉该真实模型上的一条,
   *   避免永久泄漏。
   * @param cooldownUntil 上游给的**绝对**冷却截止时刻(epoch 秒),由调用方从
   *   `UpstreamError.retryAfter` 算出来。给了就**压过** provider 覆盖与全局 floor ——
   *   见 {@link CooldownHint} 的三层优先级。不传就是现行为:走覆盖链。
   *
   * ⚠️ 成功时**绝不**解除 pin —— 每轮都 unpin 等于根本没有会话亲和:额度刷新
   * 触发的重排会把长会话在几个模型之间来回甩,prompt cache 全失效。
   *
   * ⚠️ `kind` / `status` 必须由调用方**如实传**:否则面板上「密钥失效」和
   * 「上游超时」长得一模一样,都只能显示成一句没有信息量的空白。
   */
  finish(planItem, opts = {}) {
    if (planItem === null || planItem === void 0) {
      return;
    }
    const ep = planItem.endpoint;
    const sessionId = opts.sessionId ?? "";
    const ok = opts.ok ?? true;
    const preempted = opts.preempted === true;
    const voidAttempt = opts.voidAttempt === true;
    const latencyMs = opts.latencyMs ?? 0;
    const ttftMs = opts.ttftMs ?? null;
    const promptTokens = opts.promptTokens ?? 0;
    const completionTokens = opts.completionTokens ?? 0;
    const cachedTokens = opts.cachedTokens ?? 0;
    const counted = Boolean(latencyMs) || Boolean(ttftMs) || Boolean(promptTokens) || Boolean(completionTokens) || Boolean(cachedTokens);
    const outcome = counted ? {
      ok,
      status: opts.status ?? 0,
      error: opts.error ?? "",
      latencyMs: Math.trunc(latencyMs || 0),
      ttftMs: ttftMs === null || ttftMs === void 0 ? null : Math.trunc(ttftMs),
      promptTokens: Math.trunc(promptTokens || 0),
      completionTokens: Math.trunc(completionTokens || 0),
      cachedTokens: Math.trunc(cachedTokens || 0)
    } : null;
    const leaseId = opts.leaseId ?? "";
    if (leaseId) {
      this.ledger.release(leaseId, { outcome });
    } else {
      this.ledger.releaseBucket(ep.endpointId);
    }
    const hint = ok ? { until: null, policy: null } : {
      until: opts.cooldownUntil ?? null,
      // 只有上游**明确**给了恢复时刻(`Retry-After`)才有资格压过
      // 「瞬时故障不冷却」的豁免;没给就是网关推算(缺省)。
      untilSource: opts.cooldownUntilSource ?? "gateway",
      policy: this.cooldownPolicy(ep.provider)
    };
    if (!preempted && !voidAttempt) {
      const rec = this.health.get(ep.endpointId);
      this.health.put(
        ep.endpointId,
        ok ? noteSuccess(rec, this.clock.wallNow()) : noteFailure(rec, {
          error: opts.error,
          kind: opts.kind,
          status: opts.status,
          now: this.clock.wallNow(),
          hint,
          provider: ep.provider
        })
      );
    }
    if (!ok && !preempted && !voidAttempt) {
      this.pins.drop(sessionId, ep.endpointId);
    }
  }
  // ------------------------------------------------------- 冷却策略
  /**
   * 本次失败要用的冷却策略(只有它的 `cooldownFloorS` 会被用到)。
   *
   * ⚠️ **真实/抽象档在这里没差别**:两档只有 `maxAttempts` 不同,而
   * `cooldownFloorS` 两档**完全一致**(都读 `retry.logical_cooldown`)。
   * 端点熔断是**端点**自己的事,不该跟着「这次谁在调用」换时长:同一个端点被
   * 两个逻辑模型共用时,分档只会让同一个故障被冷却两次不一样久。
   *
   * ⚠️ **供应商级冷却覆盖**(2026-10-16;2026-10-18 起并进 `scheduler.rules`):
   * `cooldownFloorS` 允许按失败端点的 provider 覆盖 —— 优先级
   * `scheduler.rules` 里该 provider 的 `cooldown` 规则(分钟)>
   * `retry.logical_cooldown`(全局)。覆盖是**可选**的,缺省 = 不覆盖。
   *
   * ⚠️ **配置读不动时返回 `null` 而不是抛**:那是「不熔断」(0 秒),而不是让一次
   * 记账把请求路径炸掉 —— 与「配置问题不升级成请求失败」是同一条原则。
   */
  cooldownPolicy(provider = "") {
    const floor = this.globalCooldownFloorS();
    if (floor === null) {
      return null;
    }
    const overrideMin = this.cooldownMinOverride(provider);
    return {
      maxAttempts: 0,
      cooldownFloorS: overrideMin !== null ? overrideMin * 60 : floor,
      baseS: 0,
      factor: 0,
      capS: 0,
      jitterRatio: 0,
      codes: EMPTY_CODES
    };
  }
  /**
   * 全局冷却时长(秒)= `retry.logical_cooldown`(分钟)× 60。
   *
   * ⚠️ **键缺失 / 值坏了 → 900 秒,不是 0**:上游走
   * `RetryPolicy.of(repo, abstract=False)` → `retry_setting()` → 键缺失时
   * **播种** `RETRY_DEFAULTS["retry.logical_cooldown"] = 15` 后回读,值非法时
   * 「写回默认值再回读」。所以那个函数永远返回一个数,Router 侧拿到的就是
   * 默认的 15 分钟。本方法用 {@link coerceRetryNumber} 等价地做到这点。
   *
   * 只有**读不动**(没有 repo / `get_setting` 抛错)才返回 `null` —— 对应
   * `_cooldown_policy` 的 `except` 分支,语义是「本次不熔断」。
   */
  globalCooldownFloorS() {
    const source = this.deps.settings;
    if (source === null || source === void 0) {
      return null;
    }
    let raw;
    try {
      raw = source.getSetting(SETTING_LOGICAL_COOLDOWN);
    } catch {
      return null;
    }
    const minutes = coerceRetryNumber(raw, DEFAULT_LOGICAL_COOLDOWN_MIN);
    return minutes * 60;
  }
  /**
   * 供应商级冷却时长覆盖(**分钟**,`null` = 不覆盖)。
   *
   * 优先级(命中即停,**两级**):
   * 1. `scheduler.rules` 里该 provider 的 `cooldown` 规则
   *    (`{"provider": "<id>", "cooldown": 分钟}`),只对写了的供应商生效;
   * 2. 没写到 → `null`,调用方回落全局 `retry.logical_cooldown`。
   *
   * ⚠️ **只做两级**(2026-10-17 用户定案:「逻辑模型成员冷却优先级只做两级,
   * 全局和供应商覆盖」)。更早的两级早已退役、设了不再被读。
   */
  cooldownMinOverride(provider = "") {
    if (!provider) {
      return null;
    }
    return this.cooldownRules()[provider] ?? null;
  }
  /**
   * 生效中的供应商冷却覆盖表(`scheduler.cooldown_overrides` → `{provider: 分钟}`)。
   *
   * 5s TTL 实例级缓存:热路径不重复 `JSON.parse` 整份配置;面板改完 5s 内生效。
   * ⚠️ 缓存**不能**放模块级 —— 一个进程里可能有多个 repo,那会把 A 库的覆盖表
   * 喂给 B 库。
   */
  cooldownRules() {
    const now = this.clock.wallNow();
    if (this.cdRules !== null && now - this.cdRulesAt < RULES_TTL_SECONDS) {
      return this.cdRules;
    }
    let table;
    if (this.deps.applyCooldownRules) {
      table = this.deps.applyCooldownRules();
    } else {
      table = parseCooldownOverrides(this.readSetting(SETTING_COOLDOWN_OVERRIDES));
    }
    this.cdRules = table;
    this.cdRulesAt = now;
    return table;
  }
  /**
   * 「实时日志」最大显示条数(设置键 `ui.recent_limit`,默认 50)。
   *
   * ⚠️ 这个方法**同时是保留区容量的活来源**:`Router` 把它作为 `maxRecentFn` 交给
   * {@link InflightLedger},账本每次收尾 / purge 时问一次。所以这里**不能**缓存 ——
   * 缓存会让用户在面板上改完条数后要等缓存过期才生效。
   *
   * ⚠️ 读失败 / 没配 / 值非法 → 回落默认 50(观测不该因为设置读不到而把整个视图拖垮)。
   *
   * ⚠️ 解析口径照抄上游的 `int(raw or default)`:`"3.9"` / `"1e3"` 在 Python 里
   * 会抛 `ValueError` → 回落 50,而不是被截成 3 —— 见 {@link parseStrictInt}。
   */
  recentLimit() {
    const raw = this.readSetting(SETTING_RECENT_LIMIT);
    return parseStrictInt(raw, DEFAULT_RECENT_LIMIT, 1);
  }
  /** 读设置;缺失 / 抛错 / 非字符串一律按「没有」处理(返回 `null`)。 */
  readSetting(key) {
    const source = this.deps.settings;
    if (source === null || source === void 0) {
      return null;
    }
    try {
      const raw = source.getSetting(key);
      if (raw === null || raw === void 0) {
        return null;
      }
      return String(raw);
    } catch {
      return null;
    }
  }
  // ------------------------------------------------------------------ 观测
  /**
   * **解冻一个账号名下的所有端点冷却**(用户 m16528:凭据换新后不必再等旧冷却)。
   *
   * 端点 id 形如 `<provider>/<model>@<provider>/<username>`
   * (见 {@link endpointIdOf}),所以「账号名」就是 `@` 后面最后一段 —— 按它
   * 匹配,一把 key 在多个模型上的冷却一起清掉。
   *
   * @returns 清掉的条数(0 = 本来就没在冷却)
   */
  thawAccount(provider, username) {
    if (!username) return 0;
    const suffix = `@${provider}/${username}`;
    return this.health.clearWhere((id) => id.endsWith(suffix));
  }
  /** 排障快照(只含端点名与计数,无凭据,**无 sessionId**)。 */
  snapshot() {
    return {
      inflight: this.ledger.snapshot(),
      inflightTotal: this.ledger.total(),
      inflightKey: "real_model_id",
      // ⚠️ 展示契约:inflight 仍按真实模型聚合(容量键是端点)
      pinSeconds: this.pinSeconds,
      pins: this.pins.count(),
      health: this.health.snapshot()
    };
  }
};
var EMPTY_CODES = /* @__PURE__ */ new Set();
function emptyHealthRecord() {
  return { fails: 0, cooldownUntil: 0, lastError: "", updatedAt: 0, lastKind: "", lastStatus: 0 };
}
function withHealth(item, rec) {
  if (item.endpoint.health === rec) {
    return item;
  }
  const ep = item.endpoint;
  const descriptors = Object.getOwnPropertyDescriptors(ep);
  const withoutHealth = { ...descriptors };
  delete withoutHealth.health;
  const next = Object.defineProperties(
    { ...ep, health: rec },
    withoutHealth
  );
  return { ...item, endpoint: next };
}

// core/router/account-throttle.ts
function accountThrottleKey(provider, username) {
  return `${provider}:${username}`;
}
var ACCOUNT_MIN_INTERVAL_MS = 4e3;
var ACCOUNT_INTERVAL_JITTER_MS = Math.round(ACCOUNT_MIN_INTERVAL_MS * 0.25);
var AccountThrottle = class {
  slots = /* @__PURE__ */ new Map();
  now;
  sleep;
  jitterMsOf;
  rng;
  /** 惰性清理阈值:超过这么多键时顺手扫一遍(正常只有个位数账号,不会触发)。 */
  maxKeys = 256;
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? sleepWithSignal;
    this.jitterMsOf = options.jitterMsOf ?? (() => ACCOUNT_INTERVAL_JITTER_MS);
    this.rng = options.rng ?? { random: () => Math.random(), uniform: (a, b) => a + (b - a) * Math.random(), shuffle: () => {
    } };
  }
  /**
   * 纯计算:**预留**这个键的下一时隙,返回需要等待的毫秒数(0 = 立刻可发)。
   *
   * 会把「下一时隙」推进 `interval + jitter` —— 即调用方**承诺**在这段时间内
   * 用掉这个时隙。不 sleep、不抛错,便于单测与「先判容量再决定要不要等」。
   *
   * ⚠️ 间隔是**模块常量** `ACCOUNT_MIN_INTERVAL_MS`,不再从设置读(用户 2026-11-09
   * 定案「写死在 wb 连接器中,不作为可设置项」)。所以这里没有「关闭」分支:
   * 节流永远开着 —— 它是账号安全下限,不该被顺手调成 0。
   */
  reserve(key, nowMs = this.now()) {
    const interval = ACCOUNT_MIN_INTERVAL_MS;
    const jitter = Math.max(0, this.jitterMsOf());
    const spacing = interval + (jitter > 0 ? this.rng.random() * jitter : 0);
    const slot = this.slots.get(key);
    const at = Math.max(nowMs, slot?.nextFreeMs ?? 0);
    this.slots.set(key, { nextFreeMs: at + spacing, touchedMs: nowMs });
    this.prune(nowMs, interval);
    return Math.max(0, at - nowMs);
  }
  /**
   * 预约并等到时隙。返回实际等待的毫秒数(便于日志/测试断言)。
   *
   * @param signal 客户端断开 / 抢占的信号:等待期间被 abort 会**立刻**抛
   *   `AbortError`,不把租约和客户端都晾在那里。
   */
  async acquire(key, signal) {
    const waitMs = this.reserve(key);
    if (waitMs <= 0) return 0;
    await this.sleep(waitMs, signal);
    return waitMs;
  }
  /** 清空全部时隙(凭据被删/熔断恢复后调用,避免带着旧节拍继续)。 */
  reset(key) {
    if (key === void 0) {
      this.slots.clear();
      return;
    }
    this.slots.delete(key);
  }
  /** 当前已知的键数量(诊断/测试用)。 */
  get size() {
    return this.slots.size;
  }
  /**
   * 惰性清理:丢掉「已经不用、且最早就空闲」的键。
   *
   * 条件:键数超过 {@link maxKeys},且该键的空闲时刻已经过去 `interval × 2`
   * (那种键再被用到时 `max(now, nextFree)` 与直接删除等价,删了不改变行为)。
   */
  prune(nowMs, interval) {
    if (this.slots.size <= this.maxKeys) return;
    const cutoff = nowMs - interval * 2;
    for (const [key, slot] of this.slots) {
      if (slot.nextFreeMs <= cutoff) this.slots.delete(key);
    }
  }
};
function sleepWithSignal(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function abortError() {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

// core/collector/quota.ts
import { randomBytes as randomBytes3 } from "node:crypto";

// core/connectors/trae.ts
import { createDecipheriv, createHash as createHash2, createSign, randomBytes } from "node:crypto";

// core/connectors/types.ts
var UpstreamError2 = class extends Error {
  kind;
  retryable;
  httpStatus;
  retryAfter;
  /**
   * 上游响应的**原件**(有上游答复时才带)。
   *
   * 连接器把上游原文改写进了 `message`(「认证失败 — 上游:…」),那对日志有用、
   * 对客户端是误导。带上原件后,网关出口(`upstreamErrorToHttp`)可以逐字写回
   * 上游的状态码与响应体,分类结果只用于内部的换档/冷却 —— 用户 m36329
   * 「只要上游有返回值,就返回上游返回的原始内容,不做修改」。
   *
   * 自造错误(缺凭据、池耗尽、客户端断开)没有原件,保持 undefined。
   */
  raw;
  constructor(kind, message, retryable, httpStatus, retryAfter, raw) {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    if (retryAfter !== void 0) this.retryAfter = retryAfter;
    if (raw !== void 0) this.raw = raw;
  }
};
function upstreamRawResponse(status, body) {
  let text;
  let json;
  if (typeof body === "string") {
    text = body;
    const trimmed = body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        json = JSON.parse(trimmed);
      } catch {
      }
    }
  } else {
    json = body ?? void 0;
    try {
      text = JSON.stringify(body ?? null);
    } catch {
      text = String(body);
    }
  }
  const raw = {
    text: text.length > RAW_BODY_MAX ? text.slice(0, RAW_BODY_MAX) : text,
    status
  };
  if (json !== void 0) raw.json = json;
  return raw;
}

// core/connectors/trae.ts
var APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
var TRAE_CODE_ACCOUNT_RESTRICTED = 4017;
var DEFAULT_IDE_VERSION = "0.1.50";
var DEFAULT_IDE_VERSION_CODE = "20260811";
var DEFAULT_API_BASE_CN = "https://trae-api-cn.mchost.guru";
var DEFAULT_API_BASE_AI = "https://coresg-normal.trae.ai";
var REGION_BASES = {
  cn: DEFAULT_API_BASE_CN,
  ai: DEFAULT_API_BASE_AI
};
var REGION_ALIASES = {
  cn: "cn",
  ai: "ai",
  sg: "ai",
  global: "ai",
  intl: "ai"
};
var AUTH_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
var DEVICE_CENTER_PREFIX = "iCubeAuthInfo://icube-dc:";
var HEADER_AES = Buffer.from([116, 99, 5, 16, 0, 0]);
var HEADER_AES_PRIVATE = Buffer.from([18, 57, 32, 32, 2, 3]);
var SALT_A = Buffer.from([
  82,
  9,
  106,
  213,
  48,
  54,
  165,
  56,
  191,
  64,
  163,
  158,
  129,
  243,
  215,
  251,
  124,
  227,
  57,
  130,
  155,
  47,
  255,
  135,
  52,
  142,
  67,
  68,
  196,
  222,
  233,
  203,
  84,
  123,
  148,
  50,
  166,
  194,
  35,
  61,
  238,
  76,
  149,
  11,
  66,
  250,
  195,
  78,
  8,
  46,
  161,
  102,
  40,
  217,
  36,
  178,
  118,
  91,
  162,
  73,
  109,
  139,
  209,
  37
]);
var SALT_B = Buffer.from([
  31,
  221,
  168,
  51,
  136,
  7,
  199,
  49,
  177,
  18,
  16,
  89,
  39,
  128,
  236,
  95,
  96,
  81,
  127,
  169,
  25,
  181,
  74,
  13,
  45,
  229,
  122,
  159,
  147,
  201,
  156,
  239,
  160,
  224,
  59,
  77,
  174,
  42,
  245,
  176,
  200,
  235,
  187,
  60,
  131,
  83,
  153,
  97,
  23,
  43,
  4,
  126,
  186,
  119,
  214,
  38,
  225,
  105,
  20,
  99,
  85,
  33,
  12,
  125
]);
var SALT_C = Buffer.from([
  191,
  192,
  216,
  250,
  122,
  246,
  220,
  97,
  31,
  254,
  98,
  27,
  8,
  72,
  71,
  176,
  135,
  99,
  96,
  18,
  127,
  101,
  203,
  104,
  211,
  102,
  191,
  125,
  37,
  72,
  150,
  156,
  51,
  229,
  121,
  35,
  17,
  153,
  141,
  177,
  110,
  131,
  150,
  128,
  172,
  255,
  254,
  6,
  18,
  140,
  55,
  62,
  236,
  249,
  135,
  64,
  135,
  12,
  117,
  4,
  89,
  149,
  168,
  209
]);
var SALT_D = Buffer.from([
  246,
  204,
  26,
  232,
  232,
  70,
  129,
  109,
  223,
  146,
  169,
  242,
  23,
  241,
  105,
  145,
  50,
  196,
  165,
  42,
  254,
  120,
  3,
  54,
  244,
  207,
  209,
  85,
  53,
  6,
  138,
  106,
  175,
  148,
  31,
  204,
  186,
  186,
  165,
  182,
  87,
  142,
  49,
  10,
  39,
  110,
  26,
  154,
  86,
  56,
  173,
  125,
  18,
  64,
  198,
  225,
  99,
  99,
  83,
  82,
  191,
  134,
  76,
  170
]);
function normalize_region(region) {
  const key = (region ?? "").trim().toLowerCase();
  return REGION_ALIASES[key] ?? "cn";
}
function resolve_api_base(base_url, region, extra) {
  if (base_url && base_url.trim()) {
    return base_url.trim().replace(/\/+$/, "");
  }
  const extraBase = extra?.["api_base"];
  if (typeof extraBase === "string" && extraBase.trim()) {
    return extraBase.trim().replace(/\/+$/, "");
  }
  return REGION_BASES[normalize_region(region)];
}
function resolve_identity(api_key, extra) {
  const machine_id = extra?.["machine_id"] ?? createHash2("sha256").update(`trae-machine\0${api_key}`).digest("hex");
  const device_id = extra?.["device_id"] ?? createHash2("sha256").update(`trae-device\0${api_key}`).digest("hex").slice(0, 32);
  const user_id = extra?.["user_id"] ?? extra?.["uid"] ?? "";
  return { machine_id, device_id, user_id };
}
function build_headers(api_key, identity, request_id) {
  const rid = request_id ?? randomBytes(16).toString("hex");
  const trace_id = rid.replace("-", "").slice(0, 32);
  return {
    Authorization: `Cloud-IDE-JWT ${api_key}`,
    "X-Cloudide-Token": api_key,
    "X-Ide-Token": api_key,
    // x-uid 必须是真实 user_id(计费/签到接口校验;发整串 JWT 会 401)
    "x-uid": identity.user_id ?? "",
    "x-app-id": APP_ID,
    "x-machine-id": identity.machine_id,
    "x-device-id": identity.device_id,
    "x-device-type": "windows",
    "x-os-version": "Windows 10",
    "x-app-version": DEFAULT_IDE_VERSION,
    "x-ide-version": DEFAULT_IDE_VERSION,
    "x-app-version-code": DEFAULT_IDE_VERSION_CODE,
    "x-ide-version-code": DEFAULT_IDE_VERSION_CODE,
    "x-ide-version-type": "stable",
    "request-traffic-type": "prod",
    "package-type": "stable_cn",
    "x-custom-trace-id": trace_id,
    "x-flow-traceparent": `04-${trace_id}-${trace_id.slice(0, 16)}-01`,
    "x-request-id": rid,
    "x-trae-request-id": rid,
    "User-Agent": `Trae/${DEFAULT_IDE_VERSION}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream"
  };
}
function decrypt_storage_value(encoded) {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length <= 102) {
    throw new UpstreamError2(
      "bad_request",
      "AES 解密: 密文过短",
      false,
      400
    );
  }
  const header = raw.subarray(0, 6);
  let salt;
  if (header.equals(HEADER_AES)) {
    salt = xorBuffers(SALT_A, SALT_B);
  } else if (header.equals(HEADER_AES_PRIVATE)) {
    salt = xorBuffers(SALT_C, SALT_D);
  } else {
    throw new UpstreamError2(
      "bad_request",
      "AES 解密: 未知加密头",
      false,
      400
    );
  }
  const random = raw.subarray(6, 38);
  const ciphertext = raw.subarray(38);
  const derived = createHash2("sha512").update(Buffer.concat([createHash2("sha512").update(random).digest(), salt])).digest();
  const key = derived.subarray(0, 16);
  const iv = derived.subarray(16, 32);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  let padded;
  try {
    padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new UpstreamError2(
      "bad_request",
      `AES 解密: ${err instanceof Error ? err.message : "解密失败"}`,
      false,
      400
    );
  }
  const padLen = padded[padded.length - 1];
  if (padLen < 1 || padLen > 16 || padLen > padded.length) {
    throw new UpstreamError2(
      "bad_request",
      "AES 解密: 无效的 PKCS7 填充",
      false,
      400
    );
  }
  const plaintext = padded.subarray(0, padded.length - padLen);
  if (plaintext.length < 64) {
    throw new UpstreamError2(
      "bad_request",
      "AES 解密: 明文过短",
      false,
      400
    );
  }
  const expectedHash = plaintext.subarray(0, 64);
  const body = plaintext.subarray(64);
  const actualHash = createHash2("sha512").update(body).digest();
  if (!expectedHash.equals(actualHash)) {
    throw new UpstreamError2(
      "bad_request",
      "AES 解密: 完整性校验失败",
      false,
      400
    );
  }
  return body.toString("utf-8");
}
function xorBuffers(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] ^ (b[i] ?? 0);
  }
  return out;
}
function parse_refresh_response(body) {
  if (!body || typeof body !== "object") {
    throw new UpstreamError2("bad_request", "刷新应答格式错误", false, 400);
  }
  const result = body["Result"];
  if (!result) {
    throw new UpstreamError2("bad_request", "刷新应答缺少 Result", false, 400);
  }
  const token = result["Token"];
  if (!token) {
    throw new UpstreamError2("bad_request", "刷新应答缺少 Token", false, 400);
  }
  const expiresAt = parse_expiry(result["TokenExpireAt"]);
  const refreshToken = result["RefreshToken"];
  return {
    accessToken: token,
    expiresAt,
    refreshToken
  };
}
function parse_expiry(value) {
  if (typeof value === "number") {
    if (value >= 1e11) return Math.floor(value / 1e3);
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const num3 = Number(value);
    if (Number.isFinite(num3)) {
      if (num3 >= 1e11) return Math.floor(num3 / 1e3);
      return Math.floor(num3);
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return Math.floor(date.getTime() / 1e3);
    }
  }
  return Number.POSITIVE_INFINITY;
}
function classify_solo_error(code) {
  if (code === 1005) {
    return new UpstreamError2("rate_limit", "套餐额度耗尽", true, 429);
  }
  if (code === TRAE_CODE_ACCOUNT_RESTRICTED) {
    return new UpstreamError2(
      "rate_limit",
      "账号临时限制(上游 4017),已切换到其它账号",
      true,
      429
    );
  }
  if (code === 4001 || code === 4002) {
    return new UpstreamError2("bad_request", "模型配置错误", false, 400);
  }
  if (code === 401 || code === 403) {
    return new UpstreamError2("auth", "账号已失效", false, 401);
  }
  if (code === 4008 || code === 4011 || code === 429) {
    return new UpstreamError2("rate_limit", "请求过于频繁", true, 429);
  }
  if (code >= 500) {
    return new UpstreamError2("upstream", "上游错误", true, code);
  }
  return new UpstreamError2("bad_request", "请求错误", false, 400);
}
var TraeAdapter = class {
  vendorId = "trae";
  async getToken(creds) {
    const apiKey = creds.apiKey;
    if (!apiKey) {
      throw new UpstreamError2("auth", "[trae] 缺少 api_key", false, 401);
    }
    return {
      accessToken: apiKey,
      expiresAt: Number.POSITIVE_INFINITY
    };
  }
  decorateRequest(base, token, creds) {
    const identity = resolve_identity(token.accessToken, creds);
    return {
      ...base,
      headers: {
        ...base.headers,
        ...build_headers(token.accessToken, identity)
      }
    };
  }
  classifyError(httpStatus, body) {
    const original = upstreamRawResponse(httpStatus, body);
    if (httpStatus === 200) {
      const code = extract_code(body);
      if (code !== void 0) {
        return classify_solo_error(code);
      }
    }
    if (httpStatus === 429) {
      return new UpstreamError2("rate_limit", "上游限流", true, 429, void 0, original);
    }
    if (httpStatus === 401 || httpStatus === 403) {
      return new UpstreamError2("auth", "认证失败", false, httpStatus, void 0, original);
    }
    if (httpStatus >= 500) {
      return new UpstreamError2("upstream", "上游错误", true, httpStatus, void 0, original);
    }
    if (httpStatus >= 400) {
      return new UpstreamError2("bad_request", "请求错误", false, httpStatus, void 0, original);
    }
    return new UpstreamError2("upstream", "未知错误", true, httpStatus, void 0, original);
  }
};
function extract_code(body) {
  if (body && typeof body === "object") {
    const code = body["code"];
    if (typeof code === "number") return code;
  }
  return void 0;
}

// core/connectors/workbuddy.ts
import { createHash as createHash3, randomBytes as randomBytes2, randomUUID } from "node:crypto";
var REGION_BASES2 = {
  cn: "https://copilot.tencent.com",
  global: "https://www.workbuddy.ai"
};
var REGION_ALIASES2 = {
  intl: "global",
  cn: "cn"
};
var IDENTITY_VERSIONS = {
  cn: {
    ide: "5.8.3",
    ua: "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0"
  },
  global: {
    ide: "5.9.4",
    ua: "WorkBuddy/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0"
  }
};
var CLI_IDENTITY = {
  ide: "2.168.2",
  ua: "CLI/2.168.2 CodeBuddy/2.168.2"
};
function normalize_identity(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return key === "cli" ? "cli" : "desktop";
}
function normalize_region2(region) {
  const key = (region ?? "").trim().toLowerCase();
  return REGION_ALIASES2[key] ?? "global";
}
function detect_region_from_token(token) {
  const iss = jwt_claim(token, "iss").toLowerCase();
  if (iss.includes("copilot.tencent.com") || iss.includes("codebuddy.cn") || iss.includes("workbuddy.cn")) {
    return "cn";
  }
  return "global";
}
function _jwt_claims(token) {
  try {
    const segment = token.split(".")[1];
    const padded = segment + "=".repeat((4 - segment.length % 4) % 4);
    const decoded = Buffer.from(padded, "base64url").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}
function jwt_claim(token, key) {
  const claims = _jwt_claims(token);
  const value = claims[key];
  return value != null ? String(value) : "";
}
function jwtClaimNumber(token, key) {
  const claims = _jwt_claims(token);
  const raw = claims[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return void 0;
}
function derive_id(uid, salt) {
  return createHash3("md5").update(`${salt}:${uid || "anonymous"}`).digest("hex").slice(0, 36);
}
function new_request_id_hex(nowMs = Date.now()) {
  const ms = Math.trunc(nowMs) % 2 ** 48;
  return `${ms.toString(16).padStart(12, "0")}${randomBytes2(10).toString("hex")}`;
}
function build_identity_headers(token, region, uid, domain, enterprise_id, conversation_id, identity) {
  const realm = normalize_region2(region);
  const kind = normalize_identity(identity);
  const effectiveDomain = domain || (realm === "cn" ? "copilot.tencent.com" : "www.workbuddy.ai");
  const effectiveUid = uid || jwt_claim(token, "sub") || "anonymous";
  const conv = conversation_id || randomUUID();
  const convRequestId = new_request_id_hex();
  const messageId = new_request_id_hex();
  if (kind === "cli") {
    const headers2 = {
      "Content-Type": "application/json",
      "X-Agent-Intent": "craft",
      "X-Agent-Purpose": "conversation",
      "X-Agent-Runtime": "other",
      "X-Agent-Type": "main",
      "X-IDE-Name": "CLI",
      "X-IDE-Type": "CLI",
      "X-IDE-Version": CLI_IDENTITY.ide,
      "X-Product": "SaaS",
      "X-Domain": effectiveDomain,
      "User-Agent": CLI_IDENTITY.ua,
      "X-User-Id": effectiveUid,
      Authorization: `Bearer ${token}`,
      "X-Conversation-ID": conv,
      "X-Conversation-Request-ID": convRequestId,
      "X-Root-Request-ID": convRequestId,
      "X-Conversation-Message-ID": messageId,
      "X-Request-ID": messageId
    };
    if (enterprise_id) {
      headers2["X-Enterprise-Id"] = enterprise_id;
      headers2["X-Tenant-Id"] = enterprise_id;
    }
    return headers2;
  }
  const cfg = IDENTITY_VERSIONS[realm];
  const headers = {
    "Content-Type": "application/json",
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": cfg.ide,
    "X-Private-Data": enterprise_id ? "true" : "false",
    "X-Product": "SaaS",
    "X-Domain": effectiveDomain,
    "User-Agent": cfg.ua,
    "X-User-Id": effectiveUid,
    Authorization: `Bearer ${token}`,
    "X-Conversation-ID": conv,
    "X-Conversation-Request-ID": convRequestId,
    "X-Root-Request-ID": convRequestId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-ID": messageId
  };
  if (enterprise_id) {
    headers["X-Enterprise-Id"] = enterprise_id;
    headers["X-Tenant-Id"] = enterprise_id;
  }
  return headers;
}
function build_chat_headers(token, region, uid, domain, enterprise_id, identity) {
  const realm = normalize_region2(region);
  const origin = REGION_BASES2[realm];
  const kind = normalize_identity(identity);
  const base = build_identity_headers(token, realm, uid, domain, enterprise_id, void 0, kind);
  if (kind === "cli") {
    return { ...base, Accept: "application/json" };
  }
  return {
    ...base,
    // --- 浏览器会话包装（官方桌面端对话确有这些头）---
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "X-CodeBuddy-Request": "1",
    "Accept-Language": realm === "cn" ? "zh-CN" : "en-US"
  };
}
function build_refresh_headers(refresh_token, region = "cn") {
  const realm = normalize_region2(region);
  const origin = REGION_BASES2[realm];
  return {
    "Content-Type": "application/json",
    "X-Refresh-Token": refresh_token,
    "X-Auth-Refresh-Source": realm === "cn" ? "workbuddy" : "plugin",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "Accept-Language": realm === "cn" ? "zh-CN" : "en-US",
    "X-CodeBuddy-Request": "1"
  };
}
function parse_refresh_response2(body) {
  if (!body || typeof body !== "object") {
    throw new UpstreamError2("bad_request", "刷新应答格式错误", false, 400);
  }
  const code = body["code"];
  if (code !== 0) {
    const msg = body["message"] ?? "未知错误";
    throw new UpstreamError2("auth", `刷新失败: ${msg}`, false, 401);
  }
  const data = body["data"];
  if (!data) {
    throw new UpstreamError2("bad_request", "刷新应答缺少 data", false, 400);
  }
  const accessToken = data["accessToken"];
  if (!accessToken) {
    throw new UpstreamError2("bad_request", "刷新应答缺少 accessToken", false, 400);
  }
  const expiresIn = data["expiresIn"];
  const exp = jwtClaimNumber(accessToken, "exp");
  const expiresAt = exp != null ? exp : expiresIn != null ? Math.floor(Date.now() / 1e3) + expiresIn : Number.POSITIVE_INFINITY;
  const refreshToken = data["refreshToken"];
  return {
    accessToken,
    expiresAt,
    refreshToken
  };
}
function classify_workbuddy_error(httpStatus, body) {
  const original = upstreamRawResponse(httpStatus, body);
  const detail = workbuddyErrorDetail(body);
  if (typeof detail.code === "number") {
    if (detail.code === 11128) {
      return new UpstreamError2(
        "bad_request",
        `渠道校验拦截(code 11128)${detail.text ? `:${detail.text}` : ""}`,
        false,
        httpStatus,
        void 0,
        original
      );
    }
    if (detail.code === 11140) {
      return new UpstreamError2(
        "auth",
        `账号存在异常行为,已被限制使用(code 11140)${detail.text ? `:${detail.text}` : ""}`,
        false,
        httpStatus,
        void 0,
        original
      );
    }
  }
  const raw = workbuddySnippet(body);
  const withRaw = (text) => raw === "" ? text : `${text} — 上游:${raw}`;
  if (httpStatus === 401 || httpStatus === 403) {
    return new UpstreamError2("auth", withRaw("认证失败"), false, httpStatus, void 0, original);
  }
  if (httpStatus === 429) {
    const retryAfter = workbuddyResetAfter(body);
    return new UpstreamError2("rate_limit", withRaw("上游限流"), true, 429, retryAfter, original);
  }
  if (httpStatus >= 500) {
    return new UpstreamError2("upstream", withRaw("上游错误"), true, httpStatus, void 0, original);
  }
  if (httpStatus >= 400) {
    return new UpstreamError2("bad_request", withRaw("请求错误"), false, httpStatus, void 0, original);
  }
  return new UpstreamError2("upstream", withRaw("未知错误"), true, httpStatus, void 0, original);
}
function workbuddySnippet(body) {
  const detail = workbuddyErrorDetail(body);
  const raw = detail.text !== "" ? detail.text : JSON.stringify(body ?? "");
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 200);
}
function workbuddyErrorDetail(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { code: null, text: "" };
  }
  const b = body;
  const rawCode = b["code"];
  const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" && /^\d+$/.test(rawCode) ? Number(rawCode) : null;
  const displayMsg = b["displayMsg"];
  const dm = displayMsg !== null && typeof displayMsg === "object" && !Array.isArray(displayMsg) ? displayMsg : null;
  const dmZh = dm?.["zh"];
  const text = [dmZh, b["msg"], b["message"]].find((v) => typeof v === "string" && v.trim() !== "");
  return { code, text: text?.trim() ?? "" };
}
function workbuddyResetAfter(body) {
  const detail = workbuddyErrorDetail(body);
  if (detail.text === "") return void 0;
  const m = /将在\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*(UTC([+-]\d{1,2})(?::(\d{2}))?)?\s*重置/.exec(detail.text);
  if (!m) return void 0;
  const date = m[1];
  const time = m[2];
  const tzSign = m[4];
  const tzMin = m[5];
  let iso;
  if (tzSign !== void 0) {
    const sign = tzSign[0];
    const hh = tzSign.slice(1).padStart(2, "0");
    const mm = tzMin ?? "00";
    iso = `${date}T${time}${sign}${hh}:${mm}`;
  } else {
    iso = `${date}T${time}`;
  }
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return void 0;
  const secs = Math.ceil((at - Date.now()) / 1e3);
  return secs >= 0 ? secs : 0;
}
function asOptionalString(v) {
  if (typeof v === "string" && v.trim() !== "") return v;
  return void 0;
}
var WorkbuddyAdapter = class {
  vendorId = "workbuddy";
  async getToken(creds) {
    const apiKey = creds.apiKey;
    if (!apiKey) {
      throw new UpstreamError2("auth", "[workbuddy] 缺少 api_key", false, 401);
    }
    return {
      accessToken: apiKey,
      expiresAt: Number.POSITIVE_INFINITY
    };
  }
  decorateRequest(base, token, creds) {
    const region = (creds?.region && creds.region.trim() ? creds.region : void 0) ?? detect_region_from_token(token.accessToken);
    const uid = asOptionalString(creds?.["uid"]);
    const domain = asOptionalString(creds?.["domain"]);
    const enterpriseId = asOptionalString(creds?.["enterprise_id"]);
    const identity = normalize_identity(creds?.["identity"]);
    return {
      ...base,
      headers: {
        ...base.headers,
        ...build_chat_headers(token.accessToken, region, uid, domain, enterpriseId, identity)
      }
    };
  }
  classifyError(httpStatus, body) {
    return classify_workbuddy_error(httpStatus, body);
  }
};

// core/connectors/minimax-wire.ts
import { createHash as createHash4 } from "node:crypto";
var SIGNIN_SIGNATURE_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";
var SIGNIN_SIGNATURE_SUFFIX = "ooui";
var OP_TICKET_LITERAL = "undefined";
var MINIMAX_BASE_CN = "https://agent.minimaxi.com";
var MINIMAX_BASE_GLOBAL = "https://agent.minimax.io";
var MINIMAX_SIGNIN_STATUS_PATH = "/minimax-cloud/api/v1/signin/status";
var MINIMAX_SIGNIN_CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";
var MINIMAX_CREDIT_PATH = "/matrix/api/v1/commerce/get_membership_info";
var MINIMAX_CREDIT_DETAILS_PATH = "/minimax-cloud/api/v1/credit/details";
var MINIMAX_WEB_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
var MINIMAX_DESKTOP_USER_AGENT = "MiniMaxAgent Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) MiniMaxAgent/{version} Chrome/148.0.7778.280 Safari/537.36";
var MINIMAX_DESKTOP_VERSION = "3.0.73";
var MINIMAX_TIMEOUT_MS = 6e4;
var DEFAULT_MINIMAX_SIGNIN_PROFILE = {
  lang: "en",
  osName: "Windows",
  browserName: "Chrome",
  browserLanguage: "en-US",
  browserPlatform: "Win32",
  timezoneOffsetMin: 480,
  deviceMemory: 16,
  cpuCoreNum: 8,
  screenWidth: 1920,
  screenHeight: 1080
};
function md5Hex(value) {
  return createHash4("md5").update(value, "utf8").digest("hex");
}
function formEncode(value) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}
function xSignature(unixSeconds, body) {
  return md5Hex(`${unixSeconds}${SIGNIN_SIGNATURE_SALT}${body}`);
}
function yy(signUrl, body, unixMs) {
  return md5Hex(
    `${encodeURIComponent(signUrl)}_${body}${md5Hex(String(unixMs))}${SIGNIN_SIGNATURE_SUFFIX}`
  );
}
function baseUrlOf(cred) {
  const explicit = (cred.baseUrl ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return cred.region === "cn" ? MINIMAX_BASE_CN : MINIMAX_BASE_GLOBAL;
}
function userAgentOf(cred) {
  return cred.bearer ? MINIMAX_DESKTOP_USER_AGENT.replace("{version}", MINIMAX_DESKTOP_VERSION) : MINIMAX_WEB_USER_AGENT;
}
function buildSigninQuery(cred, unixMs, forSignature, profile = DEFAULT_MINIMAX_SIGNIN_PROFILE) {
  const width = cred.screenWidth || profile.screenWidth;
  const height = cred.screenHeight || profile.screenHeight;
  const pairs = [
    ["device_platform", "web"],
    ["biz_id", "3"],
    ["app_id", "3001"],
    ["version_code", "22201"],
    ["unix", String(unixMs)],
    ["timezone_offset", String(profile.timezoneOffsetMin * 60)],
    ["sys_language", profile.lang],
    ["lang", profile.lang],
    ["uuid", cred.uuid],
    ["device_id", cred.deviceId],
    ["os_name", profile.osName],
    ["browser_name", profile.browserName],
    ["device_memory", String(profile.deviceMemory)],
    ["cpu_core_num", String(profile.cpuCoreNum)],
    ["browser_language", profile.browserLanguage],
    ["browser_platform", profile.browserPlatform],
    ["user_id", (cred.userId ?? "").trim() || "0"],
    ["op_ticket", OP_TICKET_LITERAL],
    ["screen_width", String(width)],
    ["screen_height", String(height)],
    ["token", cred.bearer ? "" : cred.token],
    ["client", "web"]
  ];
  const out = [];
  for (const [key, value] of pairs) {
    if (key === "op_ticket" && !forSignature) continue;
    if (!value && key !== "op_ticket") continue;
    out.push(`${key}=${formEncode(value)}`);
  }
  return out.join("&");
}
function signinTarget(cred, path, opts = {}, profile = DEFAULT_MINIMAX_SIGNIN_PROFILE) {
  const unixMs = opts.unixMs ?? Date.now();
  const method = opts.method ?? "GET";
  const body = opts.body ?? "";
  const signed = `${path}?${buildSigninQuery(cred, unixMs, true, profile)}`;
  const wire = `${path}?${buildSigninQuery(cred, unixMs, false, profile)}`;
  return {
    method,
    url: `${baseUrlOf(cred)}${wire}`,
    signUrl: signed,
    unixMs,
    body,
    checkin: true
  };
}
function minimaxHeaders(cred, target) {
  const base = baseUrlOf(cred);
  const unixSeconds = Math.floor(target.unixMs / 1e3);
  const yyBody = target.checkin ? "{}" : target.body;
  const headers = {
    accept: target.checkin ? "*/*" : "application/json, text/plain, */*",
    "content-type": "application/json",
    origin: base,
    referer: `${base}/`,
    "user-agent": userAgentOf(cred),
    token: cred.token,
    "x-timestamp": String(unixSeconds),
    "x-signature": xSignature(unixSeconds, target.body),
    yy: yy(target.signUrl, yyBody, target.unixMs)
  };
  if (cred.bearer) {
    headers["Authorization"] = `Bearer ${cred.bearer}`;
    delete headers["token"];
  }
  return headers;
}
function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function str(value) {
  return typeof value === "string" ? value : "";
}
function coreOf(payload) {
  const data = payload["data"];
  return typeof data === "object" && data !== null && !Array.isArray(data) ? data : payload;
}
function parseSigninPanel(core) {
  const days = [];
  const raw = core["days"];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item;
      days.push({
        dayNo: num(rec["day_no"]),
        points: num(rec["points"]),
        status: num(rec["status"]),
        isToday: rec["is_today"] === true
      });
    }
  }
  return { scene: num(core["scene"]), days };
}
function panelClaimedToday(panel) {
  const today = panel.days.find((d) => d.isToday);
  return today !== void 0 && today.status === 3;
}
function panelTodayPoints(panel) {
  const today = panel.days.find((d) => d.isToday);
  return today ? today.points : 0;
}
function parseSigninClaim(core) {
  const panelRaw = core["panel"];
  return {
    claimId: num(core["claim_id"]),
    result: num(core["claim_result"]),
    dayNo: num(core["day_no"]),
    points: num(core["points"]),
    panel: typeof panelRaw === "object" && panelRaw !== null && !Array.isArray(panelRaw) ? parseSigninPanel(panelRaw) : null
  };
}
function parseCredit(core) {
  const summary = core["op_credit_summary"];
  if (typeof summary === "object" && summary !== null && !Array.isArray(summary)) {
    const s = summary;
    return {
      planName: str(core["plan_name"]),
      planType: num(core["plan_type"]),
      total: num(s["total_remaining_amount"]),
      free: num(s["free_remaining_amount"]),
      purchased: num(s["purchased_remaining_amount"])
    };
  }
  return {
    planName: str(core["plan_name"]),
    planType: num(core["plan_type"]),
    total: num(core["opcredit_balance"]) || num(core["total_remains_credit"]),
    free: 0,
    purchased: 0
  };
}
function epochSeconds(value) {
  const n = num(value);
  if (n <= 0) return 0;
  return n > 1e11 ? Math.floor(n / 1e3) : n;
}
function parseCreditGrants(core) {
  const raw = core["details"];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item;
    out.push({
      grantedAt: epochSeconds(rec["granted_at_ms"] ?? rec["granted_at"]),
      expiresAt: epochSeconds(rec["expire_at_ms"] ?? rec["expires_at"] ?? rec["expire_at"]),
      granted: num(rec["granted_amount"] ?? rec["granted"]),
      remaining: num(rec["remaining_amount"] ?? rec["remaining"])
    });
  }
  return out;
}
function earliestGrantExpiry(grants) {
  let best = null;
  for (const g of grants) {
    if (g.remaining <= 0) continue;
    if (g.expiresAt <= 0) continue;
    if (best === null || g.expiresAt < best) best = g.expiresAt;
  }
  return best;
}

// core/connectors/checkin.ts
var CheckinError = class extends Error {
  kind = "checkin";
  constructor(message) {
    super(message);
    this.name = "CheckinError";
  }
};
var CheckinRegionError = class extends CheckinError {
  kind = "region";
  constructor(message) {
    super(message);
    this.name = "CheckinRegionError";
  }
};
var CheckinCredentialError = class extends CheckinError {
  kind = "credential";
  constructor(message) {
    super(message);
    this.name = "CheckinCredentialError";
  }
};
var WbHttpCheckinError = class extends CheckinError {
  constructor(message, httpStatus, upstreamCode, upstreamMessage) {
    super(message);
    this.httpStatus = httpStatus;
    this.upstreamCode = upstreamCode;
    this.upstreamMessage = upstreamMessage;
    this.name = "WbHttpCheckinError";
  }
  httpStatus;
  upstreamCode;
  upstreamMessage;
  kind = "wb_http";
};
var CHECKIN_PROVIDERS = ["trae", "workbuddy", "minimax", "codearts"];
function checkinSupported(provider) {
  return typeof provider === "string" && CHECKIN_PROVIDERS.includes(provider);
}
var TRAE_PAY_BASE_CN = "https://api.trae.cn";
var TRAE_CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
var TRAE_CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
var TRAE_CODE_NO_DEVICE = 9004;
var TRAE_CODE_DEVICE_ALREADY = 9095;
var TRAE_CODE_CROWDED = 9074;
var TRAE_CODE_AUTH_FAILED = 1001;
var TRAE_AUTH_HINTS = [
  "not able to authenticate",
  "unable to authenticate",
  "authenticate you",
  "unauthorized",
  "登录失效",
  "重新登录"
];
function isTraeAuthFailure(code, message) {
  if (code === TRAE_CODE_AUTH_FAILED) return true;
  const m = (message ?? "").toLowerCase();
  return TRAE_AUTH_HINTS.some((h) => m.includes(h.toLowerCase()));
}
var TRAE_CHECKIN_TIMEOUT_MS = 15e3;
var TRAE_RETRYABLE_HINTS = [
  "参与用户太多",
  "稍后再试",
  "请稍后",
  "系统繁忙",
  "服务繁忙",
  "请求过于频繁",
  "too many",
  "try again",
  "later",
  "busy"
];
var TRAE_NON_RETRYABLE_CODES = /* @__PURE__ */ new Set([TRAE_CODE_NO_DEVICE, TRAE_CODE_DEVICE_ALREADY]);
var TRANSIENT_ERROR_HINTS = [
  "超时",
  "timeout",
  "连接",
  "connection",
  "econnreset",
  "socket",
  "http 429",
  "http 500",
  "http 502",
  "http 503",
  "http 504"
];
function isRetryableCheckinFailure(message, code) {
  if (typeof code === "number" && Number.isFinite(code) && TRAE_NON_RETRYABLE_CODES.has(code)) {
    return false;
  }
  const m = (message ?? "").toLowerCase();
  if (m === "") return false;
  return TRAE_RETRYABLE_HINTS.some((h) => m.includes(h.toLowerCase()));
}
function isTransientCheckinError(err) {
  const m = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return TRANSIENT_ERROR_HINTS.some((h) => m.includes(h));
}
var DEFAULT_CHECKIN_RETRY = {
  attempts: 2,
  baseDelayMs: 5e3,
  maxDelayMs: 2e4,
  jitterRatio: 0.3
};
function checkinBackoffMs(attempt, p = {}) {
  const base = p.baseDelayMs ?? DEFAULT_CHECKIN_RETRY.baseDelayMs;
  const max = p.maxDelayMs ?? DEFAULT_CHECKIN_RETRY.maxDelayMs;
  const ratio = p.jitterRatio ?? DEFAULT_CHECKIN_RETRY.jitterRatio;
  const step = Math.max(0, attempt);
  const raw = Math.min(max, base * Math.pow(2, step));
  return Math.round(Math.min(max, raw + raw * ratio * Math.random()));
}
async function defaultSleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}
function traeCheckinHeaders(token, device_id) {
  const headers = {
    Authorization: `Cloud-IDE-JWT ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0",
    Origin: "https://www.trae.cn",
    Referer: "https://www.trae.cn/"
  };
  if (device_id && device_id.length > 0) {
    headers["x-device-id"] = device_id;
  }
  return headers;
}
function isNumber(v) {
  return typeof v === "number" && !Number.isNaN(v);
}
function parseTraeStatus(payload) {
  if (typeof payload !== "object" || payload === null) {
    return {
      checked_in: false,
      credits: 0,
      enable: true,
      did_checked_in: false,
      extra_credits: null,
      code: null,
      message: ""
    };
  }
  const p = payload;
  return {
    checked_in: p["checked_in"] === true,
    credits: isNumber(p["credits"]) ? p["credits"] : 0,
    enable: p["enable"] !== false,
    did_checked_in: p["did_checked_in"] === true,
    extra_credits: isNumber(p["extra_credits"]) && p["extra_credits"] > 0 ? p["extra_credits"] : null,
    code: isNumber(p["code"]) ? p["code"] : null,
    message: typeof p["message"] === "string" ? p["message"] : ""
  };
}
function parseTraeClaim(payload) {
  if (typeof payload !== "object" || payload === null) {
    return { claimed: false, code: -1, message: "claim 应答不是 JSON 对象" };
  }
  const p = payload;
  const code = isNumber(p["code"]) ? p["code"] : -1;
  return {
    claimed: code === 0,
    code,
    message: typeof p["message"] === "string" ? p["message"].slice(0, 200) : ""
  };
}
async function rawPost(fetchFn, url, headers, timeoutMs) {
  let resp;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new CheckinError(`签到请求超时(${timeoutMs}ms)`);
    }
    throw new CheckinError(`签到请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  let text;
  try {
    text = await resp.text();
  } catch (err) {
    throw new CheckinError(`签到应答读取失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { status: resp.status, text };
}
function requireCNCheckinAccount(account, action = "签到") {
  const region = (account.region ?? "").toString().trim().toLowerCase();
  if (region && region !== "cn") {
    throw new CheckinRegionError(
      `${action}:国际版(区域 ${region})没有签到功能 —— 国际版是订阅制,额度走 payStatus 接口。`
    );
  }
}
function resolveTraeDevice(account) {
  const fromExtra = account.extra?.["device_id"];
  if (typeof fromExtra === "string" && fromExtra.trim() !== "") return fromExtra.trim();
  const explicit = account.device_id;
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  return resolve_identity(account.token, {}).device_id;
}
async function traeCheckinStatus(account, opts = {}) {
  requireCNCheckinAccount(account, "签到状态");
  const deviceId = resolveTraeDevice(account);
  const base = (opts.baseUrl ?? TRAE_PAY_BASE_CN).replace(/\/+$/, "");
  const url = `${base}${TRAE_CHECKIN_STATUS_PATH}`;
  const r = await rawPost(
    opts.fetchFn ?? fetch,
    url,
    traeCheckinHeaders(account.token, deviceId),
    opts.timeoutMs ?? TRAE_CHECKIN_TIMEOUT_MS
  );
  if (r.status < 200 || r.status >= 300) {
    throw new CheckinError(`trae 签到端点 ${TRAE_CHECKIN_STATUS_PATH} 返回 HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(r.text);
  } catch (err) {
    throw new CheckinError(`trae 签到应答不是合法 JSON:${err instanceof Error ? err.message : String(err)}`);
  }
  return parseTraeStatus(payload);
}
async function traeCheckinClaim(account, opts) {
  const confirm = opts.confirm === true;
  requireCNCheckinAccount(account, "签到");
  const status = await traeCheckinStatus(account, opts);
  const base = { provider: "trae", username: account.username, index: account.index };
  const settled = (over) => ({ attempts: 0, retries: 0, ...base, ...over });
  if (status.enable === false) {
    if (isTraeAuthFailure(status.code, status.message)) {
      return settled({
        claimed: false,
        enabled: false,
        would_claim: false,
        auth_failed: true,
        code: status.code,
        message: `登录已失效(上游 code ${status.code ?? "?"}${status.message ? `:${status.message}` : ""}) —— 请在 Trae 客户端重新登录后重新导入账号`,
        checkin: status
      });
    }
    const detail = status.code !== null && status.code !== 0 || status.message !== "" ? `(上游 code ${status.code ?? "?"}${status.message ? `:${status.message}` : ""})` : "";
    return settled({
      claimed: false,
      enabled: false,
      would_claim: false,
      code: status.code,
      message: `该账号未启用签到${detail}`,
      checkin: status
    });
  }
  if (status.checked_in) {
    return settled({ claimed: false, enabled: true, would_claim: false, already_checked_in: true, code: null, message: "今日已签到", checkin: status });
  }
  if (status.did_checked_in) {
    return settled({
      claimed: false,
      enabled: true,
      would_claim: false,
      device_checked_in: true,
      code: TRAE_CODE_DEVICE_ALREADY,
      // ⚠️ 文案要说清**这是设备级限制**(2026-11-10 实测):上游按设备放行每日签到,
      // 同一台机器上多账号时只有第一个能签,其余一律 9095。
      // 写成「本设备今日已签」+ 原因,用户才知道该等明天、而不是反复重试。
      message: `本设备今日已签到(上游 code ${TRAE_CODE_DEVICE_ALREADY}) —— trae 按**设备**放行每日签到:同一台机器上的多个账号,一天只有第一个能签上`,
      checkin: status
    });
  }
  if (!confirm) {
    return settled({ claimed: false, enabled: true, would_claim: true, code: null, message: "今日可签到;需显式确认(confirm=True)才会领取", checkin: status });
  }
  const deviceId = resolveTraeDevice(account);
  const baseUrl = (opts.baseUrl ?? TRAE_PAY_BASE_CN).replace(/\/+$/, "");
  const claimUrl = `${baseUrl}${TRAE_CHECKIN_CLAIM_PATH}`;
  const policy = opts.retry === null ? null : opts.retry ?? DEFAULT_CHECKIN_RETRY;
  const maxAttempts = policy === null ? 1 : Math.max(1, Math.trunc(policy.attempts ?? DEFAULT_CHECKIN_RETRY.attempts));
  const sleep = policy?.sleepFn ?? defaultSleep;
  const postClaim = async () => {
    const r = await rawPost(
      opts.fetchFn ?? fetch,
      claimUrl,
      traeCheckinHeaders(account.token, deviceId),
      opts.timeoutMs ?? TRAE_CHECKIN_TIMEOUT_MS
    );
    if (r.status < 200 || r.status >= 300) {
      throw new CheckinError(`trae 签到端点 ${TRAE_CHECKIN_CLAIM_PATH} 返回 HTTP ${r.status}: ${r.text.slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(r.text);
    } catch (err) {
      throw new CheckinError(`trae 签到应答不是合法 JSON:${err instanceof Error ? err.message : String(err)}`);
    }
    return parseTraeClaim(payload);
  };
  let parsed = null;
  let lastError = null;
  let tries = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(checkinBackoffMs(attempt - 1, policy ?? void 0));
      tries += 1;
    }
    try {
      parsed = await postClaim();
    } catch (err) {
      lastError = err;
      if (!(err instanceof CheckinError) || !isTransientCheckinError(err)) break;
      continue;
    }
    lastError = null;
    if (parsed.claimed) break;
    if (!isRetryableCheckinFailure(parsed.message, parsed.code)) break;
  }
  if (parsed === null) {
    throw lastError instanceof Error ? lastError : new CheckinError(String(lastError ?? "trae 领取失败"));
  }
  const attemptsMade = tries + 1;
  if (!parsed.claimed) {
    const retried = tries > 0 ? `(已重试 ${tries} 次仍失败)` : "";
    return settled({
      claimed: false,
      enabled: true,
      would_claim: false,
      code: parsed.code,
      message: `${parsed.message || "上游拒绝领取"}${retried}`,
      checkin: status,
      attempts: attemptsMade,
      retries: tries
    });
  }
  let fresh = status;
  try {
    fresh = await traeCheckinStatus(account, opts);
  } catch {
  }
  const got = fresh.credits > 0 ? `领取成功,当前积分 ${fresh.credits}` : "领取成功";
  return settled({
    claimed: true,
    enabled: true,
    would_claim: false,
    code: 0,
    message: parsed.message || got,
    checkin: fresh,
    attempts: attemptsMade,
    retries: tries
  });
}
var WB_CN_BILLING_BASE = "https://www.codebuddy.cn";
var WB_CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
var WB_CHECKIN_CLAIM_PATH = "/v2/billing/meter/daily-checkin";
var WB_GLOBAL_BASE = "https://www.workbuddy.ai";
var WB_GLOBAL_BASE_CODEBUDDY = "https://www.codebuddy.ai";
var WB_CHECKIN_TIMEOUT_MS = 3e4;
var WB_CODE_ALREADY_CHECKED_IN = 10001;
var GLOBAL_DOMAINS = ["workbuddy.ai", "codebuddy.ai"];
function wbRegionOf(domain) {
  let d = (domain ?? "").toString().trim().toLowerCase();
  if (d.startsWith("www.")) d = d.slice(4);
  if (GLOBAL_DOMAINS.some((g) => d === g || d.endsWith(`.${g}`))) return "global";
  return "cn";
}
function wbBillingBase(domain) {
  if (wbRegionOf(domain) === "global") {
    const d = (domain ?? "").toString().toLowerCase();
    return d.includes("codebuddy.ai") ? WB_GLOBAL_BASE_CODEBUDDY : WB_GLOBAL_BASE;
  }
  return WB_CN_BILLING_BASE;
}
function wbCheckinHeaders(token, uid, domain, enterpriseId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    // 计费域是 openresty/APISIX 前置的独立站点，桌面端计费接口要带浏览器身份头。
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Origin: "https://www.workbuddy.cn",
    Referer: "https://www.workbuddy.cn/"
  };
  if (uid && uid.length > 0) headers["X-User-Id"] = uid;
  if (enterpriseId && enterpriseId.length > 0) {
    headers["X-Enterprise-Id"] = enterpriseId;
    headers["X-Tenant-Id"] = enterpriseId;
  }
  if (domain && domain.length > 0) headers["X-Domain"] = domain;
  return headers;
}
function num2(v) {
  return isNumber(v) ? v : 0;
}
function wbEnvelopeMessage(envelope) {
  const message = (typeof envelope["message"] === "string" && envelope["message"].length > 0 ? envelope["message"] : "") || (typeof envelope["msg"] === "string" && envelope["msg"].length > 0 ? envelope["msg"] : "");
  return message;
}
async function wbPost(opts, path, account) {
  const base = (opts.baseUrl ?? wbBillingBase(account.domain)).replace(/\/+$/, "");
  const url = `${base}${path}`;
  const r = await rawPost(
    opts.fetchFn ?? fetch,
    url,
    wbCheckinHeaders(account.token ?? "", account.uid, account.domain, account.enterprise_id),
    opts.timeoutMs ?? WB_CHECKIN_TIMEOUT_MS
  );
  const snippet = r.text.slice(0, 300);
  let payload;
  try {
    payload = JSON.parse(r.text);
  } catch {
    if (r.status < 200 || r.status >= 300) {
      throw new WbHttpCheckinError(`workbuddy 签到端点 ${path} 返回 HTTP ${r.status}: ${snippet}`, r.status, null, "");
    }
    throw new CheckinError(`workbuddy 签到端点 ${path} 应答不是合法 JSON: ${snippet}`);
  }
  if (typeof payload !== "object" || payload === null) {
    throw new CheckinError(`workbuddy 签到端点 ${path} 应答不是对象`);
  }
  const envelope = payload;
  const code = isNumber(envelope["code"]) ? envelope["code"] : null;
  const message = wbEnvelopeMessage(envelope);
  if (r.status < 200 || r.status >= 300) {
    const detail = code !== null || message.length > 0 ? `（code=${code === null ? "None" : code}${message.length > 0 ? `: ${message}` : ""}）` : `: ${snippet}`;
    throw new WbHttpCheckinError(`workbuddy 签到端点 ${path} 返回 HTTP ${r.status}${detail}`, r.status, code, message);
  }
  const data = envelope["data"];
  return {
    envelope,
    data: typeof data === "object" && data !== null ? data : {},
    code,
    message
  };
}
async function wbCheckinStatus(account, opts = {}) {
  if (wbRegionOf(account.domain) !== "cn") {
    throw new CheckinRegionError("国际版无签到(订阅制,额度走 payStatus)");
  }
  const res = await wbPost(opts, WB_CHECKIN_STATUS_PATH, account);
  if (res.code !== null && res.code !== 0) {
    throw new CheckinError(
      `workbuddy 签到状态业务失败 code=${res.code}${res.message.length > 0 ? `: ${res.message}` : ""}`
    );
  }
  const d = res.data;
  const dates = d["checkin_dates"];
  return {
    active: d["active"] === true,
    today_checked_in: d["today_checked_in"] === true,
    streak_days: num2(d["streak_days"]),
    daily_credit: num2(d["daily_credit"]),
    today_credit: num2(d["today_credit"]),
    is_streak_day: d["is_streak_day"] === true,
    checkin_dates: Array.isArray(dates) ? dates.filter((x) => typeof x === "string" && x.length > 0) : [],
    end_time: typeof d["end_time"] === "string" && d["end_time"].length > 0 ? d["end_time"] : null
  };
}
async function wbCheckinClaim(account, opts = {}) {
  if (!account.token) {
    throw new CheckinCredentialError("该账号没有可用令牌");
  }
  if (wbRegionOf(account.domain) !== "cn") {
    throw new CheckinRegionError("国际版无签到(订阅制,额度走 payStatus)");
  }
  let res;
  try {
    res = await wbPost(opts, WB_CHECKIN_CLAIM_PATH, account);
  } catch (err) {
    if (err instanceof WbHttpCheckinError && err.httpStatus === 400 && err.upstreamCode === WB_CODE_ALREADY_CHECKED_IN && /已签到|已签/.test(err.upstreamMessage)) {
      return {
        already: true,
        credit: 0,
        streak_days: 0,
        is_streak_day: false,
        message: err.upstreamMessage
      };
    }
    throw err;
  }
  if (res.code === WB_CODE_ALREADY_CHECKED_IN && /已签到|已签/.test(res.message)) {
    return { already: true, credit: 0, streak_days: 0, is_streak_day: false, message: res.message };
  }
  if (res.code === null || res.code !== 0) {
    throw new CheckinError(`workbuddy 业务失败 code=${res.code === null ? "None" : res.code}: ${res.message}`);
  }
  return {
    already: false,
    credit: num2(res.data["credit"]),
    streak_days: num2(res.data["streak_days"]),
    is_streak_day: res.data["is_streak_day"] === true,
    message: res.message
  };
}

// core/connectors/minimax-signin.ts
function targetOf(account, path, opts = {}) {
  const target = signinTarget(account, path, {
    method: opts.method ?? "GET",
    body: opts.body ?? ""
  });
  return {
    url: target.url,
    method: target.method,
    headers: minimaxHeaders(account, target),
    body: target.body === "" ? void 0 : target.body
  };
}
async function callJson(account, path, label, opts = {}) {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? MINIMAX_TIMEOUT_MS;
  const send = async (acct) => {
    const req = targetOf(acct, path, { method: opts.method, body: opts.body });
    try {
      return await fetchFn(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new CheckinError(`minimax ${label} 请求超时(${timeoutMs}ms)`);
      }
      throw new CheckinError(
        `minimax ${label} 请求失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
  let resp = await send(account);
  let renewFailure = null;
  let retriedWithNewToken = false;
  if ((resp.status === 401 || resp.status === 403) && opts.onAuthExpired) {
    try {
      const renewed = await opts.onAuthExpired(account);
      if (renewed !== null) {
        retriedWithNewToken = true;
        resp = await send(renewed);
      } else {
        renewFailure = "没有可用的 refresh_token(续期回调返回 null)";
      }
    } catch (err) {
      renewFailure = err instanceof Error ? err.message : String(err);
    }
  }
  let text;
  try {
    text = await resp.text();
  } catch (err) {
    throw new CheckinError(
      `minimax ${label} 读取响应失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (resp.status === 401 || resp.status === 403) {
    let suffix = "";
    if (opts.onAuthExpired) {
      suffix = renewFailure !== null ? `(自动续期未成功: ${renewFailure})` : retriedWithNewToken ? "(已用 refresh_token 换新令牌并重试,上游仍拒绝:请检查设备指纹或账号状态)" : "(已尝试用 refresh_token 自动续期,仍失败)";
    }
    throw new CheckinError(
      `minimax ${label} 鉴权失败(HTTP ${resp.status}):凭据可能已过期${suffix}`
    );
  }
  if (resp.status >= 400) {
    throw new CheckinError(`minimax ${label} HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    throw new CheckinError(`minimax ${label} 返回非 JSON: ${trimmed.slice(0, 200)}`);
  }
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    throw new CheckinError(`minimax ${label} 返回非法 JSON: ${trimmed.slice(0, 200)}`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CheckinError(`minimax ${label} 返回非对象`);
  }
  return payload;
}
async function minimaxSigninStatus(account, opts = {}) {
  requireDevice(account);
  const payload = await callJson(account, MINIMAX_SIGNIN_STATUS_PATH, "signin status", opts);
  return parseSigninPanel(coreOf(payload));
}
async function minimaxSigninClaim(account, opts = {}) {
  requireDevice(account);
  const payload = await callJson(account, MINIMAX_SIGNIN_CLAIM_PATH, "signin claim", {
    ...opts,
    method: "POST",
    body: "{}"
  });
  return parseSigninClaim(coreOf(payload));
}
async function minimaxCredit(account, opts = {}) {
  requireDevice(account);
  const payload = await callJson(account, MINIMAX_CREDIT_PATH, "credit", {
    ...opts,
    method: "POST",
    body: "{}"
  });
  return parseCredit(coreOf(payload));
}
async function minimaxCreditGrants(account, opts = {}) {
  requireDevice(account);
  const payload = await callJson(account, MINIMAX_CREDIT_DETAILS_PATH, "credit details", opts);
  return parseCreditGrants(coreOf(payload));
}
function requireDevice(account) {
  if (!(account.uuid ?? "").trim() || !(account.deviceId ?? "").trim()) {
    throw new CheckinError("minimax 账号缺少 uuid / device_id,无法构造签名请求");
  }
  if (!(account.token ?? "").trim() && !(account.bearer ?? "").trim()) {
    throw new CheckinError("minimax 账号没有可用令牌");
  }
}
var MINIMAX_ACCOUNT_ORIGINS = {
  cn: "https://account.minimax.cn",
  global: "https://account.minimax.io"
};
var MINIMAX_OAUTH_CLIENT_ID = "mcode-public";
async function minimaxRefreshToken(input, opts = {}) {
  const refreshToken = (input.refreshToken ?? "").trim();
  if (!refreshToken) {
    throw new CheckinError("minimax 账号没有 refresh_token,无法续期");
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 2e4;
  const origin = MINIMAX_ACCOUNT_ORIGINS[input.region === "global" ? "global" : "cn"];
  const body = new URLSearchParams({
    client_id: MINIMAX_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  }).toString();
  let resp;
  try {
    resp = await fetchFn(`${origin}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new CheckinError(`minimax 续期请求超时(${timeoutMs}ms)`);
    }
    throw new CheckinError(
      `minimax 续期请求失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const text = await resp.text();
  let payload = {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed;
    }
  } catch {
  }
  const accessToken = typeof payload["access_token"] === "string" ? payload["access_token"] : "";
  if (!accessToken) {
    const detail = typeof payload["error_description"] === "string" && payload["error_description"] || typeof payload["error"] === "string" && payload["error"] || text.slice(0, 200);
    throw new CheckinError(`minimax 续期被拒(HTTP ${resp.status}): ${detail}`);
  }
  const expiresIn = payload["expires_in"];
  return {
    accessToken,
    refreshToken: typeof payload["refresh_token"] === "string" && payload["refresh_token"].length > 0 ? payload["refresh_token"] : null,
    expiresInSec: typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : typeof expiresIn === "string" && Number.isFinite(Number(expiresIn)) ? Number(expiresIn) : null
  };
}
function minimaxAccountOf(input) {
  const raw = input.extra ?? {};
  const str2 = (key) => {
    const v = raw[key];
    return typeof v === "string" ? v.trim() : "";
  };
  const numOf = (key) => {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const token = input.token ?? "";
  const bearer = str2("bearer") || (str2("kind") === "oauth" && token ? token : "");
  return {
    region: (input.region ?? "").trim().toLowerCase() === "global" ? "global" : "cn",
    token,
    bearer: bearer || null,
    uuid: str2("uuid"),
    deviceId: str2("device_id"),
    userId: str2("user_id") || str2("uid") || null,
    baseUrl: str2("base_url") || null,
    screenWidth: numOf("screen_width"),
    screenHeight: numOf("screen_height")
  };
}

// core/connectors/codearts.ts
var CODEARTS_BASE_CN = "https://snap-access.cn-north-4.myhuaweicloud.com";
var CODEARTS_CHAT_PATH = "/api/v2/chat/completions";
var CODEARTS_MODELS_PATH = "/v1/model/builtin";
var CODEARTS_IDENTITY = {
  pluginName: "codemate_vscode",
  pluginVersion: "26.9.902",
  ideName: "VSCode",
  ideVersion: "26.9.902",
  appId: "CodeAgent3.0",
  language: "zh-cn",
  clientType: "IDE",
  functionName: "agent-general"
};
function hexOf(bytes) {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function codeartsSessionId(accessKey, domainId) {
  const seed = `${domainId ?? ""}|${accessKey}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `ses_${h.toString(16).padStart(8, "0")}${accessKey.slice(-4).toLowerCase()}`;
}
function codeartsIdentityHeaders(input) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "plugin-name": CODEARTS_IDENTITY.pluginName,
    "plugin-version": CODEARTS_IDENTITY.pluginVersion,
    "ide-name": CODEARTS_IDENTITY.ideName,
    "ide-version": CODEARTS_IDENTITY.ideVersion,
    "app-id": CODEARTS_IDENTITY.appId,
    "X-Language": CODEARTS_IDENTITY.language,
    "X-Requested-With": "XMLHttpRequest",
    "x-ot-client-type": CODEARTS_IDENTITY.clientType,
    "x-ot-function": CODEARTS_IDENTITY.functionName,
    "x-ot-session-id": codeartsSessionId(input.accessKey, input.domainId),
    "user-session-id": codeartsSessionId(input.accessKey, input.domainId),
    "x-ot-trace-id": hexOf(16),
    "x-ot-span-id": hexOf(8),
    "x-snap-traceid": hexOf(16),
    "user-msg-id": `msg_${hexOf(8)}`,
    "created-time": new Date(input.now ?? Date.now()).toISOString()
  };
  if (input.model !== void 0 && input.model !== "") {
    headers["model-id"] = input.model;
    headers["model-name"] = input.model;
  }
  return headers;
}
var CODEARTS_CREDENTIAL_CODES = [
  "APIG.0301",
  "APIG.0303",
  // 2026-11-25 实测：AK 被 IAM 停用（不是删除）时上游回 400 + APIG.0602
  // "the access key is inactive"——也是凭据类故障，必须计入账号故障。
  "APIG.0602",
  "STS5.1804",
  "STS5.1806",
  "invalid_grant"
];
var CODEARTS_TRANSIENT_CODES = ["TM.00001041"];
function statusFromCode(code) {
  if (code === null || code === void 0) return 400;
  const segs = String(code).trim().split(".");
  const tail = segs[segs.length - 1] ?? "";
  const n = Number(tail);
  if (Number.isInteger(n) && n >= 400 && n <= 599) return n;
  return 400;
}
function codeartsErrorOf(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const rec = body;
  const rawCode = rec["error_code"] ?? rec["errorCode"] ?? rec["code"];
  if (rawCode === void 0 || rawCode === null) {
    if (typeof rec["code"] === "number" && rec["code"] !== 0) {
      const code2 = String(rec["code"]);
      return {
        code: code2,
        message: String(rec["error_msg"] ?? rec["message"] ?? rec["msg"] ?? "上游业务错误"),
        status: statusFromCode(code2)
      };
    }
    return null;
  }
  const code = String(rawCode);
  if (code === "0" || code === "") return null;
  const details = rec["details"];
  const detailMsg = Array.isArray(details) && details.length > 0 && typeof details[0] === "object" ? String(details[0]["error_msg"] ?? "") : "";
  const message = String(
    detailMsg || rec["error_msg"] || rec["errorMsg"] || rec["message"] || rec["msg"] || "上游业务错误"
  );
  return { code, message, status: statusFromCode(code) };
}
function codeartsProxyRefusalOf(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const rec = body;
  const err = rec["error"];
  if (err === null || typeof err !== "object" || Array.isArray(err)) return null;
  const e = err;
  const code = typeof e["code"] === "string" ? e["code"] : "";
  const type = typeof e["type"] === "string" ? e["type"] : "";
  if (!`${code} ${type}`.toLowerCase().includes("resign")) return null;
  const message = String(e["message"] ?? e["msg"] ?? "上游代理拒收签名请求");
  return { code: code || type || "proxy_resign_refused", message };
}
function codeartsErrorKind(code, status) {
  const c = String(code);
  if (CODEARTS_CREDENTIAL_CODES.includes(c)) return "auth";
  if (CODEARTS_TRANSIENT_CODES.includes(c)) return "rate_limit";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream";
  if (status === 401 || status === 403) return "auth";
  return "bad_request";
}
function requireCodeartsKeys(creds) {
  const c = creds ?? {};
  const accessKey = typeof c.accessKey === "string" ? c.accessKey.trim() : "";
  const secretKey = typeof c.secretKey === "string" ? c.secretKey.trim() : "";
  if (accessKey === "" || secretKey === "") {
    throw new UpstreamError2(
      "auth",
      "CodeArts 凭据不完整：需要 accessKey + secretKey（请重新登录 CodeArts）",
      false,
      401
    );
  }
  return { accessKey, secretKey };
}
var CodeartsAdapter = class {
  vendorId = "codearts";
  async getToken(creds) {
    const c = creds ?? {};
    const { accessKey } = requireCodeartsKeys(c);
    const expiresAt = typeof c.expiresAtMs === "number" && Number.isFinite(c.expiresAtMs) ? Math.floor(c.expiresAtMs / 1e3) : Math.floor(Date.now() / 1e3) + 2 * 60 * 60;
    return {
      accessToken: accessKey,
      expiresAt,
      ...typeof c.refreshToken === "string" && c.refreshToken !== "" ? { refreshToken: c.refreshToken } : {}
    };
  }
  decorateRequest(base, _token, creds) {
    const c = creds ?? {};
    const { accessKey } = requireCodeartsKeys(c);
    const headers = codeartsIdentityHeaders({
      accessKey,
      ...typeof c.domainId === "string" ? { domainId: c.domainId } : {}
    });
    return { headers: { ...headers, ...base.headers } };
  }
  /**
   * 错误分类。
   *
   * 上游用 `200 + error_code` 表达失败，所以**先看业务码、再看 HTTP 状态**：
   * 只看状态码会把「参数越界」当账号故障、把「并发上限」当封号。
   */
  classifyError(httpStatus, body, _headers) {
    const biz = codeartsErrorOf(body);
    const code = biz?.code ?? "";
    const status = biz ? biz.status : httpStatus;
    const raw = upstreamRawResponse(httpStatus, body);
    if (biz) {
      const kind = codeartsErrorKind(code, status);
      const retryable = kind === "rate_limit" || kind === "upstream" || kind === "timeout";
      return new UpstreamError2(kind, `CodeArts 上游错误 ${code}: ${biz.message}`, retryable, status, void 0, raw);
    }
    const refusal = codeartsProxyRefusalOf(body);
    if (refusal) {
      return new UpstreamError2(
        "upstream",
        `CodeArts 请求被上游代理拒收（签名覆盖请求体，代理无法重签）：${refusal.code} ${refusal.message} —— 这不是 AK/SK 鉴权失败，无需更换凭据；请在上下文压缩代理上开启 sdk-hmac-sha256 的 passthrough，或把 codearts 账号注册进宿主凭据服务以便代理重签`,
        false,
        httpStatus,
        void 0,
        raw
      );
    }
    if (httpStatus >= 200 && httpStatus < 300) {
      return new UpstreamError2("upstream", "CodeArts 上游返回成功", false, httpStatus, void 0, raw);
    }
    if (httpStatus === 401 || httpStatus === 403) {
      return new UpstreamError2(
        "auth",
        `CodeArts AK/SK 鉴权失败（上游 HTTP ${httpStatus}）：请检查 accessKey/secretKey 是否正确、是否被禁用或轮换；若用的是 STS 临时凭据请重新导入（含 securityToken）。注意：若上游响应体不是华为云的错误格式，也可能是中间代理拒收了这条签名请求 —— 那种情况下凭据本身没问题，换凭据无用`,
        false,
        httpStatus,
        void 0,
        raw
      );
    }
    if (httpStatus === 429) {
      return new UpstreamError2("rate_limit", "CodeArts 上游限流", true, httpStatus, void 0, raw);
    }
    if (httpStatus >= 500) {
      return new UpstreamError2("upstream", `CodeArts 上游 ${httpStatus}`, true, httpStatus, void 0, raw);
    }
    return new UpstreamError2(
      "bad_request",
      `CodeArts 请求被拒（HTTP ${httpStatus}）`,
      false,
      httpStatus,
      void 0,
      raw
    );
  }
};
var CODEARTS_ADAPTER = new CodeartsAdapter();

// core/connectors/codearts-sign.ts
import { createHash as createHash5, createHmac } from "node:crypto";
function encodeRfc3986(value) {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}
function canonicalUri(pathname) {
  const raw = pathname === "" ? "/" : pathname;
  const encoded = raw.split("/").map((seg) => encodeRfc3986(seg)).join("/");
  return encoded.endsWith("/") ? encoded : `${encoded}/`;
}
function canonicalQuery(search) {
  if (!search || search === "?") return "";
  const pairs = [];
  for (const part of search.replace(/^\?/, "").split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? "" : part.slice(eq + 1);
    pairs.push([decodeURIComponent(k), decodeURIComponent(v)]);
  }
  pairs.sort((a, b) => a[0] === b[0] ? a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0 : a[0] < b[0] ? -1 : 1);
  return pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
}
function sha256Hex(data) {
  return createHash5("sha256").update(data, "utf8").digest("hex");
}
function hmacSha256Hex(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}
function sdkDateOf(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function defaultSignedHeaderNames(securityToken) {
  const names = ["host", "x-sdk-date"];
  if (securityToken) names.push("x-security-token");
  return names;
}
function buildCanonicalRequest(input) {
  const u = new URL(input.url);
  const method = input.method.toUpperCase();
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(input.headers)) lowerHeaders[k.toLowerCase()] = v;
  if (!("host" in lowerHeaders)) lowerHeaders["host"] = u.host;
  const names = (input.signedNames ?? defaultSignedHeaderNames(lowerHeaders["x-security-token"])).map((n) => n.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${(lowerHeaders[n] ?? "").trim()}
`).join("");
  const signedHeaders = names.join(";");
  const bodySigned = method === "PUT" || method === "PATCH" || method === "POST";
  const payloadHash = sha256Hex(bodySigned && input.body ? input.body : "");
  return `${method}
${canonicalUri(u.pathname)}
${canonicalQuery(u.search)}
${canonicalHeaders}
${signedHeaders}
${payloadHash}`;
}
function buildStringToSign(sdkDate, canonicalRequest) {
  return `SDK-HMAC-SHA256
${sdkDate}
${sha256Hex(canonicalRequest)}`;
}
function signCodeartsRequest(opts) {
  const sdkDate = opts.sdkDate ?? sdkDateOf(opts.now);
  const headers = { ...opts.headers, "X-Sdk-Date": sdkDate };
  if (opts.securityToken) headers["X-Security-Token"] = opts.securityToken;
  const canonicalRequest = buildCanonicalRequest({
    method: opts.method,
    url: opts.url,
    headers,
    body: opts.body ?? null,
    ...opts.signedNames ? { signedNames: opts.signedNames } : {}
  });
  const stringToSign = buildStringToSign(sdkDate, canonicalRequest);
  const signature = hmacSha256Hex(opts.secretKey, stringToSign);
  const signedNames = (opts.signedNames ?? defaultSignedHeaderNames(opts.securityToken)).map((n) => n.toLowerCase()).sort();
  headers["Authorization"] = `SDK-HMAC-SHA256 Access=${opts.accessKey}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
  return { headers, signedHeaders: signedNames, canonicalRequest };
}

// core/connectors/codearts-checkin-store.ts
var DAY_MS = 864e5;
function expireMsOf(rawExpire, claimedAtMs) {
  const n = typeof rawExpire === "number" ? rawExpire : Number(rawExpire);
  if (Number.isFinite(n) && n > 0) {
    const ms = n < 1e11 ? Math.round(n * 1e3) : Math.round(n);
    if (ms > claimedAtMs) return ms;
  }
  return claimedAtMs + DAY_MS;
}
function parseRaw2(rawJson) {
  if (rawJson === null || rawJson === void 0 || rawJson.trim() === "") return {};
  try {
    const v = JSON.parse(rawJson);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function readCodeartsCheckin(raw) {
  const obj = typeof raw === "string" ? parseRaw2(raw) : raw ?? {};
  const c = obj["checkin"];
  if (c === null || c === void 0 || typeof c !== "object" || Array.isArray(c)) return null;
  const v = c;
  const claimed = Number(v["claimed_at_ms"]);
  const expire = Number(v["expire_at_ms"]);
  const credit = Number(v["credit"]);
  if (!Number.isFinite(claimed) || claimed <= 0) return null;
  const expireMs = expireMsOf(v["expire_at_ms"], claimed);
  return {
    claimed_at_ms: claimed,
    expire_at_ms: expireMs,
    credit: Number.isFinite(credit) && credit > 0 ? credit : 0,
    day: typeof v["day"] === "string" ? v["day"] : ""
  };
}
function markCodeartsCheckin(db, username, input) {
  const row = db.credential.get("codearts", username);
  if (row === null || row === void 0) throw new Error(`codearts 凭据不存在: ${username}`);
  const raw = parseRaw2(row.raw_json);
  const claimedAtMs = input.claimedAtMs ?? Date.now();
  const expireAtMs = expireMsOf(input.expireAtMs ?? null, claimedAtMs);
  const rec = {
    claimed_at_ms: claimedAtMs,
    expire_at_ms: expireAtMs,
    credit: Math.max(0, Math.round(input.credit)),
    day: input.day ?? new Date(claimedAtMs).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  };
  raw["checkin"] = rec;
  db.credential.update({ provider: "codearts", username, raw_json: JSON.stringify(raw) });
  return rec;
}

// core/collector/quota.ts
var QuotaError = class extends Error {
  kind = "quota";
  constructor(message) {
    super(message);
    this.name = "QuotaError";
  }
};
function number_of(value) {
  if (typeof value === "boolean" || value === null || value === void 0) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function to_epoch_seconds(value) {
  const num3 = number_of(value);
  if (num3 !== null) {
    if (num3 >= 1e11) return Math.round(num3 / 1e3);
    return Math.round(num3);
  }
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return Math.round(d.getTime() / 1e3);
  }
  return null;
}
function precise_number(raw, preciseKey, numberKey) {
  for (const key of [preciseKey, numberKey]) {
    const v = number_of(raw?.[key]);
    if (v !== null) return Math.max(0, v);
  }
  return 0;
}
var TRAE_PAY_BASE = "https://api.trae.cn";
var TRAE_USAGE_PATH = "/trae/api/v2/pay/web_user_ent_usage";
var TRAE_PAY_STATUS_PATH = "/trae/api/v1/pay/ide_user_pay_status";
var TRAE_QUOTA_TIMEOUT_MS = 15e3;
var TRAE_ORIGIN = "https://www.trae.cn";
function earliest_expiry(packs) {
  const out = [];
  let best = null;
  const list = Array.isArray(packs) ? packs : [];
  for (const pack of list) {
    if (typeof pack !== "object" || pack === null) continue;
    const p = pack;
    const base = p["entitlement_base_info"] ?? {};
    const quota = base["quota"] ?? {};
    const usage = p["usage"] ?? {};
    const end_s = to_epoch_seconds(base["end_time"]);
    const limit = number_of(quota["credits_limit"]);
    const used = number_of(usage["credits_amount"]) ?? 0;
    const name = typeof base["name"] === "string" && base["name"] !== "" ? base["name"] : typeof p["display_desc"] === "string" ? String(p["display_desc"]) : "(未命名)";
    if (limit === null || limit <= 0) continue;
    const remain = Math.max(0, limit - used);
    const counts = remain > 0;
    if (counts && end_s !== null && end_s > 0) {
      if (best === null || end_s < best) best = end_s;
    }
    out.push({
      name,
      limit: Math.round(limit * 1e4) / 1e4,
      used: Math.round(used * 1e4) / 1e4,
      remain: Math.round(remain * 1e4) / 1e4,
      expires_at: end_s,
      counts_for_expiry: counts
    });
  }
  return { expires_at: best, packs: out };
}
function parse_trae_usage(data, credentialKey2, fetched_at) {
  const packsRaw = data["user_entitlement_pack_list"];
  const summary = data["usage_summary"] ?? {};
  const total = number_of(summary["total_amount"]);
  const consumed = number_of(summary["consumed_amount"]);
  const { expires_at, packs } = earliest_expiry(packsRaw);
  let remaining = null;
  let limit = null;
  if (total !== null) {
    limit = Math.round(total);
    const spent = consumed !== null ? consumed : 0;
    remaining = Math.round(Math.max(0, total - spent));
  }
  if (remaining === null) {
    let fallback_limit = 0;
    let fallback_left = 0;
    for (const p of packs) {
      fallback_limit += p.limit ?? 0;
      fallback_left += p.remain ?? 0;
    }
    if (fallback_limit > 0) {
      remaining = Math.round(fallback_left);
      limit = Math.round(fallback_limit);
    }
  }
  return {
    credentialKey: credentialKey2,
    remaining,
    limit,
    expires_at,
    fetched_at,
    packs,
    error: null
  };
}
function parse_trae_pay_status(data, credentialKey2, fetched_at) {
  const trial = data["trial_status"] ?? {};
  const expires_s = to_epoch_seconds(trial["trial_end_time"]);
  const expires_at = expires_s !== null && expires_s > 0 ? expires_s : null;
  const status = typeof trial["trial_status"] === "string" ? trial["trial_status"] : typeof data["status"] === "string" ? String(data["status"]) : "";
  return {
    credentialKey: credentialKey2,
    remaining: null,
    limit: null,
    expires_at,
    fetched_at,
    packs: [{
      name: "订阅试用",
      limit: null,
      used: null,
      remain: null,
      expires_at,
      counts_for_expiry: false,
      extra: { kind: "trial", status }
    }],
    error: null
  };
}
function traeQuotaHeaders(token, extras) {
  const identity = resolve_identity(token, extras ?? {});
  const requestId = randomBytes3(16).toString("hex");
  const headers = build_headers(token, identity, requestId);
  headers["Origin"] = TRAE_ORIGIN;
  headers["Referer"] = `${TRAE_ORIGIN}/`;
  headers["Accept"] = "application/json";
  return headers;
}
async function probe_trae_quota(account, opts = {}) {
  const region = (account.region ?? "cn").toString().trim().toLowerCase();
  const base = (opts.baseUrl ?? TRAE_PAY_BASE).replace(/\/+$/, "");
  const path = region === "cn" ? TRAE_USAGE_PATH : TRAE_PAY_STATUS_PATH;
  const url = `${base}${path}`;
  const body = region === "cn" ? JSON.stringify({ require_usage: true }) : "{}";
  const timeoutMs = opts.timeoutMs ?? TRAE_QUOTA_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;
  let resp;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: traeQuotaHeaders(account.token, account.extras),
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new QuotaError(`trae 额度查询超时(${timeoutMs}ms)`);
    }
    throw new QuotaError(`trae 额度查询连接失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  let text;
  try {
    text = await resp.text();
  } catch (err) {
    throw new QuotaError(`trae 额度响应读取失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (resp.status >= 400) {
    throw new QuotaError(`trae 计费接口 HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new QuotaError(`trae 额度响应不是 JSON(HTTP ${resp.status}): ${text.replace(/[^\x20-\x7e\u4e00-\u9fff\n]/g, "?").slice(0, 120)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new QuotaError("trae 额度响应不是对象");
  }
  const authCode = number_of(parsed["code"]);
  if (authCode === 1001) {
    const msg = String(parsed["message"] ?? "").slice(0, 200);
    throw new QuotaError(`trae 计费接口认证失败(code 1001): ${msg || "authenticate you"}`);
  }
  const fetched_at = Math.floor(Date.now() / 1e3);
  if (region === "cn") {
    return parse_trae_usage(parsed, account.credentialKey, fetched_at);
  }
  return parse_trae_pay_status(parsed, account.credentialKey, fetched_at);
}
var WORKBUDDY_BILLING_BASES = {
  cn: "https://www.codebuddy.cn",
  global: "https://www.workbuddy.ai"
};
var WORKBUDDY_RESOURCE_PATH = "/v2/billing/meter/get-user-resource";
var WORKBUDDY_MONTHLY_CAPACITY_TYPE = 4;
var WORKBUDDY_BILLING_UA = "CodeBuddy/2.63.2 CLI/2.63.2";
var WORKBUDDY_WINDOW_MS = 100 * 365.25 * 86400 * 1e3;
var WORKBUDDY_QUOTA_TIMEOUT_MS = 3e4;
function workbuddy_request_body(now = /* @__PURE__ */ new Date()) {
  const end = new Date(now.getTime() + WORKBUDDY_WINDOW_MS);
  const fmt = (d) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end)
  };
}
function wb_accounts_of(data) {
  try {
    const wrapped = data["data"] ?? {};
    const response = wrapped?.["Response"];
    const inner = response?.["Data"];
    const accounts = inner?.["Accounts"];
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    return [];
  }
}
function parse_workbuddy(data, credentialKey2, fetched_at, now = Date.now() / 1e3) {
  const accounts = wb_accounts_of(data);
  const now_s = now;
  let total = 0;
  let nearest = null;
  const packs = [];
  for (const acc of accounts) {
    if (typeof acc !== "object" || acc === null) continue;
    const a = acc;
    const monthly = a["CapacityType"] === WORKBUDDY_MONTHLY_CAPACITY_TYPE;
    let remain;
    let size;
    let expires_s;
    let refresh_s;
    if (monthly) {
      remain = precise_number(a, "CycleCapacityRemainPrecise", "CycleCapacityRemain");
      size = precise_number(a, "CycleCapacitySizePrecise", "CycleCapacitySize");
      expires_s = null;
      refresh_s = to_epoch_seconds(a["CycleEndTime"]);
    } else {
      remain = precise_number(a, "CapacityRemainPrecise", "CapacityRemain");
      size = precise_number(a, "CapacitySizePrecise", "CapacitySize");
      expires_s = to_epoch_seconds(a["ExpiredTime"]) ?? to_epoch_seconds(a["CycleEndTime"]);
      refresh_s = null;
    }
    if (!monthly && (remain <= 0 || expires_s !== null && expires_s <= now_s)) {
      continue;
    }
    total += remain;
    if (expires_s !== null) {
      if (nearest === null || expires_s < nearest) nearest = expires_s;
    }
    packs.push({
      name: typeof a["PackageName"] === "string" && a["PackageName"] !== "" ? String(a["PackageName"]) : "(未命名)",
      limit: size !== null ? Math.round(size * 100) / 100 : null,
      used: null,
      remain: Math.round(remain * 100) / 100,
      expires_at: expires_s,
      counts_for_expiry: expires_s !== null,
      extra: {
        monthly,
        refresh_at: refresh_s
      }
    });
  }
  return {
    credentialKey: credentialKey2,
    remaining: Math.round(total),
    limit: null,
    // 跨周期总额无意义(dsh 只展示余量)
    expires_at: nearest,
    // 无可用包 → null = 未知,不虚报
    fetched_at,
    packs,
    error: null
  };
}
function workbuddyQuotaHeaders(account, region) {
  const realm = region === "cn" ? "cn" : "global";
  const origin = WORKBUDDY_BILLING_BASES[realm];
  const headers = build_chat_headers(
    account.token,
    realm,
    account.uid ?? void 0,
    void 0,
    account.enterprise_id ?? void 0
  );
  headers["Origin"] = origin;
  headers["Referer"] = `${origin}/`;
  headers["User-Agent"] = WORKBUDDY_BILLING_UA;
  headers["Accept"] = "application/json";
  const uid = account.uid || jwt_claim(account.token, "sub") || "anonymous";
  headers["X-Machine-ID"] = derive_id(uid, "machine");
  headers["X-Session-ID"] = derive_id(uid, "session");
  if (account.enterprise_id) {
    headers["X-Enterprise-Id"] = account.enterprise_id;
    headers["X-Tenant-Id"] = account.enterprise_id;
  } else {
    headers["X-No-Enterprise-Id"] = "1";
  }
  return headers;
}
async function probe_workbuddy_quota(account, opts = {}) {
  const region = (account.region ?? "").toString().trim().toLowerCase() || detectRegionOfToken(account.token);
  const realm = region === "cn" ? "cn" : "global";
  const base = (opts.baseUrl ?? WORKBUDDY_BILLING_BASES[realm]).replace(/\/+$/, "");
  const url = `${base}${WORKBUDDY_RESOURCE_PATH}`;
  const body = JSON.stringify(workbuddy_request_body());
  const timeoutMs = opts.timeoutMs ?? WORKBUDDY_QUOTA_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;
  let resp;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: workbuddyQuotaHeaders(account, realm),
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new QuotaError(`workbuddy 额度查询超时(${timeoutMs}ms)`);
    }
    throw new QuotaError(`workbuddy 额度查询连接失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  let text;
  try {
    text = await resp.text();
  } catch (err) {
    throw new QuotaError(`workbuddy 额度响应读取失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (resp.status >= 400) {
    throw new QuotaError(`workbuddy 计费接口 HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new QuotaError(`workbuddy 额度响应不是 JSON(HTTP ${resp.status}): ${text.replace(/[^\x20-\x7e\u4e00-\u9fff\n]/g, "?").slice(0, 120)}`);
  }
  if (typeof payload !== "object" || payload === null) {
    throw new QuotaError("workbuddy 额度响应不是对象");
  }
  return parse_workbuddy(payload, account.credentialKey, Math.floor(Date.now() / 1e3));
}
function detectRegionOfToken(token) {
  try {
    const seg = token.split(".")[1] ?? "";
    const padded = seg + "=".repeat((4 - seg.length % 4) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64url").toString("utf-8"));
    const iss = String(claims["iss"] ?? "").toLowerCase();
    if (iss.includes("copilot.tencent.com") || iss.includes("codebuddy.cn") || iss.includes("workbuddy.cn")) {
      return "cn";
    }
  } catch {
  }
  return "global";
}
var MINIMAX_QUOTA_TIMEOUT_MS = 3e4;
async function probe_minimax_quota(account, opts = {}) {
  const raw = account.extras ?? {};
  const cred = minimaxAccountOf({
    token: account.token,
    region: (account.region ?? "").toString().trim().toLowerCase() || "cn",
    extra: raw
  });
  if (!cred.uuid || !cred.deviceId) {
    throw new QuotaError("minimax 账号缺少 uuid / device_id,无法构造签名请求");
  }
  if (opts.baseUrl) cred.baseUrl = opts.baseUrl;
  const fetchedAt = Math.floor(Date.now() / 1e3);
  const httpOpts = {
    fetchFn: opts.fetchFn,
    timeoutMs: opts.timeoutMs ?? MINIMAX_QUOTA_TIMEOUT_MS,
    // 401 时自动 refresh 续期并重试(2026-11-07):token 寿命数小时,
    // 续期由调用方提供(它持有凭据库),这里只透传。
    onAuthExpired: opts.onAuthExpired
  };
  const credit = await minimaxCredit(cred, httpOpts);
  let packs = [];
  let expiresAt = null;
  let grantError = null;
  if (opts.withGrants !== false) {
    try {
      const grants = await minimaxCreditGrants(cred, httpOpts);
      expiresAt = earliestGrantExpiry(grants);
      packs = grants.map((g, i) => ({
        name: `grant#${i + 1}`,
        limit: g.granted,
        used: Math.max(0, g.granted - g.remaining),
        remain: g.remaining,
        expires_at: g.expiresAt > 0 ? g.expiresAt : null,
        counts_for_expiry: g.remaining > 0 && g.expiresAt > 0,
        extra: { granted_at: g.grantedAt }
      }));
    } catch (err) {
      grantError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    credentialKey: account.credentialKey,
    remaining: credit.total,
    // minimax 没有「总额」概念(充值/活动发放),与 workbuddy 同口径给 null。
    limit: null,
    expires_at: expiresAt,
    fetched_at: fetchedAt,
    packs,
    error: grantError
  };
}
var CODEARTS_PACKAGE_OVERVIEW_PATH = "/snap-manager/v1/package/overview";
var CODEARTS_STATISTICS_PLUGIN_PATH = "/snap-manager/v1/statistics/plugin";
function periodEndSecondsOf(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m === null) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
  return Number.isFinite(ms) ? Math.floor(ms / 1e3) : null;
}
var CODEARTS_QUOTA_TIMEOUT_MS = 2e4;
function parse_codearts_credits(payload) {
  const num3 = (v) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  const total = record(payload["all_credit_package"]);
  if (total !== null) {
    const remain2 = num3(total["package_credit_remain"]);
    const amount2 = num3(total["package_credit_amount"]);
    if (remain2 === null || amount2 === null) {
      throw new QuotaError("codearts 积分总览缺少 package_credit_remain / package_credit_amount");
    }
    return {
      remaining: remain2,
      limit: amount2,
      used: num3(total["package_credit_used"]) ?? Math.max(0, amount2 - remain2),
      expiring: num3(total["expiring_credit_amount"]) ?? 0
    };
  }
  let remain = 0;
  let amount = 0;
  let used = 0;
  let expiring = 0;
  let found = 0;
  for (const key of ["basic_package", "bonus_credit_package", "ondemand_credit_package"]) {
    const pkg = record(payload[key]);
    if (pkg === null) continue;
    const r = num3(pkg["package_credit_remain"]);
    const a = num3(pkg["package_credit_amount"]);
    if (r === null || a === null) continue;
    remain += r;
    amount += a;
    used += num3(pkg["package_credit_used"]) ?? 0;
    expiring += num3(pkg["expiring_credit_amount"]) ?? 0;
    found += 1;
  }
  if (found === 0) {
    throw new QuotaError("codearts 积分总览缺少 all_credit_package（上游应答形态变了）");
  }
  return { remaining: remain, limit: amount, used, expiring };
}
async function probe_codearts_quota(account, opts = {}) {
  const raw = account.extras ?? {};
  const accessKey = String(raw["accessKey"] ?? "");
  const secretKey = String(raw["secretKey"] ?? "");
  const securityToken = String(raw["securityToken"] ?? "");
  const domainId = String(raw["domainId"] ?? "");
  if (accessKey === "" || secretKey === "") {
    throw new QuotaError("codearts 账号缺少 accessKey / secretKey");
  }
  const base = (opts.baseUrl || CODEARTS_BASE_CN).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? CODEARTS_QUOTA_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;
  const get = async (path) => {
    const url = `${base}${path}`;
    const signed = signCodeartsRequest({
      accessKey,
      secretKey,
      ...securityToken !== "" ? { securityToken } : {},
      method: "GET",
      url,
      headers: {
        ...codeartsIdentityHeaders({
          accessKey,
          ...domainId !== "" ? { domainId } : {}
        }),
        // `/v1/ops/*` 必须带这个头（签名后追加），否则 400「请求头Agent-Type为空」。
        "Agent-Type": "PromptCenter"
      }
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetchFn(url, { method: "GET", headers: signed.headers, signal: controller.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new QuotaError(
        controller.signal.aborted ? `codearts 额度查询超时(${timeoutMs}ms)` : `codearts 额度查询连接失败: ${msg}`
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await resp.text();
    if (!resp.ok) throw new QuotaError(`codearts ${path} HTTP ${resp.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new QuotaError(
        `codearts ${path} 响应不是 JSON(HTTP ${resp.status}): ${text.replace(/[^\x20-\x7e\u4e00-\u9fff]/g, "?").slice(0, 120)}`
      );
    }
  };
  const payload = await get(CODEARTS_PACKAGE_OVERVIEW_PATH);
  const credits = parse_codearts_credits(payload);
  const fetchedAt = Math.floor(Date.now() / 1e3);
  let expiresAt = null;
  let expiryBasis = "unknown";
  if (credits.expiring > 0) {
    let fromCheckin = null;
    try {
      const rec = readCodeartsCheckin(raw);
      if (rec !== null) {
        const sec = Math.floor(rec.expire_at_ms / 1e3);
        if (sec > fetchedAt) fromCheckin = sec;
      }
    } catch {
    }
    expiresAt = fromCheckin ?? fetchedAt + 86400;
    expiryBasis = fromCheckin !== null ? "checkin-record" : "expiring-tomorrow";
  } else {
    try {
      const stats = await get(CODEARTS_STATISTICS_PLUGIN_PATH);
      const endDate = typeof stats["end_date"] === "string" ? stats["end_date"] : "";
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate.trim());
      if (m !== null) {
        const dayStart = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1e3;
        const prevDay = periodEndSecondsOf(
          new Date((dayStart - 86400) * 1e3).toISOString().slice(0, 10)
        );
        if (prevDay !== null && prevDay > fetchedAt) {
          expiresAt = prevDay;
          expiryBasis = "period-end";
        }
      }
    } catch {
    }
    if (expiresAt === null) {
      expiresAt = periodEndSecondsOf("2026-12-16");
      expiryBasis = "period-end-fallback";
    }
  }
  if (expiresAt === null || expiresAt <= fetchedAt) {
    expiresAt = null;
    expiryBasis = "unknown";
  }
  return {
    credentialKey: account.credentialKey,
    remaining: credits.remaining,
    limit: credits.limit,
    expires_at: expiresAt,
    fetched_at: fetchedAt,
    packs: [
      {
        name: "credit_package",
        limit: credits.limit,
        used: credits.used,
        remain: credits.remaining,
        expires_at: expiresAt,
        counts_for_expiry: credits.remaining > 0,
        extra: { expiring: credits.expiring, expiry_basis: expiryBasis }
      }
    ],
    // 到期是估算（见上），不算错误：只有积分总览本身读不到才会在上面抛 QuotaError。
    error: null
  };
}

// core/connectors/workbuddy-selfcheck.ts
var WORKBUDDY_SELFCHECK_FIELD = "selfcheck";
var WORKBUDDY_SELFCHECK_TTL_MS = 24 * 3600 * 1e3;
var WORKBUDDY_SELFCHECK_TIMEOUT_MS = 8e3;
function readSelfCheck(raw) {
  const value = raw?.[WORKBUDDY_SELFCHECK_FIELD];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value;
  const verdict = rec["verdict"];
  if (verdict !== "ok" && verdict !== "banned" && verdict !== "unknown") return null;
  const atMs = typeof rec["atMs"] === "number" && Number.isFinite(rec["atMs"]) ? rec["atMs"] : 0;
  const message = typeof rec["message"] === "string" ? rec["message"] : void 0;
  return message !== void 0 ? { verdict, atMs, message } : { verdict, atMs };
}
function selfCheckDue(raw, nowMs, ttlMs = WORKBUDDY_SELFCHECK_TTL_MS) {
  const marker = readSelfCheck(raw);
  if (marker === null) return true;
  if (marker.verdict === "banned") return false;
  const age = nowMs - marker.atMs;
  return !(age >= 0 && age < ttlMs);
}
function withSelfCheck(raw, marker) {
  return { ...raw ?? {}, [WORKBUDDY_SELFCHECK_FIELD]: marker };
}
async function probeWorkbuddyAccount(creds, options = {}) {
  const token = (creds.token ?? "").trim();
  if (token === "") return { verdict: "unknown", message: "缺少令牌,无法自检" };
  const region = (creds.region ?? "").trim() || detect_region_from_token(token);
  const realm = region === "cn" ? "cn" : "global";
  const base = (WORKBUDDY_BILLING_BASES[realm] ?? "").replace(/\/+$/, "");
  const account = {
    credentialKey: `workbuddy/selfcheck`,
    provider: "workbuddy",
    username: "selfcheck",
    token,
    region: realm,
    uid: creds.uid ?? null,
    enterprise_id: creds.enterpriseId ?? null
  };
  const timeoutMs = options.timeoutMs ?? WORKBUDDY_SELFCHECK_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? fetch;
  let resp;
  try {
    resp = await fetchFn(`${base}${WORKBUDDY_RESOURCE_PATH}`, {
      method: "POST",
      headers: workbuddyQuotaHeaders(account, realm),
      body: JSON.stringify(workbuddy_request_body()),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    return { verdict: "unknown", message: `自检请求失败: ${errText(err)}` };
  }
  let text;
  try {
    text = await resp.text();
  } catch (err) {
    return { verdict: "unknown", message: `自检响应读取失败: ${errText(err)}` };
  }
  const body = parseJsonObject(text);
  const code = businessCodeOf(body);
  if (code === BAN_CODE || code === null && isBanText(text)) {
    return { verdict: "banned", message: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
  }
  if (resp.status >= 400) {
    return { verdict: "unknown", message: `自检 HTTP ${resp.status}: ${text.slice(0, 300)}` };
  }
  if (body === null) {
    return { verdict: "unknown", message: `自检响应不是 JSON 对象: ${text.slice(0, 120)}` };
  }
  if (code !== null && code !== 0) {
    return { verdict: "unknown", message: `自检业务码 ${code}: ${text.slice(0, 300)}` };
  }
  return { verdict: "ok", message: "自检通过(只读额度探针可用)" };
}
var BAN_CODE = 11140;
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}
function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function businessCodeOf(body) {
  const raw = body?.["code"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}
function isBanText(text) {
  return /(?<!\d)11140(?!\d)/.test(text);
}
function createWorkbuddySelfCheck(deps) {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? WORKBUDDY_SELFCHECK_TTL_MS;
  const warn = deps.warn ?? ((message) => console.warn(message));
  const memo = /* @__PURE__ */ new Map();
  return async (input) => {
    const username = (input.username ?? "").trim();
    if (username === "" || (input.creds?.token ?? "").trim() === "") {
      return { ok: true, banned: false, message: "跳过自检(凭据不完整)" };
    }
    let raw = {};
    try {
      const existing = await deps.vault.get("workbuddy", username);
      raw = existing?.raw ?? {};
    } catch {
    }
    const stored = readSelfCheck(raw);
    const memory = memo.get(username) ?? null;
    const latest = memory === null ? stored : stored === null ? memory : memory.atMs >= stored.atMs ? memory : stored;
    if (latest !== null && !selfCheckDue({ [WORKBUDDY_SELFCHECK_FIELD]: latest }, now(), ttlMs)) {
      return {
        ok: true,
        banned: false,
        message: latest.verdict === "banned" ? "该账号曾命中 11140(不再自检)" : "已有自检标记,跳过"
      };
    }
    const probe = await probeWorkbuddyAccount(input.creds, {
      ...deps.fetchFn !== void 0 ? { fetchFn: deps.fetchFn } : {},
      ...deps.timeoutMs !== void 0 ? { timeoutMs: deps.timeoutMs } : {}
    });
    const marker = { verdict: probe.verdict, atMs: now() };
    if (probe.verdict === "banned") marker.message = probe.message.slice(0, 300);
    memo.set(username, marker);
    try {
      await deps.vault.put({
        provider: "workbuddy",
        username,
        raw: withSelfCheck(raw, marker)
      });
    } catch (err) {
      warn(
        `[as-one] WorkBuddy 自检标记写入失败(${username}):${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (probe.verdict === "banned") {
      warn(`[as-one] WorkBuddy 自检命中 11140(${username}):${probe.message}`);
      return {
        ok: false,
        banned: true,
        // 文案与本项目 11140 的统一口径一致(网关/熔断器按 `code 11140` 识别)。
        message: `账号存在异常行为,已被限制使用(code 11140):${probe.message}`
      };
    }
    if (probe.verdict === "unknown") {
      warn(`[as-one] WorkBuddy 自检无法判定(${username}),放行:${probe.message}`);
      return { ok: true, banned: false, message: probe.message };
    }
    return { ok: true, banned: false, message: probe.message };
  };
}

// core/connectors/openai-compat.ts
var OpenAICompatAdapter = class {
  vendorId = "openai_compat";
  extraHeaders;
  constructor(extraHeaders) {
    this.extraHeaders = extraHeaders ?? {};
  }
  async getToken(creds) {
    const apiKey = creds.apiKey;
    if (!apiKey) {
      throw new UpstreamError2(
        "auth",
        "[openai_compat] 缺少 api_key",
        false,
        401
      );
    }
    return {
      accessToken: apiKey,
      expiresAt: Number.POSITIVE_INFINITY
    };
  }
  decorateRequest(base, token) {
    return {
      ...base,
      headers: {
        ...base.headers,
        ...this.extraHeaders,
        Authorization: `Bearer ${token.accessToken}`
      }
    };
  }
  classifyError(httpStatus, body, headers) {
    return classify_openai_error(httpStatus, body, headers);
  }
};
function retryAfterOf(body, headers) {
  const fromBody = numberFrom(body);
  if (fromBody !== void 0) return fromBody;
  if (!headers) return void 0;
  const raw = pickHeader(headers, "retry-after");
  if (raw === void 0) return void 0;
  const secs = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(secs)) {
    return secs >= 0 ? Math.ceil(secs) : void 0;
  }
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    const delta = Math.ceil((at - Date.now()) / 1e3);
    return delta >= 0 ? delta : void 0;
  }
  return void 0;
}
function pickHeader(headers, name) {
  if (!headers) return void 0;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue;
    const text = Array.isArray(v) ? v[0] : v;
    if (typeof text === "string") return text;
  }
  return void 0;
}
function numberFrom(body) {
  if (!body || typeof body !== "object") return void 0;
  const b = body;
  for (const key of ["retry_after", "retryAfter", "retry-after", "retry_in", "retryIn"]) {
    const v = b[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v >= 0 ? Math.ceil(v) : void 0;
    }
    if (typeof v === "string") {
      const n = Number(v.trim());
      if (v.trim() !== "" && Number.isFinite(n)) return n >= 0 ? Math.ceil(n) : void 0;
    }
  }
  const err = b["error"];
  if (err && typeof err === "object") return numberFrom(err);
  return void 0;
}
function upstreamDetailOf(body) {
  if (!body || typeof body !== "object") return "";
  const b = body;
  const err = b["error"];
  if (err && typeof err === "object") {
    const inner = upstreamDetailOf(err);
    if (inner) return inner;
  }
  for (const key of ["message", "detail", "msg", "error"]) {
    const v = b[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim().slice(0, 300);
  }
  return "";
}
function classify_openai_error(httpStatus, body, headers) {
  const detail = upstreamDetailOf(body);
  const retryAfter = retryAfterOf(body, headers);
  const original = upstreamRawResponse(httpStatus, body);
  const make = (kind, label, retryable, status) => new UpstreamError2(
    kind,
    detail ? `${label}:${detail}` : label,
    retryable,
    status,
    retryAfter,
    original
  );
  if (httpStatus === 200) {
    const code = extractCode(body);
    if (code !== void 0 && code !== 0) {
      return new UpstreamError2(
        "bad_request",
        detail ? `上游返回非零 code: ${code}:${detail}` : `上游返回非零 code: ${code}`,
        false,
        400,
        retryAfter,
        original
      );
    }
    return new UpstreamError2(
      "bad_request",
      detail ? `上游返回非零 code:${detail}` : "上游返回非零 code",
      false,
      400,
      retryAfter,
      original
    );
  }
  if (httpStatus === 429) {
    return make("rate_limit", "上游限流", true, 429);
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return make("auth", "认证失败", false, httpStatus);
  }
  if (httpStatus >= 500) {
    return make("upstream", "上游错误", true, httpStatus);
  }
  if (httpStatus >= 400) {
    return make("bad_request", "请求错误", false, httpStatus);
  }
  return make("upstream", "未知错误", true, httpStatus);
}
function extractCode(body) {
  if (body && typeof body === "object") {
    const code = body["code"];
    if (typeof code === "number") return code;
  }
  return void 0;
}

// core/connectors/sensenova-usage.ts
var DEFAULT_BASE_URL = "https://token.sensenova.cn/v1";
var PLATFORM_BASE = "https://platform.sensenova.cn";
var POOL_USAGE_URL = `${PLATFORM_BASE}/lite/console/v1/tokenplan/pool-usage`;
var ATTR_RPM = "rpm_exhausted";
var ATTR_SHARED = "shared_or_transient";
var ATTR_UNKNOWN = "unknown";
var POOL_SATURATED = "pool_saturated";
var POOL_EXHAUSTED = "pool_exhausted";
var CODE_SHARED_RE = /429003|tpm\/rpm\s+limit/i;
var CODE_RPM_RE = /code["\s:=]+8\b|rpm\s+exhausted/i;
function classify_rate_limit(body) {
  const text = body || "";
  if (CODE_SHARED_RE.test(text)) {
    return ATTR_SHARED;
  }
  if (CODE_RPM_RE.test(text)) {
    return ATTR_RPM;
  }
  return ATTR_UNKNOWN;
}
function billable_tokens(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }
  const u = usage;
  const prompt = Number(u["prompt_tokens"] ?? 0);
  const details = u["prompt_tokens_details"];
  const cached = details && typeof details === "object" ? Number(details["cached_tokens"] ?? 0) : 0;
  const completion = Number(u["completion_tokens"] ?? 0);
  return Math.max(0, prompt - cached) + completion;
}
function sensenova_username(name) {
  return name.replace(/^sensenova-/, "");
}
function numOrNull(value) {
  if (value === null || value === void 0 || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}
function toEpochSeconds(value) {
  const n = numOrNull(value);
  if (n === null) return null;
  if (n === 0) return null;
  return n >= 1e11 ? Math.round(n / 1e3) : n;
}
function intRound(value) {
  return value === null ? null : Math.round(value);
}
function windowOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const w = raw;
  const limit = numOrNull(w["limit"]);
  const used = numOrNull(w["used"] ?? w["used_tokens"]);
  const givenRemain = numOrNull(w["remaining"] ?? w["remain"]);
  const remaining = givenRemain !== null ? givenRemain : limit !== null && used !== null ? Math.max(0, limit - used) : null;
  return {
    limit,
    used,
    remaining,
    reset_at: toEpochSeconds(w["reset_at"])
  };
}
function parse_pool_usage(data) {
  const root = data && typeof data === "object" ? data : {};
  const planRaw = root["plan"] && typeof root["plan"] === "object" ? root["plan"] : {};
  const poolsRaw = root["pools"];
  const poolList = Array.isArray(poolsRaw) ? poolsRaw : poolsRaw && typeof poolsRaw === "object" ? Object.values(poolsRaw) : [];
  const pools = [];
  let grantKnown = false;
  let grantSum = 0;
  let weekLimit = 0;
  let weekRemaining = 0;
  let weekFound = false;
  let dedicatedKnown = false;
  let dedicatedSum = 0;
  for (const item of poolList) {
    if (!item || typeof item !== "object") continue;
    const pool = item;
    const typeRaw = typeof pool["pool_type"] === "string" ? pool["pool_type"].trim() : "";
    const nameRaw = typeof pool["name"] === "string" && pool["name"].trim() !== "" ? pool["name"].trim() : typeRaw !== "" ? typeRaw : "(未命名)";
    const isDedicated = typeRaw === "dedicated";
    const grant = intRound(numOrNull(pool["grant_balance"]));
    if (grant !== null) {
      if (isDedicated) {
        dedicatedKnown = true;
        dedicatedSum += grant;
      } else {
        grantKnown = true;
        grantSum += grant;
      }
    }
    const w5 = windowOf(pool["window_5h"]);
    const w7 = windowOf(pool["window_7d"]);
    const week = w7 ?? w5;
    if (isDedicated) {
    } else if (week) {
      if (week.limit !== null) weekLimit += week.limit;
      if (week.remaining !== null) {
        weekRemaining += week.remaining;
        weekFound = true;
      }
    } else {
      const fallbackLimit = numOrNull(pool["week_limit"]);
      const fallbackRemain = numOrNull(pool["week_balance"] ?? pool["week_remaining"]);
      if (fallbackLimit !== null) weekLimit += fallbackLimit;
      if (fallbackRemain !== null) {
        weekRemaining += fallbackRemain;
        weekFound = true;
      }
    }
    pools.push({
      pool_type: typeRaw !== "" ? typeRaw : nameRaw,
      pool_name: nameRaw,
      grant_balance: grant,
      grant_expiry: toEpochSeconds(pool["nearest_grant_expiry"]),
      // 在途发放**不取整**(collector 同款):round(0.53)=1 会凭空造数字。
      grant_expiring_balance: numOrNull(pool["nearest_grant_expiring_balance"]),
      w5,
      w7
    });
  }
  const grantTotal = grantKnown ? grantSum : null;
  const remaining = grantKnown || weekFound ? Math.round((grantTotal ?? 0) + weekRemaining) : null;
  const limit = weekLimit > 0 ? Math.round(weekLimit) : null;
  return {
    plan_name: typeof planRaw["name"] === "string" ? planRaw["name"] : null,
    plan_type: typeof planRaw["type"] === "string" ? planRaw["type"] : null,
    pools,
    grant_total: grantTotal,
    grant_known: grantKnown,
    remaining,
    limit,
    dedicated_grant_total: dedicatedKnown ? dedicatedSum : null,
    dedicated_grant_known: dedicatedKnown
  };
}
function jwt_expiry_epoch_s(token) {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const exp = payload["exp"];
  const n = Number(exp);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// core/connectors/sensenova-pool.ts
import { createHash as createHash6 } from "node:crypto";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
var BILLABLE_WINDOW_S = 60;
var COOLDOWN_ON_HOLD = 5;
var WINDOWED_WAIT_ROUNDS_LIMIT = 5;
var TRANSIENT_WAIT_ROUNDS_LIMIT = 12;
var SensenovaAccountRuntime = class {
  /** 60s 窗口内的 `(ts, billable)` 序列。 */
  spend = [];
  requests = 0;
  errors = 0;
  lastTtftMs = 0;
  lastUsedAt = 0;
  /** 模型 → 冷却截止(ms epoch)。键 `""` = 账号级兜底格。 */
  cooldownUntil = /* @__PURE__ */ new Map();
  /** 模型 → 冷却原因(上游报文摘要,已压白)。 */
  cooldownReason = /* @__PURE__ */ new Map();
  /** 单账号单并发:当前在途请求数(连接器内部,不经 router 账本)。 */
  inflight = 0;
  /** 账号名(池内;池外 adhoc 为 key 摘要)。**不进 snapshot**。 */
  name = "";
  /**
   * 该账号的 api_key(**进程内使用;绝不进 snapshot / 日志**)。
   *
   * 挂在运行态上而不是回头查池:池外 adhoc 账号不在 `pool.keys` 里,
   * 用 `pool.keyOf(name)` 会拿到空串 → Authorization 空 Bearer → 上游 401。
   */
  key = "";
  /**
   * 该账号的**钉连接**池。
   *
   * ⚠️ **前缀缓存亲和的关键**(2026-10-24 用户定案,m06730② 真根因之一):
   * 上游的前缀缓存按 1024-token 块存放在**推理节点本地**,而请求落到哪个节点
   * 由 TCP 连接决定。用 Node 默认的 `fetch`(undici 全局连接池)时,每账号的
   * 请求会在池里的多条连接间轮转 → 落到不同节点 → 缓存块丢一半。
   *
   * 解法:每账号一条 keep-alive client,且**限制到单条连接**
   * (等价于 `httpx` 的 `Limits(max_connections=1, max_keepalive_connections=1)`),
   * 单条 keep-alive 连接顺序请求 → 稳定命中同一个节点。
   *
   * 这里用 `node:https.Agent({ keepAlive: true, maxSockets: 1 })` 达到同样效果
   * (不引入 undici 依赖;`maxSockets: 1` 即「该 agent 下最多一条在途连接」)。
   *
   * 实测(同一前缀 4092 token,间隔 6s 连打):
   * - 裸 fetch: `cached` 在 3072 / 2048 之间抖动(换节点),首字 6s → 29s;
   * - 钉连接: 稳定 3072,首字 0.8s。
   */
  pinnedAgent = null;
  /** 取(必要时创建)该账号的钉连接 agent。 */
  pinnedHttpAgent() {
    if (this.pinnedAgent === null) {
      this.pinnedAgent = new HttpsAgent({
        keepAlive: true,
        maxSockets: 1,
        // 单账号单并发:一条连接串行,节点亲和
        maxFreeSockets: 1,
        timeout: 9e5
        // 900s:长回答留足时间
      });
    }
    return this.pinnedAgent;
  }
  /** 释放钉连接(账号被移除 / 进程收尾时调,避免 socket 泄漏)。 */
  closePinnedAgent() {
    if (this.pinnedAgent !== null) {
      this.pinnedAgent.destroy();
      this.pinnedAgent = null;
    }
  }
  /** 记一笔可计费消耗(成功后调用;命中 prompt cache 的不计)。 */
  recordSpend(tokens, now) {
    if (!(tokens > 0)) return;
    this.spend.push({ t: now, n: tokens });
    this.lastUsedAt = now;
  }
  /** 窗口内可计费 token 总和。 */
  billableInWindow(now) {
    const cutoff = now - BILLABLE_WINDOW_S * 1e3;
    let drop = 0;
    while (drop < this.spend.length && this.spend[drop].t < cutoff) drop += 1;
    if (drop > 0) this.spend.splice(0, drop);
    let sum = 0;
    for (const e of this.spend) sum += e.n;
    return sum;
  }
  recordOutcome(ok, ttftMs, now) {
    this.requests += 1;
    this.lastUsedAt = now;
    if (ok) {
      if (ttftMs > 0) this.lastTtftMs = ttftMs;
    } else {
      this.errors += 1;
    }
  }
  /**
   * 给 (账号, 模型) 这一格降温 —— **取 max 不覆盖**。
   *
   * 同号硬等会反复写这一格(每次 `COOLDOWN_ON_HOLD`);取 max 是为了别让后写
   * 的短值把更长的退避抹短。⚠️ 模型格**纯展示**,不参与选号(用户 m23215:
   * 不同模型可以用同一个账号)。
   */
  coolFor(seconds, reason, model, now) {
    const key = model || "";
    const until = now + seconds * 1e3;
    const prev = this.cooldownUntil.get(key) ?? 0;
    if (until > prev) {
      this.cooldownUntil.set(key, until);
      this.cooldownReason.set(key, reason);
    }
  }
  /**
   * 给**整个账号**降温(键 `""`)—— 新会话选号时跳过它(用户 m23215)。
   *
   * 只在「同号等待预算耗尽、这个号确实在限流」时才写:已粘住的会话不受影响
   * (粘性期内不换号),之后的新会话挑空闲号时会跳过它,直到冷却过期。
   */
  coolAccountFor(seconds, reason, now) {
    this.coolFor(seconds, reason, "", now);
  }
  isCooling(model, now) {
    return (this.cooldownUntil.get(model || "") ?? 0) > now;
  }
  /**
   * 账号级是否冷却中 —— **新会话选号**的判据。
   *
   * ⚠️ 不看模型:`isCooling(model)` 只作面板展示,选号一律走这一条
   * (用户 m23215:不同模型可以用同一个账号)。
   */
  isAccountCooling(now) {
    return this.isCooling("", now);
  }
  coolingRemaining(model, now) {
    const until = this.cooldownUntil.get(model || "") ?? 0;
    return until > now ? Math.ceil((until - now) / 1e3) : 0;
  }
  snapshot() {
    const now = Date.now();
    return {
      requests: this.requests,
      errors: this.errors,
      last_ttft_ms: this.lastTtftMs || null,
      last_used_at: this.lastUsedAt || null,
      cooldown_models: [...this.cooldownUntil.entries()].filter(([, until]) => until > now).map(([model, until]) => ({
        model: model || null,
        remaining_s: Math.ceil((until - now) / 1e3),
        reason: this.cooldownReason.get(model) ?? null
      }))
    };
  }
};
var SensenovaAccountPool = class {
  runtimes = /* @__PURE__ */ new Map();
  /** `username → api_key`(凭据投影,`setAccounts` 时重建)。 */
  keys = /* @__PURE__ */ new Map();
  setAccounts(accounts) {
    const seen = /* @__PURE__ */ new Set();
    const nextKeys = /* @__PURE__ */ new Map();
    for (const a of accounts) {
      if (!a.api_key) continue;
      let name = a.username || "?";
      while (seen.has(name)) name = `${name}#2`;
      seen.add(name);
      nextKeys.set(name, a.api_key);
      let rt = this.runtimes.get(name);
      if (!rt) {
        rt = new SensenovaAccountRuntime();
        rt.name = name;
        this.runtimes.set(name, rt);
      }
      rt.key = a.api_key;
    }
    for (const name of [...this.runtimes.keys()]) {
      if (!seen.has(name)) this.runtimes.delete(name);
    }
    this.keys.clear();
    for (const [k, v] of nextKeys) this.keys.set(k, v);
  }
  get size() {
    return this.runtimes.size;
  }
  names() {
    return [...this.runtimes.keys()];
  }
  runtime(name) {
    const rt = this.runtimes.get(name);
    if (!rt) throw new Error(`sensenova 账号池里没有 ${name}`);
    return rt;
  }
  /** 网关注入的 api_key 属池 → 返回账号名(不在池返回 `null`)。 */
  nameByKey(apiKey) {
    if (!apiKey) return null;
    for (const [name, key] of this.keys) {
      if (key === apiKey) return name;
    }
    return null;
  }
  /** 账号名 → api_key(**进程内使用;绝不进 snapshot / 日志**)。 */
  keyOf(name) {
    return this.keys.get(name) ?? "";
  }
  /** 账号池快照(**不含明文 key**)—— 面板 / 日志唯一出口。 */
  snapshot() {
    const out = {};
    for (const [name, rt] of this.runtimes) out[name] = rt.snapshot();
    return out;
  }
};
function sensenovaKeyFingerprint(apiKey) {
  return createHash6("sha256").update(apiKey).digest("hex").slice(0, 12);
}
function sensenovaSnippet(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return text.replace(/\s+/g, " ").slice(0, 160);
}
function pinnedPostJson(url, headers, payload, agent, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UpstreamError2("connection", "客户端断开", false, 499));
      return;
    }
    const req = httpsRequest(
      url,
      {
        method: "POST",
        agent,
        headers: {
          ...headers,
          "Content-Length": String(Buffer.byteLength(payload))
        }
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const body = Readable.toWeb(res);
        const outHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const one of v) outHeaders.append(k, one);
          else if (v !== void 0) outHeaders.set(k, String(v));
        }
        resolve(
          new Response(body, {
            status,
            statusText: res.statusMessage ?? "",
            headers: outHeaders
          })
        );
      }
    );
    req.on("error", (err) => {
      const aborted = signal?.aborted === true;
      reject(
        aborted ? new UpstreamError2("connection", "客户端断开", false, 499) : new UpstreamError2("connection", `上游连接失败:${err.message}`, true, 502)
      );
    });
    if (signal) {
      const onAbort = () => {
        req.destroy(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    req.end(payload);
  });
}

// core/connectors/sensenova-auth.ts
import {
  createCipheriv as createCipheriv2,
  createHash as createHash7,
  createPublicKey,
  publicEncrypt,
  randomBytes as randomBytes4
} from "node:crypto";
var IAM_BASE = "https://iam.sensecoreapi.cn";
var OIDC_AUTH = "https://platform.sensenova.cn/oauth2/auth";
var OIDC_TOKEN = "https://signin.sensecore.cn/oauth2/token";
var JWKS_URL = "https://signin.sensecore.cn/.well-known/jwks.json";
var APIKEYS_URL = `${IAM_BASE}/iam/idp/v1/apiKeys`;
var SENSENOVA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
var CLIENT_ID = "nova";
var REDIRECT_URI = "https://platform.sensenova.cn";
var SCOPE = "openid offline offline_access";
var JWKS_KID = "public:hydra.openid.id-token";
function pkce() {
  const verifier = base64url(randomBytes4(32));
  const challenge = base64url(createHash7("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge };
}
function encrypt_password_jwe(password, jwk) {
  const modulus = Buffer.from(jwk.n, "base64url");
  const exponent = Buffer.from(jwk.e, "base64url");
  const publicKey = createPublicKey({
    key: {
      kty: "RSA",
      n: modulus.toString("base64url"),
      e: exponent.toString("base64url")
    },
    format: "jwk"
  });
  const protectedHeader = { alg: "RSA-OAEP", enc: "A256GCM" };
  const protectedB64 = base64url(
    Buffer.from(JSON.stringify(protectedHeader), "utf-8")
  );
  const cek = randomBytes4(32);
  const iv = randomBytes4(12);
  const encryptedKey = publicEncrypt(
    {
      key: publicKey,
      padding: 4,
      // RSA_PKCS1_OAEP_PADDING
      oaepHash: "sha1"
    },
    cek
  );
  const cipher = createCipheriv2("aes-256-gcm", cek, iv);
  cipher.setAAD(Buffer.from(protectedB64, "utf-8"));
  const ciphertext = Buffer.concat([
    cipher.update(password, "utf-8"),
    cipher.final()
  ]);
  const tagBytes = cipher.getAuthTag();
  return [
    protectedB64,
    base64url(encryptedKey),
    base64url(iv),
    base64url(ciphertext),
    base64url(tagBytes)
  ].join(".");
}
function base64url(buf) {
  return buf.toString("base64url");
}
var SensenovaAuthFlow = class {
  constructor(fetchFn = fetch) {
    this.fetchFn = fetchFn;
  }
  fetchFn;
  jwks = null;
  jwtCache = /* @__PURE__ */ new Map();
  /**
   * refresh_token 缓存(`username → token`)。
   *
   * ⚠️ 登录时申请的 scope 含 `offline_access`,所以平台会**同时**发一个
   * refresh_token 出来。它的用处:控制台 JWT 只有约 3 小时有效期,到期后
   * 常规恢复路径是「用密码重新登录一遍」—— 但那要求用户把密码**明文**留在
   * 机器上。有 refresh_token 就不需要:拿它换一个新的 JWT 即可,密码可以不留。
   *
   * 上游没发 refresh_token 时这里就是空的,行为回落到「用密码重登」。
   */
  refreshTokenCache = /* @__PURE__ */ new Map();
  /**
   * 账号密码 → JWT（3h）。
   *
   * ⚠️ 每次登录用**独立的新 client**（登录完关闭）：平台把 OAuth 会话
   * 粘在连接上，复用单例 client 跨账号连续登录时会失败。
   */
  async login(account, username, password) {
    const name = sensenova_username(account) || sensenova_username(username);
    if (!username || !password) {
      throw new UpstreamError2("auth", "登录需要 username 与 password", false, 401);
    }
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes4(16));
    const jar = new CookieJar();
    const authUrl = `${OIDC_AUTH}?client_id=${CLIENT_ID}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${REDIRECT_URI}&response_type=code&scope=${SCOPE.replace(/ /g, "%20")}&state=${state}`;
    const challengeUrl = await this._followUntil(
      authUrl,
      (u) => u.includes("login_challenge="),
      8,
      jar
    );
    const url = new URL(challengeUrl);
    const loginChallenge = url.searchParams.get("login_challenge");
    if (!loginChallenge) {
      throw new UpstreamError2("auth", "未能解析 login_challenge", false, 401);
    }
    const jwk = await this._pubkey();
    const encrypted = encrypt_password_jwe(password, jwk);
    const loginHeaders = {
      "Content-Type": "application/json",
      Origin: "https://platform.sensenova.cn",
      Referer: "https://platform.sensenova.cn/",
      "User-Agent": SENSENOVA_UA,
      Accept: "*/*"
    };
    const loginCookie = jar.header();
    if (loginCookie) loginHeaders["Cookie"] = loginCookie;
    const loginResp = await this.fetchFn(`${IAM_BASE}/iam/authn/v1/auth/nova/login`, {
      method: "POST",
      headers: loginHeaders,
      body: JSON.stringify({
        username,
        password: encrypted,
        challenge: loginChallenge,
        is_encrypt: true
      })
    });
    jar.absorb(loginResp);
    const loginBody = await loginResp.json();
    const redirect = loginBody["redirect"];
    if (!redirect) {
      const msg = loginBody["message"] ?? loginBody["error"] ?? "无 redirect 字段";
      throw new UpstreamError2("auth", `登录失败: ${msg}`, false, 401);
    }
    const codeUrl = await this._followUntil(redirect, (u) => u.includes("code="), 8, jar);
    const codeParsed = new URL(codeUrl);
    const code = codeParsed.searchParams.get("code");
    if (!code) {
      throw new UpstreamError2("auth", "未能从回调地址解析 code", false, 401);
    }
    const tokenResp = await this.fetchFn(OIDC_TOKEN, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": SENSENOVA_UA
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE
      })
    });
    const token = await tokenResp.json();
    const access = token["access_token"];
    if (!access) {
      const err = token["error_description"] ?? token["error"] ?? "未知";
      throw new UpstreamError2("auth", `未返回 access_token: ${err}`, false, 401);
    }
    this.jwtCache.set(sensenova_username(account), access);
    const refresh = token["refresh_token"];
    if (typeof refresh === "string" && refresh !== "") {
      this.refreshTokenCache.set(sensenova_username(account), refresh);
    }
    return access;
  }
  /** 本次登录拿到的 refresh_token(没有则 undefined)。 */
  refreshTokenFor(account) {
    return this.refreshTokenCache.get(sensenova_username(account));
  }
  /**
   * 用 refresh_token 换一个新的控制台 JWT —— **不需要密码**。
   *
   * ⚠️ 为什么要有这条路:控制台 JWT 约 3 小时过期,常规恢复是「用存下来的密码
   * 重新登录一遍」。那要求用户把**明文密码**留在机器上;而 refresh_token 是
   * 平台专门为「离线续期」发的凭证(scope 里就写了 `offline_access`),用它换
   * JWT 既安全又省一次风控敏感的登录。
   *
   * 平台没发 refresh_token / 它已失效 → 抛 `auth` 错,调用方回落到「用密码重登」。
   */
  async refreshConsoleJwt(account, refreshToken) {
    if (!refreshToken) {
      throw new UpstreamError2("auth", "没有 refresh_token", false, 401);
    }
    const resp = await this.fetchFn(OIDC_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE
      })
    });
    const token = await resp.json();
    const access = token["access_token"];
    if (!access) {
      const err = token["error_description"] ?? token["error"] ?? "未知";
      throw new UpstreamError2("auth", `刷新 JWT 失败: ${err}`, false, 401);
    }
    this.jwtCache.set(sensenova_username(account), access);
    const next = token["refresh_token"];
    if (typeof next === "string" && next !== "") {
      this.refreshTokenCache.set(sensenova_username(account), next);
    }
    return access;
  }
  /**
   * 用 JWT 枚举账号 API key（明文 sk-），返回 `(key, 总数)`。
   */
  async fetch_api_key(account) {
    const jwt = this.jwtCache.get(sensenova_username(account));
    if (!jwt) {
      throw new UpstreamError2("auth", `账号 ${account} 没有可用 JWT`, false, 401);
    }
    const resp = await this.fetchFn(`${APIKEYS_URL}?page_size=100`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        Referer: "https://platform.sensenova.cn/console"
      }
    });
    if (resp.status !== 200) {
      throw new UpstreamError2("auth", `apiKeys 拉取失败 HTTP ${resp.status}`, false, resp.status);
    }
    const body = await resp.json();
    const keys = body["api_keys"] ?? [];
    const enabled = keys.filter(
      (k) => k["status"] === "enabled" && k["api_key"]
    );
    const picked = enabled.find((k) => k["type"] === "nova.tokenplan.v1") ?? enabled[0];
    if (!picked) {
      throw new UpstreamError2("auth", "账号下没有可用的 API key", false, 401);
    }
    return {
      apiKey: picked["api_key"],
      total: keys.length
    };
  }
  /**
   * 用 JWT 列出现有 API key(**不含** api_key 明文之外的筛选)。
   *
   * 与 {@link fetch_api_key} 的区别:这里把每一把都交出去(含 id / status /
   * 是否默认),交给装配层判断「有没有、能不能用」。创建前的探查与创建后的
   * 核对都用它 —— 网关不该为「列一把」和「列全部」各写一个接口。
   */
  async list_api_keys(account) {
    const jwt = this.jwtCache.get(sensenova_username(account));
    if (!jwt) {
      throw new UpstreamError2("auth", `账号 ${account} 没有可用 JWT`, false, 401);
    }
    const resp = await this.fetchFn(`${APIKEYS_URL}?page_size=100`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        Referer: "https://platform.sensenova.cn/console"
      }
    });
    if (resp.status !== 200) {
      throw new UpstreamError2("auth", `apiKeys 拉取失败 HTTP ${resp.status}`, false, resp.status);
    }
    const body = await resp.json();
    const raw = body["api_keys"] ?? [];
    return raw.map((k) => ({
      id: typeof k["id"] === "string" ? k["id"] : "",
      displayname: typeof k["displayname"] === "string" ? k["displayname"] : "",
      api_key: typeof k["api_key"] === "string" ? k["api_key"] : "",
      status: typeof k["status"] === "string" ? k["status"] : "",
      type: typeof k["type"] === "string" ? k["type"] : "",
      is_default: k["is_default"] === true
    }));
  }
  /**
   * 用 JWT 新建一把 API key,返回**明文 sk-**(平台只在创建响应里给一次)。
   *
   * ⚠️ 字段名是 `displayname`(不是 `name`):上游 400 会明说
   * `invalid APIKey.Displayname`,用 `name` 一律被拒。
   * ⚠️ 上游不认 `type` / `content`,创建的 key `type` 为空串 —— 所以
   * {@link fetch_api_key} 里「优先 type=nova.tokenplan.v1」的选择逻辑在新 key
   * 上不生效,但仍能取到(回落 `enabled[0]`)。
   */
  async create_api_key(account, displayname) {
    const jwt = this.jwtCache.get(sensenova_username(account));
    if (!jwt) {
      throw new UpstreamError2("auth", `账号 ${account} 没有可用 JWT`, false, 401);
    }
    const name = displayname && displayname.trim() !== "" ? displayname.trim().slice(0, 64) : `as-one-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
    const resp = await this.fetchFn(APIKEYS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Referer: "https://platform.sensenova.cn/console"
      },
      body: JSON.stringify({ displayname: name })
    });
    if (resp.status !== 200) {
      const text = await resp.text().catch(() => "");
      throw new UpstreamError2(
        "auth",
        `创建 API key 失败 HTTP ${resp.status}${text ? `: ${sensenovaSnippet(text)}` : ""}`,
        false,
        resp.status
      );
    }
    const body = await resp.json();
    const key = body["api_key"];
    if (typeof key !== "string" || key === "") {
      throw new UpstreamError2("auth", "创建成功但响应里没有 api_key", false, 502);
    }
    return key;
  }
  /**
   * 删掉一把 API key(按 id)。
   *
   * 平台对「遗失的 key」的处置就是删除重建,所以清理失败的那把是正道 ——
   * 但删不掉不能算致命:旧 key 留在账号下不影响新 key 可用,如实抛给上层
   * 让它决定要不要继续。
   */
  async delete_api_key(account, id) {
    if (!id) return;
    const jwt = this.jwtCache.get(sensenova_username(account));
    if (!jwt) {
      throw new UpstreamError2("auth", `账号 ${account} 没有可用 JWT`, false, 401);
    }
    const resp = await this.fetchFn(`${APIKEYS_URL}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        Referer: "https://platform.sensenova.cn/console"
      }
    });
    if (resp.status !== 200) {
      const text = await resp.text().catch(() => "");
      throw new UpstreamError2(
        "auth",
        `删除 API key 失败 HTTP ${resp.status}${text ? `: ${sensenovaSnippet(text)}` : ""}`,
        false,
        resp.status
      );
    }
  }
  /**
   * 「确保有一把能用的 key」—— 自愈链的收口。
   *
   * 与 {@link ensure_api_key} 的区别:除了新建,还会**把无效的旧 key 删掉**。
   * 平台对「遗失/失效的 key」的处置就是删除重建,留着旧 key 只是占位
   * (列表里它仍然 `enabled`,下次 ensure 又会挑到它 —— 死循环)。
   *
   * 顺序:
   * 1. 列出全部,挑 enabled(优先套餐那把);
   * 2. 一把都没有 → 新建;
   * 3. `dropIds` 里点名的旧 key → 建完新的再删(先建后删,绝不出现
   *    「删了但没建成」的窗口);删不掉不算失败,回执里如实说。
   */
  async ensure_api_key_replacing(account, dropIds = [], displayname) {
    const keys = await this.list_api_keys(account);
    const enabled = keys.filter((k) => k.status === "enabled" && k.api_key !== "");
    const picked = enabled.find((k) => k.type === "nova.tokenplan.v1") ?? enabled[0];
    if (picked && dropIds.length === 0) {
      return { apiKey: picked.api_key, total: keys.length, created: false, dropped: [] };
    }
    const apiKey = await this.create_api_key(account, displayname);
    const dropped = [];
    for (const id of dropIds) {
      try {
        await this.delete_api_key(account, id);
        dropped.push(id);
      } catch {
      }
    }
    const after = await this.list_api_keys(account).catch(() => []);
    return { apiKey, total: after.length || keys.length + 1, created: true, dropped };
  }
  async ensure_api_key(account, displayname) {
    const keys = await this.list_api_keys(account);
    const enabled = keys.filter((k) => k.status === "enabled" && k.api_key !== "");
    const picked = enabled.find((k) => k.type === "nova.tokenplan.v1") ?? enabled[0];
    if (picked) {
      return { apiKey: picked.api_key, total: keys.length, created: false };
    }
    const apiKey = await this.create_api_key(account, displayname);
    const after = await this.list_api_keys(account).catch(() => keys);
    return { apiKey, total: after.length + 1, created: true };
  }
  /** 获取缓存的 JWT */
  jwtFor(account) {
    return this.jwtCache.get(sensenova_username(account));
  }
  /**
   * 拉取控制台积分池用量(pool-usage)。
   *
   * `jwt` 可不传:优先用显式传入的 JWT,否则回落本实例登录时缓存的 JWT
   * (登录后同一实例直接调用即可)。响应体原样返回,解析交给
   * {@link parse_pool_usage}(纯函数,层间解耦)。
   */
  async fetch_pool_usage(account, jwt) {
    const token = jwt ?? this.jwtCache.get(sensenova_username(account));
    if (!token) {
      throw new UpstreamError2("auth", `账号 ${account} 没有可用 JWT`, false, 401);
    }
    const resp = await this.fetchFn(POOL_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Referer: "https://platform.sensenova.cn/console",
        "User-Agent": SENSENOVA_UA
      }
    });
    if (resp.status >= 400) {
      throw new UpstreamError2("auth", `sensenova 积分池接口 HTTP ${resp.status}`, false, resp.status);
    }
    return resp.json();
  }
  /** 拉取 JWKS 公钥 */
  async _pubkey() {
    if (this.jwks) return this.jwks;
    const resp = await this.fetchFn(JWKS_URL);
    if (resp.status !== 200) {
      throw new UpstreamError2("auth", `JWKS 拉取失败 HTTP ${resp.status}`, false, resp.status);
    }
    const body = await resp.json();
    const keys = body["keys"] ?? [];
    const jwk = keys.find((k) => k["kid"] === JWKS_KID);
    if (!jwk) {
      throw new UpstreamError2("auth", `JWKS 中没有 ${JWKS_KID}`, false, 401);
    }
    this.jwks = { n: jwk["n"], e: jwk["e"] };
    return this.jwks;
  }
  /**
   * 手动跟随重定向直到 predicate 成立。
   *
   * ⚠️ 必须带上 cookie jar:登录链的前几跳
   * (OIDC_AUTH → … → iam 登录页)会下发 `Set-Cookie`,**POST `/nova/login`
   * 必须把那条 session cookie 带回去**,否则服务端拿不到 CSRF 值,直接
   * 回 `InvalidArgument`(已知坑:
   * 「缺少 session cookie 时报 No CSRF value available in the session cookie」)。
   */
  async _followUntil(start, predicate, maxHops = 8, jar) {
    let location = start;
    for (let i = 0; i < maxHops; i++) {
      if (location && predicate(location)) {
        return location;
      }
      const headers = { Accept: "*/*", "User-Agent": SENSENOVA_UA };
      const cookie = jar?.header();
      if (cookie) headers["Cookie"] = cookie;
      const resp = await this.fetchFn(location, { redirect: "manual", headers });
      jar?.absorb(resp);
      const loc = resp.headers.get("location");
      if (loc) {
        location = new URL(loc, location).toString();
        continue;
      }
      if (resp.status === 200 || resp.status === 201) {
        const text = await resp.text();
        const next = this._nextFromHtml(text);
        if (next) {
          location = new URL(next, location).toString();
          continue;
        }
      }
      break;
    }
    if (location && predicate(location)) {
      return location;
    }
    throw new UpstreamError2("auth", "登录回调链中断:未取到 authorization code", false, 401);
  }
  /**
   * 从 HTML 响应体里找下一跳。
   *
   * 只认 `url=` 太窄:真实登录页给的是 `code=` 的完整 URL、`<meta http-equiv
   * ="refresh">`,或 `window.location.replace(...)` 这类 JS 跳转。少一种形态
   * 就会在中间页断链,报「登录回调链中断」。
   */
  _nextFromHtml(html) {
    if (!html) return null;
    const codeUrl = html.match(/(https?:\/\/[^"'\s<>]+[?&]code=[^&"'\s<>]+)/);
    if (codeUrl) return codeUrl[1];
    const meta = html.match(
      /<meta[^>]+http-equiv=["']refresh["'][^>]+url=["']([^"']+)/i
    );
    if (meta) return meta[1].replace(/&amp;/g, "&");
    for (const pattern of [
      /window\.location\.replace\(["']([^"']+)["']\)/,
      /window\.location\.href\s*=\s*["']([^"']+)["']/,
      /location\.href\s*=\s*["']([^"']+)["']/,
      /window\.location\s*=\s*["']([^"']+)["']/
    ]) {
      const js = html.match(pattern);
      if (js) return js[1].replace(/&amp;/g, "&");
    }
    return null;
  }
};
var CookieJar = class {
  cookies = /* @__PURE__ */ new Map();
  absorb(resp) {
    const withSet = resp.headers;
    const lines = typeof withSet.getSetCookie === "function" ? withSet.getSetCookie() : [];
    const raw = lines.length > 0 ? lines : [resp.headers.get("set-cookie") ?? ""];
    for (const line of raw) {
      if (!line) continue;
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair);
    }
  }
  header() {
    return [...this.cookies.values()].join("; ");
  }
};

// core/connectors/sensenova.ts
function holdDelaySeconds(rawBody, waitLeft) {
  const attribution = classify_rate_limit(rawBody || "");
  const windowed = attribution === ATTR_RPM || attribution === ATTR_SHARED;
  const step = windowed ? BILLABLE_WINDOW_S : COOLDOWN_ON_HOLD;
  return Math.max(0, Math.min(step, waitLeft));
}
function isTransientInvalidParameter(httpStatus, body) {
  if (httpStatus !== 400) return false;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return text.includes("inference request is invalid") && /InvalidParameter/i.test(text);
}
var MAX_TRANSIENT_400_RETRIES = 3;
var SensenovaAdapter = class {
  constructor(accounts = [], fetchFn = fetch) {
    this.accounts = accounts;
    this.fetchFn = fetchFn;
    this.pool.setAccounts(accounts);
  }
  accounts;
  fetchFn;
  vendorId = "sensenova";
  /** 账号池(跨请求存活 —— tpm/rpm 记账与冷却都挂在这里)。 */
  pool = new SensenovaAccountPool();
  /**
   * 账号池版本号:`setAccounts` 每次调用 +1。
   *
   * `getToken` 在选号前比对 —— 凭据在两次请求之间被改过(面板增删账号)
   * 就立刻重投影一次。没有它,新加的账号要等下一次 `setAccounts` 才生效。
   */
  poolVersion = 0;
  /**
   * 替换账号池(整池替换,**保留已存在账号的运行态**)。
   *
   * 装配层在凭据变化时调用(面板增删 sensenova 账号 / 刷新任务写完新 key)。
   */
  setAccounts(accounts) {
    this.accounts = accounts;
    this.pool.setAccounts(accounts);
    this.poolVersion += 1;
  }
  /** 账号池快照(**不含明文 key**)—— 面板展示。 */
  poolSnapshot() {
    return this.pool.snapshot();
  }
  /** 账号名 → api_key(仅进程内使用;测试与面板诊断)。 */
  accountKeyOf(username) {
    return this.accounts.find((a) => a.username === username)?.api_key;
  }
  /** 池外 api_key 的临时运行态(按 key 摘要做键,绝不把 key 本身当键名)。 */
  adhoc = /* @__PURE__ */ new Map();
  adhocRuntime(apiKey) {
    const fp = sensenovaKeyFingerprint(apiKey);
    let rt = this.adhoc.get(fp);
    if (!rt) {
      rt = new SensenovaAccountRuntime();
      rt.name = fp;
      this.adhoc.set(fp, rt);
    }
    rt.key = apiKey;
    return rt;
  }
  /**
   * 本轮请求**起始**用哪一个账号(单账号;换号在 {@link runWithAccount} 里发生)。
   *
   * 分支(优先级从高到低):
   * 1. `creds.sensenova_account` 钉死 → 只有它(池里没有 → 400);
   * 2. 池空 → 只用 `creds.apiKey`(单账号,按 key 摘要建临时运行态);
   * 3. `creds.apiKey` 属池 → **从它开始**(网关注入哪号就先试哪号);
   * 4. `creds.apiKey` 不在池 → 只用它(池外身份,不拿别的身份顶替);
   * 5. 都没带 → 从池里挑**一个空闲账号**({@link pickIdle})。
   *
   * ⚠️ 分支 3 只决定**起点**。429 时 {@link runWithAccount} 会换到池内其它空闲
   * 账号(用户 2026-11-01 定案:缓存跨账号共享,粘性绑真实模型级)。
   * 分支 4 的池外 key **不参与换号** —— 池里没有它,也就没有第二个身份可选。
   */
  accountFor(creds) {
    const pinned = typeof creds["sensenova_account"] === "string" ? String(creds["sensenova_account"]) : "";
    if (pinned) {
      try {
        return this.pool.runtime(pinned);
      } catch {
        throw new UpstreamError2(
          "bad_request",
          `[sensenova] 账号池里没有 ${pinned};可用:${this.pool.names().join(", ") || "(空)"}`,
          false,
          400
        );
      }
    }
    const apiKey = creds.apiKey;
    if (this.pool.size === 0) {
      if (!apiKey) {
        throw new UpstreamError2("auth", "[sensenova] 账号池为空且请求未带 api_key", false, 401);
      }
      return this.adhocRuntime(apiKey);
    }
    if (apiKey) {
      const name = this.pool.nameByKey(apiKey);
      return name === null ? this.adhocRuntime(apiKey) : this.pool.runtime(name);
    }
    return this.pickIdle();
  }
  /**
   * 从池里挑**一个空闲账号**(新会话 / 粘性过期时的选号,用户 m23215)。
   *
   * 判据只有两条:
   * - `inflight === 0`(没在途请求 —— 上游要求单账号单并发);
   * - 账号级没冷却(`isAccountCooling`,键 `""` 那一格)。
   *
   * **不看模型** —— 不同模型可以用同一个账号;按 (账号,模型) 的冷却记录只作
   * 面板展示,不参与选号(旧实现会因某模型冷却就把该号排除,甚至误判池空)。
   *
   * 一个都没有 → 池空(`POOL_EXHAUSTED`,可重试 429):等占用释放 / 冷却过期,
   * **不换身份**(这里本来就是在挑号,没有「换」的概念)。
   */
  pickIdle() {
    const now = Date.now();
    const idle = this.pool.names().map((n) => this.pool.runtime(n)).filter((rt) => rt.inflight === 0 && !rt.isAccountCooling(now));
    if (idle.length === 0) {
      throw new UpstreamError2(
        POOL_EXHAUSTED,
        "[sensenova] 没有空闲账号(全部单并发占用中或账号级冷却中),请退避约 15s",
        true,
        429,
        15
      );
    }
    return idle[Math.floor(Math.random() * idle.length)];
  }
  /**
   * 429 换号:从池里挑一个**没试过**的空闲未冷却账号(没有 → `null`)。
   *
   * 为什么允许换号(用户 2026-11-01 定案,修正 m23215 的「绝不换号」):
   * sensenova 的上游**前缀缓存跨账号共享**(按推理节点存放,与凭证无关),
   * 所以换账号不会丢缓存亲和 —— 粘性只需要绑在**真实模型**一级,账号是
   * 同模型下的负载分担。rpm/rps/tpm 都是**账号级**限流,换一个号就能继续,
   * 死等同一个号只会把 100s 预算烧光(实测)。
   *
   * `tried` 由调用方维护:防 A→B→A 打转。池外 adhoc 账号(`name === ""`)
   * 不参与换号 —— 没有池就没有第二个身份可选。
   */
  pickOtherAccount(tried, now) {
    const idle = this.pool.names().map((n) => this.pool.runtime(n)).filter((rt) => rt.inflight === 0 && !rt.isAccountCooling(now) && !tried.has(rt.name));
    if (idle.length === 0) return null;
    return idle[Math.floor(Math.random() * idle.length)];
  }
  /**
   * 取**本轮请求**要用的账号并占用它(单并发 +1)。
   *
   * 调用方必须配对 {@link releaseFor}(`runWithAccount` 里在 finally)。
   *
   * ⚠️ 钉死/网关注入的账号**不判冷却**:它只是本轮的**起点**,429 时
   * {@link runWithAccount} 仍会换到池内其它空闲号(见 {@link pickOtherAccount})。
   * 只有 {@link pickIdle} 这条「挑一个新号」的路才会在选号阶段就跳过
   * 占用中 / 账号级冷却的号。
   */
  acquireFor(creds) {
    const rt = this.accountFor(creds);
    rt.inflight += 1;
    return rt;
  }
  releaseFor(rt) {
    if (rt.inflight > 0) rt.inflight -= 1;
  }
  /**
   * 取一次上游调用要用的账号(运行时),**不发起请求**。
   *
   * 供装配层/测试直接验证调度判据;请求路径走 {@link runWithAccount}。
   */
  runtimeFor(creds) {
    return this.acquireFor(creds);
  }
  /**
   * 补记一次成功请求的可计费 token(SSE 尾块拿到 usage 后调用)。
   *
   * @param username 池内账号名(池外 adhoc 传运行时 name)。
   */
  recordSpendFor(username, usage, ttftMs) {
    let rt;
    try {
      rt = this.pool.runtime(username);
    } catch {
      rt = void 0;
    }
    if (!rt) rt = this.adhoc.get(username);
    if (!rt) return;
    const now = Date.now();
    rt.recordSpend(billable_tokens(usage), now);
    rt.recordOutcome(true, ttftMs, now);
  }
  /**
   * 账号运行态快照(面板诊断)—— **不含明文 key**。
   */
  runtimeSnapshot(username) {
    try {
      return this.pool.runtime(username).snapshot();
    } catch {
      return null;
    }
  }
  // -------------------------------------------------------------------------
  // 上游请求 + 单账号调度(**不含**换号循环)
  // -------------------------------------------------------------------------
  /**
   * 打一次上游 chat 请求。
   *
   * 账号策略(用户 m23215 定案:**单账号,绝不换号**):
   * - 粘性绑定在真实模型一级;429 时**不换号**,同号同模型继续请求;
   * - 429 同号硬等:窗口型限流(tpm/rpm,60s 滑动)等满一个完整计费窗口再打
   *   (每 5s 刷一次会把窗口永远顶在「刚打过」,实测短间隔反而持续 429),
   *   瞬时型保持 COOLDOWN_ON_HOLD 短间隔(见 {@link holdDelaySeconds});
   * - **轮数有界,超限交回错误码**(2026-11-28 用户定案):等满窗口是必要
   *   等待,但轮数有上限(窗口型 {@link WINDOWED_WAIT_ROUNDS_LIMIT} /
   *   瞬时型 {@link TRANSIENT_WAIT_ROUNDS_LIMIT})—— 超限立刻交回**上一次
   *   的真实 429**,让外层退避重试或换档,而不是在外层 600s 预算里空转到
   *   超时(「不要无意义等待:要么持续重试到成功,要么把错误码交回去」);
   * - **例外**:`isTransientInvalidParameter()` 认出的 400 是上游限流期的
   *   伪 400(见该函数注释),按 429 同号短等待重试,有独立次数上限;
   * - 非 429 的其它错误(401/403/普通 400)直接抛:凭据/请求问题,等也没用。
   *
   * ⏱️ 等待时间由调用方计入 TTFT:客户端请求进入网关那一刻就是起点。
   */
  async runWithAccount(url, body, model, creds, signal, waitBudgetSeconds = BILLABLE_WINDOW_S) {
    const rt = this.acquireFor(creds);
    let waitLeft = Math.max(0, waitBudgetSeconds);
    let waitedS = 0;
    let windowedRounds = 0;
    let transientRounds = 0;
    let transient400Retries = 0;
    let lastError;
    try {
      for (; ; ) {
        if (signal?.aborted) throw lastError ?? this.budgetExhausted(rt, waitedS);
        let res;
        try {
          res = await this.pinnedFetch(rt, url, body, signal);
        } catch (fetchErr) {
          if (signal?.aborted) throw lastError ?? this.budgetExhausted(rt, waitedS);
          throw fetchErr;
        }
        if (res.ok) return { res, runtime: rt };
        const text = await res.text().catch(() => "");
        const err = this.classifyError(res.status, text);
        rt.recordOutcome(false, 0, Date.now());
        const transient400 = isTransientInvalidParameter(res.status, text);
        if (transient400) {
          if (transient400Retries >= MAX_TRANSIENT_400_RETRIES) throw err;
          transient400Retries += 1;
          lastError = err;
          const delay2 = Math.min(COOLDOWN_ON_HOLD, Math.max(0, waitLeft));
          if (delay2 <= 0) {
            waitLeft = Math.max(0, waitBudgetSeconds);
            continue;
          }
          rt.coolFor(delay2, sensenovaSnippet(text), model, Date.now());
          await this.sleep(delay2 * 1e3, signal);
          waitLeft = Math.max(0, waitLeft - delay2);
          waitedS += delay2;
          continue;
        }
        if (res.status !== 429) throw err;
        const now = Date.now();
        lastError = err;
        const windowed = classify_rate_limit(text || "") === ATTR_RPM || classify_rate_limit(text || "") === ATTR_SHARED;
        if (windowed) {
          windowedRounds += 1;
          if (windowedRounds > WINDOWED_WAIT_ROUNDS_LIMIT) throw err;
        } else {
          transientRounds += 1;
          if (transientRounds > TRANSIENT_WAIT_ROUNDS_LIMIT) throw err;
        }
        if (waitLeft <= 0) {
          rt.coolAccountFor(BILLABLE_WINDOW_S, sensenovaSnippet(text), now);
          waitLeft = Math.max(0, waitBudgetSeconds);
          waitedS = 0;
        }
        const delay = holdDelaySeconds(text, waitLeft);
        rt.coolFor(delay, sensenovaSnippet(text), model, now);
        await this.sleep(delay * 1e3, signal);
        waitLeft -= delay;
        waitedS += delay;
      }
    } finally {
      this.releaseFor(rt);
    }
  }
  /**
   * sleep(连接器内部等待,不让客户端重试;时长计入 TTFT)。
   *
   * ⚠️ 必须响应 `signal`：同号等待现在是「重置计时继续」而不是抛错，
   * 终止完全依赖外层总预算 abort —— 睡死了就打断不了，请求会一直占着并发租约。
   */
  sleep(ms, signal) {
    if (signal === void 0) return new Promise((r) => setTimeout(r, ms));
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
  /**
  * 总预算耗尽、且**一次真实上游错误都没拿到**时的兜底错误。
  *
  * 用户定案（2026-11-18）：「返回上一次的报错信息，没有才返回超时」。
  * 所以只有在 `lastError` 为空（一次都没打出去 / 上游没回过错误）时才用它。
  */
  budgetExhausted(rt, waitedS) {
    return new UpstreamError2(
      "timeout",
      `[sensenova] 账号 ${rt.name || "(adhoc)"} 请求总超时预算耗尽（累计等待 ${Math.round(waitedS)}s），未拿到有效响应`,
      true,
      504
    );
  }
  /**
   * 走**该账号的钉连接**发一次请求(返回标准 `Response`,与 fetch 同形)。
   *
   * 为什么不用 `this.fetchFn`(Node 全局 fetch):undici 全局连接池会为同一
   * origin 开多条连接并轮转,每换一条就可能落到不同推理节点 → 上游前缀缓存
   * (按 1024-token 块存在节点本地)**命中率掉一半**。改用
   * `max_connections=1` 的独立 client 钉死节点,这里用 `maxSockets: 1` 的
   * `https.Agent` 达到同样效果。
   *
   * 注入的 `fetchFn`(测试替身)仍然优先 —— 单测不该真的连网。
   */
  async pinnedFetch(rt, url, body, signal) {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${rt.key}`
    };
    if (this.fetchFn !== fetch) {
      return this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal
      });
    }
    return pinnedPostJson(url, headers, JSON.stringify(body), rt.pinnedHttpAgent(), signal);
  }
  async getToken(creds) {
    const apiKey = creds.apiKey;
    if (!apiKey) {
      const enabled = this.accounts.filter((a) => a.enabled !== false);
      if (enabled.length === 0) {
        throw new UpstreamError2("auth", "[sensenova] 账号池为空且请求未带 api_key", false, 401);
      }
      return { accessToken: enabled[0].api_key, expiresAt: Number.POSITIVE_INFINITY };
    }
    return { accessToken: apiKey, expiresAt: Number.POSITIVE_INFINITY };
  }
  decorateRequest(base, token) {
    return {
      ...base,
      headers: { ...base.headers, Authorization: `Bearer ${token.accessToken}` }
    };
  }
  classifyError(httpStatus, body) {
    const raw = sensenovaSnippet(body);
    const rawText = raw.replace(/^(null|""|'')$/, "").trim();
    const withRaw = (text) => rawText ? `${text} — 上游:${rawText}` : text;
    const original = upstreamRawResponse(httpStatus, body);
    if (httpStatus === 429) {
      const bodyStr = typeof body === "string" ? body : JSON.stringify(body ?? "");
      const attribution = classify_rate_limit(bodyStr);
      if (attribution === ATTR_SHARED) {
        return new UpstreamError2(POOL_SATURATED, withRaw("整个池子都满"), false, 429, void 0, original);
      }
      if (attribution === ATTR_RPM) {
        return new UpstreamError2(POOL_EXHAUSTED, withRaw("账号额度耗尽"), true, 429, void 0, original);
      }
      return new UpstreamError2("rate_limit", withRaw("上游限流"), true, 429, void 0, original);
    }
    if (httpStatus === 401 || httpStatus === 403) {
      return new UpstreamError2("auth", withRaw("认证失败"), false, httpStatus, void 0, original);
    }
    if (httpStatus >= 500) {
      return new UpstreamError2("upstream", withRaw("上游错误"), true, httpStatus, void 0, original);
    }
    if (httpStatus >= 400) {
      return new UpstreamError2("bad_request", withRaw("请求错误"), false, httpStatus, void 0, original);
    }
    return new UpstreamError2("upstream", withRaw("未知错误"), true, httpStatus, void 0, original);
  }
};

// core/connectors/minimax.ts
var MINIMAX_LLM_PATH = "/mavis/api/v1/llm/v1/messages";
var MINIMAX_ANTHROPIC_VERSION = "2023-06-01";
function tokenOf(creds) {
  const apiKey = typeof creds.apiKey === "string" ? creds.apiKey.trim() : "";
  if (apiKey !== "") return apiKey;
  const token = typeof creds["token"] === "string" ? String(creds["token"]).trim() : "";
  return token;
}
var MinimaxAdapter = class {
  vendorId = "minimax";
  async getToken(creds) {
    const token = tokenOf(creds);
    if (token === "") {
      throw new UpstreamError2("auth", "[minimax] 缺少 access token(需重新设备码授权)", false, 401);
    }
    return { accessToken: token, expiresAt: Number.POSITIVE_INFINITY };
  }
  decorateRequest(base, token) {
    return {
      ...base,
      headers: {
        ...base.headers,
        Authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        "anthropic-version": MINIMAX_ANTHROPIC_VERSION
      }
    };
  }
  /**
   * 错误归类。
   *
   * ⚠️ 401/403 必须落 `auth`:面板据此提示「重新授权」,而不是当普通上游故障
   * 反复重试同一把废令牌。429 落 `rate_limit` 并尽量带出 `Retry-After`。
   */
  classifyError(httpStatus, body, headers) {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
    const detail = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    const retryAfter = retryAfterOf2(body, headers);
    if (httpStatus === 401 || httpStatus === 403) {
      return new UpstreamError2(
        "auth",
        `[minimax] 鉴权失败(HTTP ${httpStatus}):access token 可能已过期,需重新设备码授权${detail ? ` — ${detail}` : ""}`,
        false,
        httpStatus
      );
    }
    if (httpStatus === 429) {
      return new UpstreamError2(
        "rate_limit",
        "[minimax] 上游限流(HTTP 429)",
        true,
        429,
        retryAfter
      );
    }
    if (httpStatus >= 500) {
      return new UpstreamError2("upstream", `[minimax] 上游错误(HTTP ${httpStatus})`, true, httpStatus, retryAfter);
    }
    if (httpStatus >= 400) {
      return new UpstreamError2(
        "bad_request",
        `[minimax] 请求被拒(HTTP ${httpStatus})${detail ? ` — ${detail}` : ""}`,
        false,
        httpStatus
      );
    }
    return new UpstreamError2("upstream", `[minimax] 意外的 HTTP ${httpStatus}`, true, httpStatus);
  }
};
function retryAfterOf2(body, headers) {
  if (body !== null && typeof body === "object") {
    const b = body;
    for (const key of ["retry_after", "retryAfter", "retry-after"]) {
      const v = b[key];
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    }
  }
  if (headers === null || headers === void 0) return void 0;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "retry-after") continue;
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) {
      const delta = Math.ceil((at - Date.now()) / 1e3);
      if (delta >= 0) return delta;
    }
  }
  return void 0;
}

// core/connectors/anthropic.ts
var ANTHROPIC_VERSION = "2023-06-01";
var ANTHROPIC_MESSAGES_PATH = "/messages";
var ANTHROPIC_QUIRKS = {
  effortField: "none",
  requiresSignature: true,
  systemShape: "blocks",
  streamOnly: true,
  maxTokensDefault: 8192
};
function anthropicMessagesUrl(baseUrl) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (base === "") return "";
  return /\/v1$/i.test(base) ? `${base}${ANTHROPIC_MESSAGES_PATH}` : `${base}/v1${ANTHROPIC_MESSAGES_PATH}`;
}
var EFFORT_FIELDS = /* @__PURE__ */ new Set(["output_config", "budget_tokens", "none"]);
function anthropicQuirksFrom(raw) {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return {};
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value;
  const out = {};
  if (typeof v["effortField"] === "string" && EFFORT_FIELDS.has(v["effortField"])) {
    out.effortField = v["effortField"];
  }
  if (typeof v["requiresSignature"] === "boolean") out.requiresSignature = v["requiresSignature"];
  if (v["systemShape"] === "string" || v["systemShape"] === "blocks") {
    out.systemShape = v["systemShape"];
  }
  if (typeof v["streamOnly"] === "boolean") out.streamOnly = v["streamOnly"];
  if (typeof v["maxTokensDefault"] === "number" && Number.isFinite(v["maxTokensDefault"]) && v["maxTokensDefault"] > 0) {
    out.maxTokensDefault = Math.floor(v["maxTokensDefault"]);
  }
  return out;
}
function tokenOf2(creds) {
  const apiKey = typeof creds.apiKey === "string" ? creds.apiKey.trim() : "";
  if (apiKey !== "") return apiKey;
  const token = typeof creds["token"] === "string" ? String(creds["token"]).trim() : "";
  return token;
}
function detailOf(body) {
  if (body !== null && typeof body === "object") {
    const err = body["error"];
    if (err !== null && typeof err === "object") {
      const message = err["message"];
      if (typeof message === "string" && message !== "") return message;
    }
  }
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
function retryAfterOf3(body, headers) {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== "retry-after") continue;
    const n = Number(Array.isArray(value) ? value[0] : value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (body !== null && typeof body === "object") {
    for (const key of ["retry_after", "retryAfter"]) {
      const n = Number(body[key]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return void 0;
}
var AnthropicAdapter = class {
  vendorId = "anthropic";
  async getToken(creds) {
    const token = tokenOf2(creds);
    if (token === "") {
      throw new UpstreamError2("auth", "[anthropic] 缺少 API key", false, 401);
    }
    return { accessToken: token, expiresAt: Number.POSITIVE_INFINITY };
  }
  decorateRequest(base, token) {
    return {
      ...base,
      headers: {
        ...base.headers,
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        // 官方只认 x-api-key，多数中转只认 Bearer —— 同时发是这类网关的通行做法。
        "x-api-key": token.accessToken,
        Authorization: `Bearer ${token.accessToken}`
      }
    };
  }
  /**
   * 错误归类（Anthropic 语义）。
   *
   * 401/403 → auth（换号无意义）；429 → rate_limit（可退避）；529/5xx → upstream（可换档）；
   * 其余 4xx → bad_request（不可重试）。
   */
  classifyError(httpStatus, body, headers) {
    const detail = detailOf(body);
    const retryAfter = retryAfterOf3(body, headers);
    const suffix = detail === "" ? "" : ` — ${detail}`;
    if (httpStatus === 401 || httpStatus === 403) {
      return new UpstreamError2("auth", `[anthropic] 鉴权失败(HTTP ${httpStatus})${suffix}`, false, httpStatus);
    }
    if (httpStatus === 429) {
      return new UpstreamError2("rate_limit", `[anthropic] 上游限流(HTTP 429)${suffix}`, true, 429, retryAfter);
    }
    if (httpStatus >= 500) {
      return new UpstreamError2("upstream", `[anthropic] 上游错误(HTTP ${httpStatus})${suffix}`, true, httpStatus, retryAfter);
    }
    if (httpStatus >= 400) {
      return new UpstreamError2("bad_request", `[anthropic] 请求被拒(HTTP ${httpStatus})${suffix}`, false, httpStatus);
    }
    return new UpstreamError2("upstream", `[anthropic] 意外的 HTTP ${httpStatus}`, true, httpStatus);
  }
};

// core/connectors/qoder-cosy.ts
import {
  createCipheriv as createCipheriv3,
  createDecipheriv as createDecipheriv2,
  createHash as createHash8,
  privateDecrypt,
  publicEncrypt as publicEncrypt2,
  randomBytes as randomBytes5,
  randomUUID as randomUUID2
} from "node:crypto";
var CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
var STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var CUSTOM_PAD = "$";
var s2c = /* @__PURE__ */ new Map();
var c2s = /* @__PURE__ */ new Map();
for (let i = 0; i < 64; i += 1) {
  s2c.set(STD_ALPHABET[i], CUSTOM_ALPHABET[i]);
  c2s.set(CUSTOM_ALPHABET[i], STD_ALPHABET[i]);
}
s2c.set("=", CUSTOM_PAD);
c2s.set(CUSTOM_PAD, "=");
function cosyEncode(plaintext) {
  const std = Buffer.from(plaintext).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = "";
  for (const ch of rearranged) {
    const mapped = s2c.get(ch);
    if (mapped === void 0) throw new Error(`cosy encode: char out of alphabet: ${ch}`);
    out += mapped;
  }
  return out;
}
function md5Hex2(input) {
  return createHash8("md5").update(input, "utf8").digest("hex");
}
function sha512Base64Url(input) {
  return createHash8("sha512").update(input, "utf8").digest("base64url");
}
function currentRfc1123Date(now = /* @__PURE__ */ new Date()) {
  return now.toUTCString();
}
var COSY_APPCODE = "cosy";
var COSY_SECRET_B64 = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
var COSY_VERSION = "0.1.43";
function signLegacy(date) {
  return md5Hex2(`${COSY_APPCODE}&${COSY_SECRET_B64}&${date}`);
}
var SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
function aesCbcEncrypt(plain, key) {
  const blockSize = 16;
  const padLen = blockSize - plain.length % blockSize;
  const padded = new Uint8Array(plain.length + padLen);
  padded.set(plain);
  padded.fill(padLen, plain.length);
  const cipher = createCipheriv3("aes-128-cbc", key, key);
  return new Uint8Array(Buffer.concat([cipher.update(padded), cipher.final()]));
}
function rsaEncrypt(plain) {
  const out = publicEncrypt2(
    { key: SERVER_PUBKEY_PEM, padding: 1 },
    Buffer.from(plain)
  );
  return new Uint8Array(out);
}
function identityFromJobToken(jt) {
  const id = String(jt.id ?? jt.aid ?? jt.uid ?? "");
  return {
    name: String(jt.name ?? ""),
    aid: id,
    uid: id,
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: String(jt.userType ?? jt.user_type ?? "personal_standard"),
    security_oauth_token: String(jt.securityOauthToken ?? jt.security_oauth_token ?? ""),
    refresh_token: String(jt.refreshToken ?? jt.refresh_token ?? "")
  };
}
function identityPayload(identity) {
  return {
    name: identity.name,
    aid: identity.aid,
    uid: identity.uid,
    yx_uid: identity.yx_uid,
    organization_id: identity.organization_id,
    organization_name: identity.organization_name,
    user_type: identity.user_type,
    security_oauth_token: identity.security_oauth_token,
    refresh_token: identity.refresh_token
  };
}
function newCosySession(identity, machineId, machineToken, machineType) {
  const tempKey = new Uint8Array(Buffer.from(randomBytes5(16).toString("hex").slice(0, 16), "utf8"));
  const cosyKey = Buffer.from(rsaEncrypt(tempKey)).toString("base64");
  const payload = JSON.stringify(identityPayload(identity));
  const info = Buffer.from(
    aesCbcEncrypt(new Uint8Array(Buffer.from(payload, "utf8")), tempKey)
  ).toString("base64");
  return { tempKey, cosyKey, info, identity, machineId, machineToken, machineType };
}
function buildPayloadB64(info, requestId = randomUUID2()) {
  const payload = {
    cosyVersion: COSY_VERSION,
    ideVersion: "",
    info,
    requestId,
    version: "v1"
  };
  const sorted = Object.fromEntries(
    Object.entries(payload).sort(([a], [b]) => a < b ? -1 : 1)
  );
  return Buffer.from(JSON.stringify(sorted)).toString("base64");
}
function signRequest(payloadB64, cosyKey, cosyDate, body, pathSig) {
  return md5Hex2(`${payloadB64}
${cosyKey}
${cosyDate}
${body}
${pathSig}`);
}
function composeBearer(payloadB64, sig) {
  return `Bearer COSY.${payloadB64}.${sig}`;
}
function pathSigFrom(fullUrl) {
  let path;
  try {
    path = new URL(fullUrl).pathname;
  } catch {
    path = fullUrl;
  }
  return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}
function cosyDateOf(nowMs = Date.now()) {
  return String(Math.floor(nowMs / 1e3));
}
var MAX_MACHINE_TYPE_LEN = 18;
var MAX_MACHINE_TOKEN_LEN = 43;
function saltedSeed(seed, installSalt) {
  return installSalt ? `${seed}|salt:${installSalt}` : seed;
}
function deriveId(seed, salt, installSalt) {
  return md5Hex2(`${salt}:${saltedSeed(seed, installSalt)}`);
}
function deriveFingerprint(uid, credential, installSalt) {
  const seed = uid !== "" ? uid : `cred:${credential}`;
  return {
    machineId: deriveId(seed, "machine", installSalt),
    machineType: deriveId(seed, "machinetype", installSalt).slice(0, MAX_MACHINE_TYPE_LEN),
    machineToken: sha512Base64Url(`machinetoken:${saltedSeed(seed, installSalt)}`).slice(
      0,
      MAX_MACHINE_TOKEN_LEN
    )
  };
}

// core/connectors/qoder-wire.ts
var QODER_REGIONS = ["qoder"];
function isQoderRegion(v) {
  return v === "qoder";
}
var QODER_CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentMode=prompt_enhancer&Encode=1";
var MODELS_PATH = "/algo/api/v2/model/list?Encode=1";
var JOB_TOKEN_PATH = "/algo/api/v3/user/jobToken?Encode=1";
var CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
var QODER_REGION_CONFIGS = {
  qoder: {
    region: "qoder",
    label: "Qoder（国内）",
    gateway: "https://gateway.qoder.com.cn",
    openapi: "https://openapi.qoder.com.cn",
    chatPath: QODER_CHAT_PATH,
    modelsPath: MODELS_PATH,
    jobTokenPath: JOB_TOKEN_PATH,
    campaignsPath: CAMPAIGNS_PATH,
    requiresDeviceRisk: false
  }
};
var COSY_CLIENT_TYPE = "10";
var SASH_CLIENT_TYPE = "10";
var SASH_USER_AGENT = "Qoder";
var QODER_DEFAULT_HEADERS = {
  "cosy-data-policy": "agree",
  "content-type": "application/json",
  "cosy-clienttype": COSY_CLIENT_TYPE,
  "login-version": "v2",
  "user-agent": "Go-http-client/2.0",
  "cosy-scene": "assistant",
  "cosy-business-product": "ide",
  "cosy-business-type": "agent"
};
function jobTokenBody(credential) {
  const isRefresh = credential.startsWith("drt-");
  const inner = {
    personalToken: isRefresh ? "" : credential,
    securityOauthToken: "",
    refreshToken: isRefresh ? credential : "",
    needRefresh: isRefresh,
    authInfo: {}
  };
  const outer = { payload: JSON.stringify(inner), encodeVersion: "1" };
  return cosyEncode(new TextEncoder().encode(JSON.stringify(outer)));
}
var QUOTA_CODES = /* @__PURE__ */ new Set(["110", "111", "112", "144", "147"]);
var CONTENT_POLICY_MARKERS = [
  "DataInspectionFailed",
  "inappropriate content",
  "content_policy",
  "content policy"
];
function isContentPolicy(detail) {
  const lower = detail.toLowerCase();
  return CONTENT_POLICY_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}
function classifyHttpStatus(status, detail = "") {
  if (isContentPolicy(detail)) return "content-policy";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limited";
  if (status === 400) return "invalid-request";
  if (status === 418 || status >= 500) return "transient";
  return "unknown";
}
function businessCodeOf2(detail) {
  const trimmed = detail.trim();
  if (!trimmed.startsWith("{")) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null) return void 0;
  const raw = parsed["code"];
  if (typeof raw === "string" && raw !== "") return raw;
  if (typeof raw === "number" && Number.isInteger(raw)) return String(raw);
  return void 0;
}
var MAX_CODE_NESTING = 6;
var STATUS_ECHO_CODES = /* @__PURE__ */ new Set([
  "400",
  "401",
  "403",
  "404",
  "408",
  "409",
  "418",
  "422",
  "429",
  "500",
  "502",
  "503",
  "504"
]);
function deepestBusinessCode(detail, depth = 0) {
  const code = businessCodeOf2(detail);
  if (code !== void 0 && !STATUS_ECHO_CODES.has(code)) return code;
  if (depth >= MAX_CODE_NESTING) return code;
  let parsed;
  try {
    parsed = JSON.parse(detail.trim());
  } catch {
    return code;
  }
  if (typeof parsed !== "object" || parsed === null) return code;
  const message = parsed["message"];
  if (typeof message !== "string") return code;
  return deepestBusinessCode(message, depth + 1) ?? code;
}
function classifyBusinessCode(code) {
  if (code === void 0) return void 0;
  if (QUOTA_CODES.has(code)) return "quota-exhausted";
  if (code === "10605") return "rate-limited";
  return void 0;
}
function classifyFailure(status, detail) {
  if (isContentPolicy(detail)) return "content-policy";
  return classifyBusinessCode(deepestBusinessCode(detail)) ?? classifyHttpStatus(status, detail);
}
function retryAfterMsOf(detail, depth = 0) {
  const trimmed = detail.trim();
  if (!trimmed.startsWith("{")) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null) return void 0;
  const rec = parsed;
  const seconds = rec["retryAfterSeconds"];
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1e3);
  }
  if (depth >= MAX_CODE_NESTING) return void 0;
  const message = rec["message"];
  return typeof message === "string" ? retryAfterMsOf(message, depth + 1) : void 0;
}
function retryAfterMsOfHeader(value, nowMs = Date.now()) {
  if (value === null || value.trim() === "") return void 0;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1e3);
  const at = Date.parse(value);
  return Number.isNaN(at) ? void 0 : Math.max(0, at - nowMs);
}
function sseDataPayload(line) {
  if (!line.startsWith("data:")) return void 0;
  const payload = line.slice("data:".length).trim();
  if (payload === "" || payload === "[DONE]") return void 0;
  return payload;
}
function parseQoderFrame(payload) {
  let outer;
  try {
    outer = JSON.parse(payload);
  } catch {
    return void 0;
  }
  if (typeof outer !== "object" || outer === null) return void 0;
  const rec = outer;
  const statusRaw = rec["statusCodeValue"] ?? rec["statusCode"];
  const statusCode = typeof statusRaw === "number" ? statusRaw : 200;
  const body = rec["body"];
  if (typeof body === "string" && body.trim() !== "") {
    try {
      const inner = JSON.parse(body);
      if (typeof inner === "object" && inner !== null) {
        return { inner, statusCode, raw: payload };
      }
    } catch {
      return { inner: { __raw: body }, statusCode, raw: payload };
    }
    return void 0;
  }
  return { inner: rec, statusCode, raw: payload };
}
function qoderErrorFrameOf(inner, raw) {
  const failed = inner["success"] === false;
  const codeRaw = inner["msgCode"] ?? inner["code"] ?? inner["statusCode"];
  const code = typeof codeRaw === "number" && Number.isFinite(codeRaw) ? codeRaw : void 0;
  const hasChoices = Array.isArray(inner["choices"]) && inner["choices"].length > 0;
  if (!failed && (code === void 0 || hasChoices)) return void 0;
  const message = typeof inner["message"] === "string" ? inner["message"] : typeof inner["msgInfo"] === "string" ? inner["msgInfo"] : "";
  return {
    status: code !== void 0 && code >= 400 ? code : 500,
    detail: message !== "" ? `${message} | ${raw}` : raw
  };
}
function qoderErrorBlockOf(text) {
  let status;
  let message = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : line;
    if (!payload.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const frame = qoderErrorFrameOf(parsed, payload);
    if (frame === void 0) continue;
    status = frame.status;
    if (message === "" || /msgInfo|message/.test(payload)) {
      message = frame.detail.split(" | ")[0] ?? "";
    }
  }
  return {
    status: status !== void 0 && status >= 400 ? status : 500,
    detail: message !== "" ? `${message} | ${text}` : text
  };
}
function readCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function parseCachedTokens(usage) {
  const details = usage["prompt_tokens_details"];
  if (typeof details === "object" && details !== null) {
    const fromDetails = readCount(details["cached_tokens"]);
    if (fromDetails !== void 0) return fromDetails;
  }
  return readCount(usage["prompt_cache_hit_tokens"]) ?? readCount(usage["cached_tokens"]);
}
function parseStreamDelta(inner) {
  const choices = inner["choices"];
  const first = Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object" && choices[0] !== null ? choices[0] : void 0;
  const delta = first?.["delta"];
  const message = first?.["message"];
  const source = delta ?? message ?? {};
  const content = typeof source["content"] === "string" ? source["content"] : "";
  const reasoning = typeof source["reasoning_content"] === "string" ? source["reasoning_content"] : typeof source["reasoning"] === "string" ? source["reasoning"] : "";
  const toolCalls = Array.isArray(source["tool_calls"]) ? source["tool_calls"] : Array.isArray(inner["tool_calls"]) ? inner["tool_calls"] : void 0;
  const usage = inner["usage"];
  const usageRec = typeof usage === "object" && usage !== null ? usage : void 0;
  const finishRaw = first?.["finish_reason"];
  return {
    content,
    reasoning,
    toolCalls,
    finishReason: typeof finishRaw === "string" && finishRaw !== "" ? finishRaw : void 0,
    inputTokens: usageRec ? readCount(usageRec["prompt_tokens"]) : void 0,
    outputTokens: usageRec ? readCount(usageRec["completion_tokens"]) : void 0,
    cachedTokens: usageRec ? parseCachedTokens(usageRec) : void 0
  };
}
function pickList(payload, keys) {
  for (const key of keys) {
    const v = payload[key];
    if (Array.isArray(v)) return v;
  }
  const data = payload["data"];
  if (typeof data === "object" && data !== null) return pickList(data, keys);
  return [];
}
function maxContextOf(rec) {
  const cfg = rec["context_config"];
  if (typeof cfg !== "object" || cfg === null) return void 0;
  let max;
  for (const value of Object.values(cfg)) {
    if (typeof value !== "object" || value === null) continue;
    const count = value["token_count"];
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
    if (max === void 0 || count > max) max = count;
  }
  return max;
}
function parseModelCatalog(payload) {
  const rows = pickList(payload, ["models", "chat", "model_list"]);
  const out = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row;
    const key = typeof rec["key"] === "string" ? rec["key"] : "";
    if (key === "") continue;
    const displayName = typeof rec["display_name"] === "string" && rec["display_name"] !== "" ? rec["display_name"] : typeof rec["name"] === "string" && rec["name"] !== "" ? rec["name"] : key;
    out.push({
      key,
      displayName,
      enable: rec["enable"] !== false,
      isDefault: rec["is_default"] === true,
      isVl: rec["is_vl"] === true,
      isReasoning: rec["is_reasoning"] === true,
      isFree: rec["is_free"] === true,
      priceFactor: typeof rec["price_factor"] === "number" ? rec["price_factor"] : void 0,
      maxInputTokens: typeof rec["max_input_tokens"] === "number" ? rec["max_input_tokens"] : void 0,
      maxContextTokens: maxContextOf(rec),
      maxOutputTokens: typeof rec["max_output_tokens"] === "number" ? rec["max_output_tokens"] : void 0,
      raw: rec
    });
  }
  return out;
}
function numOrUndefined(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
function epochSecondsOf(v) {
  const n = numOrUndefined(v);
  if (n === void 0) return void 0;
  return n >= 1e11 ? Math.floor(n / 1e3) : n;
}
function readBucket(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const v = value;
  return {
    total: numOrUndefined(v["total"]),
    used: numOrUndefined(v["used"]),
    remaining: numOrUndefined(v["remaining"]),
    percentage: numOrUndefined(v["percentage"])
  };
}
function parseUsage(payload) {
  const nested = payload["qoderUsage"];
  const source = typeof nested === "object" && nested !== null ? nested : payload;
  const userQuota = readBucket(source["userQuota"]);
  const addOnRaw = source["addOnQuota"];
  const addOn = readBucket(addOnRaw);
  const orgRaw = source["orgResourcePackage"];
  const org = typeof orgRaw === "object" && orgRaw !== null ? orgRaw : void 0;
  const expRaw = source["expiresAt"];
  return {
    userType: typeof source["userType"] === "string" ? source["userType"] : void 0,
    expiresAt: epochSecondsOf(expRaw),
    upgradeUrl: typeof source["upgradeUrl"] === "string" ? source["upgradeUrl"] : void 0,
    userQuota,
    addOnQuota: addOn === void 0 ? void 0 : {
      ...addOn,
      detailUrl: typeof addOnRaw["detailUrl"] === "string" ? String(addOnRaw["detailUrl"]) : void 0
    },
    orgResourcePackage: org === void 0 ? void 0 : {
      used: numOrUndefined(org["used"]),
      cap: numOrUndefined(org["cap"]),
      remaining: numOrUndefined(org["remaining"]),
      percentage: numOrUndefined(org["percentage"]),
      available: org["available"] === true
    },
    isQuotaExceeded: source["isQuotaExceeded"] === true
  };
}
function projectCampaignEntry(entry) {
  if (typeof entry !== "object" || entry === null) return void 0;
  const raw = entry;
  const campaignId = typeof raw["campaignId"] === "string" ? raw["campaignId"] : "";
  if (campaignId === "") return void 0;
  const benefit = typeof raw["benefit"] === "object" && raw["benefit"] !== null ? raw["benefit"] : {};
  const validity = typeof benefit["validity"] === "object" && benefit["validity"] !== null ? benefit["validity"] : {};
  const placements = Array.isArray(raw["placements"]) ? raw["placements"] : [];
  let campaignUrl;
  const content = {};
  for (const p of placements) {
    if (typeof p !== "object" || p === null) continue;
    const slot = p;
    if (campaignUrl === void 0 && typeof slot["campaignUrl"] === "string") {
      campaignUrl = slot["campaignUrl"];
    }
    const slotContent = slot["content"];
    if (typeof slotContent !== "object" || slotContent === null) continue;
    for (const [lang, text] of Object.entries(slotContent)) {
      if (typeof text !== "object" || text === null) continue;
      const t = text;
      const row = {
        ...typeof t["title"] === "string" ? { title: t["title"] } : {},
        ...typeof t["description"] === "string" ? { description: t["description"] } : {},
        ...typeof t["detailUrl"] === "string" ? { detailUrl: t["detailUrl"] } : {},
        ...typeof t["buttonText"] === "string" ? { buttonText: t["buttonText"] } : {}
      };
      const prior = content[lang];
      if (prior === void 0 || Object.keys(prior).length === 0 && Object.keys(row).length > 0) {
        content[lang] = row;
      }
    }
  }
  return {
    campaignId,
    campaignKey: typeof raw["campaignKey"] === "string" ? raw["campaignKey"] : void 0,
    actionType: typeof raw["actionType"] === "string" ? raw["actionType"] : "",
    claimStatus: typeof raw["claimStatus"] === "string" ? raw["claimStatus"] : "",
    amount: numOrUndefined(benefit["amount"]),
    validityDays: numOrUndefined(validity["days"]),
    startAt: numOrUndefined(raw["startAt"]),
    endAt: numOrUndefined(raw["endAt"]),
    campaignUrl,
    content
  };
}
function parseCampaignFeed(payload) {
  const data = typeof payload["data"] === "object" && payload["data"] !== null ? payload["data"] : payload;
  const rows = Array.isArray(data["campaigns"]) ? data["campaigns"] : [];
  return {
    campaigns: rows.map((entry) => projectCampaignEntry(entry)).filter((c) => c !== void 0),
    claimable: typeof data["claimable"] === "boolean" ? data["claimable"] : void 0,
    showCampaign: typeof data["showCampaign"] === "boolean" ? data["showCampaign"] : void 0,
    campaignUrl: typeof data["campaignUrl"] === "string" ? data["campaignUrl"] : void 0
  };
}
function isQoderClaimedStatus(status) {
  const v = String(status ?? "").toUpperCase();
  return v === "CLAIMED" || v === "ALREADY_CLAIMED" || v === "ALREADY" || v === "REPLAYED";
}
function createChatBodyTemplate() {
  return {
    request_id: "",
    request_set_id: "",
    chat_record_id: "",
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      extra: {
        modelConfig: { is_reasoning: false, key: "lite" },
        originalContent: { type: "text", text: "" }
      },
      text: { type: "text", text: "" }
    },
    session_id: "",
    source: 1,
    version: "3",
    aliyun_user_type: "personal_standard",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    model_config: { key: "lite", is_vl: false, is_reasoning: false, source: "system" },
    messages: [],
    business: { id: "", name: "hi", begin_at: 0 }
  };
}
function applyModelKey(template, modelKey, userType, isVl) {
  template.model_config.key = modelKey;
  template.model_config.is_vl = isVl;
  template.chat_context.extra.modelConfig.key = modelKey;
  template.aliyun_user_type = userType !== "" ? userType : "personal_standard";
}
function blankResponseMeta() {
  return {
    id: "",
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 }
    }
  };
}
function structuredMessage(role, text) {
  return { role, content: text, response_meta: blankResponseMeta(), reasoning_content_signature: "" };
}
function normalizeMessageText(message) {
  const content = message["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (typeof part === "object" && part !== null) {
        const rec = part;
        if (typeof rec["text"] === "string") parts.push(rec["text"]);
        else if (typeof rec["value"] === "string") parts.push(rec["value"]);
      }
    }
    return parts.join("");
  }
  return "";
}
function extractMessageImages(message) {
  if (message["role"] !== "user") return [];
  const content = message["content"];
  if (!Array.isArray(content)) return [];
  const urls = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const iu = part["image_url"];
    if (typeof iu === "object" && iu !== null) {
      const url = iu["url"];
      if (typeof url === "string") urls.push(url);
    }
  }
  return urls;
}
function extractLatestUserPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m["role"] === "user") {
      const text = normalizeMessageText(m);
      if (text.trim() !== "") return text;
    }
  }
  return "";
}
function buildQoderMessages(messages) {
  const out = [];
  for (const message of messages) {
    const role = typeof message["role"] === "string" ? message["role"] : "user";
    if (role === "user") {
      const images = extractMessageImages(message);
      const text = normalizeMessageText(message);
      const parts = [];
      for (const url of images) parts.push({ type: "image_url", image_url: { url } });
      if (text.trim() !== "") parts.push({ type: "text", text });
      if (parts.length === 0) parts.push({ type: "text", text: "" });
      out.push({
        role: "user",
        content: "",
        contents: parts,
        response_meta: blankResponseMeta(),
        reasoning_content_signature: ""
      });
      continue;
    }
    if (role === "tool") {
      const row = structuredMessage("tool", normalizeMessageText(message));
      if (typeof message["name"] === "string") row["name"] = message["name"];
      if (typeof message["tool_call_id"] === "string") row["tool_call_id"] = message["tool_call_id"];
      out.push(row);
      continue;
    }
    if (role === "assistant") {
      const row = structuredMessage("assistant", normalizeMessageText(message));
      if (Array.isArray(message["tool_calls"])) row["tool_calls"] = message["tool_calls"];
      out.push(row);
      continue;
    }
    out.push(structuredMessage(role, normalizeMessageText(message)));
  }
  return out;
}

// core/connectors/qoder.ts
function parseJobToken(payload) {
  const data = typeof payload["data"] === "object" && payload["data"] !== null ? payload["data"] : payload;
  const str2 = (key) => typeof data[key] === "string" ? String(data[key]) : "";
  return {
    id: str2("id") !== "" ? str2("id") : str2("uid"),
    name: str2("name"),
    userType: str2("userType") !== "" ? str2("userType") : str2("user_type"),
    expireTime: typeof data["expireTime"] === "number" ? data["expireTime"] : typeof data["expire_time"] === "number" ? data["expire_time"] : void 0,
    securityOauthToken: str2("securityOauthToken") !== "" ? str2("securityOauthToken") : str2("security_oauth_token"),
    refreshToken: str2("refreshToken") !== "" ? str2("refreshToken") : str2("refresh_token")
  };
}
function toCoreErrorKind(kind) {
  switch (kind) {
    case "auth":
      return { kind: "auth", retryable: false };
    case "rate-limited":
      return { kind: "rate_limit", retryable: true };
    case "quota-exhausted":
      return { kind: "pool_exhausted", retryable: false };
    case "invalid-request":
      return { kind: "bad_request", retryable: false };
    case "content-policy":
      return { kind: "bad_request", retryable: false };
    case "transient":
      return { kind: "upstream", retryable: true };
    default:
      return { kind: "upstream", retryable: false };
  }
}
var QoderUpstreamError = class extends UpstreamError2 {
  /** Qoder 侧细分分类（`quota-exhausted` 这类核心枚举里没有的）。 */
  qoderKind;
  code;
  constructor(kind, message, status = 0, code, retryAfter, raw) {
    const mapped = toCoreErrorKind(kind);
    super(mapped.kind, message, mapped.retryable, status, retryAfter, raw);
    this.qoderKind = kind;
    this.code = code;
  }
};
var ERROR_RING_SIZE = 8;
var RETRY_AFTER_HINT_MS = 500;
var QoderClient = class {
  region;
  config;
  fetchImpl;
  installSalt;
  logger;
  holders = /* @__PURE__ */ new Map();
  errors = [];
  constructor(region, options = {}) {
    this.region = region;
    this.config = QODER_REGION_CONFIGS[region];
    this.fetchImpl = options.fetch ?? fetch;
    this.installSalt = options.installSalt;
    this.logger = options.logger ?? (() => {
    });
  }
  /** 最近的上游错误（新的在前）。 */
  recentErrors() {
    return [...this.errors];
  }
  record(kind, status, body) {
    this.errors.unshift({
      atMs: Date.now(),
      region: this.region,
      status,
      kind,
      body: body.slice(0, 2048)
    });
    if (this.errors.length > ERROR_RING_SIZE) this.errors.length = ERROR_RING_SIZE;
  }
  /** 凭据 → 会话（按凭证键控；换 PAT 必换会话）。 */
  async ensureSession(credential, signal) {
    const cached = this.holders.get(credential);
    if (cached !== void 0) {
      const remaining = (cached.jobToken.expireTime ?? 0) * 1e3 - Date.now();
      if (cached.jobToken.expireTime === void 0 || remaining > 5 * 60 * 1e3) return cached;
    }
    const jobToken = await this.exchangeJobToken(credential, signal);
    const identity = identityFromJobToken({
      id: jobToken.id,
      name: jobToken.name,
      userType: jobToken.userType,
      securityOauthToken: jobToken.securityOauthToken,
      refreshToken: jobToken.refreshToken
    });
    const fingerprint2 = deriveFingerprint(jobToken.id, credential, this.installSalt);
    const session = newCosySession(
      identity,
      fingerprint2.machineId,
      fingerprint2.machineToken,
      fingerprint2.machineType
    );
    const sashToken = await this.exchangeSashToken(credential, signal).catch(() => jobToken.securityOauthToken);
    const holder = {
      session,
      fingerprint: fingerprint2,
      jobToken,
      sashToken: sashToken !== "" ? sashToken : jobToken.securityOauthToken,
      createdAtMs: Date.now()
    };
    this.holders.set(credential, holder);
    return holder;
  }
  /**
   * `POST {gateway}{jobTokenPath}`：PAT → jobToken。
   *
   * ⚠️ 这里是 **认证面**，不是 cosy 数据面 —— 两者签的不是同一套头。实测
   * （2026-10-30，真 PAT）用数据面那套（`cosy-key` + `authorization: <bearer>`）
   * 换 jobToken 会被上游直接丢弃：
   *
   * `HTTP 403 {"success":false,"errorMessage":"Request discarded","errorCode":"Forbidden"}`
   *
   * 认证面要的是**旧式签名**：`appcode: cosy` + `date: <RFC1123 UTC>` +
   * `signature: md5("cosy&<secret>&<date>")`，再配设备三件套
   * （`cosy-machineid/-token/-type`），且**不带** `authorization` 与 `cosy-key`。
   * 两个独立参考实现（`dingminhua/dsh-connect-qoder` 的 `exchangeJobToken`、
   * `fengyinxia/qoder2api` 的 `jobTokenPost`）都是这套头；`signLegacy()` 与
   * `currentRfc1123Date()` 早就在 `qoder-cosy.ts` 里备好，只是此前没人调。
   */
  async exchangeJobToken(credential, signal) {
    const url = `${this.config.gateway}${this.config.jobTokenPath}`;
    const body = jobTokenBody(credential);
    const fingerprint2 = deriveFingerprint("", credential, this.installSalt);
    const date = currentRfc1123Date();
    const resp = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "cosy-machinetoken": fingerprint2.machineToken,
        "cosy-machinetype": fingerprint2.machineType,
        "login-version": "v2",
        appcode: COSY_APPCODE,
        accept: "application/json",
        "accept-encoding": "identity",
        "cosy-version": "1.1.69",
        "cosy-clienttype": "10",
        date,
        signature: signLegacy(date),
        "content-type": "application/json",
        "cosy-machineid": fingerprint2.machineId,
        "user-agent": "Go-http-client/2.0"
      },
      body,
      ...signal ? { signal } : {}
    });
    const text = await resp.text();
    if (resp.status !== 200) {
      const kind = classifyFailure(resp.status, text);
      this.record(kind, resp.status, text);
      throw new QoderUpstreamError(
        kind,
        `jobToken 交换失败: HTTP ${resp.status} ${text.slice(0, 200)}`,
        resp.status,
        deepestBusinessCode(text),
        retryAfterMsOf(text) ?? retryAfterMsOfHeader(resp.headers.get("retry-after")),
        upstreamRawResponse(resp.status, text)
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new QoderUpstreamError("unknown", `jobToken 响应不是 JSON: ${text.slice(0, 200)}`, resp.status);
    }
    const jt = parseJobToken(parsed);
    if (jt.id === "" && jt.securityOauthToken === "") {
      throw new QoderUpstreamError("auth", `jobToken 交换响应缺少身份字段: ${text.slice(0, 200)}`, resp.status);
    }
    return jt;
  }
  /**
   * `POST {openapi}/api/v1/jobToken/exchange`：换 sash 面令牌（失败回落）。
   *
   * 与 {@link exchangeJobToken} 是**不同的端点、不同的请求头**（2026-10-30 对齐
   * 参考实现 `dingminhua/dsh-connect-qoder`）：
   * - 主机是 `openapi`（sash 面），不是 cosy `gateway`；
   * - body 是 `{ personal_token: <PAT> }` —— 参考实现实测 `personal_access_token`
   *   拼写会回 400 BadRequest；
   * - 只带 `content-type` + `accept`，**不带** Authorization、不带 cosy 协议头。
   *
   * 国内版两族令牌等价，所以这一支失败时回落到 `securityOauthToken` 是安全的；
   * 但它决定「积分/签到能不能读」，故仍按正确形状发，而不是随便带个 Bearer。
   */
  async exchangeSashToken(credential, signal) {
    const url = `${this.config.openapi}/api/v1/jobToken/exchange`;
    const resp = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ personal_token: credential }),
      ...signal ? { signal } : {}
    });
    if (resp.status !== 200 && resp.status !== 201) return "";
    const text = await resp.text();
    try {
      const parsed = JSON.parse(text);
      const data = typeof parsed["data"] === "object" && parsed["data"] !== null ? parsed["data"] : parsed;
      for (const key of ["token", "job_token", "jobToken", "accessToken"]) {
        const v = data[key];
        if (typeof v === "string" && v !== "") return v;
      }
    } catch {
      return "";
    }
    return "";
  }
  /** 签名后的通用请求（GET/POST 都走这条）。 */
  async signedRequest(holder, url, init) {
    const rawBody = init.body === void 0 ? "" : JSON.stringify(init.body);
    const encoded = rawBody === "" ? "" : cosyEncode(new TextEncoder().encode(rawBody));
    const date = cosyDateOf();
    const payloadB64 = buildPayloadB64(holder.session.info);
    const sig = signRequest(payloadB64, holder.session.cosyKey, date, encoded, pathSigFrom(url));
    return this.fetchImpl(url, {
      method: init.method,
      headers: {
        ...QODER_DEFAULT_HEADERS,
        "cosy-machinetype": holder.session.machineType,
        "cosy-date": date,
        "cosy-user": holder.session.identity.uid,
        "cosy-key": holder.session.cosyKey,
        "cosy-machineid": holder.session.machineId,
        "cosy-machinetoken": holder.session.machineToken,
        "cosy-version": "1.1.69",
        authorization: composeBearer(payloadB64, sig),
        ...init.stream ? { accept: "text/event-stream", "cache-control": "no-cache" } : {},
        ...init.modelKey ? { "x-model-key": init.modelKey, "x-model-source": "system" } : {}
      },
      ...encoded === "" ? {} : { body: encoded },
      ...init.signal ? { signal: init.signal } : {}
    });
  }
  /** sash 面请求（`jt-` 令牌 + sash 专有头；国际版带设备风控头）。 */
  async sashRequest(holder, url, init) {
    const token = holder.sashToken !== "" ? holder.sashToken : holder.jobToken.securityOauthToken;
    if (token === "") {
      throw new QoderUpstreamError("auth", "没有可用的 sash 令牌（jobToken 交换未产出）", 401);
    }
    const resp = await this.fetchImpl(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        "cosy-clienttype": SASH_CLIENT_TYPE,
        accept: "application/json",
        "accept-language": "zh-CN",
        "user-agent": SASH_USER_AGENT,
        ...this.config.requiresDeviceRisk ? {
          "cosy-machinetoken": holder.session.machineToken,
          "cosy-machineid": holder.session.machineId,
          "cosy-machinetype": holder.session.machineType
        } : {},
        ...init.method === "POST" ? { "content-type": "application/json", origin: this.config.openapi } : {}
      },
      ...init.method === "POST" ? { body: JSON.stringify(init.body ?? {}) } : {},
      ...init.signal ? { signal: init.signal } : {}
    });
    const text = await resp.text();
    if (resp.status !== 200 && resp.status !== 201) {
      throw this.failFromHttp(resp.status, text, resp.headers.get("retry-after"));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new QoderUpstreamError("unknown", `响应不是 JSON: ${text.slice(0, 200)}`, resp.status);
    }
  }
  failFromHttp(status, text, retryAfterHeader) {
    const kind = classifyFailure(status, text);
    this.record(kind, status, text);
    return new QoderUpstreamError(
      kind,
      `请求失败: HTTP ${status} ${text.slice(0, 200)}`,
      status,
      deepestBusinessCode(text),
      retryAfterMsOf(text) ?? retryAfterMsOfHeader(retryAfterHeader) ?? (kind === "rate-limited" ? RETRY_AFTER_HINT_MS : void 0),
      upstreamRawResponse(status, text)
    );
  }
  // -------------------------------------------------------------------------
  // 数据面
  // -------------------------------------------------------------------------
  /** 模型目录（`/algo/api/v2/model/list`）。 */
  async fetchModels(credential, signal) {
    const holder = await this.ensureSession(credential, signal);
    const url = `${this.config.gateway}${this.config.modelsPath}`;
    const resp = await this.signedRequest(holder, url, { method: "GET", signal });
    const text = await resp.text();
    if (resp.status !== 200) throw this.failFromHttp(resp.status, text, resp.headers.get("retry-after"));
    try {
      return parseModelCatalog(JSON.parse(text));
    } catch {
      throw new QoderUpstreamError("unknown", `模型目录不是 JSON: ${text.slice(0, 200)}`, resp.status);
    }
  }
  /** 用量（`{openapi}/sash/api/v2/me/usage`，需 `jt-` 令牌）。 */
  async fetchUsage(credential, signal) {
    const holder = await this.ensureSession(credential, signal);
    const url = `${this.config.openapi}/sash/api/v2/me/usage`;
    const data = await this.sashRequest(holder, url, { method: "GET", signal });
    return parseUsage(data);
  }
  /** 活动列表（签到活动就在这里面）。 */
  async fetchCampaigns(credential, signal) {
    const holder = await this.ensureSession(credential, signal);
    const url = `${this.config.openapi}${this.config.campaignsPath}?forceRefresh=true`;
    const data = await this.sashRequest(holder, url, { method: "GET", signal });
    return parseCampaignFeed(data).campaigns;
  }
  /**
   * 每日签到：先拉活动找 `CLAIM_BENEFIT` 可领的那条，再领。
   *
   * 三态分清：`claimed` / `already-claimed`（幂等，409 也算）/ `unavailable`。
   * 上游对「重复领取」并不只有一种写法：活动列表里的 `CLAIMED`、领取 409、
   * 领取响应里的 `ALREADY_CLAIMED` / `ALREADY` / `replayed` 都是「今天已经领过」，
   * 不能当成失败，否则用户会以为「点签到没反应」。
   */
  async claimDailyCredits(credential, signal) {
    const campaigns = await this.fetchCampaigns(credential, signal);
    const daily = campaigns.find((c) => c.actionType === "CLAIM_BENEFIT");
    const claimable = campaigns.find((c) => c.actionType === "CLAIM_BENEFIT" && c.claimStatus === "CLAIMABLE");
    const nextRefreshAtMs = daily?.endAt === void 0 ? void 0 : daily.endAt * 1e3;
    if (claimable === void 0) {
      return isQoderClaimedStatus(daily?.claimStatus) ? { status: "already-claimed", nextRefreshAtMs } : { status: "unavailable", message: "上游今日没有下发可领取的签到活动" };
    }
    const holder = await this.ensureSession(credential, signal);
    const url = `${this.config.openapi}${this.config.campaignsPath}/${encodeURIComponent(claimable.campaignId)}/claim`;
    try {
      const data = await this.sashRequest(holder, url, { method: "POST", body: {}, signal });
      const status = String(data["status"] ?? "");
      if (status.toUpperCase() === "CLAIMED") {
        return {
          status: "claimed",
          amount: claimable.amount,
          validityDays: claimable.validityDays,
          nextRefreshAtMs
        };
      }
      if (isQoderClaimedStatus(status)) {
        return { status: "already-claimed", nextRefreshAtMs };
      }
      return { status: "unavailable", message: `签到未完成（上游状态 ${String(data["status"] ?? "未知")}）` };
    } catch (error) {
      if (error instanceof QoderUpstreamError && error.httpStatus === 409) {
        return { status: "already-claimed", nextRefreshAtMs };
      }
      throw error;
    }
  }
  /**
   * 流式 chat。逐帧产出 OpenAI 形状的增量（由调用方包成 SSE 行）。
   *
   * 会话必须已经建好（会按 credential 惰性交换）。
   */
  async *chatStream(credential, request, signal) {
    const holder = await this.ensureSession(credential, signal);
    const template = createChatBodyTemplate();
    const userType = holder.jobToken.userType;
    applyModelKey(template, request.modelKey, userType, request.isVl === true);
    if (request.isReasoning === true) {
      template.model_config.is_reasoning = true;
      template.chat_context.extra.modelConfig.is_reasoning = true;
    }
    if (request.reasoningEffort !== void 0 && request.reasoningEffort !== "") {
      template.reasoningEffort = request.reasoningEffort;
      template.parameters = { ...template.parameters ?? {}, reasoning_effort: request.reasoningEffort };
    }
    const prompt = extractLatestUserPrompt(request.messages);
    template.messages = buildQoderMessages(request.messages);
    if (request.tools !== void 0 && request.tools.length > 0) template.tools = request.tools;
    const requestId = request.requestId ?? cryptoRandomId();
    template.request_id = requestId;
    template.chat_record_id = requestId;
    template.request_set_id = cryptoRandomId();
    template.session_id = cryptoRandomId();
    template.business.id = cryptoRandomId();
    template.business.name = prompt.slice(0, 30) || "hi";
    template.business.begin_at = Date.now();
    const url = `${this.config.gateway}${this.config.chatPath}`;
    const resp = await this.signedRequest(holder, url, {
      method: "POST",
      body: template,
      signal,
      modelKey: request.modelKey,
      stream: true
    });
    if (resp.status !== 200) {
      const text = await resp.text();
      throw this.failFromHttp(resp.status, text, resp.headers.get("retry-after"));
    }
    if (resp.body === null) {
      throw new QoderUpstreamError("unknown", "聊天响应没有 body", resp.status);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let frameEvent = "";
    let errorBlock = null;
    const flushErrorBlock = () => {
      if (errorBlock === null) return;
      const text = errorBlock.join("\n");
      errorBlock = null;
      if (text.trim() === "") return;
      const failure = qoderErrorBlockOf(text);
      this.record("transient", failure.status, text);
      throw new QoderUpstreamError(
        "transient",
        `上游错误帧: ${failure.detail.slice(0, 300)}`,
        failure.status,
        deepestBusinessCode(text),
        void 0,
        upstreamRawResponse(failure.status, text)
      );
    };
    for await (const raw of resp.body) {
      buffer += decoder.decode(raw, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.startsWith("event:")) {
          flushErrorBlock();
          frameEvent = line.slice("event:".length).trim();
          errorBlock = frameEvent === "error" ? [] : null;
          index = buffer.indexOf("\n");
          continue;
        }
        if (errorBlock !== null && line.trim() !== "") {
          errorBlock.push(line);
          index = buffer.indexOf("\n");
          continue;
        }
        const payload = sseDataPayload(line);
        if (payload !== void 0) {
          const chunk = this.translateFrame(payload, frameEvent, requestId, request.modelKey);
          frameEvent = "";
          if (chunk !== void 0) yield chunk;
        } else if (line.trim() === "") {
          flushErrorBlock();
          frameEvent = "";
        }
        index = buffer.indexOf("\n");
      }
    }
    if (buffer.trim() !== "") {
      const leftover = buffer.replace(/\r$/, "");
      if (errorBlock !== null) {
        errorBlock.push(leftover);
      } else {
        const payload = sseDataPayload(leftover);
        if (payload !== void 0) {
          const chunk = this.translateFrame(payload, frameEvent, requestId, request.modelKey);
          if (chunk !== void 0) yield chunk;
        }
      }
    }
    flushErrorBlock();
  }
  /** 一帧 → 增量（错误帧抛 {@link QoderUpstreamError}，带原文）。 */
  translateFrame(payload, eventName, requestId, modelKey) {
    const frame = parseQoderFrame(payload);
    if (frame === void 0) return void 0;
    if (frame.statusCode !== 200) {
      const kind = classifyFailure(frame.statusCode, frame.raw);
      this.record(kind, frame.statusCode, frame.raw);
      throw new QoderUpstreamError(
        kind,
        `流内错误帧: HTTP ${frame.statusCode} ${frame.raw.slice(0, 300)}`,
        frame.statusCode,
        deepestBusinessCode(frame.raw),
        void 0,
        upstreamRawResponse(frame.statusCode, frame.raw)
      );
    }
    const failure = qoderErrorFrameOf(frame.inner, frame.raw);
    if (failure !== void 0) {
      const kinds = classifyFailure(failure.status, frame.raw);
      this.record(kinds, failure.status, frame.raw);
      const kind = eventName === "error" ? "transient" : kinds;
      throw new QoderUpstreamError(
        kind,
        `上游错误帧: ${failure.detail.slice(0, 300)}`,
        failure.status,
        deepestBusinessCode(frame.raw),
        void 0,
        upstreamRawResponse(failure.status, frame.raw)
      );
    }
    const delta = parseStreamDelta(frame.inner);
    const text = /\{"code"/.test(payload) && delta.content === "" && delta.reasoning === "" ? payload : void 0;
    if (text !== void 0 && deepestBusinessCode(payload) !== void 0) {
      const kind = classifyFailure(frame.statusCode, payload);
      this.record(kind, frame.statusCode, payload);
      throw new QoderUpstreamError(
        kind,
        `流内业务错误: ${payload.slice(0, 300)}`,
        frame.statusCode,
        deepestBusinessCode(payload),
        void 0,
        upstreamRawResponse(frame.statusCode, payload)
      );
    }
    return {
      id: requestId,
      created: Math.floor(Date.now() / 1e3),
      model: modelKey,
      content: delta.content,
      reasoning: delta.reasoning,
      toolCalls: delta.toolCalls,
      finishReason: delta.finishReason,
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cachedTokens: delta.cachedTokens
    };
  }
};
function cryptoRandomId() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
var clients = /* @__PURE__ */ new Map();
function getQoderClient(region, options = {}) {
  const existing = clients.get(region);
  if (existing !== void 0) return existing;
  const created = new QoderClient(region, options);
  clients.set(region, created);
  return created;
}
var QoderAdapter = class {
  vendorId;
  region;
  constructor(region = "qoder") {
    this.region = region;
    this.vendorId = region;
  }
  credentialOf(creds) {
    const pat = typeof creds.apiKey === "string" ? creds.apiKey.trim() : "";
    if (pat !== "") return pat;
    const refresh = typeof creds.refreshToken === "string" ? creds.refreshToken.trim() : "";
    return refresh;
  }
  async getToken(creds) {
    const credential = this.credentialOf(creds);
    if (credential === "") {
      throw new QoderUpstreamError("auth", "Qoder 凭据为空：需要 PAT（pt-…）", 401);
    }
    const client = getQoderClient(this.region);
    const probe = await client.fetchModels(credential).catch((error) => {
      if (error instanceof QoderUpstreamError) throw error;
      throw new QoderUpstreamError("unknown", String(error), 0);
    });
    const expiresAt = Math.floor(Date.now() / 1e3) + 3600;
    void probe;
    return { accessToken: `qoder:${this.region}`, expiresAt };
  }
  decorateRequest(base, _token, _creds) {
    return {
      headers: { ...base.headers ?? {}, ...QODER_DEFAULT_HEADERS, "cosy-version": "1.1.69" },
      ...base.query === void 0 ? {} : { query: base.query }
    };
  }
  classifyError(httpStatus, body, headers) {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
    const kind = classifyFailure(httpStatus, text);
    const retryHeader = headers?.["retry-after"];
    const retryValue = Array.isArray(retryHeader) ? retryHeader[0] : retryHeader;
    const retryAfter = retryAfterMsOf(text) ?? retryAfterMsOfHeader(retryValue ?? null) ?? void 0;
    void classifyHttpStatus;
    return new QoderUpstreamError(
      kind,
      `Qoder 上游错误: HTTP ${httpStatus} ${text.slice(0, 200)}`,
      httpStatus,
      deepestBusinessCode(text),
      retryAfter,
      upstreamRawResponse(httpStatus, text)
    );
  }
  /**
   * 网关侧「打一次上游」的出口 —— 形状对齐 `SensenovaAdapter.runWithAccount`。
   *
   * 为什么不是普通 fetch：
   * - Qoder 的请求体是**固定模板 + 签名**，签名覆盖 body，所以必须由本类
   *   自己组包（网关那层只给 OpenAI 形状的 body）；
   * - 上游回的是 cosy 信封帧（`{statusCodeValue, body}` 双层 JSON），要在这里
   *   翻译成 OpenAI chunk 流，网关的 `iterUpstreamChunks` 才能按 openai 口径解析。
   *
   * 返回的 `res` 是**本地合成的 SSE Response**（不是上游原始响应）：上层
   * 照常 `iterUpstreamChunks(res.body, "openai", …)` 消费，错误分类也照常
   * 走 `classifyResponse`（本方法非 200 时抛 `QoderUpstreamError`）。
   */
  async runWithAccount(_url, body, model, creds, signal) {
    const pat = typeof creds.apiKey === "string" ? creds.apiKey.trim() : "";
    const account = typeof creds.username === "string" ? creds.username : model;
    if (pat === "") {
      throw new QoderUpstreamError("auth", "Qoder 账号缺少 PAT（pt-…）", 401);
    }
    const region = regionOfCreds(creds, this.region);
    const client = getQoderClient(region);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : void 0;
    const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : void 0;
    const request = {
      modelKey: model,
      messages,
      ...tools === void 0 ? {} : { tools },
      ...creds.is_vl === true ? { isVl: true } : {},
      ...creds.is_reasoning === true ? { isReasoning: true } : {},
      ...effort === void 0 || effort === "" ? {} : { reasoningEffort: effort }
    };
    const completionId = `qoder-${cryptoRandomId()}`;
    const created = Math.floor(Date.now() / 1e3);
    const source = client.chatStream(pat, request, signal);
    const encoder = new TextEncoder();
    let usage = null;
    const line = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}

`);
    const first = await source.next();
    const emit = (controller, chunk) => {
      const delta = {};
      if (chunk.content !== "") delta.content = chunk.content;
      if (chunk.reasoning !== "") delta.reasoning_content = chunk.reasoning;
      if (chunk.toolCalls !== void 0 && chunk.toolCalls.length > 0) delta.tool_calls = chunk.toolCalls;
      controller.enqueue(
        line({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: chunk.finishReason ?? null
            }
          ]
        })
      );
      if (chunk.inputTokens !== void 0 || chunk.outputTokens !== void 0) {
        const prev = usage ?? {};
        const prompt = chunk.inputTokens ?? prev.prompt_tokens;
        const completion = chunk.outputTokens ?? prev.completion_tokens;
        const next = { ...prev };
        if (prompt !== void 0) next.prompt_tokens = prompt;
        if (completion !== void 0) next.completion_tokens = completion;
        if (prompt !== void 0 && completion !== void 0) next.total_tokens = prompt + completion;
        if (chunk.cachedTokens !== void 0) {
          next.prompt_tokens_details = { cached_tokens: chunk.cachedTokens };
        }
        usage = next;
      }
    };
    const stream = new ReadableStream({
      async start(controller) {
        try {
          if (!first.done) emit(controller, first.value);
          for await (const chunk of source) {
            emit(controller, chunk);
          }
          if (usage !== null) {
            controller.enqueue(line({ id: completionId, created, model, choices: [], usage }));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          controller.enqueue(encoder.encode(`: qoder-error ${text.replace(/\n/g, " ").slice(0, 400)}

`));
          controller.close();
        }
      },
      cancel() {
        void source.return(void 0);
      }
    });
    return {
      res: new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" }
      }),
      runtime: { name: account, region }
    };
  }
  /** 记账出口（Qoder 没有 TPM/RPM 池，保留形状供网关统一调用）。 */
  recordSpendFor(_username, _usage, _ttftMs) {
  }
};
function regionOfCreds(_creds, _fallback) {
  return "qoder";
}
var QODER_ADAPTERS = [new QoderAdapter("qoder")];

// core/connectors/minimax-models.ts
var MINIMAX_MODELS = [
  {
    id: "minimax-agent",
    name: "MiniMax Agent",
    upstreamModel: "MiniMax-M3.1-Flash",
    context: 1048576,
    output: null,
    vision: true,
    reasoning: "switchable"
  },
  {
    id: "minimax-m3.1-flash",
    name: "MiniMax M3.1 Flash",
    upstreamModel: "MiniMax-M3.1-Flash",
    context: 1048576,
    output: null,
    vision: true,
    reasoning: "switchable"
  },
  {
    id: "minimax-m3.1-flash-thinking",
    name: "MiniMax M3.1 Flash Thinking",
    upstreamModel: "MiniMax-M3.1-Flash",
    context: 1048576,
    output: null,
    vision: true,
    reasoning: "forced"
  },
  {
    id: "minimax-m3",
    name: "MiniMax M3",
    upstreamModel: "MiniMax-M3",
    context: 1048576,
    output: null,
    vision: true,
    reasoning: "switchable"
  },
  {
    id: "minimax-m3-thinking",
    name: "MiniMax M3 Thinking",
    upstreamModel: "MiniMax-M3",
    context: 1048576,
    output: null,
    vision: true,
    reasoning: "forced"
  },
  {
    id: "minimax-image",
    name: "MiniMax Image",
    upstreamModel: "",
    context: null,
    output: null,
    vision: true,
    reasoning: "none"
  }
];
function minimaxModelOf(localId) {
  const key = String(localId ?? "").trim().toLowerCase();
  if (key === "") return null;
  return MINIMAX_MODELS.find((m) => m.id === key) ?? null;
}
function minimaxUpstreamModelOf(localId) {
  const spec = minimaxModelOf(localId);
  if (spec !== null && spec.upstreamModel !== "") return spec.upstreamModel;
  return String(localId ?? "").trim();
}

// core/wire/anthropic.ts
var DEFAULT_ANTHROPIC_QUIRKS = {
  effortField: "output_config",
  requiresSignature: false,
  systemShape: "string",
  streamOnly: true,
  maxTokensDefault: 4096
};
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const p = part;
    if (p["type"] === "text" && typeof p["text"] === "string") parts.push(p["text"]);
  }
  return parts.join("\n");
}
function toolChoiceOf(choice) {
  if (choice === null || choice === void 0 || choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return null;
  if (typeof choice === "object") {
    const fn = choice["function"];
    const name = fn !== null && typeof fn === "object" ? fn["name"] : void 0;
    if (typeof name === "string" && name !== "") return { type: "tool", name };
  }
  return { type: "auto" };
}
function toolsOf(tools) {
  const out = [];
  if (!Array.isArray(tools)) return out;
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object") continue;
    const t = tool;
    const fn = t["type"] === "function" && t["function"] !== null && typeof t["function"] === "object" ? t["function"] : t;
    const name = fn["name"];
    if (typeof name !== "string" || name === "") continue;
    const schema = fn["parameters"];
    out.push({
      name,
      description: typeof fn["description"] === "string" ? fn["description"] : "",
      input_schema: schema !== null && typeof schema === "object" && !Array.isArray(schema) ? schema : { type: "object", properties: {} }
    });
  }
  return out;
}
function messageOf(item, quirks) {
  const role = item["role"];
  if (role === "assistant") {
    const blocks = [];
    const reasoning = typeof item["reasoning_content"] === "string" ? item["reasoning_content"] : "";
    if (reasoning.trim() !== "" && !quirks.requiresSignature) {
      blocks.push({ type: "thinking", thinking: reasoning });
    }
    const text = textOf(item["content"]);
    if (text !== "") blocks.push({ type: "text", text });
    const calls = item["tool_calls"];
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (call === null || typeof call !== "object") continue;
        const c = call;
        const fn = c["function"] !== null && typeof c["function"] === "object" ? c["function"] : {};
        const args = fn["arguments"];
        let input = {};
        if (typeof args === "string") {
          try {
            const parsed = JSON.parse(args);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
              input = parsed;
            }
          } catch {
            input = {};
          }
        } else if (args !== null && typeof args === "object" && !Array.isArray(args)) {
          input = args;
        }
        blocks.push({
          type: "tool_use",
          id: typeof c["id"] === "string" ? c["id"] : "",
          name: typeof fn["name"] === "string" ? fn["name"] : "",
          input
        });
      }
    }
    return { role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] };
  }
  const content = item["content"];
  if (typeof content === "string") {
    return { role: "user", content: [{ type: "text", text: content }] };
  }
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const p = part;
      if (p["type"] === "text") {
        blocks.push({ type: "text", text: typeof p["text"] === "string" ? p["text"] : "" });
      } else if (p["type"] === "image_url") {
        const image = p["image_url"];
        const url = image !== null && typeof image === "object" ? image["url"] : image;
        if (typeof url === "string" && url !== "") {
          blocks.push(anthropicImageBlock(url));
        }
      }
    }
    return { role: "user", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] };
  }
  return null;
}
function anthropicImageBlock(url) {
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  const mime = /^data:([^;,]+);base64,/i.exec(url);
  if (mime !== null) {
    const payload = url.slice(mime[0].length);
    const mediaType = mime[1].toLowerCase();
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: payload }
    };
  }
  return {
    type: "text",
    text: "[图片: 该 image_url 既不是 data URL 也不是公网地址,未能传给上游。]"
  };
}
function toAnthropicRequest(body, model, effort, quirks = DEFAULT_ANTHROPIC_QUIRKS) {
  const q = { ...DEFAULT_ANTHROPIC_QUIRKS, ...quirks };
  const messages = [];
  const systemParts = [];
  const rawMessages = body["messages"];
  if (Array.isArray(rawMessages)) {
    for (const item of rawMessages) {
      if (item === null || typeof item !== "object") continue;
      const m = item;
      const role = m["role"];
      if (role === "system" || role === "developer") {
        const text = textOf(m["content"]);
        if (text !== "") systemParts.push(text);
        continue;
      }
      if (role === "tool") {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: typeof m["tool_call_id"] === "string" ? m["tool_call_id"] : "",
              content: textOf(m["content"])
            }
          ]
        });
        continue;
      }
      const converted = messageOf(m, q);
      if (converted !== null) messages.push(converted);
    }
  }
  if (messages.length === 0) messages.push({ role: "user", content: [{ type: "text", text: "" }] });
  const maxTokensRaw = body["max_tokens"] ?? body["max_completion_tokens"];
  const maxTokens = typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : q.maxTokensDefault;
  const out = {
    model,
    messages,
    // 恒流式:网关的非流式请求也走 SSE 聚合,见文件头。
    stream: q.streamOnly ? true : body["stream"] === true,
    max_tokens: maxTokens
  };
  if (systemParts.length > 0) {
    const text = systemParts.join("\n\n");
    out["system"] = q.systemShape === "blocks" ? [{ type: "text", text }] : text;
  }
  if (typeof body["temperature"] === "number") out["temperature"] = body["temperature"];
  if (typeof body["top_p"] === "number") out["top_p"] = body["top_p"];
  const tools = toolsOf(body["tools"]);
  if (tools.length > 0) {
    out["tools"] = tools;
    const choice = toolChoiceOf(body["tool_choice"]);
    if (choice !== null) out["tool_choice"] = choice;
  }
  const stop = body["stop"];
  if (typeof stop === "string") out["stop_sequences"] = [stop];
  else if (Array.isArray(stop) && stop.every((s) => typeof s === "string")) {
    out["stop_sequences"] = stop;
  }
  if (effort !== void 0 && effort !== "") {
    if (q.effortField === "output_config") {
      out["output_config"] = { effort };
    } else if (q.effortField === "budget_tokens") {
      const budget = Math.max(1024, Math.min(2048, maxTokens - 1024));
      out["thinking"] = { type: "enabled", budget_tokens: budget };
    }
  }
  return out;
}
function imageUrlFromBlock(block) {
  const direct = block["url"] ?? block["data_url"] ?? block["image_url"];
  if (typeof direct === "string" && direct !== "") return direct;
  const nested = block["image_url"] ?? block["source"] ?? block["image"];
  if (nested !== null && typeof nested === "object") {
    const url = nested["url"];
    if (typeof url === "string" && url !== "") return url;
  }
  return null;
}
function textFromBlocks(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b["text"] === "string") parts.push(b["text"]);
  }
  return parts.join("\n");
}
function toAnthropicRequestFromBlocks(req, model, effort, quirks = DEFAULT_ANTHROPIC_QUIRKS, maxTokens) {
  const q = { ...DEFAULT_ANTHROPIC_QUIRKS, ...quirks };
  const messages = [];
  const systemParts = [];
  if (typeof req.system === "string" && req.system.trim() !== "") systemParts.push(req.system);
  for (const m of req.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      const text = textFromBlocks(m.content);
      if (text !== "") systemParts.push(text);
      continue;
    }
    if (m.role === "tool") {
      const blocks2 = [];
      const images = m.content.filter((b) => b.type === "image");
      if (images.length > 0) {
        const content = images.map((b) => imageUrlFromBlock(b)).filter((u) => u !== null).map((url) => anthropicImageBlock(url));
        const text = textFromBlocks(m.content);
        if (text !== "") content.push({ type: "text", text });
        blocks2.push({ type: "tool_result", tool_use_id: m.toolCallId ?? "", content });
      } else {
        blocks2.push({ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: textFromBlocks(m.content) });
      }
      messages.push({ role: "user", content: blocks2 });
      continue;
    }
    if (m.role === "assistant") {
      const blocks2 = [];
      for (const b of m.content) {
        if (b.type === "reasoning") {
          const thinking = typeof b["text"] === "string" ? b["text"] : "";
          if (thinking.trim() !== "" && !q.requiresSignature) blocks2.push({ type: "thinking", thinking });
        } else if (b.type === "text") {
          const text = typeof b["text"] === "string" ? b["text"] : "";
          if (text !== "") blocks2.push({ type: "text", text });
        } else if (b.type === "tool-call") {
          let input = {};
          const args = b["arguments"];
          if (typeof args === "string") {
            try {
              const parsed = JSON.parse(args);
              if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                input = parsed;
              }
            } catch {
              input = {};
            }
          }
          blocks2.push({
            type: "tool_use",
            id: typeof b["id"] === "string" ? b["id"] : "",
            name: typeof b["name"] === "string" ? b["name"] : "",
            input
          });
        }
      }
      messages.push({ role: "assistant", content: blocks2.length > 0 ? blocks2 : [{ type: "text", text: "" }] });
      continue;
    }
    const blocks = [];
    for (const b of m.content) {
      if (b.type === "text") {
        const text = typeof b["text"] === "string" ? b["text"] : "";
        if (text !== "") blocks.push({ type: "text", text });
      } else if (b.type === "image") {
        const url = imageUrlFromBlock(b);
        if (url !== null) blocks.push(anthropicImageBlock(url));
      }
    }
    messages.push({ role: "user", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
  }
  if (messages.length === 0) messages.push({ role: "user", content: [{ type: "text", text: "" }] });
  const out = {
    model,
    messages,
    // DSH 路径恒流式:网关的非流式请求也走 SSE 聚合。
    stream: true,
    max_tokens: typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : q.maxTokensDefault
  };
  if (systemParts.length > 0) {
    const text = systemParts.join("\n\n");
    out["system"] = q.systemShape === "blocks" ? [{ type: "text", text }] : text;
  }
  if (req.tools !== void 0 && req.tools.length > 0) {
    out["tools"] = req.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.parameters !== null && typeof t.parameters === "object" && !Array.isArray(t.parameters) ? t.parameters : { type: "object", properties: {} }
    }));
  }
  if (effort !== void 0 && effort !== "") {
    if (q.effortField === "output_config") {
      out["output_config"] = { effort };
    } else if (q.effortField === "budget_tokens") {
      const maxTokens2 = out["max_tokens"];
      out["thinking"] = { type: "enabled", budget_tokens: Math.max(1024, Math.min(2048, maxTokens2 - 1024)) };
    }
  }
  return out;
}
function anthropicUsageOf(usage) {
  const u = usage !== null && typeof usage === "object" ? usage : {};
  const num3 = (v) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
  const fresh = num3(u["input_tokens"]);
  const cacheRead = num3(u["cache_read_input_tokens"]);
  const cacheWrite = num3(u["cache_creation_input_tokens"]);
  const completion = num3(u["output_tokens"]);
  const prompt = fresh + cacheRead + cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cacheRead + cacheWrite },
    // D1:`DshUsage` 要区分 cacheRead / cacheWrite,所以原始两格单列带走。
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite
  };
}
var unmappedStopReasons = /* @__PURE__ */ new Map();
function mergeUsage(prev, next) {
  const prompt = Math.max(next.prompt_tokens, prev.prompt_tokens);
  const completion = Math.max(next.completion_tokens, prev.completion_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: {
      cached_tokens: Math.max(
        next.prompt_tokens_details.cached_tokens,
        prev.prompt_tokens_details.cached_tokens
      )
    },
    cache_read_input_tokens: Math.max(next.cache_read_input_tokens, prev.cache_read_input_tokens),
    cache_creation_input_tokens: Math.max(
      next.cache_creation_input_tokens,
      prev.cache_creation_input_tokens
    )
  };
}
function finishOf(stopReason) {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  if (typeof stopReason === "string" && stopReason !== "" && stopReason !== "end_turn" && stopReason !== "stop_sequence") {
    unmappedStopReasons.set(stopReason, (unmappedStopReasons.get(stopReason) ?? 0) + 1);
  }
  return "stop";
}
function createAnthropicChunkTranslator(meta) {
  let finished = false;
  let roleSent = false;
  let usage = anthropicUsageOf(null);
  const toolNames = /* @__PURE__ */ new Map();
  const toolArgs = /* @__PURE__ */ new Map();
  const toolOrder = [];
  function chunk(delta, finish = null, withUsage = false) {
    const payload = {
      id: meta.completionId,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason: finish }]
    };
    if (withUsage) payload["usage"] = usage;
    return payload;
  }
  return {
    get finished() {
      return finished;
    },
    usage() {
      return usage;
    },
    handle(event) {
      if (event === null || typeof event !== "object") return [];
      const e = event;
      const type = e["type"];
      const out = [];
      if (type === "message_start") {
        const message = e["message"];
        const rawUsage = message !== null && typeof message === "object" ? message["usage"] : null;
        if (rawUsage !== null && rawUsage !== void 0) usage = anthropicUsageOf(rawUsage);
        if (!roleSent) {
          roleSent = true;
          out.push(chunk({ role: "assistant" }));
        }
        return out;
      }
      if (type === "content_block_start") {
        const block = e["content_block"];
        const index = typeof e["index"] === "number" ? e["index"] : 0;
        if (block !== null && typeof block === "object") {
          const b = block;
          if (b["type"] === "tool_use") {
            toolNames.set(index, [
              typeof b["id"] === "string" ? b["id"] : "",
              typeof b["name"] === "string" ? b["name"] : ""
            ]);
            toolArgs.set(index, "");
            toolOrder.push(index);
          }
        }
        return out;
      }
      if (type === "content_block_delta") {
        const delta = e["delta"];
        const index = typeof e["index"] === "number" ? e["index"] : 0;
        if (delta === null || typeof delta !== "object") return out;
        const d = delta;
        if (d["type"] === "text_delta") {
          out.push(chunk({ content: typeof d["text"] === "string" ? d["text"] : "" }));
        } else if (d["type"] === "thinking_delta") {
          out.push(chunk({ reasoning_content: typeof d["thinking"] === "string" ? d["thinking"] : "" }));
        } else if (d["type"] === "input_json_delta") {
          toolArgs.set(index, (toolArgs.get(index) ?? "") + (typeof d["partial_json"] === "string" ? d["partial_json"] : ""));
        }
        return out;
      }
      if (type === "content_block_stop") {
        const index = typeof e["index"] === "number" ? e["index"] : 0;
        const named = toolNames.get(index);
        if (named !== void 0) {
          toolNames.delete(index);
          const [id, name] = named;
          const position = toolOrder.indexOf(index);
          out.push(
            chunk({
              tool_calls: [
                {
                  index: position >= 0 ? position : index,
                  id,
                  type: "function",
                  function: { name, arguments: toolArgs.get(index) || "{}" }
                }
              ]
            })
          );
          toolArgs.delete(index);
        }
        return out;
      }
      if (type === "message_delta") {
        const rawUsage = e["usage"];
        if (rawUsage !== null && rawUsage !== void 0) {
          usage = mergeUsage(usage, anthropicUsageOf(rawUsage));
        }
        const d = e["delta"];
        const stop = d !== null && typeof d === "object" ? d["stop_reason"] : null;
        out.push(chunk({}, finishOf(stop), true));
        return out;
      }
      if (type === "message_stop") {
        finished = true;
        return out;
      }
      return out;
    }
  };
}
function anthropicErrorOf(event) {
  if (event === null || typeof event !== "object") return null;
  const e = event;
  if (e["type"] !== "error") return null;
  const err = e["error"];
  if (err !== null && typeof err === "object") {
    const message = err["message"];
    if (typeof message === "string" && message !== "") return message;
  }
  return "上游在流中返回 error 帧";
}

// core/connectors/minimax-llm.ts
var MINIMAX_QUIRKS = {
  ...DEFAULT_ANTHROPIC_QUIRKS,
  effortField: "output_config",
  requiresSignature: false,
  systemShape: "string",
  streamOnly: true,
  maxTokensDefault: 4096
};

// core/connectors/codearts-wire.ts
var STREAM_ONLY_MODEL_IDS = ["glm-5.3"];
var STREAM_ONLY_MODEL_SET = new Set(STREAM_ONLY_MODEL_IDS);
function buildCodeartsBody(req, model) {
  const body = {
    model,
    messages: req.messages,
    stream: req.stream
  };
  if (req.temperature !== void 0) body["temperature"] = req.temperature;
  if (req.max_tokens !== void 0) body["max_tokens"] = req.max_tokens;
  if (req.top_p !== void 0) body["top_p"] = req.top_p;
  if (req.stop !== void 0) body["stop"] = req.stop;
  if (req.tools !== void 0) body["tools"] = req.tools;
  if (req.tool_choice !== void 0) body["tool_choice"] = req.tool_choice;
  if (req.response_format !== void 0) body["response_format"] = req.response_format;
  return body;
}

// core/connectors/index.ts
var defaultConnectors = [
  new OpenAICompatAdapter(),
  new TraeAdapter(),
  new WorkbuddyAdapter(),
  new SensenovaAdapter(),
  new MinimaxAdapter(),
  new AnthropicAdapter(),
  ...QODER_ADAPTERS,
  CODEARTS_ADAPTER
];
function getConnector(vendorId) {
  return defaultConnectors.find((c) => c.vendorId === vendorId);
}
function getAllConnectors() {
  return [...defaultConnectors];
}
function registerConnector(connector) {
  const existing = defaultConnectors.findIndex((c) => c.vendorId === connector.vendorId);
  if (existing >= 0) {
    defaultConnectors[existing] = connector;
  } else {
    defaultConnectors.push(connector);
  }
}

// core/datahub/quota.ts
function quotaRollupOf(snapshots) {
  const acc = /* @__PURE__ */ new Map();
  for (const snap of snapshots) {
    if (!snap || typeof snap !== "object") continue;
    const key = snap.credentialKey;
    if (typeof key !== "string" || key === "") continue;
    const provider = key.split("/")[0] ?? "";
    if (provider === "") continue;
    const current = acc.get(provider) ?? {
      remaining: null,
      limit: null,
      expires_at: null,
      fetched_at: null,
      accounts: 0
    };
    current.accounts += 1;
    if (typeof snap.remaining === "number") {
      current.remaining = (current.remaining ?? 0) + snap.remaining;
    }
    if (typeof snap.limit === "number") {
      current.limit = (current.limit ?? 0) + snap.limit;
    }
    if (typeof snap.expires_at === "number" && snap.expires_at > 0) {
      current.expires_at = current.expires_at === null ? snap.expires_at : Math.min(current.expires_at, snap.expires_at);
    }
    if (typeof snap.fetched_at === "number" && snap.fetched_at > 0) {
      current.fetched_at = current.fetched_at === null ? snap.fetched_at : Math.max(current.fetched_at, snap.fetched_at);
    }
    acc.set(provider, current);
  }
  return acc;
}
var QuotaHub = class {
  /** 账号快照（键 = `provider/username`）。 */
  store = /* @__PURE__ */ new Map();
  /** sensenova 通用池窗口比例（键 = username）。 */
  ratios = /* @__PURE__ */ new Map();
  /* ---------------------------------------------------------- 存储 */
  get(key) {
    return this.store.get(key);
  }
  has(key) {
    return this.store.has(key);
  }
  set(key, entry) {
    this.store.set(key, entry);
  }
  delete(key) {
    return this.store.delete(key);
  }
  keys() {
    return this.store.keys();
  }
  /** 全量条目迭代（键 + 快照 + 写入时刻）。 */
  entries() {
    return this.store.entries();
  }
  /** 快照迭代（只给值，调用方基本只要 snapshot）。 */
  *snapshots() {
    for (const entry of this.store.values()) {
      if (entry.snapshot && typeof entry.snapshot === "object") yield entry.snapshot;
    }
  }
  get size() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
    this.ratios.clear();
  }
  /* -------------------------------------------------- sensenova 比例 */
  setPoolRatios(username, ratios) {
    this.ratios.set(username, ratios);
  }
  poolRatios() {
    return new Map(this.ratios);
  }
  /* ---------------------------------------------------------- 投影 */
  /**
   * 快照表 → 调度器的额度表（`AppSchedulerRepo.quotas()` 的**唯一**实现）。
   *
   * 包含三段：
   * 1. 逐账号一行（键 `provider/username`，与调度侧 `quotaKey(row)` 同构）；
   * 2. 多账号渠道的 provider 级聚合行（键 = 裸 provider id，到期取最早）；
   * 3. sensenova 通用池的窗口剩余比例（只补 `w5_ratio`/`w7_ratio`，
   *    **不覆盖** remaining/limit —— 这条路上本来就没有那些字段，不伪造）。
   */
  table() {
    const out = {};
    const collected = [];
    for (const { snapshot } of this.store.values()) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const k = snapshot.credentialKey;
      if (typeof k !== "string" || k === "") continue;
      collected.push(snapshot);
      const row = {};
      if (typeof snapshot.remaining === "number") row.remaining = snapshot.remaining;
      if (typeof snapshot.limit === "number") row.limit = snapshot.limit;
      if (typeof snapshot.expires_at === "number" && snapshot.expires_at > 0) {
        row.expires_at = snapshot.expires_at;
      }
      if (typeof snapshot.fetched_at === "number") row.fetched_at = snapshot.fetched_at;
      if (snapshot.error !== null) row.error = snapshot.error;
      out[k] = row;
    }
    for (const [provider, rollup] of quotaRollupOf(collected)) {
      out[provider] = {
        remaining: rollup.remaining ?? void 0,
        limit: rollup.limit ?? void 0,
        expires_at: rollup.expires_at ?? void 0,
        fetched_at: rollup.fetched_at ?? void 0
      };
    }
    for (const [username, ratios] of this.ratios) {
      const k = `sensenova/${username}`;
      const prev = out[k] ?? {};
      out[k] = {
        ...prev,
        ...ratios.w5 !== null ? { w5_ratio: ratios.w5 } : {},
        ...ratios.w7 !== null ? { w7_ratio: ratios.w7 } : {}
      };
    }
    return out;
  }
  /* -------------------------------------------------------- 新鲜度 */
  /**
   * 额度快照是否「可用来排序」（三条全满足才算新鲜）：
   * 1. 至少一条带 `expires_at > 0` —— 那是 due-first 的排序键；
   * 2. 最新一条 `fetched_at` 距今不超过 `maxAgeMs`；
   * 3. 最新那条不是 error 态。
   *
   * ⚠️ 必须廉价：每个请求调度前都会调，只读内存绝不打上游。
   * 与 `src/quota-freshness.ts` 的 `evaluateQuotaFreshness` 同口径 ——
   * 后者保留给纯函数单测，这里直接复用它的输入形状。
   */
  snapshotsForFreshness() {
    const out = [];
    for (const { snapshot } of this.store.values()) {
      if (!snapshot || typeof snapshot !== "object") continue;
      out.push({
        expires_at: snapshot.expires_at,
        fetched_at: snapshot.fetched_at,
        error: snapshot.error
      });
    }
    return out;
  }
  /* -------------------------------------------------------- 诊断 */
  /** 一行摘要（面板/日志用）：多少条、几条有到期、最新一条多久前。 */
  summary(now) {
    let withExpiry = 0;
    let newestAtMs = null;
    for (const entry of this.store.values()) {
      if (typeof entry.snapshot?.expires_at === "number" && entry.snapshot.expires_at > 0) withExpiry += 1;
      if (newestAtMs === null || entry.fetchedAtMs > newestAtMs) newestAtMs = entry.fetchedAtMs;
    }
    return {
      total: this.store.size,
      withExpiry,
      newestAgeMs: newestAtMs === null ? null : Math.max(0, now - newestAtMs)
    };
  }
};
var quotaHub = new QuotaHub();

// src/repo.ts
function intOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}
var AppSchedulerRepo = class {
  constructor(db, registry, env2) {
    this.db = db;
    this.registry = registry;
    this.env = env2;
  }
  db;
  registry;
  env;
  // ── SettingsRepo ────────────────────────────────────────────────────────
  getSetting(key) {
    const row = this.db.setting.get(key);
    return row ? row.v : null;
  }
  setSetting(key, value) {
    this.db.setting.set(key, value);
  }
  settings() {
    const out = {};
    for (const row of this.db.raw.prepare("SELECT k, v FROM setting WHERE v IS NOT NULL").all()) {
      out[row.k] = row.v;
    }
    return out;
  }
  // ── SchedulerRepo ───────────────────────────────────────────────────────
  logicalModelRow(name) {
    const lm = this.registry.getLogicalModel(name);
    if (!lm) return null;
    return {
      name: lm.name,
      strategy: lm.strategy,
      members: lm.members
    };
  }
  membersOf(name) {
    const lm = this.registry.getLogicalModel(name);
    return lm ? lm.members : null;
  }
  endpointChain(name) {
    const members = this.registry.membersOf(name);
    if (!members || members.length === 0) return [];
    const rows = [];
    for (const member of members) {
      rows.push(...this.#rowsFor(member.provider, member.model, member));
    }
    return rows;
  }
  directChain(name) {
    const pair = splitModelId(name);
    if (!pair) return [];
    return this.#rowsFor(pair[0], pair[1], null);
  }
  quotas() {
    try {
      return this.env.quotaSnapshot?.() ?? {};
    } catch {
      return {};
    }
  }
  // ── 私有 ────────────────────────────────────────────────────────────────
  /**
   * 成员×启用账户展开成 RawEndpointRow。
   *
   * ⚠️ **只负责展开，不负责排序**。账号层的「先到期优先」由调度器负责 ——
   * `Scheduler.chain()` 在组装完 items 后按 (priority, key 到期) 稳定排序，
   * 见 engine.ts 的 `items.sort` 段。两处都排会造成双真源。
   *
   * （历史上这里曾按凭据序展开，一度被误认为「due-first 没生效」的原因；
   * 真正的原因是 `_quotaMap` 把空表当成新鲜缓存了 300s，见那里的注释。）
   */
  #rowsFor(provider, model, member) {
    const pdef = this.registry.getProvider(provider);
    const rdef = this.registry.getRealModel(provider, model);
    if (!pdef || !rdef) return [];
    const dbRow = this.db.realModel.get(provider, model);
    const concurrency = dbRow && dbRow.concurrency > 0 ? dbRow.concurrency : intOr(rdef.concurrency, defaultConcurrencyOf(provider));
    const supportsVision = dbRow?.supports_vision ?? rdef.supportsVision;
    const maxInputTokens = dbRow?.max_input_tokens ?? intOr(rdef.maxInputTokens, 0);
    const maxOutputTokens = dbRow?.max_output_tokens ?? intOr(rdef.maxOutputTokens, 0);
    const rows = [];
    if (!this.env.isChannelEnabled(provider)) return rows;
    for (const account of this.registry.listAccounts(provider)) {
      const credentialRef = account.credentialRef;
      if (!this.env.hasSecret(credentialRef) || !this.env.isAccountEnabled(credentialRef)) continue;
      const username = credentialRef.slice(provider.length + 1);
      if (!username) continue;
      const endpoint = {
        endpoint_id: endpointIdOf(provider, model, username),
        provider,
        provider_id: provider,
        model,
        upstream_id: model,
        credential_key: [provider, username],
        username,
        account_id: username,
        protocol: pdef.protocol,
        base_url: pdef.baseUrl ?? "",
        region: "",
        concurrency,
        supports_vision: supportsVision ? 1 : 0,
        max_input_tokens: maxInputTokens,
        max_output_tokens: maxOutputTokens,
        cooldown_until: 0
      };
      if (member) {
        rows.push({ member, real_model_id: `${provider}/${model}`, endpoint });
      } else {
        rows.push(endpoint);
      }
    }
    return rows;
  }
};

// core/wire/index.ts
function encodeWith(quirks, body, model, effort, extra) {
  if (extra?.blocks !== void 0) {
    return toAnthropicRequestFromBlocks(extra.blocks, model, effort, quirks, extra.maxTokens);
  }
  return toAnthropicRequest(body, model, effort, quirks);
}
var MINIMAX_CODEC = {
  family: "anthropic",
  encodeBody(body, model, effort, _creds, extra) {
    return encodeWith(MINIMAX_QUIRKS, body, model, effort, extra);
  }
};
var ANTHROPIC_CODEC = {
  family: "anthropic",
  encodeBody(body, model, effort, creds, extra) {
    const quirks = { ...ANTHROPIC_QUIRKS, ...anthropicQuirksFrom(creds?.["quirks"]) };
    return encodeWith(quirks, body, model, effort, extra);
  }
};
function wireCodecFor(protocol) {
  if (protocol === "minimax") return MINIMAX_CODEC;
  if (protocol === "anthropic") return ANTHROPIC_CODEC;
  return void 0;
}
function wireFamilyOf(protocol) {
  return wireCodecFor(protocol)?.family ?? "chat";
}
function wireShapeOf(protocol, hasBlocks) {
  const family = wireFamilyOf(protocol);
  const source = hasBlocks ? "blocks" : "chat";
  const crossed = family === "anthropic" && source === "chat";
  return { family, source, crossed };
}

// core/connectors/stream-aggregate.ts
function normalizeUsageInts(usage) {
  const prompt = toIntOrZero(usage?.prompt_tokens);
  const completion = toIntOrZero(usage?.completion_tokens);
  const totalRaw = toIntOrZero(usage?.total_tokens);
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: totalRaw > 0 ? totalRaw : prompt + completion
  };
  const completionDetails = usage?.completion_tokens_details;
  if (isMapping(completionDetails) && Object.keys(completionDetails).length > 0) {
    out.completion_tokens_details = normalizeDetails(completionDetails);
  }
  const promptDetails = usage?.prompt_tokens_details;
  if (isMapping(promptDetails) && Object.keys(promptDetails).length > 0) {
    out.prompt_tokens_details = normalizeDetails(promptDetails);
  }
  return out;
}
function toIntOrZero(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}
function isMapping(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function normalizeDetails(details) {
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    out[k] = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : v;
  }
  return out;
}
function mergeToolCall(acc, order, raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const r = raw;
  const idx = typeof r.index === "number" && Number.isInteger(r.index) ? r.index : 0;
  let slot = acc.get(idx);
  if (!slot) {
    slot = { id: null, type: "function", function: { name: "", arguments: "" } };
    acc.set(idx, slot);
    order.push(idx);
  }
  if (typeof r.id === "string" && r.id !== "" && slot.id === null) {
    slot.id = r.id;
  }
  const fn = r.function;
  if (typeof fn === "object" && fn !== null && !Array.isArray(fn)) {
    const f = fn;
    if (typeof f.name === "string" && f.name !== "" && slot.function.name === "") {
      slot.function.name = f.name;
    }
    if (typeof f.arguments === "string" && f.arguments !== "") {
      slot.function.arguments += f.arguments;
    }
  }
}
async function aggregateCompletion(chunks, options) {
  const { model, completionId, created } = options;
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = /* @__PURE__ */ new Map();
  const order = [];
  let finishReason = null;
  let usage = null;
  for await (const chunk of chunks) {
    if (chunk.usage && typeof chunk.usage === "object") {
      usage = normalizeUsageInts(chunk.usage);
    }
    const choices = chunk.choices ?? [];
    if (choices.length === 0) continue;
    const choice = choices[0];
    if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content !== "") {
      textParts.push(delta.content);
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      reasoningParts.push(delta.reasoning_content);
    }
    for (const tc of delta.tool_calls ?? []) {
      mergeToolCall(toolCalls, order, tc);
    }
  }
  const message = {
    role: "assistant",
    content: textParts.join("") || null
  };
  if (reasoningParts.length > 0) {
    message.reasoning_content = reasoningParts.join("");
  }
  if (toolCalls.size > 0) {
    const suffix = completionId.replace(/^chatcmpl-/, "").slice(0, 8);
    message.tool_calls = order.map((i, n) => {
      const merged = toolCalls.get(i);
      return {
        id: merged.id ?? `call_${suffix}_${n}`,
        type: "function",
        function: merged.function
      };
    });
  }
  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason ?? (toolCalls.size > 0 ? "tool_calls" : "stop")
      }
    ],
    usage: usage ?? void 0
  };
}

// core/gateway/image-bridge.ts
import { createHash as createHash9 } from "node:crypto";
var FREE_PARSE_PROMPT = "你是图像证据转写器。只做一件事:把这张图里**能直接看到**的信息转成文字证据。不推理、不联想、不补全,不要写图中没有的东西。\n按下面的顺序输出,没有内容的段整段省略:\n【文字】逐字转写图中所有可见文字,保留原有换行与层级;表格按行列写,不要概括。\n【版面】这张图是什么形态(截图/照片/图表/表格/代码/界面…),关键区域在哪、阅读顺序如何。\n【要素】图中出现的实体与具体值:型号、编号、日期、金额、参数、字段名、按钮名。\n【不确定】看不清 / 被截断 / 无法辨认的部分,写清它大概在哪个位置。\n如果图片损坏、空白、过于模糊或文字完全无法辨认,只回复四个字:无法解析\n【任务可行性】最后一行单独输出:可以完成 或 无法完成任务: <原因>。判据:只看这张图里能直接读到的信息,能否完成用户当前任务;信息不足、过于模糊、或必须依赖原生视觉能力才能继续时,一律输出无法完成任务。\n只输出上面的内容本身:不要解释你的过程,不要用 markdown 代码块包裹。";
var FREE_PARSE_UNPARSED = "无法解析";
var FREE_PARSE_CANNOT_COMPLETE = "无法完成任务";
var FREE_PARSE_MAX_IMAGES = 8;
var IMAGE_HARD_LIMIT = 50;
var IMAGE_PARSED_TEMPLATE = "[图片 {seq}/{total} 解析] {text}";
var IMAGE_UNPARSED_TEMPLATE = "[图片 {seq}/{total} 无法解析:{reason}] 这张图没有被转写成文字;不要猜测图中内容。";
var IMAGE_BRIDGE_NOTE = "\n\n【图像桥】重要：本请求里的图片**不是原图**——它们已由图像桥转写成文字(见 [图片解析] / [图片无法解析] 标记)，原文不在你的上下文中。你看到的图像信息**来自图像桥的文字转述**，不是你自己的视觉。\n因此：\n1. 一般性的问答、描述、概要识别，可以基于转述回答；但**不要**声称看到转述里没有的具体细节（精确颜色、构图比例、小字、像素级差异），也不要猜测图中内容。\n2. **若本任务对图像要求较高**——例如图像生成/改图（需要按参考图核对产出）、按图比对构图或站位、读取图中细微文字与数值、判断配色光影材质等——**文字转述不足以完成任务**。此时请**立即中止任务**，直接告诉用户：「本模型没有原生视觉能力，当前图片是图像桥的文字转述，无法可靠完成该任务，请更换支持原生图像的模型」。\n宁可停下换模型，也不要基于转述硬交付一个看起来对、实际错的结果。";
var PARSE_CACHE_MAX = 128;
var CACHE_OK = "ok\0";
var CACHE_FAIL = "fail\0";
var parseCache = /* @__PURE__ */ new Map();
function parseCacheGet(key) {
  const value = parseCache.get(key);
  if (value !== void 0) {
    parseCache.delete(key);
    parseCache.set(key, value);
  }
  return value ?? null;
}
function parseCacheSet(key, value) {
  if (parseCache.has(key)) parseCache.delete(key);
  parseCache.set(key, value);
  while (parseCache.size > PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next();
    if (oldest.done) break;
    parseCache.delete(oldest.value);
  }
}
function okValue(text) {
  return CACHE_OK + text;
}
function failValue(reason) {
  return CACHE_FAIL + reason;
}
var MIN_INLINE_BASE64_LEN = 64;
function isCompleteBase64Image(payload, header) {
  if (payload.length === 0 || payload.length % 4 !== 0) return false;
  let bytes;
  try {
    bytes = Buffer.from(payload, "base64");
  } catch {
    return false;
  }
  if (bytes.length < 32) return false;
  if (bytes.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")) return false;
  const mime = /^data:image\/([a-z0-9.+-]+)/i.exec(header)?.[1]?.toLowerCase() ?? "";
  const ascii = (start, end) => bytes.subarray(start, end).toString("ascii");
  const startsWithBytes = (...arr) => arr.every((v, i) => bytes[i] === v);
  if (mime === "png" || mime === "apng") {
    return startsWithBytes(137, 80, 78, 71, 13, 10, 26, 10) && bytes.includes(Buffer.from("IEND", "ascii"));
  }
  if (mime === "jpeg" || mime === "jpg") {
    return startsWithBytes(255, 216) && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  }
  if (mime === "gif") {
    return ascii(0, 4) === "GIF8" && bytes[bytes.length - 1] === 59;
  }
  if (mime === "webp") {
    return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  }
  if (mime === "bmp") {
    return ascii(0, 2) === "BM";
  }
  if (mime === "svg+xml") {
    return bytes.toString("utf8").includes("</svg>");
  }
  return startsWithBytes(137, 80, 78, 71) || startsWithBytes(255, 216, 255) || ascii(0, 4) === "GIF8" || ascii(8, 12) === "WEBP";
}
function splitInlineImageDataUrls(content, opts = {}) {
  const HEAD = /data:image\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9=.+-]+)*;base64,/g;
  const isB64 = (code) => code >= 65 && code <= 90 || // A-Z
  code >= 97 && code <= 122 || // a-z
  code >= 48 && code <= 57 || // 0-9
  code === 43 || // +
  code === 47 || // /
  code === 61;
  const parts = [];
  let last = 0;
  let hit = false;
  for (; ; ) {
    const m = HEAD.exec(content);
    if (m === null) break;
    const start = m.index;
    let end = m.index + m[0].length;
    while (end < content.length && isB64(content.charCodeAt(end))) end += 1;
    const payloadLen = end - (m.index + m[0].length);
    if (payloadLen < MIN_INLINE_BASE64_LEN) {
      continue;
    }
    if (opts.requireComplete === true && !isCompleteBase64Image(content.slice(m.index + m[0].length, end), m[0])) {
      continue;
    }
    hit = true;
    const before = content.slice(last, start);
    if (before.trim() !== "") parts.push({ type: "text", text: before });
    parts.push({
      type: "image_url",
      image_url: { url: content.slice(start, end) }
    });
    last = end;
    HEAD.lastIndex = end;
  }
  if (!hit) return null;
  const tail = content.slice(last);
  if (tail.trim() !== "") parts.push({ type: "text", text: tail });
  return parts.length > 0 ? parts : null;
}
function foldedImagePlaceholder(mime, ref) {
  const segs = [];
  if (ref !== null) segs.push(`ref=${ref}`);
  if (mime !== null) segs.push(mime);
  segs.push("历史轮次,未载入像素");
  return `[图片 已折叠 · ${segs.join(" · ")}]`;
}
function imageUrlOfPart(imagePart) {
  const p = imagePart;
  let url;
  if (p.type === "image_url") {
    const inner = p.image_url;
    url = inner !== null && typeof inner === "object" ? inner.url : void 0;
  } else if (p.type === "image") {
    url = p.url;
    if (typeof url !== "string") {
      const inner = p.image_url;
      if (inner !== null && typeof inner === "object") {
        url = inner.url;
      } else if (typeof inner === "string") {
        url = inner;
      }
    }
  }
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return trimmed === "" ? null : trimmed;
}
function imageContentRef(imagePart) {
  const url = imageUrlOfPart(imagePart);
  if (url === null) return null;
  return createHash9("sha256").update(url, "utf-8").digest("hex").slice(0, 16);
}
function imageMimeOf(imagePart) {
  const url = imageUrlOfPart(imagePart);
  if (url === null) return null;
  const m = /^data:(image\/[a-z0-9.+-]+)/i.exec(url);
  return m?.[1]?.toLowerCase() ?? null;
}
function shouldBridgeImages(chainHasVision) {
  return !chainHasVision;
}
function normalizeInlineImages(messages) {
  let changed = false;
  const out = messages.map((msg) => {
    if (msg?.role !== "user") return msg;
    const content = msg?.content;
    if (typeof content !== "string" || !content.includes("data:image")) return msg;
    const parts = splitInlineImageDataUrls(content, { requireComplete: true });
    if (parts === null) return msg;
    changed = true;
    return { ...msg, content: parts };
  });
  return changed ? out : messages;
}
function imagePartIndices(messages) {
  const found = [];
  messages.forEach((msg, mi) => {
    const content = msg?.content;
    if (!Array.isArray(content)) return;
    content.forEach((part, pi) => {
      if (part === null || typeof part !== "object") return;
      const type = part.type;
      if (type === "image_url" || type === "image") found.push([mi, pi]);
    });
  });
  return found;
}
function lastUserMessage(messages) {
  for (let mi = messages.length - 1; mi >= 0; mi -= 1) {
    const msg = messages[mi];
    if (msg !== null && typeof msg === "object" && msg.role === "user") return mi;
  }
  return null;
}
function parseCacheKey(imagePart, parseModel = "") {
  const canonical = imageUrlOfPart(imagePart);
  if (canonical === null) return null;
  return createHash9("sha256").update(`v3|${parseModel}|${canonical}`, "utf-8").digest("hex");
}
function imageReplacement(seq, total, value) {
  if (value.startsWith(CACHE_OK)) {
    return IMAGE_PARSED_TEMPLATE.replace("{seq}", String(seq)).replace("{total}", String(total)).replace("{text}", value.slice(CACHE_OK.length));
  }
  const reason = value.startsWith(CACHE_FAIL) ? value.slice(CACHE_FAIL.length) : value;
  return IMAGE_UNPARSED_TEMPLATE.replace("{seq}", String(seq)).replace("{total}", String(total)).replace("{reason}", reason);
}
function deepCopyMessages(messages) {
  return messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? m.content.map((p) => ({ ...p })) : m.content
  }));
}
async function tryParseImages(messages, opts) {
  const images = imagePartIndices(messages);
  const result = {
    replaced: 0,
    cacheHits: 0,
    unparsed: 0,
    droppedHistory: 0,
    parsedNow: 0
  };
  if (images.length === 0) return { messages, result };
  const allowNative = opts.chainHasVision && opts.hardOverflow !== true;
  const maxImages = opts.maxImages ?? FREE_PARSE_MAX_IMAGES;
  const newMessages = deepCopyMessages(messages);
  const totals = /* @__PURE__ */ new Map();
  for (const [mi] of images) totals.set(mi, (totals.get(mi) ?? 0) + 1);
  const seen = /* @__PURE__ */ new Map();
  const currentMi = lastUserMessage(messages);
  let notePlaced = false;
  const place = (mi, pi, seq, total, value) => {
    const suffix = notePlaced ? "" : IMAGE_BRIDGE_NOTE;
    notePlaced = true;
    const content = newMessages[mi]?.content;
    if (!Array.isArray(content)) return;
    const text = imageReplacement(seq, total, value);
    content[pi] = { type: "text", text: text + suffix };
    result.replaced += 1;
  };
  const dropHistoryImage = (mi, pi) => {
    const content = newMessages[mi]?.content;
    if (!Array.isArray(content)) return;
    const part = content[pi];
    if (part === void 0) return;
    content[pi] = {
      type: "text",
      text: foldedImagePlaceholder(imageMimeOf(part), imageContentRef(part))
    };
    result.droppedHistory += 1;
  };
  for (const [mi, rawPi] of images) {
    seen.set(mi, (seen.get(mi) ?? 0) + 1);
    const seq = seen.get(mi);
    const total = totals.get(mi);
    const pi = rawPi;
    const content = newMessages[mi]?.content;
    if (!Array.isArray(content)) continue;
    const part = content[pi];
    if (part === void 0) continue;
    const key = parseCacheKey(part, opts.parseModel);
    if (key !== null) {
      const cached = parseCacheGet(key);
      if (cached !== null) {
        place(mi, pi, seq, total, cached);
        result.cacheHits += 1;
        continue;
      }
    }
    if (currentMi === null || mi < currentMi) {
      continue;
    }
    if (result.parsedNow >= maxImages) {
      if (allowNative) continue;
      place(mi, pi, seq, total, failValue("超出单请求解析配额"));
      result.unparsed += 1;
      continue;
    }
    const text = await opts.parseOne(part);
    result.parsedNow += 1;
    if (text === null) {
      if (allowNative) continue;
      place(mi, pi, seq, total, failValue("解析请求失败"));
      result.unparsed += 1;
      continue;
    }
    const trimmed = text.trim();
    if (trimmed === "") {
      if (allowNative) continue;
      place(mi, pi, seq, total, failValue("解析结果为空"));
      result.unparsed += 1;
      continue;
    }
    if (trimmed.includes(FREE_PARSE_UNPARSED)) {
      const value2 = failValue("模型无法辨认这张图");
      if (key !== null) parseCacheSet(key, value2);
      if (allowNative) continue;
      place(mi, pi, seq, total, value2);
      result.unparsed += 1;
      continue;
    }
    const value = okValue(trimmed);
    if (key !== null) parseCacheSet(key, value);
    place(mi, pi, seq, total, value);
  }
  return { messages: newMessages, result };
}

// core/connectors/workbuddy-gate.ts
var WORKBUDDY_NEUTRAL_HEAD = "You are a helpful assistant.";
var CHANNEL_REJECT_TIP = "被 WorkBuddy 网关的渠道校验拦截(HTTP 400 / code 11128):网关匹配请求里的 system/assistant 提示内容,与账号、积分、额度、网络都无关 —— 换账号或换区域 不会改变结果。若该内容来自宿主或其他插件,请修改对应提示;已对已知的第三方 agent 指纹做归一化,新指纹可反馈到 issue。";
function isTextPart(part) {
  return part !== null && typeof part === "object" && !Array.isArray(part) && typeof part.text === "string";
}
function eachTextOf(content) {
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    return content.filter(isTextPart).map((p) => p.text);
  }
  return [];
}
function isScannedRole(role) {
  return role === "system" || role === "developer" || role === "assistant";
}
var HOST_IDENTITY_REWRITES = [
  // 宿主自述的 ACP/记账标记(`<acp tokens="1.7K" type="text">m35968</acp>`):
  // 它既不是散文也不在身份句里,整条剥掉。先做,免得下面的空行压缩被它干扰。
  [/<acp\b[^>]*>[\s\S]*?<\/acp>/giu, ""],
  [/<acp\b[^>]*\/>/giu, ""],
  // ③ Web GUI 自述。**先于**通用品牌替换:那条会把句子改成
  // 「the the deployment assistant Web GUI」的病句。
  [
    /\byou\s+are\s+interacting\s+with\s+the\s+user\s+through\s+the\s+deepseek\s+harness(?:\s+web\s+gui)?\b/giu,
    "You are interacting with the user through the web interface"
  ],
  // ①② agent 身份从句(含 `a coding agent powered by <model> model` 这种
  // 模型插值形态)。匹配到句号之前,句号留在原文里,重写后仍是完整句子。
  [/\byou\s+are\s+(?:an?\s+)?[\w-]*\s*agent\s+powered\s+by\s+[^.\n]{1,160}/giu, WORKBUDDY_NEUTRAL_HEAD],
  // ②的**同族变体**:上游对「自我介绍句式 + 品牌」只要求「句式在前、品牌在后」,
  // 动词搭配每加一条就能再造一次 11128。参考实现 `workbuddy2api-hub`
  // (`SANITIZE_IDENTITY_VERBS`,#533/#537/#539)已实测出的其余搭配都收在这里:
  // `built on` / `built by` / `created by` / `developed by` / `made by` /
  // `trained by`(如 `You are Example Agent, built by Example Corp.`)。
  // `powered by` 已由上面那条覆盖,这里不重复,免得两条抢同一段文本。
  [
    /\byou\s+are\s+(?:an?\s+|the\s+)?(?:[\w.-]+\s+){0,3}?(?:agent|assistant|model|ai|llm)?[\s,]{0,2}(?:built\s+on|built\s+by|created\s+by|developed\s+by|made\s+by|trained\s+by)[^.\n]{0,160}/giu,
    WORKBUDDY_NEUTRAL_HEAD
  ],
  // ③b 上游黑名单里的另一条第三方 agent 身份句(2026-11-26 补,用户已授权
  // 改写系统提示词)。`running within the Claude Agent SDK` 是同一条指纹的尾巴,
  // 一起吃掉;整句换成中性头,发出去的报文里不再有这条自述。
  [
    /\byou\s+are\s+claude\s+code,\s*anthropic'?s\s+official\s+cli\s+for\s+claude(?:,\s*running\s+within\s+the\s+claude\s+agent\s+sdk)?\.?/giu,
    WORKBUDDY_NEUTRAL_HEAD
  ],
  // ④ `@` 文件引用说明段 —— 官方插件 `@deepseek-ai/dsh-file-reference`
  // (packages/context/file-reference)注入的 `FILE_REFERENCE_PROMPT`。
  //
  // 2026-10-28 参考实现在 CN 号池实测的边界(见其 #684 / #677 / #675):
  // **整段连续文本**才是指纹 —— 只发 A+B 两句 → 200;整段五句连排 → 400(稳定);
  // 整段里 A 句补一个 `that` → 200。也就是说匹配单位是整段,不是某个单词。
  //
  // 修法取最小改动:只在 A 句 `paths the user` 中间补 `that`,
  // B 句及其后所有句子逐字保留,语义不变;`(?!that )` 保证幂等。
  // 不改成别的措辞:这段话在提示词里有实际语义(告诉模型 `@` 前缀是路径),
  // 删掉或换句会改变模型对 `@` 的理解。
  [
    /(tokens\s+prefixed\s+with\s+@\s+are\s+paths\s+)(?!that\s)(the\s+user\s+explicitly\s+referenced\.)/giu,
    "$1that $2"
  ],
  // 兜底:品牌短语的其它出现(门 B 的精确子串)。放在最后,不抢上面那条的活。
  //
  // ⚠️ 2026-11-26:先吃掉前置的 "the",否则 DSH 的
  // `The runtime context names the DeepSeek Harness implementation checkout.`
  // 会被改成 `names the the deployment assistant …`(the the 病句)。
  // 两条都保留 "the deployment assistant" 这个替换值 —— 与既有测试/语义一致。
  [/\bthe\s+deepseek\s+harness\b/giu, "the deployment assistant"],
  [/\bdeepseek\s+harness\b/giu, "the deployment assistant"]
];
function rewriteHostIdentityText(text) {
  let out = text;
  for (const [pattern, replacement] of HOST_IDENTITY_REWRITES) {
    out = out.replace(pattern, replacement);
  }
  if (out === text) return text;
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
function rewriteHostIdentity(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return m;
    const msg = m;
    if (!isScannedRole(msg.role)) return m;
    if (typeof msg.content === "string") {
      const next = rewriteHostIdentityText(msg.content);
      if (next === msg.content) return m;
      changed = true;
      return { ...msg, content: next };
    }
    if (Array.isArray(msg.content)) {
      let any = false;
      const parts = msg.content.map((part) => {
        if (!isTextPart(part)) return part;
        const next = rewriteHostIdentityText(part.text);
        if (next === part.text) return part;
        any = true;
        return { ...part, text: next };
      });
      if (!any) return m;
      changed = true;
      return { ...msg, content: parts };
    }
    return m;
  });
  return changed ? out : messages;
}
function isChannelRejectDetail(detail) {
  return /"code"\s*:\s*11128(?!\d)/.test(detail) || /code\s+11128(?!\d)/.test(detail) || /(?<!\d)11128(?!\d)/.test(detail) || detail.includes("渠道校验") || detail.includes("channel_reject") || detail.includes("不是官方客户端") || detail.includes("conversation id missing") || detail.includes("first message is not system prompt");
}
function systemOpeningsOf(messages, limit = 3) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const msg = m;
    if (!isScannedRole(msg.role)) continue;
    for (const t of eachTextOf(msg.content)) {
      const line = t.trim().split("\n")[0] ?? "";
      if (line === "") continue;
      out.push(`${msg.role}:${line.slice(0, 120)}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
function channelRejectMessage(messages) {
  const openings = systemOpeningsOf(messages);
  const hits = openings.length > 0 ? `命中的提示开头:${openings.map((o) => `「${o}」`).join("、")}。` : "";
  return `${hits}${CHANNEL_REJECT_TIP}`;
}
function isWorkbuddyWire(protocol) {
  return protocol === "workbuddy";
}

// core/gateway/reasoning-effort.ts
var LADDER_RANK = {
  off: -1,
  low: 0,
  medium: 1,
  high: 2,
  max: 3
};
var TIE_PREFER_LOW = false;
var LOW_SIDE_INPUTS = /* @__PURE__ */ new Set(["low"]);
function canonicalEffort(name) {
  const n = name.trim().toLowerCase().replace(/[-_\s.]/g, "");
  if (n === "off" || n === "none" || n === "disabled" || n === "false" || n === "no") return "off";
  if (n === "low" || n === "minimal" || n === "min" || n === "light" || n === "thinkinglow") {
    return "low";
  }
  if (n === "medium" || n === "med" || n === "default" || n === "mid" || n === "thinkingmedium") {
    return "medium";
  }
  if (n === "high" || n === "thinkinghigh") return "high";
  if (n === "max" || n === "xhigh" || n === "ultra" || n === "extreme" || n === "highest" || n === "thinkingmax" || // trae 的目录用 `light` / `high` / `extra_high` 三档(2026-11-08 实测
  // `reasoning_effort_config.options`),`extra_high` 就是它的最高档。
  n === "extrahigh" || n === "veryhigh" || n === "superhigh") {
    return "max";
  }
  return null;
}
function orderRawLevels(list) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of list) {
    const raw = String(item ?? "").trim();
    if (raw === "") continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    const level = canonicalEffort(raw);
    if (level === null || level === "off") continue;
    seen.add(key);
    out.push({ raw, rank: LADDER_RANK[level] });
  }
  return out.sort((a, b) => a.rank - b.rank).map((e) => e.raw);
}
function tableOf(levels) {
  const out = [];
  for (const item of levels) {
    const raw = String(item ?? "").trim();
    if (raw === "") continue;
    const level = canonicalEffort(raw);
    if (level === null || level === "off") continue;
    out.push({ raw, level, rank: LADDER_RANK[level] });
  }
  return out.sort((a, b) => a.rank - b.rank);
}
function resolveReasoningEffort(requested, levels, allowsOff = null) {
  if (typeof requested !== "string" || requested.trim() === "") {
    return { value: void 0, off: false, clamped: false, reason: "unspecified" };
  }
  const req = canonicalEffort(requested);
  if (req === null) {
    return { value: void 0, off: false, clamped: false, reason: "unrecognized" };
  }
  if (levels === null || levels === void 0) {
    return { value: void 0, off: false, clamped: false, reason: "unknown" };
  }
  const table = tableOf(levels);
  if (table.length === 0) {
    return { value: void 0, off: false, clamped: false, reason: "unsupported" };
  }
  if (req === "off") {
    if (allowsOff !== false) {
      return { value: void 0, off: true, clamped: false, reason: "off" };
    }
    return { value: table[0].raw, off: false, clamped: true, reason: "off-fallback" };
  }
  const wanted = requested.trim().toLowerCase();
  const exact = table.find((e) => e.raw.toLowerCase() === wanted) ?? table.find((e) => e.level === req);
  if (exact !== void 0) {
    return { value: exact.raw, off: false, clamped: false, reason: "exact" };
  }
  const rank = LADDER_RANK[req];
  const tieToLow = LOW_SIDE_INPUTS.has(req);
  let best = table[0];
  let bestDelta = Math.abs(best.rank - rank);
  for (const entry of table) {
    const delta = Math.abs(entry.rank - rank);
    if (delta > bestDelta) continue;
    if (delta < bestDelta) {
      best = entry;
      bestDelta = delta;
      continue;
    }
    const wantLow = tieToLow || TIE_PREFER_LOW;
    if (wantLow ? entry.rank < best.rank : entry.rank > best.rank) best = entry;
  }
  return { value: best.raw, off: false, clamped: true, reason: "nearest" };
}

// core/gateway/reasoning-wire.ts
function offWireValue(protocol) {
  if (protocol === "minimax") return void 0;
  return "none";
}

// core/connectors/trae-wire.ts
import { createHash as createHash10, randomUUID as randomUUID3 } from "node:crypto";
var CHAT_PATH = "/api/agent/v3/llm_utils_chat";
var WORKSPACE_ID = "e04cdd";
var DEFAULT_MAX_TOKENS = 4096;
var PROMPT_MAX_TOKENS = 168e3;
var DEFAULT_FUNCTION = "solo_work_lite";
var _IMAGE_PLACEHOLDER = "[图片未发送:trae 通道无法确认该模型支持图像输入]";
function env(name, fallback) {
  if (typeof process === "undefined") return fallback;
  const v = process.env[name];
  return v && v.trim() ? v : fallback;
}
function convertContent(content) {
  if (content === null || content === void 0) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }];
  const parts = [];
  let dropped = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") {
      dropped += 1;
      continue;
    }
    const p = part;
    if (typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
      continue;
    }
    const url = imageUrlOf(p);
    if (url !== null) {
      parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    dropped += 1;
  }
  if (dropped > 0) {
    parts.push({
      type: "text",
      text: _IMAGE_PLACEHOLDER + (dropped > 1 ? `×${dropped}` : "")
    });
  }
  if (parts.length === 0) return [{ type: "text", text: "" }];
  return parts;
}
function imageUrlOf(part) {
  const inner = part.image_url;
  const url = inner && typeof inner === "object" ? inner.url : part.url;
  if (typeof url === "string" && url.trim() !== "") return url;
  return null;
}
function convertHistoryToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const out = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const t = tc;
    const fn = t.function_call ?? t.function;
    if (!fn || typeof fn !== "object") continue;
    const f = fn;
    if (typeof f.name !== "string" || f.name === "") continue;
    out.push({
      id: typeof t.id === "string" ? t.id : null,
      type: "function",
      function_call: { name: f.name, arguments: typeof f.arguments === "string" ? f.arguments : "" }
    });
  }
  return out;
}
function convertMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg;
    const role = typeof m.role === "string" ? m.role : "user";
    const entry = { role, content: convertContent(m.content) };
    if (role === "assistant") {
      const converted = convertHistoryToolCalls(m.tool_calls);
      if (converted.length > 0) entry.tool_calls = converted;
    }
    if (role === "tool" && typeof m.tool_call_id === "string") {
      entry.tool_call_id = m.tool_call_id;
    }
    if (typeof m.name === "string") entry.name = m.name;
    out.push(entry);
  }
  return out;
}
function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool;
    if (!t.function || typeof t.function !== "object") continue;
    const fn = { ...t.function };
    if (typeof fn.parameters === "object" && fn.parameters !== null) {
      fn.parameters = JSON.stringify(fn.parameters);
    }
    out.push({ type: typeof t.type === "string" ? t.type : "function", function: fn });
  }
  return out.length > 0 ? out : null;
}
function normalizeToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return null;
  const tc = toolChoice;
  const fn = tc.function;
  const name = fn && typeof fn === "object" ? fn.name : tc.name;
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  return null;
}
function stableSessionId(sessionKey) {
  if (sessionKey === void 0 || sessionKey === "") return randomUUID3();
  const h = createHash10("sha256").update(`trae-session|${sessionKey}`, "utf-8").digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = b[6] & 15 | 64;
  b[8] = b[8] & 63 | 128;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function buildUpstreamBody(model, messages, identity, optional, requestId) {
  const cleanModel = model.startsWith("trae/") ? model.split("/", 2)[1] ?? model : model;
  const sessionId = stableSessionId(optional.sessionKey);
  const tools = normalizeTools(optional.tools);
  const body = {
    messages: convertMessages(messages),
    model: cleanModel,
    config_name: cleanModel,
    model_name: `${cleanModel}__dev`,
    // ⚠️ 上游必填(见 optional.usage 的长注释):真实模型的缺省是 chat_completion。
    usage: optional.usage ?? "chat_completion",
    function: env("TRAE_FUNCTION", DEFAULT_FUNCTION),
    stream: true,
    max_tokens: optional.max_tokens ?? optional.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    conversation_id: sessionId,
    session_id: sessionId,
    request_id: requestId ?? sessionId,
    user_id: identity.user_id ?? "",
    device_id: identity.device_id,
    machine_id: identity.machine_id,
    project_id: randomUUID3(),
    workspace_id: WORKSPACE_ID,
    prompt_max_tokens: PROMPT_MAX_TOKENS,
    mode: "FunctionCall",
    ide_version: env("TRAE_IDE_VERSION", DEFAULT_IDE_VERSION),
    ide_version_code: env("TRAE_IDE_VERSION_CODE", DEFAULT_IDE_VERSION_CODE),
    app_id: env("TRAE_APP_ID", APP_ID),
    package_type: "stable_cn"
  };
  if (tools) body.tools = tools;
  const choice = normalizeToolChoice(optional.tool_choice);
  if (choice) body.tool_choice = choice;
  if (typeof optional.temperature === "number" && Number.isFinite(optional.temperature)) {
    body.temperature = optional.temperature;
  }
  if (typeof optional.reasoning_effort === "string" && optional.reasoning_effort !== "") {
    body.reasoning_effort = optional.reasoning_effort;
  }
  return body;
}
function resolveChatUrl(baseUrl, region, extra) {
  return resolve_api_base(baseUrl, region, extra) + CHAT_PATH;
}
function decodeTraeEvent(event, data) {
  if (data.trim() === "[DONE]") return { kind: "done", finish_reason: null };
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return { kind: "unknown", event };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "unknown", event };
  }
  const p = payload;
  if (event === "request_wait_in_queue") {
    return {
      kind: "queue",
      position: typeof p.position === "number" && Number.isFinite(p.position) ? p.position : null
    };
  }
  if (event === "progress_notice") return { kind: "progress", notice: payload };
  if (event === "token_usage") {
    return { kind: "usage", usage: toOpenAIUsage(payload) };
  }
  if (event === "done" || typeof p.finish_reason === "string" && !String(p.finish_reason).includes("response")) {
    return { kind: "done", finish_reason: typeof p.finish_reason === "string" ? p.finish_reason : "stop" };
  }
  if (event === "error" || (typeof p.code === "number" || typeof p.code === "bigint") && Number(p.code) >= 4e3) {
    return {
      kind: "error",
      code: typeof p.code === "number" ? Number(p.code) : null,
      message: typeof p.message === "string" ? p.message : "",
      extra: p.extra
    };
  }
  if (event === "output" || "response" in p || "reasoning_content" in p) {
    return {
      kind: "delta",
      text: typeof p.response === "string" ? p.response : "",
      reasoning: typeof p.reasoning_content === "string" ? p.reasoning_content : null,
      tool_calls: p.tool_calls
    };
  }
  return { kind: "unknown", event };
}
function toOpenAIUsage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const p = payload;
  const usage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    const v = p[key];
    if (typeof v === "number" && Number.isFinite(v) && typeof v !== "boolean") {
      usage[key] = Math.trunc(v);
    }
  }
  const firstPositive = (keys, nested) => {
    for (const k of keys) {
      const v = (nested ?? p)[k];
      if (typeof v === "number" && Number.isFinite(v) && v !== 0) return Math.trunc(v);
    }
    return null;
  };
  const details = {};
  const rt = p["reasoning_tokens"];
  if (typeof rt === "number" && Number.isFinite(rt) && rt !== 0) {
    details["reasoning_tokens"] = Math.trunc(rt);
  }
  const ptd = p["prompt_tokens_details"] !== null && typeof p["prompt_tokens_details"] === "object" ? p["prompt_tokens_details"] : null;
  const cached = firstPositive([
    "cache_read_input_tokens",
    "cached_tokens",
    "prompt_cache_hit_tokens",
    "cache_read_tokens",
    "cache_hit_tokens"
  ]) ?? (ptd !== null ? firstPositive(["cached_tokens", "cache_read_input_tokens"], ptd) : null);
  if (cached !== null) details["cached_tokens"] = cached;
  const write = firstPositive([
    "cache_creation_input_tokens",
    "cache_write_tokens",
    "prompt_cache_miss_tokens"
  ]);
  if (write !== null) details["cache_write_tokens"] = write;
  if (Object.keys(details).length > 0) {
    usage["prompt_tokens_details"] = details;
  }
  return usage;
}
function normalizeToolCallDelta(raw, fallbackIndex, ids, idPrefix) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw;
  const fnRaw = r.function_call ?? r.function;
  const fn = fnRaw && typeof fnRaw === "object" ? fnRaw : {};
  const index = typeof r.index === "number" && Number.isInteger(r.index) ? r.index : fallbackIndex;
  const rawId = typeof r.id === "string" && r.id !== "" ? r.id : null;
  if (rawId && !ids.has(index)) ids.set(index, rawId);
  const callId = ids.get(index) ?? `call_${idPrefix}_${index}`;
  ids.set(index, callId);
  const name = typeof fn.name === "string" && fn.name !== "" ? fn.name : null;
  const args = typeof fn.arguments === "string" && fn.arguments !== "" ? fn.arguments : "";
  return {
    index,
    id: callId,
    type: "function",
    function: name !== null ? { name, arguments: args } : { arguments: args }
  };
}
function makeChunk(completionId, created, model, delta, finishReason = null, usage = null) {
  return {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage
  };
}
var TraeSseParser = class {
  buffer = "";
  event = null;
  data = [];
  /** 喂入 chunk,返回完整事件对列表(可能为空)。 */
  push(chunk) {
    this.buffer += chunk;
    const out = [];
    let match;
    const newline = /\r?\n/;
    while ((match = newline.exec(this.buffer)) !== null) {
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const ev = this.consumeLine(line);
      if (ev) out.push(ev);
    }
    return out;
  }
  /** 流结束:冲刷残余缓冲。 */
  finish() {
    const out = [];
    if (this.buffer !== "") {
      const ev = this.consumeLine(this.buffer);
      if (ev) out.push(ev);
      this.buffer = "";
    }
    const dispatched = this.dispatch();
    if (dispatched) out.push(dispatched);
    return out;
  }
  consumeLine(line) {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      this.event = value;
      return null;
    }
    if (field === "data") {
      this.data.push(value);
      return null;
    }
    return null;
  }
  dispatch() {
    if (this.data.length === 0) {
      this.event = null;
      return null;
    }
    const result = [this.event ?? "", this.data.join("\n")];
    this.event = null;
    this.data = [];
    return result;
  }
};
var TraeChunkBuilder = class {
  constructor(completionId, created, model) {
    this.completionId = completionId;
    this.created = created;
    this.model = model;
    this.idPrefix = completionId.replace(/^chatcmpl-/, "").slice(0, 16);
  }
  completionId;
  created;
  model;
  sawToolCalls = false;
  usage = null;
  ids = /* @__PURE__ */ new Map();
  idPrefix;
  opened = false;
  finished = false;
  /** 喂入解码事件,产出 chunk(可能为空数组)。 */
  feed(events) {
    if (this.finished) return [];
    const out = [];
    for (const decoded of events) {
      if (this.finished) return out;
      if (decoded.kind === "delta") {
        const delta = {};
        if (decoded.reasoning && decoded.reasoning !== "") {
          delta.reasoning_content = decoded.reasoning;
        }
        const text = decoded.text ?? "";
        if (text !== "") delta.content = text;
        let normalized = [];
        if (Array.isArray(decoded.tool_calls)) {
          for (let i = 0; i < decoded.tool_calls.length; i++) {
            const norm = normalizeToolCallDelta(decoded.tool_calls[i], i, this.ids, this.idPrefix);
            if (norm) normalized.push(norm);
          }
        }
        if (normalized.length > 0) {
          delta.tool_calls = normalized;
          this.sawToolCalls = true;
        }
        if (Object.keys(delta).length === 0) continue;
        if (!this.opened) {
          this.opened = true;
          const withRole = { role: "assistant", ...delta };
          out.push(makeChunk(this.completionId, this.created, this.model, withRole));
        } else {
          out.push(makeChunk(this.completionId, this.created, this.model, delta));
        }
      } else if (decoded.kind === "usage") {
        this.usage = decoded.usage ?? {};
      } else if (decoded.kind === "done") {
        let finishReason = decoded.finish_reason ?? "stop";
        if (this.sawToolCalls && finishReason === "stop") finishReason = "tool_calls";
        this.finished = true;
        out.push(makeChunk(this.completionId, this.created, this.model, {}, finishReason, this.usage));
      } else if (decoded.kind === "error") {
        throw this.soloError(decoded);
      }
    }
    return out;
  }
  /** 整条流读完后再调:补发收尾块。 */
  finish() {
    if (this.finished) return [];
    this.finished = true;
    return [
      makeChunk(
        this.completionId,
        this.created,
        this.model,
        {},
        this.sawToolCalls ? "tool_calls" : "stop",
        this.usage
      )
    ];
  }
  soloError(decoded) {
    if (typeof decoded.code === "number") {
      return classifySoloError(decoded.code);
    }
    return new UpstreamError2("bad_request", decoded.message || "trae 流内错误", false, 400);
  }
};
function classifySoloError(code) {
  if (code === 1005) return new UpstreamError2("rate_limit", "套餐额度耗尽", true, 429);
  if (code === 4001 || code === 4002) return new UpstreamError2("bad_request", "模型配置错误", false, 400);
  if (code === 401 || code === 403) return new UpstreamError2("auth", "账号已失效", false, 401);
  if (code === 4008 || code === 4011 || code === 429) return new UpstreamError2("rate_limit", "请求过于频繁", true, 429);
  if (code >= 500) return new UpstreamError2("upstream", "上游错误", true, code);
  return new UpstreamError2("bad_request", "请求错误", false, 400);
}
function prepareTraeRequest(w) {
  const url = resolveChatUrl(w.baseUrl, w.region, w.extra);
  const sessionKey = (typeof w.req.prompt_cache_key === "string" && w.req.prompt_cache_key !== "" ? w.req.prompt_cache_key : void 0) ?? (typeof w.extra?.["session_id"] === "string" && w.extra["session_id"] !== "" ? w.extra["session_id"] : void 0);
  const body = buildUpstreamBody(
    w.req.model,
    w.req.messages,
    w.identity,
    {
      temperature: w.req.temperature,
      max_tokens: w.req.max_tokens,
      tools: w.req.tools,
      tool_choice: w.req.tool_choice,
      reasoning_effort: w.req.reasoning_effort,
      sessionKey
    },
    w.requestId
  );
  return { url, body };
}
function identityFromExtra(apiKey, extra) {
  const identity = resolve_identity(apiKey, extra);
  return {
    user_id: typeof extra?.["user_id"] === "string" ? extra["user_id"] : void 0,
    machine_id: identity.machine_id,
    device_id: identity.device_id
  };
}

// core/connectors/workbuddy-wire.ts
var CHAT_PATH2 = "/v2/chat/completions";
var XML_TOOL_OPEN = "<tool_call>";
var XML_TOOL_CLOSE = "</tool_call>";
var XML_TOOL_FN = "<function=";
var XML_TOOL_OPEN_RE = /^\s*<tool_call>/m;
function buildWorkbuddyBody(req) {
  const body = {
    model: req.model,
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: true }
  };
  const maxTokens = req.max_tokens ?? req.max_completion_tokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) {
    body.max_tokens = maxTokens;
  }
  if (typeof req.temperature === "number" && Number.isFinite(req.temperature)) {
    body.temperature = req.temperature;
  }
  if (typeof req.top_p === "number" && Number.isFinite(req.top_p)) {
    body.top_p = req.top_p;
  }
  if (Array.isArray(req.stop) && req.stop.length > 0) {
    body.stop = req.stop;
  }
  if (req.tools) body.tools = req.tools;
  if (req.tool_choice) body.tool_choice = req.tool_choice;
  if (req.reasoning_effort) body.reasoning_effort = req.reasoning_effort;
  return body;
}
var XmlToolCallCopyFilter = class {
  seenStructured = false;
  buf = null;
  /** 喂入一段文本,返回应外发的部分。 */
  feed(text) {
    if (text === "") return "";
    if (this.buf !== null) return this.drain(text);
    const openAt = this.findOpen(text);
    if (openAt === -1) return text;
    return text.slice(0, openAt) + this.open(text.slice(openAt));
  }
  /** 流结束:丢弃未闭合缓冲。 */
  finish() {
    if (this.buf !== null) {
      this.buf = null;
    }
    return "";
  }
  /** 缓冲内追加,寻找闭合标记(闭合标签本身计入缓冲段)。 */
  drain(text) {
    const closeAt = text.indexOf(XML_TOOL_CLOSE);
    if (closeAt === -1) {
      this.buf.push(text);
      return "";
    }
    this.buf.push(text.slice(0, closeAt + XML_TOOL_CLOSE.length));
    const segment = this.buf.join("");
    this.buf = null;
    return this.decide(segment) + this.feed(text.slice(closeAt + XML_TOOL_CLOSE.length));
  }
  /** 开启缓冲(首段可能同帧闭合)。 */
  open(text) {
    const closeAt = text.indexOf(XML_TOOL_CLOSE);
    if (closeAt !== -1) {
      const segment = text.slice(0, closeAt + XML_TOOL_CLOSE.length);
      return this.decide(segment) + this.feed(text.slice(closeAt + XML_TOOL_CLOSE.length));
    }
    this.buf = [text];
    return "";
  }
  /** 闭合段去向:seen_structured 时丢弃,否则原样外发。 */
  decide(segment) {
    return this.seenStructured ? "" : segment;
  }
  /** 找开启位置:行首 <tool_call> 优先;seen_structured 后任意位置也认。 */
  findOpen(text) {
    const m = XML_TOOL_OPEN_RE.exec(text);
    if (m) return m.index;
    if (!this.seenStructured) return -1;
    const openAt = text.indexOf(XML_TOOL_OPEN);
    if (openAt !== -1) return openAt;
    return text.indexOf(XML_TOOL_FN);
  }
};
function filterWorkbuddyChunk(chunk, flt) {
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return chunk;
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const c = choice;
    const delta = c.delta;
    if (!delta || typeof delta !== "object") continue;
    const d = delta;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) {
      flt.seenStructured = true;
    }
    if (typeof d.content !== "string" || d.content === "") continue;
    const text = flt.feed(d.content);
    if (text !== "") {
      d.content = text;
    } else {
      delete d.content;
    }
  }
  return chunk;
}
function decorateWorkbuddyChunk(chunk, completionId, created, model) {
  return {
    ...chunk,
    id: chunk.id ?? completionId,
    object: "chat.completion.chunk",
    created: chunk.created ?? created,
    model: chunk.model ?? model
  };
}
function resolveWorkbuddyChatUrl(baseUrl, region) {
  const base = (baseUrl && baseUrl.trim() ? baseUrl.trim() : REGION_BASES2[normalize_region2(region)]).replace(/\/+$/, "");
  return base + CHAT_PATH2;
}

// src/gateway-upstream-body.ts
function mergeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    const existing = Object.keys(out).find((k) => k.toLowerCase() === lower);
    if (existing === void 0) {
      out[key] = value;
    } else {
      out[existing] = value;
    }
  }
  return out;
}
function upstreamHeaders(headers) {
  return mergeHeaders({ "content-type": "application/json", ...headers });
}
function sessionOf(req) {
  const v = req.extra?.session_id;
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function cacheRoutingKeyOf(req) {
  const v = req.prompt_cache_key;
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function affinityKeyOf(req) {
  return cacheRoutingKeyOf(req) ?? sessionOf(req);
}
function toRouterChain(chain) {
  return chain.map((item) => {
    const ep = item.endpoint;
    return chainItemFrom({
      endpoint: {
        endpointId: ep.endpointId,
        provider: ep.provider,
        model: ep.model,
        credentialKey: ep.credentialKey,
        protocol: ep.protocol,
        baseUrl: ep.baseUrl,
        region: ep.region,
        concurrency: ep.concurrency,
        supportsVision: ep.supportsVision,
        maxInputTokens: ep.maxInputTokens,
        maxOutputTokens: ep.maxOutputTokens,
        cooldownUntil: ep.cooldownUntil
      },
      priority: item.priority,
      blackout: item.blackout,
      strategy: item.strategy,
      // ⚠️ degraded 必须搬过去:least-busy / balanced 由 Router 按实时在途裁决,
      // 完全不看链序 —— 丢了它,用户在 P4 里配的「少用」对这两种策略就失效
      // (2026-11-07 修 P4 未生效的一部分)。
      degraded: item.degraded,
      // ⚠️ direct 必须搬过去:router 的 plan(ignoreCooldown)与
      // commit(acquireDirect 抢占)都按它判定是不是「真实模型直连」。
      direct: item.direct
    });
  });
}
function completionIdOf() {
  return `chatcmpl-${Math.floor(performance.now()).toString(16)}`;
}
function createdOf() {
  return Math.floor(Date.now() / 1e3);
}
function bodyForProtocol(providerId, protocol, req, creds) {
  const codec = wireCodecFor(protocol);
  if (codec !== void 0) {
    const model = protocol === "minimax" ? minimaxUpstreamModelOf(String(req.model ?? "")) : String(req.model ?? "");
    return codec.encodeBody(
      req,
      model,
      typeof req.reasoning_effort === "string" ? req.reasoning_effort : void 0,
      creds,
      // 有块投影就走「blocks → messages」（一次形状转换），否则退回 chat 体。
      { blocks: req.blocks, maxTokens: req.max_tokens }
    );
  }
  if (protocol === "codearts") {
    return buildCodeartsBody(
      {
        model: String(req.model ?? ""),
        messages: req.messages,
        stream: req.stream === true,
        ...req.temperature !== void 0 ? { temperature: req.temperature } : {},
        ...req.max_tokens !== void 0 ? { max_tokens: req.max_tokens } : {},
        ...req.top_p !== void 0 ? { top_p: req.top_p } : {},
        ...req.stop !== void 0 ? { stop: req.stop } : {},
        ...req.tools !== void 0 ? { tools: req.tools } : {},
        ...req.tool_choice !== void 0 ? { tool_choice: req.tool_choice } : {}
      },
      String(req.model ?? "")
    );
  }
  if (protocol === "trae") {
    const identity = identityFromExtra(creds["apiKey"] ?? "", creds);
    return prepareTraeRequest({
      req,
      identity,
      baseUrl: creds["base_url"],
      region: creds["region"],
      extra: creds
    }).body;
  }
  if (isWorkbuddyWire(protocol) || protocol === "sensenova") {
    const body = buildWorkbuddyBody(req);
    if (isWorkbuddyWire(protocol)) {
      const rewritten = rewriteHostIdentity(body.messages);
      if (rewritten !== body.messages) body.messages = rewritten;
    }
    return body;
  }
  if (protocol === "qoder") {
    const body = bodyFor(req);
    const rewritten = rewriteHostIdentity(body.messages);
    if (rewritten !== body.messages) body.messages = rewritten;
    return body;
  }
  return bodyFor(req);
}
function bodyFor(req) {
  const body = {
    model: req.model,
    messages: req.messages,
    stream: req.stream
  };
  if (req.stream === true) {
    body.stream_options = { include_usage: true };
  }
  for (const key of [
    "temperature",
    "max_tokens",
    "top_p",
    "stop",
    "tools",
    "tool_choice",
    "reasoning_effort"
  ]) {
    const v = req[key];
    if (v !== void 0) body[key] = v;
  }
  if (req.extra) {
    for (const [k, v] of Object.entries(req.extra)) {
      if (k === "session_id" || k === CACHE_ROUTING_KEY_FIELD) continue;
      if (v !== void 0) body[k] = v;
    }
  }
  delete body[CACHE_ROUTING_KEY_FIELD];
  return body;
}
function hasVision(messages) {
  const asBridge = messages;
  if (imagePartIndices(asBridge).length > 0) return true;
  return messages.some((m) => {
    const content = m?.content;
    return typeof content === "string" && content.includes("data:image");
  });
}

// src/gateway-upstream-errors.ts
var CONNECTOR_KIND_TO_GATEWAY = {
  rate_limit: UpstreamErrorKind.RateLimit,
  auth: UpstreamErrorKind.Auth,
  auth_challenge: UpstreamErrorKind.AuthChallenge,
  upstream: UpstreamErrorKind.Upstream,
  bad_request: UpstreamErrorKind.BadRequest,
  timeout: UpstreamErrorKind.Timeout,
  connection: UpstreamErrorKind.Connection,
  pool_saturated: UpstreamErrorKind.RateLimit,
  pool_exhausted: UpstreamErrorKind.RateLimit
};
function isWorkbuddyBanError(err) {
  return /(?<!\d)11140(?!\d)/.test(err.detail);
}
function isWorkbuddyChannelReject(err, protocol) {
  if (protocol !== "workbuddy") return false;
  if (err.kind !== UpstreamErrorKind.BadRequest) return false;
  return isChannelRejectDetail(err.detail);
}
var MAX_HONORED_RETRY_AFTER_S = 86400;
function cooldownUntilOf(gerr) {
  if (gerr.retryAfter === void 0) return void 0;
  const secs = Number(gerr.retryAfter);
  if (!Number.isFinite(secs) || secs < 0) return void 0;
  return Date.now() / 1e3 + Math.min(secs, MAX_HONORED_RETRY_AFTER_S);
}
function canFailover(gerr, provider) {
  if (isWorkbuddyBanError(gerr)) return false;
  if (isStickyNoSwitchProvider(provider) && gerr.kind === UpstreamErrorKind.RateLimit) {
    return false;
  }
  return gerr.kind !== UpstreamErrorKind.BadRequest && gerr.kind !== UpstreamErrorKind.AuthChallenge;
}
function canFailoverMember(gerr, opts) {
  if (isWorkbuddyBanError(gerr)) return false;
  if (gerr.kind === UpstreamErrorKind.BadRequest || gerr.kind === UpstreamErrorKind.AuthChallenge) {
    return false;
  }
  if (gerr.kind === UpstreamErrorKind.RateLimit && isStickyNoSwitchProvider(opts.provider)) {
    return opts.alternativeChannel;
  }
  return true;
}
var LOGICAL_SWITCH_DELAY_S = 0.2;
function failoverDecision(input) {
  if (input.direct) {
    return {
      allowed: canFailover(input.gerr, input.provider) && input.policy.shouldRetry(input.gerr),
      delayS: input.policy.delayFor(input.attempt)
    };
  }
  return {
    allowed: canFailoverMember(input.gerr, {
      provider: input.provider,
      alternativeChannel: input.alternativeChannel
    }),
    delayS: LOGICAL_SWITCH_DELAY_S * Math.max(1, input.attempt)
  };
}
function isReasoningEffortRejection(detail) {
  if (detail.length === 0) return false;
  return /reasoning[_ ]?effort/i.test(detail) || /unsupported.*(reasoning|thinking)/i.test(detail);
}
function toGatewayError(err) {
  if (err instanceof UpstreamError) return err;
  if (err !== null && typeof err === "object" && typeof err.kind === "string" && typeof err.httpStatus === "number") {
    const ce = err;
    const kind = CONNECTOR_KIND_TO_GATEWAY[ce.kind] ?? UpstreamErrorKind.Upstream;
    return new UpstreamError(kind, ce.message || "上游错误", {
      statusCode: ce.httpStatus,
      ...typeof ce.retryAfter === "number" ? { retryAfter: ce.retryAfter } : {},
      // 连接器若带了上游原件(逐字透传),原封不动接过去。
      ...ce.raw !== void 0 ? { raw: ce.raw } : {}
    });
  }
  if (err instanceof Error) {
    const cause = err.cause;
    const code = err.code ?? cause?.code;
    const name = err.name === "TimeoutError" ? "TimeoutError" : cause?.name ?? err.name;
    if (name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
      return new UpstreamError(UpstreamErrorKind.Timeout, err.message, { statusCode: 504 });
    }
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "EPIPE" || code === "EAI_AGAIN" || code === "UND_ERR_SOCKET") {
      const detail = cause?.message ?? err.message;
      return new UpstreamError(UpstreamErrorKind.Connection, detail, { statusCode: 502 });
    }
    if (name === "AbortError") {
      return new UpstreamError(UpstreamErrorKind.Timeout, `上游连接超时:${err.message}`, {
        statusCode: 504
      });
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return new UpstreamError(UpstreamErrorKind.Upstream, message, { statusCode: 502 });
}
function httpStatusOf(err) {
  return err.httpStatus;
}

// src/gateway-upstream-peers.ts
async function connectorExtra(vault, provider, username) {
  try {
    const cred = await vault.get(provider, username);
    const raw = cred?.raw ?? {};
    const out = {};
    const region = raw["region"];
    if (typeof region === "string" && region.trim() !== "") out.region = region.trim();
    for (const key of ["uid", "user_id", "domain", "enterprise_id", "machine_id", "device_id", "api_base"]) {
      const v = raw[key];
      if (typeof v === "string" && v.trim() !== "") out[key] = v.trim();
    }
    for (const key of ["accessKey", "secretKey", "securityToken", "domainId"]) {
      const v = raw[key];
      if (typeof v === "string" && v.trim() !== "") out[key] = v.trim();
    }
    const expiresAtMs = raw["expiresAtMs"];
    if (typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs)) out.expiresAtMs = expiresAtMs;
    if (raw["quirks"] !== void 0) out.quirks = raw["quirks"];
    return out;
  } catch {
    return {};
  }
}
async function runSensenova(peer, body, model, signal) {
  const connector = peer.connector;
  return connector.runWithAccount(peer.url, body, model, peer.creds, signal);
}
async function runQoder(peer, body, model, signal) {
  const connector = peer.connector;
  if (connector === void 0 || typeof connector.runWithAccount !== "function") {
    throw new UpstreamError(UpstreamErrorKind.Auth, "Qoder 连接器未注册(protocol=qoder)", {
      statusCode: 500
    });
  }
  const key = typeof body["model"] === "string" && body["model"] !== "" ? body["model"] : model;
  return connector.runWithAccount(peer.url, body, key, peer.creds, signal);
}
function codeartsSignedHeaders(peer, url, body, base = {}) {
  const creds = peer.creds ?? {};
  const { accessKey, secretKey } = requireCodeartsKeys(creds);
  const model = typeof body["model"] === "string" ? body["model"] : "";
  const headers = {
    ...base,
    ...codeartsIdentityHeaders({
      accessKey,
      ...model !== "" ? { model } : {},
      ...typeof creds.domainId === "string" ? { domainId: creds.domainId } : {}
    })
  };
  return signCodeartsRequest({
    accessKey,
    secretKey,
    ...typeof creds.securityToken === "string" && creds.securityToken !== "" ? { securityToken: creds.securityToken } : {},
    method: "POST",
    url,
    headers,
    body: JSON.stringify(body)
  }).headers;
}
async function preparePeer(item, vault, options = {}) {
  const ep = item.endpoint;
  const provider = ep.provider;
  const username = ep.credentialKey[1];
  const secret = await vault.secret(provider, username);
  const connector = getConnector(ep.protocol);
  const extra = await connectorExtra(vault, provider, username);
  const protocol = ep.protocol;
  const baseUrl = (ep.baseUrl || "").trim().replace(/\/+$/, "");
  const creds = {
    apiKey: secret ?? void 0,
    username: secret == null ? username : void 0,
    base_url: baseUrl,
    ...extra
  };
  let url;
  const region = ep.region ?? void 0;
  if (protocol === "trae") {
    url = resolveChatUrl(baseUrl || void 0, region, creds);
  } else if (isWorkbuddyWire(protocol)) {
    url = resolveWorkbuddyChatUrl(baseUrl || void 0, extra["region"] ?? region);
  } else if (protocol === "sensenova") {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    url = `${base}/chat/completions`;
  } else if (protocol === "minimax") {
    const mmRegion = (typeof extra["region"] === "string" ? extra["region"] : region) ?? "";
    const fallback = mmRegion === "global" ? MINIMAX_BASE_GLOBAL : MINIMAX_BASE_CN;
    const base = (baseUrl || fallback).replace(/\/+$/, "");
    url = `${base}${MINIMAX_LLM_PATH}`;
  } else if (protocol === "qoder") {
    const qRegion = regionOfCreds(creds, "qoder");
    const cfg = QODER_REGION_CONFIGS[qRegion];
    const base = (baseUrl || cfg.gateway).replace(/\/+$/, "");
    url = `${base}${cfg.chatPath}`;
  } else if (protocol === "anthropic") {
    url = anthropicMessagesUrl(baseUrl);
    if (url === "") {
      throw new UpstreamError(UpstreamErrorKind.BadRequest, `[anthropic] provider ${provider} 未配置 base_url`, {
        statusCode: 500
      });
    }
  } else if (protocol === "codearts") {
    const base = (baseUrl || CODEARTS_BASE_CN).replace(/\/+$/, "");
    url = `${base}${CODEARTS_CHAT_PATH}`;
  } else {
    url = `${baseUrl || ""}/chat/completions`;
  }
  let headers = {};
  let connectorRef = connector;
  if (isWorkbuddyWire(protocol) && options.selfCheck) {
    const verdict = await options.selfCheck({
      username,
      creds: {
        token: secret ?? "",
        ...typeof extra["region"] === "string" ? { region: extra["region"] } : {},
        ...typeof extra["uid"] === "string" ? { uid: extra["uid"] } : {},
        ...typeof extra["enterprise_id"] === "string" ? { enterpriseId: extra["enterprise_id"] } : {}
      }
    });
    if (!verdict.ok) {
      throw new UpstreamError(UpstreamErrorKind.Auth, verdict.message, { statusCode: 403 });
    }
  }
  if (protocol === "qoder") {
    headers = { ...QODER_DEFAULT_HEADERS };
    return { url, headers, connector: connectorRef, creds };
  }
  if (protocol === "codearts") {
    return { url, headers: {}, connector: connectorRef, creds };
  }
  if (connector) {
    try {
      const token = await connector.getToken(creds);
      headers = connector.decorateRequest({ headers: {} }, token, creds).headers ?? {};
    } catch (err) {
      throw toGatewayError(err);
    }
  } else {
    if (secret) headers.Authorization = `Bearer ${secret}`;
    connectorRef = void 0;
  }
  return { url, headers, connector: connectorRef, creds };
}
async function classifyResponse(res, connector) {
  const text = await res.text();
  let body = text;
  let parsed = false;
  try {
    body = JSON.parse(text);
    parsed = true;
  } catch {
  }
  const detail = typeof body === "object" && body !== null ? body.error?.message ?? body.detail ?? text.slice(0, 200) : text.slice(0, 200);
  const raw = rawResponseOf(res, text, parsed ? body : void 0);
  if (connector) {
    try {
      const ce = connector.classifyError(res.status, body, headerRecord(res.headers));
      const kind2 = CONNECTOR_KIND_TO_GATEWAY[ce.kind] ?? UpstreamErrorKind.Upstream;
      return new UpstreamError(kind2, ce.message || detail, {
        statusCode: ce.httpStatus || res.status,
        retryAfter: ce.retryAfter,
        raw
      });
    } catch {
    }
  }
  const fallback = classify_openai_error(res.status, body, headerRecord(res.headers));
  const kind = CONNECTOR_KIND_TO_GATEWAY[fallback.kind] ?? UpstreamErrorKind.Upstream;
  return new UpstreamError(kind, fallback.message || detail, {
    statusCode: fallback.httpStatus || res.status,
    retryAfter: fallback.retryAfter,
    raw
  });
}
function rawResponseOf(res, text, json) {
  const raw = {
    text: text.length > RAW_BODY_MAX ? text.slice(0, RAW_BODY_MAX) : text,
    status: res.status
  };
  if (json !== void 0) raw.json = json;
  const contentType = res.headers.get("content-type");
  if (contentType !== null && contentType !== "") raw.contentType = contentType;
  return raw;
}
function headerRecord(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
async function postWorkbuddyWithGate(url, headers, body, signal, connector, fetchFn = fetch) {
  const originalMessages = Array.isArray(body.messages) ? body.messages : [];
  const res = await fetchFn(url, {
    method: "POST",
    headers: upstreamHeaders(headers),
    body: JSON.stringify(body),
    signal
  });
  if (res.ok) return res;
  const err = await classifyResponse(res, connector);
  if (!isChannelRejectDetail(err.detail)) {
    return Promise.reject(err);
  }
  return Promise.reject(
    new UpstreamError(err.kind, `${channelRejectMessage(originalMessages)}
${err.detail}`, {
      statusCode: err.httpStatus,
      ...err.retryAfter !== void 0 ? { retryAfter: err.retryAfter } : {},
      ...err.raw !== void 0 ? { raw: err.raw } : {}
    })
  );
}

// src/gateway-upstream-stream.ts
var SSE_DONE = "[DONE]";
function isSseDoneLine(line) {
  return line.startsWith("data:") && line.slice("data:".length).trim() === SSE_DONE;
}
async function* rawLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        yield line;
        if (isSseDoneLine(line)) {
          await reader.cancel().catch(() => {
          });
          return;
        }
      }
    }
    const tail = buf.trim();
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }
}
function sseDataPayload2(line) {
  if (!line.startsWith("data:")) return null;
  const data = line.slice("data:".length).trim();
  if (data === "" || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
async function* iterUpstreamChunks(body, protocol, meta, providerId = "") {
  if (protocol === "trae") {
    const parser = new TraeSseParser();
    const builder = new TraeChunkBuilder(meta.completionId, meta.created, meta.model);
    for await (const line of rawLines(body)) {
      for (const [event, data] of parser.push(`${line}
`)) {
        const decoded = decodeTraeEvent(event, data);
        for (const chunk of builder.feed([decoded])) {
          yield chunk;
        }
      }
    }
    for (const chunk of parser.finish().flatMap(([event, data]) => {
      const decoded = decodeTraeEvent(event, data);
      return builder.feed([decoded]);
    })) {
      yield chunk;
    }
    for (const chunk of builder.finish()) {
      yield chunk;
    }
    return;
  }
  if (wireFamilyOf(protocol) === "anthropic") {
    const tr = createAnthropicChunkTranslator(meta);
    for await (const line of rawLines(body)) {
      if (isSseDoneLine(line)) return;
      const obj = sseDataPayload2(line);
      if (obj === null || typeof obj !== "object") continue;
      const upstreamError = anthropicErrorOf(obj);
      if (upstreamError !== null) {
        throw new UpstreamError(UpstreamErrorKind.Upstream, `[${providerId || protocol}] 流中错误:${upstreamError}`, {
          statusCode: 502
        });
      }
      for (const chunk of tr.handle(obj)) {
        yield chunk;
      }
      if (tr.finished) return;
    }
    return;
  }
  if (isWorkbuddyWire(protocol)) {
    const flt = new XmlToolCallCopyFilter();
    for await (const line of rawLines(body)) {
      const obj = sseDataPayload2(line);
      if (obj === null || typeof obj !== "object") continue;
      const chunk = filterWorkbuddyChunk(obj, flt);
      yield decorateWorkbuddyChunk(chunk, meta.completionId, meta.created, meta.model);
    }
    flt.finish();
    return;
  }
  for await (const line of rawLines(body)) {
    const obj = sseDataPayload2(line);
    if (obj === null || typeof obj !== "object") continue;
    const raw = obj;
    if (protocol === "sensenova") {
      const choices2 = raw.choices;
      if ((!Array.isArray(choices2) || choices2.length === 0) && raw.usage == null) continue;
    }
    const choices = raw.choices;
    if ((!Array.isArray(choices) || choices.length === 0) && raw.usage == null) continue;
    yield raw;
  }
}

// src/gateway-upstream.ts
function DEFAULT_RETRY_POLICY(abstract) {
  return new RetryPolicy({
    maxAttempts: abstract ? 1 : 10,
    cooldownFloorS: 15 * 60,
    baseS: 1,
    factor: DEFAULT_FACTOR,
    capS: 15,
    jitterRatio: 0.2,
    codes: new Set(
      "timeout,connection,429,500,502,503,504".split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "")
    )
  });
}
var STREAM_CONNECT_TIMEOUT_MS = 6e4;
function armConnectTimeout(abort, seconds) {
  if (!(seconds > 0)) return null;
  return setTimeout(() => abort.abort(), Math.round(seconds * 1e3));
}
var MAX_FAILOVER_ATTEMPTS = 10;
function sleepMs(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function clampMaxTokens(clientMax, memberCap, logicalCap) {
  if (memberCap === null || memberCap === void 0 || !Number.isFinite(memberCap) || memberCap <= 0) {
    return clientMax;
  }
  if (clientMax === void 0) return memberCap;
  if (logicalCap !== null && logicalCap !== void 0 && clientMax === logicalCap) {
    return memberCap;
  }
  return Math.min(clientMax, memberCap);
}
function hasAlternativeChannel(chain, tried, provider) {
  return chain.some(
    (it) => it.endpoint.provider !== provider && !tried.has(it.endpoint.endpointId)
  );
}
function wireProtocolOf(protocol) {
  return protocol === "qoder" || protocol === "codearts" ? "openai" : protocol;
}
function buildResolveUpstream(runtime) {
  const { scheduler, router, vault } = runtime;
  let warnedNoVisionRoute = false;
  const logicalOutputCapOf = (logicalName) => runtime.logicalOutputCap?.(logicalName) ?? null;
  const policyOf = (abstract) => runtime.retryPolicy?.(abstract) ?? DEFAULT_RETRY_POLICY(abstract);
  const requestTimeoutMs = () => runtime.requestTimeoutMs?.() ?? STREAM_CONNECT_TIMEOUT_MS / 1e3;
  const remainingBudgetS = (startedAtMs) => {
    const total = requestTimeoutMs();
    if (!(total > 0)) return 0;
    const elapsed = (performance.now() - startedAtMs) / 1e3;
    return Math.max(0, total - elapsed);
  };
  const reserveWorkbuddySlot = async (item, signal) => {
    const throttle = runtime.workbuddyThrottle;
    if (!throttle || !isWorkbuddyWire(item.endpoint.protocol)) return;
    try {
      await throttle(item.endpoint.credentialKey[1], signal);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new UpstreamError(UpstreamErrorKind.Connection, "客户端断开");
      }
      throw toGatewayError(err);
    }
  };
  return function resolveUpstream(model) {
    let chain = [];
    try {
      chain = scheduler.chain(model);
    } catch (err) {
      console.error(`[as-one] scheduler.chain("${model}") failed:`, err);
      return void 0;
    }
    if (chain.length === 0) return void 0;
    const routerChain = toRouterChain(chain);
    const directRequest = routerChain.length > 0 && routerChain.every((i) => i.direct === true);
    const visionRoute = runtime.routes?.().vision;
    const parseOneImage = async (part, sessionId) => {
      if (visionRoute === void 0) return null;
      const visionUpstream = resolveUpstream(visionRoute);
      if (!visionUpstream) {
        if (!warnedNoVisionRoute) {
          warnedNoVisionRoute = true;
          console.warn(`[as-one] 图像解析车道不可用:${visionRoute}(库里没有这个模型),带图请求将原样放行`);
        }
        return null;
      }
      const parseSession = `${sessionId}:vision-parse`;
      try {
        const data = await visionUpstream.complete({
          model: visionRoute,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: FREE_PARSE_PROMPT },
                part
              ]
            }
          ],
          stream: false,
          // 「解析时关闭思考」—— 图片解析要的是快和准的证据,不是深度推理。
          // ⚠️ **不传 max_tokens**(用户 m06638①「不限制最大输出 token」,
          // 2026-10-24 定案):以前钉死 768,四段证据经常被截断 —— 截断的证据
          // 比没有更危险(看起来完整,实际丢了一半)。不传时 `clampMaxTokens`
          // 会用该成员的真实 `max_output_tokens` 补(见 clampMaxTokens 文档),
          // 成员上限缺失则保持 undefined,让上游用自己的缺省。
          temperature: 0,
          // 解析要确定性:同样一张图给同样的描述
          reasoning_effort: "none",
          extra: { session_id: parseSession }
        });
        const content = data.choices?.[0]?.message?.content;
        return typeof content === "string" ? content : null;
      } catch (err) {
        console.warn(`[as-one] 图片解析失败(${visionRoute}):`, err);
        return null;
      }
    };
    const bridgeImagesIfNeeded = async (req, sessionId) => {
      const normalized = normalizeInlineImages(req.messages);
      const reqWithImages = normalized === req.messages ? req : { ...req, messages: normalized };
      const messages = reqWithImages.messages;
      const imageCount = imagePartIndices(messages).length;
      if (imageCount === 0) return reqWithImages;
      if (visionRoute === void 0) {
        if (!warnedNoVisionRoute) {
          warnedNoVisionRoute = true;
          console.warn("[as-one] 未设置 routes.vision:跳过图像桥,带图请求原样放行");
        }
        return reqWithImages;
      }
      const chainHasVision = chain.some(
        (it) => it.endpoint.supportsVision === true
      );
      if (shouldBridgeImages(chainHasVision)) {
        const bridged = await tryParseImages(messages, {
          parseOne: (part) => parseOneImage(part, sessionId),
          parseModel: visionRoute,
          chainHasVision: false,
          hardOverflow: imageCount > IMAGE_HARD_LIMIT
        });
        if (bridged.result.replaced > 0 || bridged.result.droppedHistory > 0) {
          console.warn(
            `[as-one] 图像桥:替换 ${bridged.result.replaced} 张(缓存命中 ${bridged.result.cacheHits}、失败 ${bridged.result.unparsed}、丢历史 ${bridged.result.droppedHistory}、本次实解析 ${bridged.result.parsedNow})`
          );
        }
        if (JSON.stringify(bridged.messages).includes(FREE_PARSE_CANNOT_COMPLETE)) {
          throw new Error("[as-one] 图像信息不足,无法完成当前任务;请更换具备视觉能力的模型后重试");
        }
        return {
          ...reqWithImages,
          messages: bridged.messages
        };
      }
      return reqWithImages;
    };
    const planErrorOf = (reason, lastError) => {
      if (reason === "all_busy") return allBusyError();
      if (lastError !== null) return lastError;
      return new UpstreamError(
        UpstreamErrorKind.Connection,
        `无可用上游:${reason || "no endpoint"}`,
        { statusCode: 502 }
      );
    };
    return {
      async *stream(req) {
        const sessionId = sessionOf(req);
        const affinityKey = affinityKeyOf(req);
        let snRuntime = null;
        let snConnector = null;
        const bridged = await bridgeImagesIfNeeded(req, sessionId ?? "");
        const tried = /* @__PURE__ */ new Set();
        const t0 = performance.now();
        const preemptedEndpoints = /* @__PURE__ */ new Set();
        const policy = policyOf(!directRequest);
        const maxAttempts = directRequest ? Math.max(1, Math.min(policy.maxAttempts, MAX_FAILOVER_ATTEMPTS, routerChain.length)) : Math.max(
          1,
          Math.min(
            MAX_FAILOVER_ATTEMPTS,
            Math.max(policy.maxAttempts, routerChain.length)
          )
        );
        let lastError = null;
        let contextShrinks = 0;
        let contextCapHint = null;
        let sentPromptTokens = 0;
        let rawPromptTokens = 0;
        let maskedOverflowNotice = null;
        let stripReasoningEffort = false;
        for (let attempt = 1; ; attempt += 1) {
          if (attempt > 1 && sessionId) internalSwitch.noteInternalSwitch(String(sessionId));
          const plan = router.plan({
            // ⚠️ **被抢占过的端点不再选**(m02240):抢占是「直连要这个位置」,
            // 选回它只会被再抢一次 —— 反复抢、反复换,直到预算耗尽。
            // 换档的语义是「去**别的**模型」,不是「跟抢占者抢同一个位置」。
            chain: preemptedEndpoints.size === 0 ? routerChain : routerChain.filter((it) => !preemptedEndpoints.has(it.endpoint.endpointId)),
            // ⚠️ 亲和键 = 缓存路由键优先(m09081):同前缀 → 同端点 → 上游前缀缓存命中。
            sessionId: affinityKey,
            // ⚠️ 桥接后消息里已无图 → needs_vision 自然为 false,
            // 选路走普通的非视觉池(同一口径)。
            needsVision: hasVision(bridged.messages),
            ignoreCooldown: directRequest,
            // 压缩分块会填:块大小按真实模型窗口算,选路就不许挑装不下它的端点。
            minInputTokens: req.minInputTokens
          });
          const item = plan.item;
          if (!item) throw planErrorOf(plan.reason ?? "", lastError);
          const alreadyTried = tried.has(item.endpoint.endpointId);
          tried.add(item.endpoint.endpointId);
          let preemptedBy = null;
          const abort = new AbortController();
          let clientGone = false;
          const clientSignal = req.clientSignal;
          const onClientAbort = () => {
            clientGone = true;
            abort.abort();
          };
          if (clientSignal) {
            if (clientSignal.aborted) {
              clientGone = true;
              abort.abort();
            } else {
              clientSignal.addEventListener("abort", onClientAbort, { once: true });
            }
          }
          await reserveWorkbuddySlot(item, abort.signal);
          const leaseId = router.commit(item, {
            logicalName: model,
            sessionId: affinityKey,
            stream: true,
            onPreempt: (reason) => {
              preemptedBy = reason;
              abort.abort();
            }
          });
          if (!leaseId) throw planErrorOf("all_busy", null);
          let firstChunkEmitted = false;
          let ttftMs = null;
          const effortPlan = stripReasoningEffort ? void 0 : resolveReasoningEffort(
            bridged.reasoning_effort,
            runtime.reasoningEffortsOf?.(item.endpoint.provider, item.endpoint.model) ?? null,
            runtime.reasoningAllowsOffOf?.(item.endpoint.provider, item.endpoint.model) ?? null
          );
          const wantedEffort = effortPlan === void 0 ? void 0 : effortPlan.off ? offWireValue(item.endpoint.protocol) : effortPlan.value;
          const bodyReq = { ...bridged, reasoning_effort: wantedEffort };
          try {
            const peer = await preparePeer(item, vault, { selfCheck: runtime.workbuddySelfCheck });
            const { url, headers, connector, creds } = peer;
            const clamped = clampMaxTokens(
              bridged.maxTokensClient ?? bridged.max_tokens,
              item.endpoint.maxOutputTokens ?? null,
              logicalOutputCapOf(model)
            );
            const measured = counterForModel(item.endpoint.provider, item.endpoint.model);
            const fitted = fitForEndpoint(
              bodyReq.messages,
              item.endpoint.maxInputTokens,
              clamped ?? item.endpoint.maxOutputTokens ?? null,
              item.endpoint.endpointId,
              contextCapHint,
              measured
            );
            sentPromptTokens = Math.ceil(
              estimateRequestTokens(fitted.messages, bodyReq.tools, measured.count) * promptScale(item.endpoint.endpointId)
            );
            rawPromptTokens = estimateRequestTokens(fitted.messages, bodyReq.tools, measured.count);
            if (fitted.changed) {
              console.warn(
                `[as-one] context trim model=${model} endpoint=${item.endpoint.endpointId} ${fitted.counterName} ${fitted.estimatedBefore}→${fitted.estimatedAfter} tokens (省略 ${fitted.droppedMessages} 条消息 / 截短 ${fitted.compactedToolResults} 条工具结果)`
              );
            }
            const body = bodyForProtocol(item.endpoint.provider, item.endpoint.protocol, { ...bodyReq, messages: fitted.messages, model: item.endpoint.model, max_tokens: clamped }, creds);
            {
              const shape = wireShapeOf(item.endpoint.protocol, bodyReq.blocks !== void 0);
              if (shape.family !== "chat") {
                console.debug(`[as-one] wire family=${shape.family} source=${shape.source} crossed=${shape.crossed} protocol=${item.endpoint.protocol}`);
              }
            }
            const timer = armConnectTimeout(abort, remainingBudgetS(t0));
            let res;
            try {
              if (item.endpoint.protocol === "sensenova") {
                snConnector = connector;
                const sn = await runSensenova(peer, body, model, abort.signal);
                res = sn.res;
                snRuntime = sn.runtime;
              } else if (item.endpoint.protocol === "qoder") {
                snConnector = connector;
                const q = await runQoder(peer, body, item.endpoint.model, abort.signal);
                res = q.res;
                snRuntime = q.runtime;
              } else {
                const sendHeaders = item.endpoint.protocol === "codearts" ? codeartsSignedHeaders(peer, url, body, headers) : headers;
                res = isWorkbuddyWire(item.endpoint.protocol) ? (
                  // 渠道校验闸门必须在流式路径上也生效 —— DSH 的对话请求
                  // 全是流式的,只在 complete() 挂闸门等于没挂(用户实测拿到的
                  // 就是「渠道校验拦截(code 11128):请求被拦截,请重新发送」)。
                  // ⚠️ 判据只有 protocol(2026-10-31 用户定案收回按名字放宽):
                  // 名字带 workbuddy/wb 但 protocol=openai 的 provider 一律按
                  // 普通 OpenAI 直连,不改它的提示词。
                  await postWorkbuddyWithGate(url, headers, body, abort.signal, connector)
                ) : await fetch(url, {
                  method: "POST",
                  headers: upstreamHeaders(sendHeaders),
                  body: JSON.stringify(body),
                  signal: abort.signal
                });
              }
            } finally {
              if (timer !== null) clearTimeout(timer);
            }
            if (!res.ok || !res.body) {
              throw await classifyResponse(res, connector);
            }
            const chunkMeta = { completionId: completionIdOf(), created: createdOf(), model: req.model };
            let usage = null;
            for await (const chunk of iterUpstreamChunks(res.body, wireProtocolOf(item.endpoint.protocol), chunkMeta, item.endpoint.provider)) {
              if (chunk.usage) usage = chunk.usage;
              if (ttftMs === null) ttftMs = performance.now() - t0;
              firstChunkEmitted = true;
              yield chunk;
            }
            if (usage?.prompt_tokens) {
              notePromptUsage(item.endpoint.endpointId, rawPromptTokens, usage.prompt_tokens);
            }
            if (snRuntime) {
              snConnector?.recordSpendFor(snRuntime.name, usage, ttftMs === null ? 0 : Math.round(ttftMs));
            }
            router.finish(item, {
              leaseId,
              ok: true,
              status: 200,
              latencyMs: Math.round(performance.now() - t0),
              ttftMs: ttftMs === null ? void 0 : Math.round(ttftMs),
              promptTokens: usage?.prompt_tokens,
              completionTokens: usage?.completion_tokens,
              cachedTokens: usage?.prompt_tokens_details?.cached_tokens
            });
            if (stripReasoningEffort) {
              runtime.onReasoningEffortLearned?.(item.endpoint.provider, item.endpoint.model);
            }
            return;
          } catch (err) {
            if (preemptedBy !== null) {
              router.finish(item, {
                leaseId,
                ok: false,
                preempted: true,
                status: 0,
                error: preemptedBy,
                latencyMs: Math.round(performance.now() - t0)
              });
              if (firstChunkEmitted) {
                console.warn(
                  `[as-one] stream preempted after first chunk (${model}): ${preemptedBy}`
                );
                return;
              }
              preemptedEndpoints.add(item.endpoint.endpointId);
              console.warn(
                `[as-one] preempted by direct request (${model}) endpoint=${item.endpoint.endpointId}: ${preemptedBy} → 换档`
              );
              if (attempt < maxAttempts) {
                continue;
              }
              throw new UpstreamError(
                UpstreamErrorKind.Upstream,
                `被直连请求抢占,且已无更多档位可换:${preemptedBy}`,
                { statusCode: 503 }
              );
            }
            const gerr = toGatewayError(err);
            if (clientGone) {
              router.finish(item, {
                leaseId,
                // ⚠️ 打断**既不算成功也不算上游失败**（2026-11-17 用户报「手动打断
                // 会话也会让模型进冷却」）：`ok:false` + `kind:"client_disconnected"`
                // —— `client_disconnected` 已在 `TRANSIENT_KINDS` 里，所以只记账、
                // 不落冷却。以前首块已发时传 `ok: true`，那是**虚假成功**：它会
                // 顺手把端点之前的连续失败与冷却清零，等于用一次「用户按了停止」
                // 洗掉一个真故障的账。
                ok: false,
                status: firstChunkEmitted ? 200 : 0,
                error: "客户端断开",
                kind: "client_disconnected",
                latencyMs: Math.round(performance.now() - t0)
              });
              return;
            }
            const windowTokens = effectiveWindowTokens(
              item.endpoint.maxInputTokens,
              item.endpoint.endpointId
            );
            const maskedOverflow = !firstChunkEmitted && isMaskedOverflow(gerr.detail, gerr.kind, sentPromptTokens, windowTokens);
            if (maskedOverflow) {
              maskedOverflowNotice = describeMaskedOverflow(sentPromptTokens, windowTokens);
            }
            const overflow = !firstChunkEmitted && isContextOverflow(gerr.detail, gerr.kind, sentPromptTokens, windowTokens);
            const channelReject = !firstChunkEmitted && isWorkbuddyChannelReject(gerr, item.endpoint.protocol);
            const overloaded = !firstChunkEmitted && !overflow && isRateLimitOversize(gerr.kind, sentPromptTokens, item.endpoint.maxInputTokens);
            if (overflow || overloaded) {
              if (overflow) noteContextOverflow(item.endpoint.endpointId, sentPromptTokens);
              if (contextShrinks < MAX_CONTEXT_SHRINKS) {
                const nextCap = Math.max(4096, Math.floor(sentPromptTokens / 2));
                router.finish(item, {
                  leaseId,
                  ok: false,
                  voidAttempt: true,
                  status: 0,
                  error: overflow ? `上下文超窗(本次 ${sentPromptTokens} tokens),压到 ${nextCap} 后重发:${gerr.detail}` : `上游限流(本次 ${sentPromptTokens} tokens,一次就吃掉每分钟配额),瘦身到 ${nextCap} 后重发:${gerr.detail}`,
                  latencyMs: Math.round(performance.now() - t0)
                });
                contextShrinks += 1;
                contextCapHint = nextCap;
                attempt -= 1;
                console.warn(
                  `[as-one] ${overflow ? "context overflow" : "rate-limit oversize"} model=${model} endpoint=${item.endpoint.endpointId} 本次 ${sentPromptTokens} tokens → 压到 ${nextCap} 重发 (${contextShrinks}/${MAX_CONTEXT_SHRINKS}): ${gerr.detail}`
                );
                continue;
              }
            }
            if (!stripReasoningEffort && !firstChunkEmitted && isReasoningEffortRejection(gerr.detail)) {
              router.finish(item, {
                leaseId,
                ok: false,
                voidAttempt: true,
                status: 0,
                error: `reasoning_effort 不被支持,丢参重试:${gerr.detail}`,
                latencyMs: Math.round(performance.now() - t0)
              });
              stripReasoningEffort = true;
              console.warn(
                `[as-one] reasoning_effort rejected (${model}, ${item.endpoint.endpointId}) → 丢参重试: ${gerr.detail}`
              );
              if (attempt < maxAttempts) {
                continue;
              }
            }
            router.finish(item, {
              leaseId,
              ok: firstChunkEmitted,
              // 首块已发则不算上游失败(客户端断开属正常)
              // 上下文超窗且压到底仍被拒 / 11128 渠道校验拦截 → 不记失败
              // (见上面的 `overflow` / `channelReject` 说明:端点没做错)。
              voidAttempt: overflow && !firstChunkEmitted || channelReject,
              status: firstChunkEmitted ? 200 : httpStatusOf(gerr),
              error: firstChunkEmitted ? void 0 : gerr.detail,
              kind: firstChunkEmitted ? void 0 : gerr.kind,
              latencyMs: Math.round(performance.now() - t0),
              // 上游给了 retry_after 就按它冷却(优先按上游给出的时间);
              // 没给 → undefined,回落 provider 覆盖 / 全局 floor。
              // `cooldownUntilOf` 只在上游真给了 `Retry-After` 时返回时刻,
              // 所以这里标 `"upstream"` —— 它才有资格压过瞬时故障豁免。
              cooldownUntil: firstChunkEmitted || overflow || channelReject ? void 0 : cooldownUntilOf(gerr),
              cooldownUntilSource: "upstream"
            });
            if (!firstChunkEmitted && gerr.kind === UpstreamErrorKind.Auth && item.endpoint.provider === "sensenova") {
              try {
                runtime.onSensenovaKeyInvalid?.(item.endpoint.credentialKey[1]);
              } catch {
              }
            }
            if (firstChunkEmitted) {
              console.warn(`[as-one] stream cut after first chunk (${model}): ${gerr.detail}`);
              return;
            }
            if (maskedOverflowNotice !== null) {
              throw new UpstreamError(
                UpstreamErrorKind.BadRequest,
                maskedOverflowNotice,
                { statusCode: httpStatusOf(gerr) }
              );
            }
            if (overflow) {
              throw new UpstreamError(
                UpstreamErrorKind.BadRequest,
                `请求超出模型上下文窗口(本次请求 ${sentPromptTokens} tokens,${contextShrinks > 0 ? `已自动压缩 ${contextShrinks} 次仍被拒` : `未自动压缩（自动压缩已关闭）`}。请执行 /compact 或新建会话再试。上游原文:${gerr.detail}`,
                { statusCode: httpStatusOf(gerr) }
              );
            }
            lastError = gerr;
            const decision = failoverDecision({
              gerr,
              provider: item.endpoint.provider,
              direct: directRequest,
              policy,
              attempt,
              alternativeChannel: hasAlternativeChannel(routerChain, tried, item.endpoint.provider)
            });
            if (requestTimeoutMs() > 0 && remainingBudgetS(t0) <= 0) {
              throw lastError ?? gerr;
            }
            if (decision.allowed && !alreadyTried && attempt < maxAttempts) {
              const delayS = decision.delayS;
              console.warn(
                `[as-one] failover ${attempt}/${maxAttempts} model=${model} endpoint=${item.endpoint.endpointId} kind=${gerr.kind} (${directRequest ? "直连" : "逻辑模型换成员"}): ${gerr.detail} (等待 ${delayS.toFixed(2)}s 后换档)`
              );
              await sleepMs(delayS * 1e3);
              continue;
            }
            throw gerr;
          } finally {
            try {
              scheduler.invalidate();
            } catch {
            }
          }
        }
      },
      async complete(req) {
        const sessionId = sessionOf(req);
        const affinityKey = affinityKeyOf(req);
        let snRuntime = null;
        let snConnector = null;
        const bridged = await bridgeImagesIfNeeded(req, sessionId ?? "");
        const tried = /* @__PURE__ */ new Set();
        const preemptedEndpoints = /* @__PURE__ */ new Set();
        const policy = policyOf(!directRequest);
        const maxAttempts = directRequest ? Math.max(1, Math.min(policy.maxAttempts, MAX_FAILOVER_ATTEMPTS, routerChain.length)) : Math.max(
          1,
          Math.min(
            MAX_FAILOVER_ATTEMPTS,
            Math.max(policy.maxAttempts, routerChain.length)
          )
        );
        let lastError = null;
        let contextShrinks = 0;
        let contextCapHint = null;
        let sentPromptTokens = 0;
        let rawPromptTokens = 0;
        let maskedOverflowNotice = null;
        let stripReasoningEffort = false;
        const t0 = performance.now();
        for (let attempt = 1; ; attempt += 1) {
          if (attempt > 1 && sessionId) internalSwitch.noteInternalSwitch(String(sessionId));
          const plan = router.plan({
            // ⚠️ **被抢占过的端点不再选**(m02240):同 stream() 口径。
            chain: preemptedEndpoints.size === 0 ? routerChain : routerChain.filter((it) => !preemptedEndpoints.has(it.endpoint.endpointId)),
            sessionId: affinityKey,
            // ⚠️ 桥接后消息里已无图 → needs_vision 自然为 false,
            // 选路走普通的非视觉池(同一口径)。
            needsVision: hasVision(bridged.messages),
            ignoreCooldown: directRequest,
            // 压缩分块会填:块大小按真实模型窗口算,选路就不许挑装不下它的端点。
            minInputTokens: req.minInputTokens
          });
          const item = plan.item;
          if (!item) throw planErrorOf(plan.reason ?? "", lastError);
          const alreadyTried = tried.has(item.endpoint.endpointId);
          tried.add(item.endpoint.endpointId);
          let preemptedBy = null;
          const abort = new AbortController();
          let clientGone = false;
          const clientSignal = req.clientSignal;
          const onClientAbort = () => {
            clientGone = true;
            abort.abort();
          };
          if (clientSignal) {
            if (clientSignal.aborted) {
              clientGone = true;
              abort.abort();
            } else {
              clientSignal.addEventListener("abort", onClientAbort, { once: true });
            }
          }
          await reserveWorkbuddySlot(item, abort.signal);
          const leaseId = router.commit(item, {
            logicalName: model,
            sessionId: affinityKey,
            stream: false,
            onPreempt: (reason) => {
              preemptedBy = reason;
              abort.abort();
            }
          });
          if (!leaseId) throw planErrorOf("all_busy", null);
          const effortPlan = stripReasoningEffort ? void 0 : resolveReasoningEffort(
            bridged.reasoning_effort,
            runtime.reasoningEffortsOf?.(item.endpoint.provider, item.endpoint.model) ?? null,
            runtime.reasoningAllowsOffOf?.(item.endpoint.provider, item.endpoint.model) ?? null
          );
          const wantedEffort = effortPlan === void 0 ? void 0 : effortPlan.off ? offWireValue(item.endpoint.protocol) : effortPlan.value;
          const bodyReq = { ...bridged, reasoning_effort: wantedEffort };
          try {
            const protocol = item.endpoint.protocol;
            const peer = await preparePeer(item, vault, { selfCheck: runtime.workbuddySelfCheck });
            const { url, headers, connector, creds } = peer;
            const clamped = clampMaxTokens(
              bridged.maxTokensClient ?? bridged.max_tokens,
              item.endpoint.maxOutputTokens ?? null,
              logicalOutputCapOf(model)
            );
            const measured = counterForModel(item.endpoint.provider, item.endpoint.model);
            const fitted = fitForEndpoint(
              bodyReq.messages,
              item.endpoint.maxInputTokens,
              clamped ?? item.endpoint.maxOutputTokens ?? null,
              item.endpoint.endpointId,
              contextCapHint,
              measured
            );
            sentPromptTokens = Math.ceil(
              estimateRequestTokens(fitted.messages, bodyReq.tools, measured.count) * promptScale(item.endpoint.endpointId)
            );
            rawPromptTokens = estimateRequestTokens(fitted.messages, bodyReq.tools, measured.count);
            if (fitted.changed) {
              console.warn(
                `[as-one] context trim model=${model} endpoint=${item.endpoint.endpointId} ${fitted.counterName} ${fitted.estimatedBefore}→${fitted.estimatedAfter} tokens (省略 ${fitted.droppedMessages} 条消息 / 截短 ${fitted.compactedToolResults} 条工具结果)`
              );
            }
            const body = bodyForProtocol(item.endpoint.provider, protocol, { ...bodyReq, messages: fitted.messages, model: item.endpoint.model, max_tokens: clamped }, creds);
            {
              const shape = wireShapeOf(protocol, bodyReq.blocks !== void 0);
              if (shape.family !== "chat") {
                console.debug(`[as-one] wire family=${shape.family} source=${shape.source} crossed=${shape.crossed} protocol=${protocol}`);
              }
            }
            const timer = armConnectTimeout(abort, remainingBudgetS(t0));
            let res;
            try {
              if (protocol === "sensenova") {
                snConnector = connector;
                const sn = await runSensenova(peer, body, model, abort.signal);
                res = sn.res;
                snRuntime = sn.runtime;
              } else if (protocol === "qoder") {
                snConnector = connector;
                const q = await runQoder(peer, body, item.endpoint.model, abort.signal);
                res = q.res;
                snRuntime = q.runtime;
              } else {
                const sendHeaders = protocol === "codearts" ? codeartsSignedHeaders(peer, url, body, headers) : headers;
                res = isWorkbuddyWire(protocol) ? await postWorkbuddyWithGate(url, headers, body, abort.signal, connector) : await fetch(url, {
                  method: "POST",
                  headers: upstreamHeaders(sendHeaders),
                  body: JSON.stringify(body),
                  signal: abort.signal
                });
              }
            } finally {
              if (timer !== null) clearTimeout(timer);
            }
            if (!res.ok) {
              throw await classifyResponse(res, connector);
            }
            let data;
            if ((protocol === "openai" || protocol === "codearts") && !req.stream) {
              data = await res.json();
            } else {
              const completionId = completionIdOf();
              const created = createdOf();
              const chunks = iterUpstreamChunks(res.body, wireProtocolOf(protocol), { completionId, created, model: req.model }, item.endpoint.provider);
              data = await aggregateCompletion(chunks, { model: req.model, completionId, created });
            }
            if (data.usage?.prompt_tokens) {
              notePromptUsage(item.endpoint.endpointId, rawPromptTokens, data.usage.prompt_tokens);
            }
            if (snRuntime) {
              snConnector?.recordSpendFor(snRuntime.name, data.usage, 0);
            }
            router.finish(item, {
              leaseId,
              ok: true,
              status: 200,
              latencyMs: Math.round(performance.now() - t0),
              promptTokens: data.usage?.prompt_tokens,
              completionTokens: data.usage?.completion_tokens,
              cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens
            });
            if (stripReasoningEffort) {
              runtime.onReasoningEffortLearned?.(item.endpoint.provider, item.endpoint.model);
            }
            return data;
          } catch (err) {
            if (preemptedBy !== null) {
              router.finish(item, {
                leaseId,
                ok: false,
                preempted: true,
                status: 0,
                error: preemptedBy,
                latencyMs: Math.round(performance.now() - t0)
              });
              preemptedEndpoints.add(item.endpoint.endpointId);
              console.warn(
                `[as-one] preempted by direct request (${model}) endpoint=${item.endpoint.endpointId}: ${preemptedBy} → 换档`
              );
              if (attempt < maxAttempts) {
                continue;
              }
              throw new UpstreamError(
                UpstreamErrorKind.Upstream,
                `被直连请求抢占,且已无更多档位可换:${preemptedBy}`,
                { statusCode: 503 }
              );
            }
            if (clientGone) {
              router.finish(item, {
                leaseId,
                ok: false,
                status: 0,
                error: "客户端断开",
                kind: "client_disconnected",
                latencyMs: Math.round(performance.now() - t0)
              });
              throw new UpstreamError(UpstreamErrorKind.Connection, "客户端断开");
            }
            const gerr = toGatewayError(err);
            const windowTokens = effectiveWindowTokens(
              item.endpoint.maxInputTokens,
              item.endpoint.endpointId
            );
            const maskedOverflow = isMaskedOverflow(
              gerr.detail,
              gerr.kind,
              sentPromptTokens,
              windowTokens
            );
            if (maskedOverflow) {
              maskedOverflowNotice = describeMaskedOverflow(sentPromptTokens, windowTokens);
            }
            const overflow = isContextOverflow(
              gerr.detail,
              gerr.kind,
              sentPromptTokens,
              windowTokens
            );
            const channelReject = isWorkbuddyChannelReject(gerr, item.endpoint.protocol);
            const overloaded = !overflow && isRateLimitOversize(gerr.kind, sentPromptTokens, item.endpoint.maxInputTokens);
            if (overflow || overloaded) {
              if (overflow) noteContextOverflow(item.endpoint.endpointId, sentPromptTokens);
              if (contextShrinks < MAX_CONTEXT_SHRINKS) {
                const nextCap = Math.max(4096, Math.floor(sentPromptTokens / 2));
                router.finish(item, {
                  leaseId,
                  ok: false,
                  voidAttempt: true,
                  status: 0,
                  error: overflow ? `上下文超窗(本次 ${sentPromptTokens} tokens),压到 ${nextCap} 后重发:${gerr.detail}` : `上游限流(本次 ${sentPromptTokens} tokens,一次就吃掉每分钟配额),瘦身到 ${nextCap} 后重发:${gerr.detail}`,
                  latencyMs: Math.round(performance.now() - t0)
                });
                contextShrinks += 1;
                contextCapHint = nextCap;
                attempt -= 1;
                console.warn(
                  `[as-one] ${overflow ? "context overflow" : "rate-limit oversize"} model=${model} endpoint=${item.endpoint.endpointId} 本次 ${sentPromptTokens} tokens → 压到 ${nextCap} 重发 (${contextShrinks}/${MAX_CONTEXT_SHRINKS}): ${gerr.detail}`
                );
                continue;
              }
            }
            if (!stripReasoningEffort && isReasoningEffortRejection(gerr.detail)) {
              router.finish(item, {
                leaseId,
                ok: false,
                voidAttempt: true,
                status: 0,
                error: `reasoning_effort 不被支持,丢参重试:${gerr.detail}`,
                latencyMs: Math.round(performance.now() - t0)
              });
              stripReasoningEffort = true;
              console.warn(
                `[as-one] reasoning_effort rejected (${model}, ${item.endpoint.endpointId}) → 丢参重试: ${gerr.detail}`
              );
              if (attempt < maxAttempts) {
                continue;
              }
            }
            router.finish(item, {
              leaseId,
              ok: false,
              // 上下文超窗压到底仍被拒 / 11128 渠道校验拦截 → 不记失败
              // (端点没做错:前者是我们发得太长,后者是内容没过渠道校验)。
              voidAttempt: overflow || channelReject,
              status: httpStatusOf(gerr),
              error: gerr.detail,
              kind: gerr.kind,
              latencyMs: Math.round(performance.now() - t0),
              cooldownUntil: overflow || channelReject ? void 0 : cooldownUntilOf(gerr),
              // 与 stream() 同口径:只有上游真给了 `Retry-After` 才标 upstream。
              cooldownUntilSource: "upstream"
            });
            if (gerr.kind === UpstreamErrorKind.Auth && item.endpoint.provider === "sensenova") {
              try {
                runtime.onSensenovaKeyInvalid?.(item.endpoint.credentialKey[1]);
              } catch {
              }
            }
            if (maskedOverflowNotice !== null) {
              throw new UpstreamError(
                UpstreamErrorKind.BadRequest,
                maskedOverflowNotice,
                { statusCode: httpStatusOf(gerr) }
              );
            }
            if (overflow) {
              throw new UpstreamError(
                UpstreamErrorKind.BadRequest,
                `请求超出模型上下文窗口(本次请求 ${sentPromptTokens} tokens,${contextShrinks > 0 ? `已自动压缩 ${contextShrinks} 次仍被拒` : `未自动压缩（自动压缩已关闭）`}。请执行 /compact 或新建会话再试。上游原文:${gerr.detail}`,
                { statusCode: httpStatusOf(gerr) }
              );
            }
            lastError = gerr;
            const decision = failoverDecision({
              gerr,
              provider: item.endpoint.provider,
              direct: directRequest,
              policy,
              attempt,
              alternativeChannel: hasAlternativeChannel(
                routerChain,
                tried,
                item.endpoint.provider
              )
            });
            if (requestTimeoutMs() > 0 && remainingBudgetS(t0) <= 0) {
              throw lastError ?? gerr;
            }
            if (decision.allowed && !alreadyTried && attempt < maxAttempts) {
              const delayS = decision.delayS;
              console.warn(
                `[as-one] failover ${attempt}/${maxAttempts} model=${model} endpoint=${item.endpoint.endpointId} kind=${gerr.kind} (${directRequest ? "直连" : "逻辑模型换成员"}): ${gerr.detail} (等待 ${delayS.toFixed(2)}s 后换档)`
              );
              await sleepMs(delayS * 1e3);
              continue;
            }
            throw gerr;
          } finally {
            try {
              scheduler.invalidate();
            } catch {
            }
          }
        }
      },
      // 真实模型直连判 404 用;阶段一统一返回 undefined(未知)。
      hasModel() {
        return void 0;
      }
    };
  };
}

// panel/modelview.ts
function parseReasoningEfforts(raw) {
  if (raw === null || raw === void 0) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return orderRawLevels(v.map((x) => String(x ?? "")));
  } catch {
    return null;
  }
}
function parseReasoningAllowsOff(raw) {
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  return null;
}
function serializeReasoningEfforts(efforts) {
  if (efforts === null || efforts === void 0) return null;
  return JSON.stringify(efforts);
}
function realModelMapOf(registry, db, pid) {
  const out = /* @__PURE__ */ new Map();
  for (const def of registry.listRealModels(pid)) {
    out.set(`${def.provider}/${def.model}`, {
      provider: def.provider,
      model: def.model,
      name: def.name,
      hidden: def.hidden,
      supportsVision: def.supportsVision,
      maxInputTokens: def.maxInputTokens,
      maxOutputTokens: def.maxOutputTokens,
      concurrency: def.concurrency,
      registered: true,
      // 注册表是「空库首启播种」的投影,不带能力字段;真值一律由 db 行覆盖。
      supportedReasoningEfforts: null,
      supportedReasoningEffortsRaw: null,
      reasoningAllowsOff: null
    });
  }
  for (const row of db.realModel.list().filter((r) => pid === void 0 || r.provider === pid)) {
    const prev = out.get(`${row.provider}/${row.model}`);
    out.set(`${row.provider}/${row.model}`, {
      provider: row.provider,
      model: row.model,
      name: row.name,
      hidden: row.hidden === 1,
      supportsVision: row.supports_vision === 1,
      maxInputTokens: row.max_input_tokens,
      maxOutputTokens: row.max_output_tokens,
      concurrency: row.concurrency > 0 ? row.concurrency : null,
      registered: prev?.registered ?? false,
      supportedReasoningEfforts: parseReasoningEfforts(row.supported_reasoning_efforts),
      supportedReasoningEffortsRaw: row.supported_reasoning_efforts ?? null,
      reasoningAllowsOff: parseReasoningAllowsOff(row.reasoning_allows_off)
    });
  }
  return out;
}

// panel/utils.ts
import { closeSync as closeSync2, openSync as openSync2, readSync } from "node:fs";
function pad2(n) {
  return String(n).padStart(2, "0");
}
function countJsonlLines(path) {
  const fd = openSync2(path, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    let count = 0;
    let pending = false;
    for (; ; ) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      for (let i = 0; i < read; i += 1) {
        if (chunk[i] === 10) {
          if (pending) count += 1;
          pending = false;
        } else {
          pending = true;
        }
      }
    }
    if (pending) count += 1;
    return count;
  } finally {
    closeSync2(fd);
  }
}
function fmtDay(d) {
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function todayLocal() {
  return fmtDay(/* @__PURE__ */ new Date());
}
function dayAdd(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  return fmtDay(new Date(y, m - 1, d + delta));
}
function clampDay(day, first) {
  if (first === null) return day;
  return day < first ? first : day;
}
function rangeDays(from, to) {
  const out = [];
  let d = from;
  while (d <= to && out.length < 3660) {
    out.push(d);
    d = dayAdd(d, 1);
  }
  return out;
}
function monthAxis(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  while (y < ty || y === ty && m <= tm) {
    out.push(`${String(y).padStart(4, "0")}-${pad2(m)}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
function round1(x) {
  return Math.round(x * 10) / 10;
}
function pct(part, total) {
  if (!(total > 0)) return null;
  return Math.round(part / total * 1e4) / 1e4;
}
function fpOf(secret) {
  if (secret === null || secret === void 0 || secret === "") return null;
  return secret.length > 8 ? `${secret.slice(0, 8)}…` : secret;
}
function splitRef(credentialRef) {
  const idx = credentialRef.indexOf("/");
  return idx > 0 ? [credentialRef.slice(0, idx), credentialRef.slice(idx + 1)] : [credentialRef, ""];
}
function parseDbMembers(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
      if (typeof item === "string") {
        const pair = splitModelId(item);
        if (pair) out.push({ provider: pair[0], model: pair[1] });
      } else if (item !== null && typeof item === "object") {
        const o = item;
        const p = o.provider;
        const m = o.model;
        if (typeof p === "string" && typeof m === "string" && p !== "" && m !== "") {
          out.push({ provider: p, model: m });
        } else if (typeof o.real_model_id === "string") {
          const pair = splitModelId(o.real_model_id);
          if (pair) out.push({ provider: pair[0], model: pair[1] });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
function membersFromInput(input) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (id) => {
    const at = id.indexOf("@");
    const real = at > 0 ? id.slice(0, at) : id;
    const pair = splitModelId(real);
    if (!pair) return;
    const key = `${pair[0]}/${pair[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ provider: pair[0], model: pair[1] });
  };
  for (const m of input.members ?? []) add(String(m));
  for (const d of input.deployments ?? []) add(String(d));
  for (const g of input.strategy_groups ?? []) {
    for (const m of g?.members ?? []) add(String(m));
  }
  for (const f of input.fallbacks ?? []) add(String(f));
  return out;
}

// panel/modelcatalog.ts
var labelKey = (s) => s.trim().toLowerCase();
function dedupeLabels(bases, tags, always) {
  const keyCount = /* @__PURE__ */ new Map();
  for (const b of bases) {
    const k = labelKey(b);
    keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  }
  const out = [];
  const used = /* @__PURE__ */ new Set();
  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    const tag = tags[i];
    const shouldTag = tag !== null && tag !== void 0 && (always?.[i] === true || (keyCount.get(labelKey(base)) ?? 0) > 1);
    let label = shouldTag ? `${base} (${tag})` : base;
    if (used.has(labelKey(label))) {
      for (let n = 2; ; n += 1) {
        const candidate = `${label} ·${n}`;
        if (!used.has(labelKey(candidate))) {
          label = candidate;
          break;
        }
      }
    }
    used.add(labelKey(label));
    out.push(label);
  }
  return out;
}
var LOGICAL_REASONING_EFFORTS = ["low", "medium", "high", "max"];
function listModelEntries(registry, db, providersWithCredentials2) {
  const windowOf2 = /* @__PURE__ */ new Map();
  const visionOf = /* @__PURE__ */ new Map();
  for (const mv of realModelMapOf(registry, db).values()) {
    const key = `${mv.provider}/${mv.model}`;
    windowOf2.set(key, mv.maxInputTokens ?? 0);
    visionOf.set(key, mv.supportsVision);
  }
  const logical = [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of db.logicalModel.list()) {
    if (seen.has(row.name)) continue;
    const members = parseDbMembers(row.members);
    if (members.length === 0) continue;
    seen.add(row.name);
    logical.push({ row, members, base: (row.display_name ?? "").trim() || row.name });
  }
  const reals = [...realModelMapOf(registry, db).values()].filter((mv) => !mv.hidden && providersWithCredentials2.has(mv.provider)).sort(
    (a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0
  );
  const realRows = [];
  for (const mv of reals) {
    const id = `${mv.provider}/${mv.model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    realRows.push({ mv, id });
  }
  const dbReal = /* @__PURE__ */ new Map();
  for (const r of db.realModel.list()) dbReal.set(`${r.provider}/${r.model}`, r.name);
  const bases = [
    ...logical.map((l) => l.base),
    ...realRows.map(({ mv, id }) => {
      const raw = dbReal.has(id) ? dbReal.get(id) : mv.name;
      return (raw ?? "").trim() || mv.model;
    })
  ];
  const tags = [...logical.map(() => null), ...realRows.map(({ mv }) => mv.provider)];
  const alwaysTagged = [...logical.map(() => false), ...realRows.map(() => true)];
  const labels = dedupeLabels(bases, tags, alwaysTagged);
  const out = [];
  logical.forEach((l, i) => {
    const windows = l.members.map((m) => windowOf2.get(`${m.provider}/${m.model}`) ?? 0).filter((w) => Number.isFinite(w) && w > 0);
    out.push({
      id: l.row.name,
      object: "model",
      owned_by: "as-one",
      litenexus_kind: "logical",
      name: l.base,
      display_name: labels[i],
      max_input_tokens: windows.length > 0 ? Math.min(...windows) : void 0,
      // 最大成员窗口:压缩分块按它切块(配合请求上的 `minInputTokens` 让选路
      // 避开装不下的小窗口成员),详见 `ModelEntry.max_member_input_tokens`。
      max_member_input_tokens: windows.length > 0 ? Math.max(...windows) : void 0,
      supports_vision: l.members.some((m) => visionOf.get(`${m.provider}/${m.model}`) === true),
      reasoning_efforts: LOGICAL_REASONING_EFFORTS,
      reasoning_allows_off: true
    });
  });
  realRows.forEach(({ mv, id }, j) => {
    out.push({
      id,
      object: "model",
      owned_by: "as-one",
      litenexus_kind: "real",
      name: (mv.name ?? "").trim() || mv.model,
      display_name: labels[logical.length + j],
      max_input_tokens: mv.maxInputTokens ?? void 0,
      max_output_tokens: mv.maxOutputTokens ?? void 0,
      supports_vision: mv.supportsVision,
      reasoning_efforts: mv.supportedReasoningEfforts,
      reasoning_allows_off: mv.reasoningAllowsOff
    });
  });
  return out;
}
async function providersWithCredentials(registry, vault) {
  const out = /* @__PURE__ */ new Set();
  for (const p of registry.listProviders()) {
    const creds = await vault.list(p.id).catch(() => []);
    if (creds.length > 0) out.add(p.id);
  }
  return out;
}
function resolveModelEntry(registry, db, id) {
  const wanted = id.trim();
  if (wanted === "") return void 0;
  const logicalRow = db.logicalModel.get(wanted);
  if (logicalRow !== null && logicalRow !== void 0) {
    const members = parseDbMembers(logicalRow.members);
    if (members.length === 0) return void 0;
    const windowOf2 = /* @__PURE__ */ new Map();
    const visionOf = /* @__PURE__ */ new Map();
    for (const mv2 of realModelMapOf(registry, db).values()) {
      windowOf2.set(`${mv2.provider}/${mv2.model}`, mv2.maxInputTokens ?? 0);
      visionOf.set(`${mv2.provider}/${mv2.model}`, mv2.supportsVision);
    }
    const windows = members.map((m) => windowOf2.get(`${m.provider}/${m.model}`) ?? 0).filter((w) => Number.isFinite(w) && w > 0);
    return {
      id: logicalRow.name,
      object: "model",
      owned_by: "as-one",
      litenexus_kind: "logical",
      name: (logicalRow.display_name ?? "").trim() || logicalRow.name,
      display_name: (logicalRow.display_name ?? "").trim() || logicalRow.name,
      max_input_tokens: windows.length > 0 ? Math.min(...windows) : void 0,
      max_member_input_tokens: windows.length > 0 ? Math.max(...windows) : void 0,
      supports_vision: members.some((m) => visionOf.get(`${m.provider}/${m.model}`) === true),
      reasoning_efforts: LOGICAL_REASONING_EFFORTS,
      reasoning_allows_off: true
    };
  }
  const slash = wanted.indexOf("/");
  if (slash <= 0 || slash >= wanted.length - 1) return void 0;
  const provider = wanted.slice(0, slash);
  const model = wanted.slice(slash + 1);
  const mv = realModelMapOf(registry, db).get(wanted);
  if (!mv) return void 0;
  const dbRealName = db.realModel.get(provider, model)?.name;
  return {
    id: wanted,
    object: "model",
    owned_by: provider,
    litenexus_kind: "real",
    name: (mv.name ?? "").trim() || mv.model,
    display_name: (dbRealName ?? mv.name ?? "").trim() || mv.model,
    max_input_tokens: mv.maxInputTokens ?? void 0,
    max_output_tokens: mv.maxOutputTokens ?? void 0,
    supports_vision: mv.supportsVision,
    reasoning_efforts: mv.supportedReasoningEfforts,
    reasoning_allows_off: mv.reasoningAllowsOff
  };
}

// src/setup.ts
var sensenovaPoolConnector = new SensenovaAdapter();
registerConnector(sensenovaPoolConnector);
async function syncSensenovaPool(vault) {
  try {
    const creds = await vault.list("sensenova").catch(() => []);
    const accounts = [];
    for (const c of creds) {
      const full = await vault.get("sensenova", c.username).catch(() => null);
      const key = full?.secret?.trim();
      if (!key) continue;
      accounts.push({ username: c.username, api_key: key, enabled: true });
    }
    sensenovaPoolConnector.setAccounts(accounts);
  } catch (err) {
    console.error("[as-one] sensenova account pool sync failed:", err);
  }
}
var ACCOUNT_OVERLAY_PREFIX = "account.enabled.";
var ACCOUNT_OVERLAY_LEGACY_KEY = "account.enabled";
function overlayKeyOf(ref) {
  return ACCOUNT_OVERLAY_PREFIX + ref;
}
function absorbLegacyAccountOverlay(db, into) {
  const raw = settingOf(db, ACCOUNT_OVERLAY_LEGACY_KEY);
  if (raw === null || raw === "") return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      db.setting.delete(ACCOUNT_OVERLAY_LEGACY_KEY);
      return;
    }
    for (const [ref, value] of Object.entries(parsed)) {
      if (typeof value !== "boolean") continue;
      const key = overlayKeyOf(ref);
      if (db.setting.get(key)) continue;
      db.setting.set(key, value ? "1" : "0");
      into.set(ref, value);
    }
    db.setting.delete(ACCOUNT_OVERLAY_LEGACY_KEY);
  } catch (err) {
    console.error("[as-one] account.enabled 旧格式迁移失败,按无覆盖处理:", err);
  }
}
var LiveAccountOverlay = class extends Map {
  constructor(db) {
    super();
    this.db = db;
    this.version = db.dataVersion();
    this.reload();
  }
  db;
  version;
  /** 无条件重读逐键家族(构造期与「检测到别的实例提交」时调用)。 */
  reload() {
    super.clear();
    for (const row of this.db.setting.entries(ACCOUNT_OVERLAY_PREFIX)) {
      const ref = row.k.slice(ACCOUNT_OVERLAY_PREFIX.length);
      if (ref === "") continue;
      super.set(ref, row.v === "1" || row.v === "true");
    }
    absorbLegacyAccountOverlay(this.db, this);
    this.version = this.db.dataVersion();
  }
  /** 别的实例提交过就重读;自己实例的写入不改变 data_version,靠下面直接改内存。 */
  sync() {
    let now;
    try {
      now = this.db.dataVersion();
    } catch {
      return;
    }
    if (now !== this.version) this.reload();
  }
  get(ref) {
    this.sync();
    return super.get(ref);
  }
  has(ref) {
    this.sync();
    return super.has(ref);
  }
  entries() {
    this.sync();
    return super.entries();
  }
  keys() {
    this.sync();
    return super.keys();
  }
  values() {
    this.sync();
    return super.values();
  }
  /**
   * 删掉一个覆盖 = 回到「跟随 registry 默认值」。
   *
   * 覆盖掉 `Map.delete` 是为了**连库一起删**:qoder 删账号走的是
   * `accountOverlay.delete()`,只删内存的话重启后那条覆盖还躺着(指向一个
   * 不存在的账号),属于同一类「内存与库不同步」的老毛病。
   */
  delete(ref) {
    try {
      this.db.setting.delete(overlayKeyOf(ref));
    } catch (err) {
      console.error("[as-one] 账号覆盖删除落库失败:", err);
    }
    return super.delete(ref);
  }
};
var CHANNEL_OVERLAY_PREFIX = "channel.enabled.";
var LiveChannelOverlay = class extends Map {
  constructor(db) {
    super();
    this.db = db;
    this.version = db.dataVersion();
    this.reload();
  }
  db;
  version;
  /** 无条件重读逐键家族(构造期与「检测到别的实例提交」时调用)。 */
  reload() {
    super.clear();
    for (const row of this.db.setting.entries(CHANNEL_OVERLAY_PREFIX)) {
      const provider = row.k.slice(CHANNEL_OVERLAY_PREFIX.length);
      if (provider === "") continue;
      super.set(provider, row.v === "1" || row.v === "true");
    }
    this.version = this.db.dataVersion();
  }
  /** 别的实例提交过就重读;自己实例的写入不改变 data_version,靠直接改内存。 */
  sync() {
    let now;
    try {
      now = this.db.dataVersion();
    } catch {
      return;
    }
    if (now !== this.version) this.reload();
  }
  get(provider) {
    this.sync();
    return super.get(provider);
  }
  has(provider) {
    this.sync();
    return super.has(provider);
  }
  entries() {
    this.sync();
    return super.entries();
  }
  keys() {
    this.sync();
    return super.keys();
  }
  values() {
    this.sync();
    return super.values();
  }
};
function settingOf(db, key) {
  const row = db.setting.get(key);
  return row ? row.v : null;
}
function numSetting(db, key, def, min = 0) {
  const raw = settingOf(db, key);
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (Number.isNaN(n) || n < min) return def;
  return n;
}
function parseMembers(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
      if (typeof item === "string") {
        const pair = splitModelId(item);
        if (pair) out.push({ provider: pair[0], model: pair[1] });
      } else if (item !== null && typeof item === "object") {
        const o = item;
        const p = o.provider;
        const m = o.model;
        if (typeof p === "string" && typeof m === "string" && p !== "" && m !== "") {
          out.push({ provider: p, model: m });
        } else if (typeof o.real_model_id === "string") {
          const pair = splitModelId(o.real_model_id);
          if (pair) out.push({ provider: pair[0], model: pair[1] });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
function parseEfforts(raw) {
  if (raw === null || raw === void 0) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.filter((x) => typeof x === "string");
  } catch {
    return null;
  }
}
function parseAllowsOff(raw) {
  if (raw === null || raw === void 0) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  return null;
}
async function setupAsOne(options) {
  const { dbPath } = options;
  const env2 = options.env ?? process.env;
  const startedAtMs = Date.now();
  const dataDir = options.dataDir ?? dirname2(dbPath);
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(dbPath);
  const channelOverlay = new LiveChannelOverlay(db);
  const channelLive = /* @__PURE__ */ new Map();
  const setChannelLive = (provider, live) => {
    const fn = live?.enabled;
    if (typeof fn === "function") {
      channelLive.set(provider, fn);
    } else {
      channelLive.delete(provider);
    }
  };
  const setChannelEnabled = (provider, enabled) => {
    channelOverlay.set(provider, enabled);
    channelLive.delete(provider);
    try {
      db.setting.set(`${CHANNEL_OVERLAY_PREFIX}${provider}`, enabled ? "1" : "0");
    } catch (err) {
      console.error("[as-one] 渠道启停落库失败:", err);
    }
  };
  const channelEnabledOf = (provider) => {
    const live = channelLive.get(provider);
    if (live) {
      try {
        return live();
      } catch {
      }
    }
    return channelOverlay.get(provider) ?? true;
  };
  const registry = ProviderRegistry.fromSnapshot(snapshotFromDb(db).snapshot);
  const syncRegistry = () => {
    try {
      registry.refreshFromSnapshot(snapshotFromDb(db).snapshot);
    } catch (err) {
      console.error("[as-one] registry reprojection failed:", err);
    }
  };
  const vault = new CredentialVault(new DbCredentialBackend(db));
  if (channelEnabledOf("sensenova")) {
    await syncSensenovaPool(vault);
  }
  const secretPresence = /* @__PURE__ */ new Map();
  for (const pdef of registry.listProviders()) {
    try {
      for (const username of (await vault.secretsFor(pdef.id)).keys()) {
        secretPresence.set(`${pdef.id}/${username}`, true);
      }
    } catch (err) {
      console.error(`[as-one] credential probe failed for provider ${pdef.id}:`, err);
    }
  }
  const accountOverlay = new LiveAccountOverlay(db);
  const setAccountEnabled = (ref, enabled) => {
    accountOverlay.set(ref, enabled);
    try {
      db.setting.set(overlayKeyOf(ref), enabled ? "1" : "0");
    } catch (err) {
      console.error("[as-one] 账号启停落库失败:", err);
    }
  };
  const repo = new AppSchedulerRepo(db, registry, {
    hasSecret: (ref) => secretPresence.get(ref) ?? false,
    isAccountEnabled: (ref) => accountOverlay.get(ref) ?? (registry.getAccount(ref)?.enabled ?? false),
    /**
     * 渠道级总开关(用户 m11109 定案):渠道关闭 → 其下所有账号全部不进链。
     * ref 形如 `provider/username`,provider 取第一段。
     */
    isChannelEnabled: (ref) => {
      const slash = ref.indexOf("/");
      const provider = slash === -1 ? ref : ref.slice(0, slash);
      return channelEnabledOf(provider);
    },
    // 运行期额度快照:与 electron 同一份投影(`@as-one/panel` 模块级 chQuotaCache)。
    // 没喂它 → due-first 的 `_expiryOf()` 两个来源全空 → 排序键并列 → 只能按
    // members 数组序,「到期早的先上」等于没生效(用户 m17562/m34799)。
    // 面板刷新写完缓存后会 `scheduler.invalidate()`,所以这里不必自己缓存。
    quotaSnapshot: options.quotaSnapshot ? () => options.quotaSnapshot() ?? {} : () => quotaHub.table()
  });
  const scheduler = new Scheduler(repo, {});
  const router = new Router(repo, {
    // 会话粘性活读设置项(与 electron 同口径:default 900s;0 = 关掉粘性)。
    pinSecondsOf: () => numSetting(db, "scheduler.pin_seconds", 900),
    onCommit: () => {
      try {
        scheduler.invalidate();
      } catch {
      }
    }
  });
  const keyProvider = new EnvKeyProvider("ONE_API_KEY", env2);
  const logDir = options.logDir ?? join2(dataDir, "logs");
  const requestLogWriter = new RequestLogWriter(logDir);
  const requestLogMode = createContentModeResolver((key) => settingOf(db, key));
  const onRequestDone = (info) => {
    let realModelId;
    let endpointId;
    try {
      const affinityKeys = /* @__PURE__ */ new Set();
      if (info.session_id) affinityKeys.add(info.session_id);
      if (info.prompt_cache_key) affinityKeys.add(info.prompt_cache_key);
      const matched = router.ledger.recentRows(40).find(
        (r) => r.lease.logicalModel === info.model && r.lease.stream === info.stream && (affinityKeys.size === 0 || affinityKeys.has(r.lease.sessionId))
      );
      if (matched) {
        realModelId = matched.lease.realModelId;
        endpointId = matched.lease.endpointId;
      }
    } catch {
    }
    const logicalName = repo.logicalModelRow(info.model) !== null ? info.model : null;
    const row = {
      ts: Date.now() / 1e3,
      real_model_id: realModelId,
      logical_model: logicalName,
      username: endpointId ? endpointId.split("@")[1]?.split("/")[1] : void 0,
      session_id: info.session_id ?? null,
      prompt_cache_key: info.prompt_cache_key ?? null,
      discarded_fields: info.discarded_fields ?? null,
      status: info.status,
      ok: info.ok,
      error: info.error ?? void 0,
      error_kind: info.error_kind ?? void 0,
      latency_ms: info.latency_ms,
      ttft_ms: info.ttft_ms,
      usage: info.usage ?? void 0,
      request: info.request
    };
    try {
      logRequests([row], {
        record: (delta) => db.statsDaily.record(delta),
        writer: requestLogWriter,
        getSetting: (key) => settingOf(db, key),
        getContentMode: requestLogMode
      });
    } catch {
    }
  };
  let sensenovaKeyRepair = null;
  const workbuddyThrottle = new AccountThrottle();
  const workbuddySelfCheck = createWorkbuddySelfCheck({ vault });
  const resolveUpstream = buildResolveUpstream({
    scheduler,
    router,
    registry,
    vault,
    routes: () => rerouteSettingsFrom((key) => settingOf(db, key)),
    // 逻辑模型级输出上限(成员链最小值)—— `max_tokens` 钳制要用。
    // 唯一真源 = db(不读 registry:面板删掉的模型不该还参与钳制)。
    logicalOutputCap: (logicalName) => {
      const row = db.logicalModel.get(logicalName);
      if (!row) return null;
      const members = parseMembers(row.members);
      if (members.length === 0) return null;
      const caps = [];
      for (const m of members) {
        const dbRow = db.realModel.get(m.provider, m.model);
        const rdef = registry.getRealModel(m.provider, m.model);
        const cap = dbRow?.max_output_tokens ?? rdef?.maxOutputTokens ?? null;
        if (cap === null || cap === void 0) return null;
        caps.push(cap);
      }
      return caps.length > 0 ? Math.min(...caps) : null;
    },
    // 思考强度能力表(三态:NULL 不拦 / [] 一律不发 / [...] 钳制)。
    reasoningEffortsOf: (provider, model) => parseEfforts(db.realModel.get(provider, model)?.supported_reasoning_efforts),
    reasoningAllowsOffOf: (provider, model) => parseAllowsOff(db.realModel.get(provider, model)?.reasoning_allows_off),
    // 上游拒了 reasoning_effort → 丢参重试成功 ⇒ 写明「该模型不支持思考档位」。
    //
    // ⚠️ 写 `[]` 而不是 NULL(2026-11-08):NULL 只是「上游没给表」,将来上游
    // 补上档位表就会重新发送;`[]` 是确定的「不支持」,既不发也不用再学。
    onReasoningEffortLearned: (provider, model) => {
      try {
        db.realModel.update({ provider, model, supported_reasoning_efforts: "[]" });
      } catch (err) {
        console.error("[as-one] 记录思考强度不支持失败:", err);
      }
    },
    // 连接超时(秒)= 设置项 `real.wait_budget_s`;0 = 不设超时;坏值回退 60。
    requestTimeoutMs: () => numSetting(db, "real.wait_budget_s", 60),
    // 重试策略(次数上限 + 退避 + 可重试白名单);一次读齐,请求内前后一致。
    retryPolicy: (abstract) => RetryPolicy.of(
      {
        getSetting: (key) => settingOf(db, key),
        setSetting: (key, value) => {
          db.setting.set(key, value);
        }
      },
      { abstract }
    ),
    // ⚠️ **凭据类失败 → 后台换 key**(用户 m16528)。这里是**不阻塞**的:换 key
    //    要登录 + 建 key + 等 IAM 传播(实测 ~8s),原地等会把这次请求的 TTFT
    //    硬拖 8 秒起跳;换档去别的账号**立刻**能试。冷却照常落(按
    //    `scheduler.cooldown_overrides` 里的 sensenova 设置值),后台修好 + 冷却
    //    到期 ⇒ 下一跳即用新 key。
    //    自愈实现由 `setSensenovaKeyRepair` 后挂(面板构造完才有)。
    onSensenovaKeyInvalid: (username) => {
      const repair = sensenovaKeyRepair;
      if (!repair) return;
      void repair(username, "上游返回 401/403:API key 无效或已被回收").then((r) => {
        console.warn(
          `[as-one] [sensenova] key 自愈 ${r.ok ? "完成" : "未成功"}(${username}):${r.message}`
        );
        if (!r.ok) return;
        try {
          router.thawAccount("sensenova", username);
        } catch {
        }
      }).catch((err) => {
        console.error(
          `[as-one] [sensenova] key 自愈异常(${username}):${err instanceof Error ? err.message : String(err)}`
        );
      });
    },
    // A1:WorkBuddy 账号级最小请求间隔(网关在 commit 之前等,见 AccountThrottle)。
    workbuddyThrottle: async (username, signal) => {
      await workbuddyThrottle.acquire(accountThrottleKey("workbuddy", username), signal);
    },
    // A4:WorkBuddy 首用自检(新账号首个请求前先打只读探针)。
    workbuddySelfCheck
  });
  const runtime = {
    dataDir,
    dbPath,
    logDir,
    db,
    registry,
    vault,
    repo,
    scheduler,
    router,
    ledger: router.ledger,
    health: router.health,
    keyProvider,
    accountOverlay,
    setAccountEnabled,
    /**
     * 渠道启停覆盖(用户 m11109 定案:每渠道一个子组件,设置页一个开关)。
     * - 内存这份是读缓存,唯一真源是 `setting` 表逐键行 `channel.enabled.<provider>`;
     * - 渠道行(子组件)apply 时经 `setChannelLive` 登记 live 源 —— 优先于镜像,
     *   schemastery Volatile 免重启;db 镜像是它的持久化影子(跨实例一致)。
     */
    channelOverlay,
    setChannelEnabled,
    setChannelLive,
    getSetting: (key) => settingOf(db, key),
    secretPresence,
    subagentCapOf: (provider, model) => {
      const realCap = (p, m) => {
        if (!channelEnabledOf(p)) return 0;
        const creds = registry.listAccounts(p).filter((a) => accountOverlay.get(a.credentialRef) ?? a.enabled).length;
        const conc = db.realModel.get(p, m)?.concurrency ?? registry.getRealModel(p, m)?.concurrency ?? defaultConcurrencyOf(p);
        return Math.max(1, creds) * Math.max(1, conc);
      };
      if (model !== void 0 && model !== "" && !model.includes("/")) {
        const row = db.logicalModel.get(model);
        if (row !== null && row !== void 0) {
          const members = parseMembers(row.members);
          if (members.length === 0) return null;
          return members.reduce((sum, m) => sum + realCap(m.provider, m.model), 0);
        }
      }
      if (provider === void 0 || provider === "" || model === void 0 || model === "") return null;
      return realCap(provider, model);
    },
    syncRegistry,
    resolveUpstream,
    /**
     * /v1/models 清单:凭据在场 × **渠道启用**(用户 m11109 定案)。
     * 渠道关闭后其真实模型不再出现在对外清单里 —— 选路也进不去,清单没意义。
     */
    listModels: async () => {
      const withCreds = await providersWithCredentials(registry, vault);
      const live = /* @__PURE__ */ new Set();
      for (const p of withCreds) {
        if (channelEnabledOf(p)) live.add(p);
      }
      return listModelEntries(registry, db, live);
    },
    /**
     * 运行期单模型解析(**不过滤 hidden**)—— 与 GUI 清单分离。
     * 压缩组件直连隐藏成员(如 maas/spark-x2.6-4b)必须能解析,否则 404。
     * 见 `resolveModelEntry` 注释(2026-11-21 web profile 实测修复)。
     */
    resolveModelEntry: (id) => resolveModelEntry(registry, db, id),
    onRequestDone,
    startedAtMs,
    setSensenovaKeyRepair(fn) {
      sensenovaKeyRepair = fn;
    },
    /**
     * 挂在运行时上的「额度就绪门」（由插件入口注入，见 AsOneRuntime.awaitQuota）。
     *
     * 这里刻意用可变槽而不是构造参数：WarmupGate 依赖 panel host，而 panel host
     * 又依赖本函数返回的 runtime —— 有循环，只能后挂。
     */
    awaitQuota: void 0,
    attachQuotaGate(gate) {
      if (gate === null) {
        runtime.awaitQuota = void 0;
        return;
      }
      runtime.awaitQuota = async () => {
        try {
          await gate.wait();
        } catch {
        }
      };
    },
    dispose() {
      try {
        sensenovaPoolConnector.setAccounts([]);
      } catch {
      }
      vault.close();
      registry.close();
      db.close();
    }
  };
  return runtime;
}

export {
  UpstreamError2 as UpstreamError,
  AUTH_STORAGE_KEY,
  DEVICE_CENTER_PREFIX,
  normalize_region,
  resolve_api_base,
  resolve_identity,
  build_headers,
  decrypt_storage_value,
  parse_refresh_response,
  CheckinError,
  CheckinRegionError,
  CheckinCredentialError,
  CHECKIN_PROVIDERS,
  checkinSupported,
  TRAE_CODE_CROWDED,
  traeCheckinStatus,
  traeCheckinClaim,
  wbRegionOf,
  wbCheckinStatus,
  wbCheckinClaim,
  CODEARTS_BASE_CN,
  CODEARTS_MODELS_PATH,
  codeartsIdentityHeaders,
  signCodeartsRequest,
  REGION_BASES2 as REGION_BASES,
  normalize_region2,
  detect_region_from_token,
  jwt_claim,
  build_refresh_headers,
  parse_refresh_response2,
  panelClaimedToday,
  panelTodayPoints,
  minimaxSigninStatus,
  minimaxSigninClaim,
  minimaxRefreshToken,
  minimaxAccountOf,
  markCodeartsCheckin,
  number_of,
  probe_trae_quota,
  probe_workbuddy_quota,
  MINIMAX_QUOTA_TIMEOUT_MS,
  probe_minimax_quota,
  probe_codearts_quota,
  orderRawLevels,
  serializeReasoningEfforts,
  realModelMapOf,
  countJsonlLines,
  todayLocal,
  dayAdd,
  clampDay,
  rangeDays,
  monthAxis,
  round1,
  pct,
  fpOf,
  splitRef,
  parseDbMembers,
  membersFromInput,
  quotaHub,
  credentialKey,
  expiresAtOf,
  needsRefresh,
  fingerprint,
  probeWorkbuddyAccount,
  MINIMAX_MODELS,
  QODER_REGIONS,
  isQoderRegion,
  QODER_REGION_CONFIGS,
  QoderUpstreamError,
  QoderClient,
  getQoderClient,
  sensenova_username,
  parse_pool_usage,
  jwt_expiry_epoch_s,
  SensenovaAuthFlow,
  getAllConnectors,
  setCompactHost,
  internalSwitch,
  syncSensenovaPool,
  setupAsOne
};
//# sourceMappingURL=chunk-4Z6VTPLS.js.map
