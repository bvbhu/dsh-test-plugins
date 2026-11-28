/**
 * bot-mhy 行 —— Yunzai supervisor 托管 + SnowLuma 受控入口 + 米游社签到通知。
 *
 * patch 行 `@bvbhu/as-one/bot-mhy`。只装三件事（与 chat/assistant/notify
 * 零服务引用，完全隔离）：
 *
 * 1. **Yunzai supervisor**：spawn `node app.js`（cwd = app 目录，trss-yunzai
 *    3.1.3 可裸跑）。**先探测再 spawn**：端口已通（开发期 pm2 原样运行）就
 *    不重复拉起；心跳（缺省 60s）探测进程活性，死了/卡死（端口连不通连续
 *    N 轮）重拉；行卸载 tree-kill（Windows `taskkill /PID x /T /F`）。
 * 2. **SnowLuma 通知**：开发期不动（pm2 原样），代码里只留受控入口——
 *    配置键 `bot.mhy.snowLuma.autoStart`（缺省 false）等，联调时 lead 开启。
 * 3. **签到**：每天 00:02（`bot.mhy.signin.time` 可覆盖）跑
 *    `plugins/xiaoyao-cvs-plugin/sign-all.mjs`（cwd = app 目录，脚本按
 *    process.cwd() 拼 import 路径），跑完 emit `as-one:bot:mhy-signin`
 *    事件（payload {ok, summary}）给 bot-notify 行消费；结果同时经
 *    asOneBotChannel 直推主人私聊。通道缺失只 warn 跳过，**不阻塞签到逻辑**。
 *
 * 跨行契约（只 import type，零运行时依赖其他行）：
 *   - bot-channel 行 provide `asOneBotChannel`（send）；通道缺失本行照常
 *     加载，spawn/签到逻辑不变，只跳过推送。
 *   - 核心行 provide `asOneCore`（runtime.getSetting 读 `bot.mhy.*` 配置）。
 *   - settings 行 provide `asOneMhySettings`（Volatile live 配置）——**配置
 *     首选来源**（DSH 设置页可编辑）；settings 行缺席时回退 setting 表。
 *
 * 配置键（settings 行 schema 为首选，setting 表为兜底；同一逻辑键两套存储）：
 *   bot.mhy.yunzai.dir          Yunzai app 目录（缺省 D:\projects\bot\yunzai-qqbot\app）
 *   bot.mhy.yunzai.port         探测端口（缺省读 app/config/config/server.yaml，再缺省 2536）
 *   bot.mhy.yunzai.autoStart    缺省开（探测先行，pm2 在跑时不会双开）
 *   bot.mhy.yunzai.heartbeatMs  心跳间隔（缺省 60000，钳制 5s..1h）
 *   bot.mhy.snowLuma.autoStart  SnowLuma 自动托管开关（缺省 false，开发期不动）
 *   bot.mhy.snowLuma.dir        SnowLuma 目录（开启时必填）
 *   bot.mhy.signin.enabled      签到开关（缺省 true）
 *   bot.mhy.signin.time         每天签到时刻 HH:MM（缺省 "00:02"）
 *   bot.mhy.signin.ownerQQ      直推主人 QQ（缺省 3187192488）
 *
 * 运行期语义：配置在本行 apply 时解析一次（快照）。settings UI 改值后
 * Volatile live 变化不重启 supervisor——改 dir/port 需重启 DSH 生效。
 */

import { spawn, spawnSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Volatile } from "@deepseek-ai/cordis";

import type { AsOneBotChannelService } from "./bot-channel-service.js";
import type { AsOneCoreService } from "./core-service.js";
import type { AsOneMhySettingsService } from "./settings-service.js";
import type { Context } from "./context-types.js";

export const name = "@bvbhu/as-one/bot-mhy";
export const inject = ["asOneBotChannel", "asOneCore", "asOneMhySettings"];

