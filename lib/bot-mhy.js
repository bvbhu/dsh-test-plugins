// src/bot-mhy-row.ts
import { spawn, spawnSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
var name = "@bvbhu/as-one/bot-mhy";
var inject = ["asOneBotChannel", "asOneCore", "asOneMhySettings"];
var DEFAULT_YUNZAI_DIR = "D:\\projects\\bot\\yunzai-qqbot\\app";
var DEFAULT_YUNZAI_PORT = 2536;
var DEFAULT_HEARTBEAT_MS = 6e4;
var HEARTBEAT_MIN_MS = 5e3;
var HEARTBEAT_MAX_MS = 36e5;
var PORT_MISS_LIMIT = 3;
var PROBE_TIMEOUT_MS = 2e3;
var DEFAULT_SIGNIN_TIME = "00:02";
var DEFAULT_OWNER_QQ = "3187192488";
var SIGN_ALL_REL = join("plugins", "xiaoyao-cvs-plugin", "sign-all.mjs");
var SIGN_RESULT_REL = join("plugins", "xiaoyao-cvs-plugin", "data", "sign-all-last.json");
function probePort(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
      }
      resolve(open);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const socket = netConnect({ port, host: "127.0.0.1" });
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
function configuredYunzaiPort(appDir) {
  try {
    const text = readFileSync(join(appDir, "config", "config", "server.yaml"), "utf-8");
    const m = /^port:\s*(\d+)/m.exec(text);
    if (m) {
      const port = Number(m[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    }
  } catch {
  }
  return DEFAULT_YUNZAI_PORT;
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const res = spawnSync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
      { windowsHide: true, encoding: "utf-8", timeout: 5e3 }
    );
    if (res.status !== 0) return false;
    const out = `${res.stdout ?? ""}`;
    return out.includes(`,"${pid}",`) || out.includes(`,"${pid}"`);
  } catch {
    return false;
  }
}
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const res = spawnSync(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 1e4 }
    );
    return res.status === 0;
  } catch {
    return false;
  }
}
function getVolatile(root, path) {
  let cur = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return void 0;
    cur = cur[part];
  }
  return cur;
}
async function resolveConfig(runtime, settings) {
  const str = async (key, fallback) => {
    try {
      return runtime.getSetting(key) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const sVal = (path) => {
    if (!settings) return void 0;
    try {
      return getVolatile(settings.config, path)?.get();
    } catch {
      return void 0;
    }
  };
  const yunzaiDir = String(sVal("yunzai.dir") ?? await str("bot.mhy.yunzai.dir", DEFAULT_YUNZAI_DIR)).trim() || DEFAULT_YUNZAI_DIR;
  const port = Number(
    String(sVal("yunzai.port") ?? await str("bot.mhy.yunzai.port", String(configuredYunzaiPort(yunzaiDir)))).trim()
  );
  const heartbeatMs = Number(
    String(sVal("yunzai.heartbeatMs") ?? await str("bot.mhy.yunzai.heartbeatMs", String(DEFAULT_HEARTBEAT_MS))).trim()
  );
  const signinTime = String(sVal("signin.time") ?? await str("bot.mhy.signin.time", DEFAULT_SIGNIN_TIME)).trim();
  const autoStartVal = sVal("yunzai.autoStart");
  const signinEnabledVal = sVal("signin.enabled");
  return {
    yunzaiDir,
    yunzaiPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_YUNZAI_PORT,
    yunzaiAutoStart: autoStartVal !== void 0 ? autoStartVal === true : await str("bot.mhy.yunzai.autoStart", "1") !== "0",
    heartbeatMs: Number.isFinite(heartbeatMs) ? Math.min(Math.max(heartbeatMs, HEARTBEAT_MIN_MS), HEARTBEAT_MAX_MS) : DEFAULT_HEARTBEAT_MS,
    signinEnabled: signinEnabledVal !== void 0 ? signinEnabledVal === true : await str("bot.mhy.signin.enabled", "1") !== "0",
    signinTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(signinTime) ? signinTime : DEFAULT_SIGNIN_TIME,
    signinScript: join(yunzaiDir, SIGN_ALL_REL),
    ownerQQ: String(sVal("signin.ownerQQ") ?? await str("bot.mhy.signin.ownerQQ", DEFAULT_OWNER_QQ)).trim() || DEFAULT_OWNER_QQ
  };
}
function startYunzaiSupervisor(ctx, cfg) {
  let child = null;
  let owns = false;
  let portMisses = 0;
  let stopped = false;
  let timer = null;
  const spawnChild = async (why) => {
    if (stopped) return;
    if (await probePort(cfg.yunzaiPort)) {
      ctx.logger?.info?.(
        `[as-one] bot-mhy: port ${cfg.yunzaiPort} already serving, skip spawn (${why})`
      );
      return;
    }
    try {
      const c = spawn(process.execPath, ["app.js"], {
        cwd: cfg.yunzaiDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child = c;
      owns = true;
      portMisses = 0;
      c.stdout?.on("data", (d) => {
        ctx.logger?.debug?.(`[yunzai] ${d.toString().trim()}`);
      });
      c.stderr?.on("data", (d) => {
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
  const heartbeat = async () => {
    if (stopped || !owns) return;
    const alive = child !== null && child.exitCode === null && child.signalCode === null && isPidAlive(child.pid ?? 0);
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
      `[as-one] bot-mhy: yunzai port ${cfg.yunzaiPort} dark (${portMisses}/${PORT_MISS_LIMIT})`
    );
    if (portMisses >= PORT_MISS_LIMIT) {
      const pid = child?.pid;
      child = null;
      ctx.logger?.warn?.("[as-one] bot-mhy: yunzai wedged, killing tree and respawning");
      if (pid !== void 0 && !killTree(pid)) {
        ctx.logger?.warn?.(`[as-one] bot-mhy: taskkill failed pid=${pid}, will retry next tick`);
      }
      void spawnChild(`heartbeat: port dark x${PORT_MISS_LIMIT}`);
      portMisses = 0;
    }
  };
  void (async () => {
    if (await probePort(cfg.yunzaiPort)) {
      ctx.logger?.info?.(
        `[as-one] bot-mhy: port ${cfg.yunzaiPort} already serving (dev pm2?), supervisor idle`
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
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      const pid = child?.pid;
      child = null;
      if (pid !== void 0 && owns && !killTree(pid)) {
        ctx.logger?.warn?.(`[as-one] bot-mhy: dispose taskkill failed pid=${pid}`);
      }
    }
  };
}
function delayToNextDaily(hhmm) {
  const [hh, mm] = hhmm.split(":").map((n) => Number.parseInt(n, 10));
  const now = /* @__PURE__ */ new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh ?? 0, mm ?? 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
function scheduleDaily(run, hhmm, ctx) {
  const timer = setTimeout(() => {
    void run().catch((err) => ctx.logger?.warn?.("[as-one] bot-mhy: signin run failed:", err)).finally(() => scheduleDaily(run, hhmm, ctx));
  }, delayToNextDaily(hhmm));
  timer.unref();
}
function readSignResult(cwd) {
  try {
    const file = join(cwd, SIGN_RESULT_REL);
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}
function starRailSigned(message) {
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
function summarizeSignin(cwd, exitCode, tail) {
  const stamp = (/* @__PURE__ */ new Date()).toLocaleString("sv-SE");
  const data = readSignResult(cwd);
  if (!data) {
    return {
      ok: false,
      summary: `米游社签到失败（${stamp}）：未生成签到结果文件，无法确认签到成功${tail ? `；${tail}` : ""}`
    };
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const entryOk = (r) => r && r.ok === true && r.status === "ok" || starRailSigned(String(r?.message ?? ""));
  let okCount;
  let failed;
  if (results.length > 0) {
    okCount = results.filter(entryOk).length;
    failed = results.filter((r) => !entryOk(r)).map((r) => ({
      qq: r.qq,
      ltuid: r.ltuid,
      reason: String(r.message ?? "").trim().split("\n").find(Boolean) ?? "未说明原因"
    }));
  } else {
    okCount = typeof data.okCount === "number" ? data.okCount : 0;
    failed = Array.isArray(data.failed) ? data.failed : [];
  }
  const ok = results.length > 0 ? okCount > 0 && failed.length === 0 : data.ok === true && okCount > 0 && failed.length === 0;
  if (ok) {
    return {
      ok: true,
      summary: `米游社签到完成（${stamp}）：${okCount} 个通行证已签到`
    };
  }
  const details = failed.slice(0, 5).map((f) => `通行证${f.ltuid ?? "?"}(QQ ${f.qq ?? "?"})：${String(f.reason ?? "未说明原因").replace(/\s+/g, " ").slice(0, 120)}`).join("；");
  const more = failed.length > 5 ? `；另有 ${failed.length - 5} 个失败` : "";
  return {
    ok: false,
    summary: `米游社签到失败（${stamp}）：成功 ${okCount} 个，失败 ${failed.length} 个${details ? `；${details}` : ""}${more}${!details && tail ? `；${tail}` : ""}`
  };
}
function runSignScript(script, cwd) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const c = spawn(process.execPath, [script], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    c.stdout?.on("data", (d) => {
      out += d.toString();
    });
    c.stderr?.on("data", (d) => {
      err += d.toString();
    });
    c.on("error", (e) => {
      resolve({ ok: false, summary: `签到脚本拉起失败：${e.message}` });
    });
    c.on("exit", (code) => {
      const tail = (err.trim() || out.trim()).split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300);
      resolve(summarizeSignin(cwd, code, tail));
    });
  });
}
function apply(ctx) {
  const core = ctx.get("asOneCore");
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, bot-mhy row skipped");
    return;
  }
  const settings = ctx.get("asOneMhySettings");
  let channel = ctx.get("asOneBotChannel");
  if (channel && typeof channel.send !== "function") {
    ctx.logger?.warn?.("[as-one] bot channel service malformed, bot-mhy row treats it as absent");
    channel = void 0;
  }
  if (!channel) {
    ctx.logger?.warn?.(
      "[as-one] bot channel service unavailable, bot-mhy row loads without push"
    );
  }
  ctx.effect(
    async () => {
      const cfg = await resolveConfig(
        core.runtime,
        settings
      );
      const yunzai = startYunzaiSupervisor(ctx, cfg);
      if (cfg.signinEnabled) {
        const signin = async () => {
          const res = await runSignScript(cfg.signinScript, cfg.yunzaiDir);
          ctx.emit("as-one:bot:mhy-signin", { ok: res.ok, summary: res.summary });
          if (channel) {
            void Promise.resolve(
              channel.send({ kind: "private", id: cfg.ownerQQ }, res.summary)
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
      };
    },
    "@bvbhu/as-one/bot-mhy: yunzai supervisor + daily signin"
  );
}
export {
  apply,
  inject,
  name,
  starRailSigned,
  summarizeSignin
};
//# sourceMappingURL=bot-mhy.js.map
