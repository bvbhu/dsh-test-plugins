#!/usr/bin/env node
/**
 * 一次性数据迁移:清洗 `stats_daily` 里 provider='as-one' 的**遗留行**。
 *
 * ## 背景
 *
 * 2026-10-04 ~ 10-11 是旧版插件还没有真实供应商归属机制的时期,那 1,323 条请求
 * 全部落成 provider='as-one'(10-12 起归属正常,此后不再产生)。明细日志已只留
 * 到 10-31,DB 无明细表 —— 逐条核对后只能按**模型名**定归属(2026-11-14 用户定案):
 *
 * | 现状模型 | 处理 | 改写为 |
 * |---|---|---|
 * | workbuddy/hy4-preview | 改写 | workbuddy / hy4-preview |
 * | workbuddy/hy3 | 改写 | workbuddy / hy3 |
 * | workbuddy/space-bunny | 改写 | workbuddy / space-bunny |
 * | trae/glm-5.3-flashx | 改写 | trae / glm-5.3-flashx |
 * | trae/deepseek-v4.1-flash | 改写 | trae / deepseek-v4.1-flash |
 * | sensenova-1/sensenova-6.8-flash-lite | 改写 | sensenova / sensenova-6.8-flash-lite |
 * | sensenova-0/deepseek-v4-flash | 改写 | sensenova / deepseek-v4-flash |
 * | deepseek-v4-flash | 改写 | sensenova / deepseek-v4-flash(用户点名) |
 * | chatgpt/luna | 改写 | chatgpt / luna |
 * | nexus-flash | **删除**(旧逻辑模型,当时成员不可考) |
 * | image | **删除**(旧图像桥伪模型,走的视觉端点不可考) |
 * | compact | **删除**(旧压缩伪模型,同上) |
 *
 * 改写行的 `logical_model` 一律落 NULL:这些名字(带斜杠的真实直连名、已不存在的
 * 旧逻辑名)都不在现行 logical_model 表里,按现行口径必须落 NULL。
 * 同一天多条源行落到同一目标键时(10-08 的 deepseek-v4-flash 与
 * sensenova-0/deepseek-v4-flash 都 → sensenova/deepseek-v4-flash)**合并计数**。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/migrate-legacy-as-one.mjs            # 预演(默认,只读)
 * node scripts/migrate-legacy-as-one.mjs --apply    # 真写(先备份,再单事务)
 * ```
 *
 * 安全措施与 migrate-provider-names.mjs 相同:VACUUM INTO 备份、BEGIN IMMEDIATE
 * 单事务、目标行已存在时合并计数而不是撞主键、认不出的模型原样保留并告警。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const LEGACY_PROVIDER = "as-one";

/** 逐条改写表:键是 `stats_daily.model` 的原样值,值是 [目标 provider, 目标 model]。 */
const REWRITES = {
  "workbuddy/hy4-preview": ["workbuddy", "hy4-preview"],
  "workbuddy/hy3": ["workbuddy", "hy3"],
  "workbuddy/space-bunny": ["workbuddy", "space-bunny"],
  "trae/glm-5.3-flashx": ["trae", "glm-5.3-flashx"],
  "trae/deepseek-v4.1-flash": ["trae", "deepseek-v4.1-flash"],
  "sensenova-1/sensenova-6.8-flash-lite": ["sensenova", "sensenova-6.8-flash-lite"],
  "sensenova-0/deepseek-v4-flash": ["sensenova", "deepseek-v4-flash"],
  // 2026-11-14 用户点名:那个时期 deepseek-v4-flash 的服务方就是 sensenova
  "deepseek-v4-flash": ["sensenova", "deepseek-v4-flash"],
  "chatgpt/luna": ["chatgpt", "luna"],
};

/** 已核对、确认删除的伪模型(成员/端点不可考,留着只会污染榜)。 */
const DELETE_MODELS = ["nexus-flash", "image", "compact"];

const COUNTERS = [
  "requests",
  "fails",
  "prompt_tokens",
  "cached_tokens",
  "completion_tokens",
  "latency_sum_ms",
  "ttft_sum_ms",
  "ttft_requests",
];

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const apply = process.argv.includes("--apply");
const dbPath = argOf("--db", join(homedir(), ".as-one", "as-one.db"));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");