/** Yunzai app 目录（trss-yunzai 3.1.3，可裸跑 `node app.js`）。 */
const DEFAULT_YUNZAI_DIR = "D:\\projects\\bot\\yunzai-qqbot\\app";
/** server.yaml 缺 port 时的兜底端口（trss-yunzai 默认 2536）。 */
const DEFAULT_YUNZAI_PORT = 2536;
/** 心跳间隔缺省 60s。 */
const DEFAULT_HEARTBEAT_MS = 60_000;
/** 心跳间隔钳制范围。 */
const HEARTBEAT_MIN_MS = 5_000;
const HEARTBEAT_MAX_MS = 3_600_000;
/** 端口连续不通多少轮判「卡死」重拉（60s × 3 = 3 分钟宽限）。 */
const PORT_MISS_LIMIT = 3;
/** TCP 探测超时。 */
const PROBE_TIMEOUT_MS = 2_000;
/** 签到时刻缺省 00:02。 */
const DEFAULT_SIGNIN_TIME = "00:02";
/** 主人 QQ（私聊直推目标）。 */
const DEFAULT_OWNER_QQ = "3187192488";
/** sign-all.mjs 相对 app 目录的路径（脚本按 process.cwd() 拼 import 路径）。 */
const SIGN_ALL_REL = join("plugins", "xiaoyao-cvs-plugin", "sign-all.mjs");
/** sign-all.mjs 写出的结果文件（相对 app 目录），用于摘要里的签到数。 */
const SIGN_RESULT_REL = join("plugins", "xiaoyao-cvs-plugin", "data", "sign-all-last.json");

/** 签到结果事件 payload（bot-notify 行消费）。 */
export interface BotMhySigninPayload {
  ok: boolean;
  summary: string;
}

/** 本行配置（全部来自 setting 表，缺省兜底）。 */
interface MhyConfig {
  yunzaiDir: string;
  yunzaiPort: number;
  yunzaiAutoStart: boolean;
  heartbeatMs: number;
  snowLumaAutoStart: boolean;
  snowLumaDir: string;
  signinEnabled: boolean;
  signinTime: string;
  signinScript: string;
  ownerQQ: string;
}

/**
 * 探测端口是否在听：能连上就认为 Yunzai（或等价服务）已在跑。
 * 开发期 Yunzai 由 pm2 管着，端口通 → supervisor 不重复拉起。
 */
function probePort(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (open: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      resolve(open);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const socket = netConnect({ port, host: "127.0.0.1" });
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** 从 app/config/config/server.yaml 读 port（读不到/没配用默认 2536）。 */
function configuredYunzaiPort(appDir: string): number {
  try {
    const text = readFileSync(join(appDir, "config", "config", "server.yaml"), "utf-8");
    const m = /^port:\s*(\d+)/m.exec(text);
    if (m) {
      const port = Number(m[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    }
  } catch {}
  return DEFAULT_YUNZAI_PORT;
}

/** Windows tasklist 判 pid 活性（child 'exit' 之外的兜底，防僵尸句柄）。 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const res = spawnSync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
      { windowsHide: true, encoding: "utf-8", timeout: 5_000 },
    );
    if (res.status !== 0) return false;
    const out = `${res.stdout ?? ""}`;
    return out.includes(`,"${pid}",`) || out.includes(`,"${pid}"`);
  } catch {
    return false;
  }
}

/** Windows tree-kill：taskkill /PID x /T /F（杀整棵进程树）。 */
function killTree(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const res = spawnSync(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 10_000 },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * 沿 settings.config 走 dotted path（"yunzai.dir"）取 Volatile 引用；
 * 任一段缺失 → undefined（调用方回退 setting 表）。
 */
function getVolatile(root: unknown, path: string): Volatile<unknown> | undefined {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur as Volatile<unknown> | undefined;
}

/**
 * 解析本行配置。**双源**：
 *  1. settings 行 `asOneMhySettings`（Volatile live 值，DSH 设置页可编辑）——首选；
 *  2. setting 表 `runtime.getSetting`（settings 行缺席时的兜底，兼容旧数据）。
 * 两源都读失败/空值一律走缺省，不让配置 bug 拖垮本行。
 */
async function resolveConfig(
  runtime: { getSetting(key: string): string | null },
  settings: AsOneMhySettingsService | undefined,
): Promise<MhyConfig> {
  /** setting 表兜底（读失败/空值一律走缺省）。 */
  const str = async (key: string, fallback: string): Promise<string> => {
    try {
      return runtime.getSetting(key) ?? fallback;
    } catch {
      return fallback;
    }
  };

  /** settings 行 live 值；settings 行缺席/字段缺失/读取失败 → undefined（回退 setting 表）。 */
  const sVal = (path: string): unknown => {
    if (!settings) return undefined;
    try {
      return getVolatile(settings.config, path)?.get();
    } catch {
      return undefined;
    }
  };

  const yunzaiDir = String(sVal("yunzai.dir") ?? (await str("bot.mhy.yunzai.dir", DEFAULT_YUNZAI_DIR))).trim() || DEFAULT_YUNZAI_DIR;
  const port = Number(
    String(sVal("yunzai.port") ?? (await str("bot.mhy.yunzai.port", String(configuredYunzaiPort(yunzaiDir))))).trim(),
  );
  const heartbeatMs = Number(
    String(sVal("yunzai.heartbeatMs") ?? (await str("bot.mhy.yunzai.heartbeatMs", String(DEFAULT_HEARTBEAT_MS)))).trim(),
  );
  const signinTime = String(sVal("signin.time") ?? (await str("bot.mhy.signin.time", DEFAULT_SIGNIN_TIME))).trim();

  const autoStartVal = sVal("yunzai.autoStart");
  const snowAutoVal = sVal("snowLuma.autoStart");
  const signinEnabledVal = sVal("signin.enabled");

  return {
    yunzaiDir,
    yunzaiPort:
      Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_YUNZAI_PORT,
    yunzaiAutoStart:
      autoStartVal !== undefined ? autoStartVal === true : (await str("bot.mhy.yunzai.autoStart", "1")) !== "0",
    heartbeatMs:
      Number.isFinite(heartbeatMs)
        ? Math.min(Math.max(heartbeatMs, HEARTBEAT_MIN_MS), HEARTBEAT_MAX_MS)
        : DEFAULT_HEARTBEAT_MS,
    snowLumaAutoStart:
      snowAutoVal !== undefined ? snowAutoVal === true : (await str("bot.mhy.snowLuma.autoStart", "0")) === "1",
    snowLumaDir: String(sVal("snowLuma.dir") ?? (await str("bot.mhy.snowLuma.dir", ""))).trim(),
    signinEnabled:
      signinEnabledVal !== undefined ? signinEnabledVal === true : (await str("bot.mhy.signin.enabled", "1")) !== "0",
    signinTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(signinTime) ? signinTime : DEFAULT_SIGNIN_TIME,
    signinScript: join(yunzaiDir, SIGN_ALL_REL),
    ownerQQ: String(sVal("signin.ownerQQ") ?? (await str("bot.mhy.signin.ownerQQ", DEFAULT_OWNER_QQ))).trim() || DEFAULT_OWNER_QQ,
  };
}

/** Yunzai supervisor：spawn/心跳自愈/卸载 kill。 */
interface YunzaiSupervisor {
  stop(): void;
}

function startYunzaiSupervisor(
  ctx: Context,
  cfg: MhyConfig,
): YunzaiSupervisor {
  let child: ChildProcess | null = null;
  /** 本 supervisor 是否「拥有」这个进程：false = 外部实例（开发期 pm2），不接管。 */
  let owns = false;
  let portMisses = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** spawn（先再探一次端口，防止 pm2 实例刚起来的竞态双开）。 */
  const spawnChild = async (why: string): Promise<void> => {
    if (stopped) return;
    if (await probePort(cfg.yunzaiPort)) {
      ctx.logger?.info?.(
        `[as-one] bot-mhy: port ${cfg.yunzaiPort} already serving, skip spawn (${why})`,
      );
      return;
    }
    try {
      const c = spawn(process.execPath, ["app.js"], {
        cwd: cfg.yunzaiDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = c;
      owns = true;
      portMisses = 0;
      c.stdout?.on("data", (d: Buffer) => {
        ctx.logger?.debug?.(`[yunzai] ${d.toString().trim()}`);
      });
      c.stderr?.on("data", (d: Buffer) => {
        ctx.logger?.warn?.(`[yunzai] ${d.toString().trim()}`);
      });
      c.on("exit", (code, signal) => {
        ctx.logger?.warn?.(`[as-one] bot-mhy: yunzai exited code=${code} signal=${signal}`);
        child = null;
      });
      ctx.logger?.info?.(`[as-one] bot-mhy: yunzai spawned pid=${c.pid} (${why})`);
    } catch (err) {
      ctx.logger?.warn?.(`[as-one] bot-mhy: yunzai spawn failed (${why}):`, err);
    }
  };

  /** 心跳：死了重拉；活着但端口连不通连续 N 轮 → 判卡死，tree-kill 重拉。 */
  const heartbeat = async (): Promise<void> => {
    if (stopped || !owns) return; // 外部实例（pm2）不接管
    const alive =
      child !== null &&
      child.exitCode === null &&
      child.signalCode === null &&
      isPidAlive(child.pid ?? 0);
    if (!alive) {
      ctx.logger?.warn?.("[as-one] bot-mhy: yunzai process gone, respawning");
      void spawnChild("heartbeat: process gone");
      return;
    }
    if (await probePort(cfg.yunzaiPort)) {
      portMisses = 0;
      return;
    }
    portMisses += 1;
    ctx.logger?.warn?.(
      `[as-one] bot-mhy: yunzai port ${cfg.yunzaiPort} dark (${portMisses}/${PORT_MISS_LIMIT})`,
    );
    if (portMisses >= PORT_MISS_LIMIT) {
      const pid = child?.pid;
      child = null;
      ctx.logger?.warn?.("[as-one] bot-mhy: yunzai wedged, killing tree and respawning");
      if (pid !== undefined && !killTree(pid)) {
        ctx.logger?.warn?.(`[as-one] bot-mhy: taskkill failed pid=${pid}, will retry next tick`);
      }
      void spawnChild(`heartbeat: port dark x${PORT_MISS_LIMIT}`);
      portMisses = 0;
    }
  };

  void (async () => {
    if (await probePort(cfg.yunzaiPort)) {
      ctx.logger?.info?.(
        `[as-one] bot-mhy: port ${cfg.yunzaiPort} already serving (dev pm2?), supervisor idle`,
      );
      return;
    }
    if (!cfg.yunzaiAutoStart) {
      ctx.logger?.info?.("[as-one] bot-mhy: yunzai.autoStart off, not spawning");
      return;
    }
    await spawnChild("initial");
  })();

  timer = setInterval(() => void heartbeat(), cfg.heartbeatMs);
  timer.unref();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      const pid = child?.pid;
      child = null;
      if (pid !== undefined && owns && !killTree(pid)) {
        ctx.logger?.warn?.(`[as-one] bot-mhy: dispose taskkill failed pid=${pid}`);
      }
    },
  };
}

/** SnowLuma 受控入口：开发期缺省关（pm2 原样），联调时 lead 开 autoStart。 */
function startSnowLuma(ctx: Context, cfg: MhyConfig): { stop(): void } | null {
  if (!cfg.snowLumaAutoStart) {
    ctx.logger?.info?.("[as-one] bot-mhy: snowluma.autoStart off (dev pm2 untouched)");
    return null;
  }
  if (!cfg.snowLumaDir || !existsSync(cfg.snowLumaDir)) {
    ctx.logger?.warn?.(
      "[as-one] bot-mhy: snowluma.autoStart on but dir unset/missing, skip (set bot.mhy.snowLuma.dir)",
    );
    return null;
  }
  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, ["app.js"], {
      cwd: cfg.snowLumaDir,
      windowsHide: true,
      stdio: "ignore",
    });
    ctx.logger?.info?.(`[as-one] bot-mhy: snowluma spawned pid=${child.pid}`);
  } catch (err) {
    ctx.logger?.warn?.("[as-one] bot-mhy: snowluma spawn failed:", err);
    return null;
  }
  return {
    stop(): void {
      const pid = child?.pid;
      child = null;
      if (pid !== undefined && !killTree(pid)) {
        ctx.logger?.warn?.(`[as-one] bot-mhy: snowluma dispose taskkill failed pid=${pid}`);
      }
    },
  };
}

/** 距下一个「今天 hh:mm（若已过则明天）」的毫秒数。 */
function delayToNextDaily(hhmm: string): number {
  const [hh, mm] = hhmm.split(":").map((n) => Number.parseInt(n, 10));
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh ?? 0, mm ?? 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** 每天定时跑一次，跑完自排下一次（unref，不挡宿主退出）。 */
function scheduleDaily(run: () => Promise<void>, hhmm: string, ctx: Context): void {
  const timer = setTimeout(() => {
    void run()
      .catch((err) => ctx.logger?.warn?.("[as-one] bot-mhy: signin run failed:", err))
      .finally(() => scheduleDaily(run, hhmm, ctx));
  }, delayToNextDaily(hhmm));
  timer.unref();
}

interface SignResultEntry {
  qq?: string;
  ltuid?: string;
  status?: string;
  ok?: boolean;
  message?: string;
}

interface SignFailureEntry {
  qq?: string;
  ltuid?: string;
  reason?: string;
}

interface SignResultFile {
  time?: string;
  ok?: boolean;
  okCount?: number;
  failedCount?: number;
  results?: SignResultEntry[];
  failed?: SignFailureEntry[];
}

/** 读 sign-all.mjs 结果文件；文件不存在/损坏返回 null。 */
function readSignResult(cwd: string): SignResultFile | null {
  try {
    const file = join(cwd, SIGN_RESULT_REL);
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf-8")) as SignResultFile;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** 星穹铁道段判定（用户 2026-11-28 定案）：multiSign 消息按 **游戏名** 分段，
 *  崩坏星穹铁道段内出现「已签到 / 签到成功」即视为该通行证签到成功 ——
 *  崩坏3 等其他游戏的失败（维护中 / 未绑定）不拉低整体结果。
 *  维护中文字「签到功能维护中」不含「已签到」，不会误判。 */
export function starRailSigned(message: string): boolean {
  const lines = String(message).split("\n");
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\*\*(崩坏)?星穹铁道\*\*$/u.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("**")) break;
    if (inSection && /已签到|签到成功/u.test(line)) return true;
  }
  return false;
}

/** 用结果文件而非进程退出码判定真实签到结果（旧脚本只写"尝试数"，会虚报成功）。 */
export function summarizeSignin(cwd: string, exitCode: number | null, tail: string): {
  ok: boolean;
  summary: string;
} {
  const stamp = new Date().toLocaleString("sv-SE");
  const data = readSignResult(cwd);
  if (!data) {
    return {
      ok: false,
      summary: `米游社签到失败（${stamp}）：未生成签到结果文件，无法确认签到成功${tail ? `；${tail}` : ""}`,
    };
  }
  const results = Array.isArray(data.results) ? data.results : [];

  // 通知口径（用户 2026-11-28 定案）：星穹铁道成功即视为该通行证签到成功，
  // 不看崩坏3 —— 上游脚本按整条文本判 ok/failed，崩坏3「维护中」一段会把
  // 整条拉成失败（2026-11-28 00:04 两通行证均因此误报失败），这里按星穹铁道段重判。
  const entryOk = (r: SignResultEntry): boolean =>
    (r && r.ok === true && r.status === "ok") || starRailSigned(String(r?.message ?? ""));
  let okCount: number;
  let failed: SignFailureEntry[];
  if (results.length > 0) {
    okCount = results.filter(entryOk).length;
    failed = results
      .filter((r) => !entryOk(r))
      .map((r) => ({
        qq: r.qq,
        ltuid: r.ltuid,
        reason: String(r.message ?? "").trim().split("\n").find(Boolean) ?? "未说明原因",
      }));
  } else {
    // results 缺失的残文件：退回文件自报口径（okCount + failed）。
    okCount = typeof data.okCount === "number" ? data.okCount : 0;
    failed = Array.isArray(data.failed) ? data.failed : [];
  }

  // 只认「至少一个成功通行证 + 零失败」；脚本整体 exit 1（崩坏3 维护中）不再拉低结果。
  const ok = results.length > 0 ? okCount > 0 && failed.length === 0 : data.ok === true && okCount > 0 && failed.length === 0;
  if (ok) {
    return {
      ok: true,
      summary: `米游社签到完成（${stamp}）：${okCount} 个通行证已签到`,
    };
  }
  const details = failed
    .slice(0, 5)
    .map((f) => `通行证${f.ltuid ?? "?"}(QQ ${f.qq ?? "?"})：${String(f.reason ?? "未说明原因").replace(/\s+/g, " ").slice(0, 120)}`)
    .join("；");
  const more = failed.length > 5 ? `；另有 ${failed.length - 5} 个失败` : "";
  return {
    ok: false,
    summary: `米游社签到失败（${stamp}）：成功 ${okCount} 个，失败 ${failed.length} 个${details ? `；${details}` : ""}${more}${!details && tail ? `；${tail}` : ""}`,
  };
}

/** 跑签到脚本：spawn node，cwd = app 目录（脚本按 process.cwd() 拼 import 路径）。 */
function runSignScript(script: string, cwd: string): Promise<{ ok: boolean; summary: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const c = spawn(process.execPath, [script], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    c.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    c.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    c.on("error", (e: NodeJS.ErrnoException) => {
      resolve({ ok: false, summary: `签到脚本拉起失败：${e.message}` });
    });
    c.on("exit", (code) => {
      const tail = (err.trim() || out.trim())
        .split("\n")
        .filter(Boolean)
        .slice(-3)
        .join(" | ")
        .slice(0, 300);
      resolve(summarizeSignin(cwd, code, tail));
    });
  });
}

export function apply(ctx: Context): void {
  const core = (ctx as unknown as { get(name: string): unknown }).get("asOneCore") as
    | AsOneCoreService
    | undefined;
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, bot-mhy row skipped");
    return;
  }
  // settings 行 provide 的 live 配置（inject 保证 providers 已装载；防御性兜底 undefined）。
  const settings = (ctx as unknown as { get(name: string): unknown }).get("asOneMhySettings") as
    | AsOneMhySettingsService
    | undefined;
  let channel =
    (ctx as unknown as { get(name: string): unknown }).get("asOneBotChannel") as
      | AsOneBotChannelService
      | undefined;
  if (channel && typeof channel.send !== "function") {
    ctx.logger?.warn?.("[as-one] bot channel service malformed, bot-mhy row treats it as absent");
    channel = undefined;
  }
  if (!channel) {
    // 通道缺失不阻塞本行：spawn/签到照常，只跳过推送（设计：bot-mhy 可独立加载）。
    ctx.logger?.warn?.(
      "[as-one] bot channel service unavailable, bot-mhy row loads without push",
    );
  }

  ctx.effect(
    async () => {
      const cfg = await resolveConfig(
        core.runtime as { getSetting(key: string): string | null },
        settings,
      );

      const yunzai = startYunzaiSupervisor(ctx, cfg);
      const snowluma = startSnowLuma(ctx, cfg);
      const disposers: (() => void)[] = [];
      if (snowluma) disposers.push(snowluma.stop);

      if (cfg.signinEnabled) {
        const signin = async (): Promise<void> => {
          const res = await runSignScript(cfg.signinScript, cfg.yunzaiDir);
          // 自定义事件给 bot-notify 行消费（不参与认领）。
          ctx.emit("as-one:bot:mhy-signin", { ok: res.ok, summary: res.summary } satisfies BotMhySigninPayload);
          // 只有脚本明确报告成功时才发"签到完成"；失败如实报告（含通行证/原因）。
          if (channel) {
            void Promise.resolve(
              channel.send({ kind: "private", id: cfg.ownerQQ }, res.summary),
            ).catch((err) => {
              ctx.logger?.warn?.("[as-one] bot-mhy: signin push failed:", err);
            });
          }
          ctx.logger?.info?.(`[as-one] bot-mhy: signin ${res.ok ? "ok" : "failed"} → ${res.summary}`);
        };
        scheduleDaily(signin, cfg.signinTime, ctx);
        ctx.logger?.info?.(`[as-one] bot-mhy: yunzai=${cfg.yunzaiDir} port=${cfg.yunzaiPort} heartbeat=${cfg.heartbeatMs}ms signin=${cfg.signinTime}`);
      } else {
        ctx.logger?.info?.("[as-one] bot-mhy: signin disabled (bot.mhy.signin.enabled=0)");
      }

      return () => {
        yunzai.stop();
        for (const dispose of disposers.reverse()) dispose();
      };
    },
    "@bvbhu/as-one/bot-mhy: yunzai supervisor + snowluma entry + daily signin",
  );
}