if (!existsSync(dbPath)) {
  console.error(`✗ 找不到库:${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: !apply });
db.exec("PRAGMA busy_timeout = 5000;");

const rows = db
  .prepare("SELECT rowid AS rid, * FROM stats_daily WHERE provider = ? ORDER BY day, model")
  .all(LEGACY_PROVIDER);

if (rows.length === 0) {
  console.log("✓ 库里没有 provider='as-one' 的行,无事可做");
  db.close();
  process.exit(0);
}

// ── 分类 ────────────────────────────────────────────────────────────
const rewrites = new Map(); // 目标键 "day\0provider\0model" → { day, provider, model, counters 累计 }
const deletes = [];
let movedTokens = 0;
const unknown = new Set();

for (const row of rows) {
  if (DELETE_MODELS.includes(row.model)) {
    deletes.push(row);
    continue;
  }
  const target = REWRITES[row.model];
  if (!target) {
    unknown.add(row.model);
    continue;
  }
  const key = `${row.day}\0${target[0]}\0${target[1]}`;
  const acc = rewrites.get(key) ?? {
    day: row.day,
    provider: target[0],
    model: target[1],
    counters: Object.fromEntries(COUNTERS.map((c) => [c, 0])),
  };
  for (const c of COUNTERS) acc.counters[c] += Number(row[c] ?? 0);
  rewrites.set(key, acc);
  movedTokens += Number(row.prompt_tokens ?? 0);
}

console.log(`库:${dbPath}`);
console.log(`模式:${apply ? "真写(会先备份)" : "预演(只读,不改一个字)"}`);
console.log(`\nprovider='${LEGACY_PROVIDER}' 共 ${rows.length} 行`);
console.log(`  改写:${rewrites.size} 个目标键(源 ${rows.length - deletes.length - unknown.size} 行,${movedTokens} prompt token)`);
for (const [key, acc] of rewrites) {
  console.log(
    `    ${acc.day}  ${LEGACY_PROVIDER}/… → ${acc.provider}/${acc.model}` +
      `  req=${acc.counters.requests} pt=${acc.counters.prompt_tokens}`,
  );
}
console.log(`  删除:${deletes.length} 行(${deletes.reduce((s, r) => s + Number(r.prompt_tokens ?? 0), 0)} prompt token)`);
for (const r of deletes) console.log(`    ${r.day}  ${r.model}  req=${r.requests} pt=${r.prompt_tokens}`);
if (unknown.size > 0) {
  console.log(`  ! 认不出的模型(原样保留,不会碰):${[...unknown].join(", ")}`);
}

if (!apply) {
  console.log("\n(预演结束。确认无误后加 --apply 真写)");
  db.close();
  process.exit(0);
}

// ── 备份 → 单事务改写 ────────────────────────────────────────────────
const backup = `${dbPath}.bak-${stamp}-legacy-as-one`;
db.prepare("VACUUM INTO ?").run(backup);
db.close();
console.log(`\n已备份:${backup}`);

const rw = new DatabaseSync(dbPath);
rw.exec("PRAGMA busy_timeout = 5000;");
rw.exec("BEGIN IMMEDIATE");
try {
  // 1) 改写:目标行(含 logical NULL)已存在则合并计数,否则插入;最后删源行。
  let inserted = 0;
  let merged = 0;
  for (const acc of rewrites.values()) {
    const hit = rw
      .prepare(
        "SELECT rowid AS rid FROM stats_daily" +
          " WHERE day = ? AND logical_model IS NULL AND provider = ? AND model = ?",
      )
      .get(acc.day, acc.provider, acc.model);
    if (hit) {
      const sets = COUNTERS.map((c) => `${c} = ${c} + ?`).join(", ");
      rw.prepare(`UPDATE stats_daily SET ${sets} WHERE rowid = ?`).run(
        ...COUNTERS.map((c) => acc.counters[c]),
        hit.rid,
      );
      merged += 1;
    } else {
      rw.prepare(
        "INSERT INTO stats_daily" +
          " (day, logical_model, provider, model, requests, fails, prompt_tokens," +
          "  cached_tokens, completion_tokens, latency_sum_ms, ttft_sum_ms, ttft_requests)" +
          " VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        acc.day,
        acc.provider,
        acc.model,
        ...COUNTERS.map((c) => acc.counters[c]),
      );
      inserted += 1;
    }
  }
  // 2) 删除伪模型行(按 rowid 精确删,不按名字兜圈子)。
  let deleted = 0;
  for (const r of deletes) {
    rw.prepare("DELETE FROM stats_daily WHERE rowid = ?").run(r.rid);
    deleted += 1;
  }
  // 3) 清掉已改写的源行(rewrite 源 = 除删除与未知外的全部 as-one 行)。
  let removedSource = 0;
  for (const row of rows) {
    if (DELETE_MODELS.includes(row.model) || unknown.has(row.model)) continue;
    rw.prepare("DELETE FROM stats_daily WHERE rowid = ?").run(row.rid);
    removedSource += 1;
  }
  rw.exec("COMMIT");
  console.log(`✓ 完成:插入 ${inserted} / 合并进已有行 ${merged} / 删除伪模型 ${deleted} / 移除源行 ${removedSource}`);
} catch (err) {
  rw.exec("ROLLBACK");
  console.error("✗ 改写失败,已回滚:", err);
  rw.close();
  process.exit(1);
}

console.log("\n── 改写后 ──");
const leftover = rw
  .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(prompt_tokens), 0) AS pt FROM stats_daily WHERE provider = ?")
  .get(LEGACY_PROVIDER);
console.log(
  leftover.n === 0
    ? "✓ provider='as-one' 已清空"
    : `! 仍残留 ${leftover.n} 行(${leftover.pt} token)—— 应该就是上面「认不出的模型」`,
);
console.log(`校验:integrity_check = ${rw.prepare("PRAGMA integrity_check").get().integrity_check}`);
rw.close();
