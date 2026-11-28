import {
  createPanelHost
} from "./chunk-3EYPZFMW.js";
import {
  internalSwitch,
  setCompactHost
} from "./chunk-4Z6VTPLS.js";
import {
  createCapacityView,
  fallbackModelOf
} from "./chunk-GARIAXHU.js";
import {
  readJsonBody,
  writeJson
} from "./chunk-O24PEWI6.js";
import {
  AS_ONE_PROVIDER,
  AsOneLlmAdapter
} from "./chunk-RRPFE2CG.js";
import {
  deepseekTokenCount,
  rerouteSettingsFrom,
  warmupDeepseekTokenizer
} from "./chunk-7NII7QAL.js";
import "./chunk-KJWR6LSK.js";

// src/panel-routes.ts
var PANEL_INTERNAL_METHODS = ["sensenovaQuotaCached", "qoderCreditsCached"];
var LEGACY_ARGS = {
  setAccountEnabled: (b) => [String(b.provider ?? ""), Number(b.index), Boolean(b.enabled)],
  getRecentRequests: (b) => b.limit === void 0 ? [] : [Number(b.limit)],
  getUsageHistory: (b) => [
    String(b.range ?? "all"),
    String(b.granularity ?? "day"),
    String(b.group ?? "model")
  ],
  removeLogicalModel: (b) => [String(b.name ?? "")],
  writeLogicalModel: (b) => [b.input ?? b],
  getQuota: (b) => [String(b.provider ?? "")],
  getProviderPage: (b) => [String(b.provider ?? "")],
  getChannelAccounts: (b) => [String(b.provider ?? "")],
  syncChannel: (b) => [String(b.provider ?? ""), Boolean(b.force)],
  syncChannelQuota: (b) => [String(b.provider ?? ""), Boolean(b.force)],
  syncChannelCatalog: (b) => [String(b.provider ?? ""), Boolean(b.force)],
  checkModel: (b) => [String(b.provider ?? ""), String(b.model ?? "")],
  saveSettings: (b) => [b.updates ?? b],
  setRequestLog: (b) => [
    b.enabled === void 0 ? void 0 : Boolean(b.enabled),
    String(b.contentMode ?? b.content_mode ?? "off")
  ]
};
function ok(value) {
  return { ok: true, value };
}
function fail(code, message) {
  return { ok: false, error: { code, message } };
}
function argsOf(method, body) {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") return [];
  const rec = body;
  if (Array.isArray(rec.args)) return rec.args;
  const legacy = LEGACY_ARGS[method];
  return legacy ? legacy(rec) : [];
}
function buildPanelRoutes(rt, options = {}) {
  const host = createPanelHost(rt, options);
  const route = (path, method) => ({
    kind: "exact",
    path,
    handler: async (req, res) => {
      if ((req.method ?? "GET").toUpperCase() !== "POST") {
        writeJson(res, 405, fail("method_not_allowed", `expected POST, got ${req.method ?? "?"}`));
        return;
      }
      try {
        const body = await readJsonBody(req);
        const value = method === "restartGateway" ? await host.ctx.restartGateway() : await host.dispatch(method, argsOf(method, body));
        writeJson(res, 200, ok(value));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const status = typeof err.status === "number" ? err.status : 500;
        writeJson(res, status, fail("internal_error", detail));
      }
    }
  });
  const panelRecord = host.panel;
  const internal = new Set(PANEL_INTERNAL_METHODS);
  const methods = Object.keys(panelRecord).filter((name2) => typeof panelRecord[name2] === "function").filter((name2) => !internal.has(name2));
  const routes = methods.map((method) => route(`/as-one/api/${method}`, method));
  routes.push(route("/as-one/api/restartGateway", "restartGateway"));
  return routes;
}

// src/components/compaction/config.ts
var DEFAULT_CHUNK_RATIO = 0.8;
var DEFAULT_CHUNK_OVERLAP_RATIO = 0.1;
var DEFAULT_MERGE_MAX_CONTEXT_TOKENS = 128e3;
var DEFAULT_FALLBACK_TO_SESSION_MODEL = true;
var DEFAULT_COOLDOWN_HOURS = 1;
var DEFAULT_PREPROCESSING = {
  dedup: true,
  purgeErrors: true,
  astSkeleton: { enabled: false, maxDepth: 2 },
  logCondense: { mode: "balanced", maxLines: 200 }
};
var DEFAULT_RUN_RECORD = {
  enabled: false,
  maxEntries: 200,
  snapshotChars: 0,
  path: ""
};
var CONFIG_KEYS = /* @__PURE__ */ new Set([
  "chunkRatio",
  "chunkOverlapRatio",
  "fallbackToSessionModel",
  "chunkPromptSuffix",
  "mergePromptSuffix",
  "tiers",
  "mergeMaxContextTokens",
  "preprocessing",
  "runRecord"
]);
var DEPRECATED_CONFIG_KEYS = /* @__PURE__ */ new Set(["mergeTiers"]);
var MODEL_KEYS = /* @__PURE__ */ new Set(["provider", "model", "maxConcurrent", "cooldownHours"]);
var TIER_KEYS = /* @__PURE__ */ new Set(["name", "models"]);
var PREPROCESSING_KEYS = /* @__PURE__ */ new Set(["dedup", "purgeErrors", "astSkeleton", "logCondense"]);
var DEPRECATED_PREPROCESSING_KEYS = /* @__PURE__ */ new Set(["headMiddleTail"]);
var AST_SKELETON_KEYS = /* @__PURE__ */ new Set(["enabled", "maxDepth"]);
var LOG_CONDENSE_KEYS = /* @__PURE__ */ new Set(["mode", "maxLines"]);
var RUN_RECORD_KEYS = /* @__PURE__ */ new Set(["enabled", "maxEntries", "snapshotChars", "path"]);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validateKeys(config, keys, name2) {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name2}: unknown key "${key}"`);
  }
}
function assertNonEmptyString(name2, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name2} must be a non-empty string`);
  }
}
function assertNonNegativeInteger(name2, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name2} (${String(value)}) must be a non-negative integer`);
  }
}
function assertRatio(name2, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name2} (${String(value)}) must be a number in (0, 1]`);
  }
}
function resolveTiers(configured) {
  if (configured === void 0) {
    throw new Error("QuiltCompactConfig.tiers is required: the model pool must declare at least one tier");
  }
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error("QuiltCompactConfig.tiers must be a non-empty array");
  }
  const seenNames = /* @__PURE__ */ new Set();
  const seenRoutes = /* @__PURE__ */ new Set();
  return configured.map((tier, index) => {
    if (!isRecord(tier)) throw new Error(`QuiltCompactConfig.tiers[${index}] must be an object`);
    validateKeys(tier, TIER_KEYS, `QuiltCompactConfig.tiers[${index}]`);
    assertNonEmptyString(`QuiltCompactConfig.tiers[${index}].name`, tier.name);
    if (seenNames.has(tier.name)) throw new Error(`QuiltCompactConfig: duplicate tier name "${tier.name}"`);
    seenNames.add(tier.name);
    if (!Array.isArray(tier.models) || tier.models.length === 0) {
      throw new Error(`QuiltCompactConfig.tiers[${index}] (${tier.name}): models must be a non-empty array`);
    }
    const models = tier.models.map((source, modelIndex) => {
      if (!isRecord(source)) {
        throw new Error(`QuiltCompactConfig.tiers[${index}].models[${modelIndex}] must be an object`);
      }
      validateKeys(source, /* @__PURE__ */ new Set([...MODEL_KEYS, "key"]), `QuiltCompactConfig.tiers[${index}].models[${modelIndex}]`);
      assertNonEmptyString("...models[].provider", source.provider);
      assertNonEmptyString("...models[].model", source.model);
      const maxConcurrent = source.maxConcurrent ?? 1;
      if (typeof maxConcurrent !== "number" || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
        throw new Error(`...models[${modelIndex}].maxConcurrent must be a positive integer`);
      }
      const cooldownHours = source.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
      if (typeof cooldownHours !== "number" || !Number.isFinite(cooldownHours) || cooldownHours <= 0) {
        throw new Error(`...models[${modelIndex}].cooldownHours must be a positive finite number`);
      }
      const key = typeof source.key === "string" && source.key.length > 0 ? source.key : `${source.provider}/${source.model}`;
      if (seenRoutes.has(key)) throw new Error(`QuiltCompactConfig: duplicate pool route "${key}"`);
      seenRoutes.add(key);
      return Object.freeze({ provider: source.provider, model: source.model, maxConcurrent, cooldownHours, key });
    });
    return Object.freeze({ name: tier.name, models: Object.freeze(models) });
  });
}
function resolvePreprocessing(configured) {
  if (configured === void 0) return { value: { ...DEFAULT_PREPROCESSING }, deprecated: [] };
  if (!isRecord(configured)) throw new Error("QuiltCompactConfig.preprocessing must be an object");
  validateKeys(
    configured,
    /* @__PURE__ */ new Set([...PREPROCESSING_KEYS, ...DEPRECATED_PREPROCESSING_KEYS]),
    "QuiltCompactConfig.preprocessing"
  );
  const deprecated = Object.keys(configured).filter((key) => DEPRECATED_PREPROCESSING_KEYS.has(key));
  const astSkeleton = configured.astSkeleton ?? DEFAULT_PREPROCESSING.astSkeleton;
  if (!isRecord(astSkeleton)) throw new Error("QuiltCompactConfig.preprocessing.astSkeleton must be an object");
  validateKeys(astSkeleton, AST_SKELETON_KEYS, "QuiltCompactConfig.preprocessing.astSkeleton");
  const ast = {
    enabled: astSkeleton.enabled ?? DEFAULT_PREPROCESSING.astSkeleton.enabled,
    maxDepth: astSkeleton.maxDepth ?? DEFAULT_PREPROCESSING.astSkeleton.maxDepth
  };
  if (typeof ast.enabled !== "boolean") throw new Error("...astSkeleton.enabled must be a boolean");
  assertNonNegativeInteger("...astSkeleton.maxDepth", ast.maxDepth);
  const logCondense = configured.logCondense ?? DEFAULT_PREPROCESSING.logCondense;
  if (!isRecord(logCondense)) throw new Error("QuiltCompactConfig.preprocessing.logCondense must be an object");
  validateKeys(logCondense, LOG_CONDENSE_KEYS, "QuiltCompactConfig.preprocessing.logCondense");
  const mode = logCondense.mode ?? DEFAULT_PREPROCESSING.logCondense.mode;
  if (mode !== "balanced" && mode !== "head" && mode !== "tail") {
    throw new Error(`...logCondense.mode must be 'balanced', 'head', or 'tail', got ${String(mode)}`);
  }
  const maxLines = logCondense.maxLines ?? DEFAULT_PREPROCESSING.logCondense.maxLines;
  assertNonNegativeInteger("...logCondense.maxLines", maxLines);
  const dedup = configured.dedup ?? DEFAULT_PREPROCESSING.dedup;
  if (typeof dedup !== "boolean") throw new Error("...dedup must be a boolean");
  const purgeErrors = configured.purgeErrors ?? DEFAULT_PREPROCESSING.purgeErrors;
  if (typeof purgeErrors !== "boolean") throw new Error("...purgeErrors must be a boolean");
  return {
    value: Object.freeze({
      dedup,
      purgeErrors,
      astSkeleton: Object.freeze(ast),
      logCondense: Object.freeze({ mode, maxLines })
    }),
    deprecated
  };
}
function resolveRunRecord(configured) {
  if (configured === void 0) return { ...DEFAULT_RUN_RECORD };
  if (!isRecord(configured)) throw new Error("QuiltCompactConfig.runRecord must be an object");
  validateKeys(configured, RUN_RECORD_KEYS, "QuiltCompactConfig.runRecord");
  const enabled = configured.enabled ?? DEFAULT_RUN_RECORD.enabled;
  if (typeof enabled !== "boolean") throw new Error("...runRecord.enabled must be a boolean");
  const maxEntries = configured.maxEntries ?? DEFAULT_RUN_RECORD.maxEntries;
  assertNonNegativeInteger("...runRecord.maxEntries", maxEntries);
  if (maxEntries < 1) throw new Error("...runRecord.maxEntries must be >= 1");
  const snapshotChars = configured.snapshotChars ?? DEFAULT_RUN_RECORD.snapshotChars;
  assertNonNegativeInteger("...runRecord.snapshotChars", snapshotChars);
  const path = configured.path ?? DEFAULT_RUN_RECORD.path;
  if (typeof path !== "string") throw new Error("...runRecord.path must be a string");
  return Object.freeze({ enabled, maxEntries, snapshotChars, path });
}
function resolveConfig(rawConfig = {}) {
  if (!isRecord(rawConfig)) throw new Error("QuiltCompactConfig must be an object");
  validateKeys(rawConfig, /* @__PURE__ */ new Set([...CONFIG_KEYS, ...DEPRECATED_CONFIG_KEYS]), "QuiltCompactConfig");
  const deprecatedConfig = Object.keys(rawConfig).filter((key) => DEPRECATED_CONFIG_KEYS.has(key));
  const chunkRatio = rawConfig.chunkRatio ?? DEFAULT_CHUNK_RATIO;
  assertRatio("QuiltCompactConfig.chunkRatio", chunkRatio);
  const chunkOverlapRatio = rawConfig.chunkOverlapRatio ?? DEFAULT_CHUNK_OVERLAP_RATIO;
  if (typeof chunkOverlapRatio !== "number" || !Number.isFinite(chunkOverlapRatio) || chunkOverlapRatio < 0 || chunkOverlapRatio >= 1) {
    throw new Error(`QuiltCompactConfig.chunkOverlapRatio (${String(chunkOverlapRatio)}) must be a finite number in [0, 1)`);
  }
  const fallbackToSessionModel = rawConfig.fallbackToSessionModel ?? DEFAULT_FALLBACK_TO_SESSION_MODEL;
  if (typeof fallbackToSessionModel !== "boolean") throw new Error("...fallbackToSessionModel must be a boolean");
  if (rawConfig.chunkPromptSuffix !== void 0 && typeof rawConfig.chunkPromptSuffix !== "string") {
    throw new Error("...chunkPromptSuffix must be a string");
  }
  if (rawConfig.mergePromptSuffix !== void 0 && typeof rawConfig.mergePromptSuffix !== "string") {
    throw new Error("...mergePromptSuffix must be a string");
  }
  const tiers = resolveTiers(rawConfig.tiers);
  const mergeMaxContextTokens = rawConfig.mergeMaxContextTokens ?? DEFAULT_MERGE_MAX_CONTEXT_TOKENS;
  if (typeof mergeMaxContextTokens !== "number" || !Number.isInteger(mergeMaxContextTokens) || mergeMaxContextTokens < 1) {
    throw new Error(`QuiltCompactConfig.mergeMaxContextTokens (${String(mergeMaxContextTokens)}) must be a positive integer`);
  }
  const preprocessing = resolvePreprocessing(rawConfig.preprocessing);
  const runRecord = resolveRunRecord(rawConfig.runRecord);
  return Object.freeze({
    chunkRatio,
    chunkOverlapRatio,
    fallbackToSessionModel,
    chunkPromptSuffix: rawConfig.chunkPromptSuffix ?? "",
    mergePromptSuffix: rawConfig.mergePromptSuffix ?? "",
    tiers,
    mergeMaxContextTokens,
    preprocessing: preprocessing.value,
    runRecord,
    deprecatedPreprocessing: Object.freeze(preprocessing.deprecated),
    deprecatedConfig: Object.freeze(deprecatedConfig)
  });
}
var COMPACTION_DEFAULTS = {
  enabled: true,
  promptMode: "default",
  logicalModel: "",
  mergeMaxContextTokens: DEFAULT_MERGE_MAX_CONTEXT_TOKENS
};
function readCompactionConfig(getSetting) {
  const rawMode = (getSetting("compaction.promptMode") ?? COMPACTION_DEFAULTS.promptMode).trim().toLowerCase();
  const promptMode = rawMode === "anchored" ? "anchored" : rawMode === "quilt" ? "quilt" : "default";
  const rawMerge = getSetting("compaction.mergeMaxContextTokens");
  const mergeMaxContextTokens = rawMerge !== null && Number.isSafeInteger(Number(rawMerge)) && Number(rawMerge) > 0 ? Number(rawMerge) : DEFAULT_MERGE_MAX_CONTEXT_TOKENS;
  const logicalModel = (getSetting("route.compact") ?? "").trim();
  return {
    enabled: logicalModel !== "",
    promptMode,
    logicalModel,
    tiers: [],
    mergeMaxContextTokens
  };
}
function tiersFromLogicalModel(registry, logicalModel) {
  const name2 = logicalModel.trim();
  if (name2 === "") return [];
  const members = registry.membersOf(name2);
  if (members.length === 0) return [];
  const models = members.map((member) => ({
    provider: member.provider,
    model: member.model,
    key: `${member.provider}/${member.model}`,
    maxConcurrent: registry.getRealModel(member.provider, member.model)?.concurrency ?? 1,
    cooldownHours: DEFAULT_COOLDOWN_HOURS
  }));
  return [Object.freeze({ name: name2, models: Object.freeze(models) })];
}
function toQuiltConfig(comp) {
  return resolveConfig({ tiers: comp.tiers, mergeMaxContextTokens: comp.mergeMaxContextTokens });
}

// src/components/compaction/errors.ts
function errorChainOf(error, limit = 500) {
  const parts = [];
  let current = error;
  const seen = /* @__PURE__ */ new Set();
  while (current !== void 0 && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const msg = current.message;
      if (msg && !parts.some((p) => p.includes(msg))) parts.push(msg);
      const cause = current.cause;
      if (cause === void 0) break;
      current = cause;
    } else {
      const text = String(current);
      if (text && !parts.includes(text)) parts.push(text);
      break;
    }
  }
  const joined = parts.length > 0 ? parts.join(": ") : String(error);
  return joined.length > limit ? `${joined.slice(0, limit - 1)}…` : joined;
}
var CompactLlmError = class extends Error {
  code;
  providerRetryAfterMs;
  constructor(message, code, failure) {
    super(message);
    this.name = "CompactLlmError";
    this.code = code;
    this.providerRetryAfterMs = failure?.providerRetryAfterMs;
  }
};

// src/components/compaction/tokenizer.ts
function countTokens(text) {
  return deepseekTokenCount(text);
}
function messageTokens(message) {
  const content = message.content;
  if (typeof content === "string") return countTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block;
    if (b.type === "text" || b.type === "reasoning") total += countTokens(String(b.text ?? ""));
    else if (b.type === "tool-call") total += countTokens(`${String(b.name ?? "")} ${String(b.arguments ?? "")}`);
    else total += countTokens(JSON.stringify(b));
  }
  return total;
}

// src/components/compaction/stage0.ts
function lineTokenCost(line) {
  return countTokens(line) + 1;
}
function messageContentLines(message) {
  const lines = [];
  const content = message.content;
  if (!Array.isArray(content)) {
    if (typeof content === "string") lines.push(...content.split(/\r\n|\r|\n/));
    return lines;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block;
    switch (b.type) {
      case "text":
      case "reasoning":
        lines.push(...String(b.text ?? "").split(/\r\n|\r|\n/));
        break;
      case "tool-call":
        lines.push(`[tool-call ${String(b.name ?? "")}]`);
        lines.push(...String(b.arguments ?? "").split(/\r\n|\r|\n/));
        break;
      case "image":
      case "file": {
        const name2 = b.attachment?.name;
        lines.push(`[${String(b.type)}${name2 === void 0 ? "" : `: ${String(name2)}`}]`);
        break;
      }
      default:
        lines.push(`[block ${String(b.type)}]`);
        try {
          lines.push(...JSON.stringify(b).split(/\r\n|\r|\n/));
        } catch {
          lines.push(String(b));
        }
    }
  }
  return lines;
}
function extractRegionLines(messages) {
  const lines = [];
  for (const message of messages) {
    lines.push(`[${String(message.role)}]`);
    lines.push(...messageContentLines(message));
  }
  return lines;
}
function dedupLines(lines) {
  const out = [];
  let previous;
  for (const line of lines) {
    if (line === previous) continue;
    out.push(line);
    previous = line;
  }
  return out;
}
var ANSI_ESCAPE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
var CURSOR_MARKER = /^\s*[\^~]{4,}\s*$/;
var LONG_SEPARATOR = /^\s*([^\s\w])\1{15,}\s*$/;
function purgeNoiseLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(ANSI_ESCAPE, "");
    if (CURSOR_MARKER.test(line) || LONG_SEPARATOR.test(line)) continue;
    out.push(line);
  }
  return out;
}
function skipBlankBlocks(lines) {
  const out = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blankRun += 1;
      if (blankRun === 3) out.push("");
      continue;
    }
    blankRun = 0;
    out.push(line);
  }
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}
var FENCE_OPEN = /^```[^\s`]*\s*$/;
var FENCE_CLOSE = /^```\s*$/;
function indentationDepth(line) {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "	") columns += 4;
    else break;
  }
  return Math.floor(columns / 4);
}
function astSkeletonize(lines, maxDepth) {
  const out = [];
  let index = 0;
  let inFence = false;
  while (index < lines.length) {
    const line = lines[index];
    if (inFence) {
      if (FENCE_CLOSE.test(line)) {
        inFence = false;
        out.push(line);
        index += 1;
        continue;
      }
      if (indentationDepth(line) <= maxDepth) {
        out.push(line);
      } else {
        let removed = 0;
        while (index < lines.length && !FENCE_CLOSE.test(lines[index]) && indentationDepth(lines[index]) > maxDepth) {
          removed += 1;
          index += 1;
        }
        out.push(`[condensed: ${removed} lines removed]`);
        continue;
      }
      index += 1;
      continue;
    }
    out.push(line);
    if (FENCE_OPEN.test(line)) inFence = true;
    index += 1;
  }
  return out;
}
var LOG_TIMESTAMP = /^\S+\s+\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
var LOG_LEVEL = /\b(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/;
function findLogRuns(lines) {
  const runs = [];
  let start = -1;
  const isLogLine = (line) => LOG_TIMESTAMP.test(line) || LOG_LEVEL.test(line);
  for (let index = 0; index <= lines.length; index += 1) {
    const logLike = index < lines.length && isLogLine(lines[index]);
    if (logLike && start === -1) start = index;
    if (!logLike && start !== -1) {
      if (index - start >= 4) runs.push([start, index]);
      start = -1;
    }
  }
  return runs;
}
function logCondenseLines(lines, mode, maxLines) {
  const runs = findLogRuns(lines);
  if (runs.length === 0) return [...lines];
  const out = [];
  let cursor = 0;
  for (const [start, end] of runs) {
    const count = end - start;
    out.push(...lines.slice(cursor, start));
    if (count <= maxLines) {
      out.push(...lines.slice(start, end));
    } else if (maxLines === 0) {
      out.push(`[condensed: ${count} lines removed]`);
    } else {
      const headCount = mode === "balanced" ? Math.ceil(maxLines / 2) : mode === "head" ? maxLines : 0;
      const tailCount = mode === "balanced" ? Math.floor(maxLines / 2) : mode === "head" ? 0 : maxLines;
      out.push(...lines.slice(start, start + headCount));
      out.push(`[condensed: ${count - maxLines} lines removed]`);
      out.push(...lines.slice(end - tailCount, end));
    }
    cursor = end;
  }
  out.push(...lines.slice(cursor));
  return out;
}
function runStage0(messages, preprocessing) {
  let lines = extractRegionLines(messages);
  if (preprocessing.dedup) lines = dedupLines(lines);
  if (preprocessing.purgeErrors) lines = purgeNoiseLines(lines);
  lines = skipBlankBlocks(lines);
  if (preprocessing.astSkeleton.enabled) {
    lines = astSkeletonize(lines, preprocessing.astSkeleton.maxDepth);
  }
  lines = logCondenseLines(lines, preprocessing.logCondense.mode, preprocessing.logCondense.maxLines);
  return lines;
}
var SENTENCE_END_CHARS = /* @__PURE__ */ new Set([".", "?", "!", ":", ";", ",", "}", "]", ")", '"', "'", "`"]);
function isBoundaryLine(line) {
  const trimmed = line.trim();
  return trimmed === "" || SENTENCE_END_CHARS.has(trimmed[trimmed.length - 1] ?? "");
}
var ALIGN_WINDOW_LINES = 12;
function alignEndBoundary(lines, start, candidate) {
  const low = Math.max(start + 1, candidate - ALIGN_WINDOW_LINES);
  for (let cut = candidate; cut >= low; cut -= 1) {
    if (isBoundaryLine(lines[cut - 1])) return cut;
  }
  return candidate;
}
function overlapStart(lines, costs, start, end, overlapTokens) {
  if (overlapTokens <= 0) return end;
  let cursor = end;
  let acc = 0;
  while (cursor > start && acc < overlapTokens) {
    cursor -= 1;
    acc += costs[cursor];
  }
  return cursor;
}
function sliceAt(lines, costs, start, chunkTokens, overlapTokens) {
  let end = start;
  let acc = 0;
  while (end < lines.length && (end === start || acc + costs[end] <= chunkTokens)) {
    acc += costs[end];
    end += 1;
  }
  if (end >= lines.length) return { end: lines.length, next: lines.length };
  const aligned = alignEndBoundary(lines, start, end);
  const overlap = overlapStart(lines, costs, start, aligned, overlapTokens);
  return { end: aligned, next: overlap > start ? overlap : aligned };
}
function sliceNextChunk(lines, start, chunkTokens, overlapTokens) {
  if (start >= lines.length) return { end: lines.length, next: lines.length };
  const costs = lines.map(lineTokenCost);
  return sliceAt(lines, costs, start, chunkTokens, overlapTokens);
}

// src/components/compaction/cooldown.ts
function computeCooldownUntil(cooldownHours, now) {
  return now + (cooldownHours ?? 0) * 3600 * 1e3;
}
var MemoryCooldownStore = class {
  records = /* @__PURE__ */ new Map();
  chain = Promise.resolve();
  cooldownUntil(key) {
    return this.records.get(key)?.cooldownUntil ?? 0;
  }
  isHealthy(key, now) {
    return this.cooldownUntil(key) <= now;
  }
  applyCooldown(key, until) {
    const job = this.chain.then(() => {
      if (this.records.get(key)?.cooldownUntil !== until) {
        this.records.set(key, { cooldownUntil: until });
      }
    });
    this.chain = job.then(() => void 0, () => void 0);
    return job;
  }
  clearAll() {
    const job = this.chain.then(() => {
      this.records.clear();
    });
    this.chain = job.then(() => void 0, () => void 0);
    return job;
  }
  keys() {
    return [...this.records.keys()];
  }
};

// src/components/compaction/as-one-call.ts
var DEFAULT_AS_ONE_PROVIDER = "as-one";
function toAsOneStreamOptions(options, asOneProvider = DEFAULT_AS_ONE_PROVIDER) {
  const provider = typeof options.provider === "string" ? options.provider : "";
  const model = typeof options.model === "string" ? options.model : "";
  const key = model.includes("/") ? model : provider !== "" && model !== "" ? `${provider}/${model}` : model;
  const { purpose: _drop, ...rest } = options;
  void _drop;
  return { ...rest, provider: asOneProvider, model: key };
}

// src/components/compaction/summarize.ts
var DEFAULT_MAX_TOKENS = 32768;
var ANCHOR_PROMPT_INSTRUCTION = [
  "Recovery: the original conversation is still indexed by @deepseek-ai/dsh-experimental-session-search, including shadowed events.",
  "To recover exact wording, call session_event_search with the session_id and seq_from/seq_to above, then session_event_read on the matching seq.",
  "Use business-specific keywords from the summary (paths, identifiers, error strings) as the query; avoid generic tool names."
].join("\n");
function anchoredInstruction(sessionId, seqStart, seqEnd) {
  const sid = sessionId ?? "unknown";
  const range = seqStart !== null && seqEnd !== null ? `${seqStart}-${seqEnd}` : "unknown";
  return [
    "The checkpoint must end with a recovery block produced by YOU (the model), written verbatim as your final output:",
    "",
    "<session-search-anchors>",
    `{"sessionId":"${sid}","seqStart":${seqStart ?? "null"},"seqEnd":${seqEnd ?? "null"},"blocks":[{"label":"<short topic>","keys":["<literal keyword>","..."],"seq":[<from>,<to>]}]}`,
    "</session-search-anchors>",
    "",
    `The original conversation is still indexed (including shadowed events) under session_id ${sid}, event seq range ${range}.`,
    "For each `blocks` entry choose a SMALL, specific piece you judge potentially useful to revisit later (a decision, a bug fix, a user correction, a code path) — never a whole chunk range. Give distinctive literal keywords for full-text search and the exact inclusive seq numbers when known (null otherwise); never invent session ids or seq numbers outside the given range.",
    "To recover exact wording later, call session_event_search(session_id, query, seq_from, seq_to) then session_event_read; use business keywords as the query, avoid generic tool names."
  ].join("\n");
}
var CHUNK_PROMPT = [
  "You are a tier-1 (Capture) stage of a hierarchical compaction engine. Condense the conversation EXCERPT above into a terse factual digest that lets another model resume without loss of essential context.",
  "",
  "Rules:",
  "- Use terse markdown bullets under stable headings: ## Request, ## Decisions, ## Files and Code, ## Errors and Fixes, ## Pending Work, ## Next Step, ## Critical Context.",
  "- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and corrections faithfully.",
  '- Keep 2-5 distinctive literal retrieval keys per topic (project names, chip/model numbers, branch names, exact error strings). These are used with full-text session search to recover the original text; generic words such as "tool" or "file" are useless.',
  '- If an excerpt section is empty, write "(none)". Never invent facts.',
  "- Output only the digest text: do not call any tool or take any other action."
].join("\n");
function digestCapInstruction(capTokens) {
  if (capTokens === void 0 || capTokens === null) return "";
  return `- Keep the digest at or under ${capTokens} tokens: a longer digest would overflow the single merge call. Prefer density over exhaustiveness.`;
}
var MERGE_PROMPT = [
  "You are a tier-2 (Distill) stage of a hierarchical compaction engine. The numbered digests above are summaries of consecutive, overlapping excerpts of one conversation.",
  "",
  "Merge them into ONE consolidated checkpoint with these terse markdown sections, in order:",
  "## Primary Request and Intent, ## Key Technical Concepts, ## Files and Code, ## Errors and Fixes, ## Pending Jobs, ## Current Work, ## Next Step, ## Critical Context.",
  "",
  "Rules:",
  "- Deduplicate facts repeated across overlapping digests; keep each fact once.",
  "- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and corrections faithfully.",
  "- Preserve the distinctive literal retrieval keys from the chunk digests (project names, model/chip numbers, branches, exact error strings). Do not replace them with vague descriptions.",
  '- Write "(none)" for an empty section; never drop a section.',
  "- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint: preserve still-true facts, drop stale ones, and merge newer information into this single consolidated summary.",
  "- The '--- source N ---' labels above are internal input markers: NEVER echo them or write any 'part/segment N of M' / '片段 N/M' divider in the output.",
  "- Write each fact ONCE. Never repeat a sentence, bullet, or whole section, and never restate the checkpoint after finishing it.",
  "- Output plain checkpoint prose only: never emit tool-call markup such as <tool_call> or raw tool-argument JSON.",
  "- If the conversation contains a <session-search-anchors> block, copy that block verbatim into the final checkpoint; it points to the original indexed events. Never invent or rewrite session ids or seq numbers.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  "- Output only the checkpoint text: do not call any tool or take any other action."
].join("\n");
var SINGLE_CHUNK_PROMPT = [
  "You are a compaction engine condensing ONE contiguous excerpt of a conversation into a single consolidated checkpoint that lets another model resume with no loss of essential context.",
  "",
  "Output terse markdown under these sections, in order:",
  "## Primary Request and Intent, ## Key Technical Concepts, ## Files and Code, ## Errors and Fixes, ## Pending Work, ## Current Work, ## Next Step, ## Critical Context.",
  "",
  "Rules:",
  "- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and corrections faithfully.",
  "- Keep 2-5 distinctive literal retrieval keys per topic (project names, model/chip numbers, exact error strings) for full-text session search; avoid generic words.",
  '- Write "(none)" for an empty section; never drop a section, never invent facts.',
  "- If a prior <compacted-summary> block is present, preserve still-true facts and merge newer information into this one checkpoint.",
  "- Write each fact ONCE. Do not emit any 'part/segment N of M' / '片段 N/M' divider, do not repeat a bullet or section, and never restate the checkpoint after finishing it.",
  "- Output plain checkpoint prose only: never emit tool-call markup such as <tool_call> or raw tool-argument JSON.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  "- Output only the checkpoint text: do not call any tool or take any other action."
].join("\n");
var CHECKPOINT_PROMPT = [
  "You are a compaction engine. Condense the conversation ABOVE into one consolidated checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  "Output terse markdown under these sections, in order:",
  "## Primary Request and Intent, ## Key Technical Concepts, ## Files and Code, ## Errors and Fixes, ## Pending Jobs, ## Current Work, ## Next Step, ## Critical Context.",
  "",
  "Rules:",
  "- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and corrections faithfully.",
  '- Write "(none)" for an empty section; never drop a section.',
  "- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint: preserve still-true facts, drop stale ones, and merge newer information into this single consolidated summary.",
  "- Write each fact ONCE. Do not emit any 'part/segment N of M' / '片段 N/M' divider, do not repeat a bullet or section, and never restate the checkpoint after finishing it.",
  "- Output plain checkpoint prose only: never emit tool-call markup such as <tool_call> or raw tool-argument JSON.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  "- Output only the checkpoint text: do not call any tool or take any other action."
].join("\n");
function chunkInstruction(config, capTokens) {
  const cap = digestCapInstruction(capTokens);
  const parts = [CHUNK_PROMPT];
  if (cap.length > 0) parts.push(cap);
  if (config.chunkPromptSuffix.length > 0) parts.push(config.chunkPromptSuffix);
  return parts.join("\n\n");
}
function mergeInstruction(config) {
  return config.mergePromptSuffix.length === 0 ? MERGE_PROMPT : `${MERGE_PROMPT}

${config.mergePromptSuffix}`;
}
function fallbackInstruction(config) {
  return config.mergePromptSuffix.length === 0 ? CHECKPOINT_PROMPT : `${CHECKPOINT_PROMPT}

${config.mergePromptSuffix}`;
}
function chunkMessages(chunkText, config, capTokens) {
  return [
    { role: "user", content: [{ type: "text", text: chunkText }] },
    { role: "user", content: [{ type: "text", text: chunkInstruction(config, capTokens) }] }
  ];
}
function mergeMessages(digests, config) {
  const joined = digests.map((digest, index) => `--- source ${index + 1} ---
${digest}`).join("\n\n");
  return [
    { role: "user", content: [{ type: "text", text: joined }] },
    { role: "user", content: [{ type: "text", text: mergeInstruction(config) }] }
  ];
}
function blocksToText(blocks) {
  return blocks.map((block) => block.type === "text" ? block.text ?? "" : "").join("\n");
}
async function collectTextBlocks(stream, onChunk) {
  const blocks = [];
  let usage;
  let finish;
  let sawTextDelta = false;
  for await (const chunk of stream) {
    onChunk?.(chunk);
    if (chunk.type === "text-delta") {
      sawTextDelta = true;
      const last = blocks[blocks.length - 1];
      if (last?.type === "text") last.text = (last.text ?? "") + String(chunk.text ?? "");
      else blocks.push({ type: "text", text: String(chunk.text ?? "") });
    } else if (chunk.type === "block-end") {
      const block = chunk.block;
      if (block?.type === "text" && !sawTextDelta) {
        blocks.push({ type: "text", text: String(block.text ?? "") });
      }
    } else if (chunk.type === "usage") {
      usage = chunk.usage;
    } else if (chunk.type === "finish") {
      finish = chunk.reason;
    }
  }
  return { blocks, usage, finish };
}
async function streamText(ctx, options) {
  const callOptions = ctx.asOneCall === true ? toAsOneStreamOptions(options, ctx.asOneProvider) : options;
  const { blocks, usage, finish } = await collectTextBlocks(ctx.llm.stream(callOptions), (chunk) => {
    if (chunk.type !== "finish") return;
    const reason = chunk.reason;
    if (reason?.kind === "error" || reason?.kind === "aborted") {
      const failure = reason.failure ?? { message: "stream aborted", code: "ABORTED" };
      throw new CompactLlmError(failure.message ?? "stream failed", failure.code ?? "UNKNOWN", failure);
    }
    if (reason?.kind === "max-tokens") {
      throw new CompactLlmError("summarization truncated at the token cap", "MAX_TOKENS");
    }
  });
  void finish;
  const summary = blocks.filter((block) => block.type === "text" && (block.text ?? "").trim().length > 0);
  if (summary.length === 0) throw new Error("summarization produced no text summary content");
  return { summary, usage };
}
async function streamTextWithRetry(ctx, options, internals = {}) {
  let policy;
  try {
    policy = ctx.llm.providerRetryPolicy?.(String(options.provider));
  } catch {
    policy = void 0;
  }
  if (policy === void 0 || typeof policy !== "object") return streamText(ctx, options);
  const random = internals.random ?? Math.random;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await streamText(ctx, options);
    } catch (error) {
      const signal = options.signal;
      if (signal?.aborted === true) throw error;
      const code = error instanceof CompactLlmError ? error.code : void 0;
      const retryable = policy.mode === "always" ? true : typeof code === "string" && Array.isArray(policy.retryableCodes) && policy.retryableCodes.includes(code);
      if (!retryable) throw error;
      if (policy.mode !== "always" && attempt >= (policy.maxRetries ?? 0)) throw error;
      const after = error instanceof CompactLlmError ? error.providerRetryAfterMs : void 0;
      const exponent = Math.min(attempt, 1024);
      const exponential = Math.min((policy.initialDelayMs ?? 1e3) * 2 ** exponent, policy.maxDelayMs ?? 6e4);
      const jitterRatio = policy.jitterRatio ?? 0.1;
      const jitter = 1 - jitterRatio + 2 * jitterRatio * random();
      const delayMs = typeof after === "number" && Number.isFinite(after) && after > 0 && after <= (policy.maxDelayMs ?? 6e4) ? after : Math.min(exponential * jitter, policy.maxDelayMs ?? 6e4);
      ctx.logger?.warn?.(`[as-one compaction] retry route=${String(options.provider)}/${String(options.model)} attempt=${attempt + 1} code=${code ?? "unknown"} delayMs=${Math.round(delayMs)}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// src/components/compaction/budget.ts
var OUTPUT_RESERVATION_RATIO = 0.15;
var PROMPT_OVERHEAD_TOKENS = 512;
var SAFETY_HEADROOM_TOKENS = 512;
var DEFAULT_CONTEXT_WINDOW = 262144;
function computeOutputBudget(contextWindow) {
  return Math.min(DEFAULT_MAX_TOKENS, Math.floor(contextWindow * OUTPUT_RESERVATION_RATIO));
}
function computeUsableInputTokens(contextWindow) {
  return Math.max(1, contextWindow - computeOutputBudget(contextWindow) - PROMPT_OVERHEAD_TOKENS - SAFETY_HEADROOM_TOKENS);
}
function computeChunkBudget(contextWindow, chunkRatio) {
  return Math.max(1, Math.floor(computeUsableInputTokens(contextWindow) * chunkRatio));
}

// src/components/compaction/model-chain.ts
var MAX_SPLIT_DEPTH = 4;
function defaultNow() {
  return Date.now();
}
function defaultSleep(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}
function textStats(text) {
  const value = String(text);
  return { chars: value.length, tokens: countTokens(value) };
}
function fingerprint(text) {
  const value = String(text);
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function preview(text, max = 80) {
  const single = String(text).replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, Math.max(0, max - 1))}…`;
}
function wakeHandle() {
  let resolve = () => {
  };
  let promise = new Promise((res) => {
    resolve = res;
  });
  return {
    get promise() {
      return promise;
    },
    fire: () => resolve(),
    reset: () => {
      promise = new Promise((res) => {
        resolve = res;
      });
    }
  };
}
function describeAttempts(attempts, limit = 500) {
  if (!Array.isArray(attempts) || attempts.length === 0) return "";
  const byRoute = /* @__PURE__ */ new Map();
  for (const attempt of attempts) {
    const key = String(attempt?.model ?? "unknown");
    const entry = byRoute.get(key) ?? { count: 0, last: void 0 };
    entry.count += 1;
    entry.last = attempt?.error;
    byRoute.set(key, entry);
  }
  let text = [...byRoute.entries()].map(([key, entry]) => `${key} x${entry.count}${entry.last === void 0 ? "" : ` (last: ${String(entry.last)})`}`).join("; ");
  if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
  return text;
}
function collapsedBatchError(headline, attempts) {
  const summary = describeAttempts(attempts);
  const error = new Error(summary.length > 0 ? `${headline}; attempts: ${summary}` : headline);
  error.attempts = attempts;
  return error;
}
function capacityUsage(capacity, model) {
  if (!capacity) return 0;
  return capacity.usage(model.provider, model.model);
}
function resolveRouteCapacities(routes, capacityOf) {
  const capacities = /* @__PURE__ */ new Map();
  for (const route of routes) {
    const live = capacityOf?.(route.provider, route.model) ?? null;
    const contextWindow = live !== null && Number.isInteger(live.contextWindow) && live.contextWindow > 0 ? live.contextWindow : DEFAULT_CONTEXT_WINDOW;
    const maxTokens = live !== null && Number.isInteger(live.maxTokens) && live.maxTokens > 0 ? live.maxTokens : DEFAULT_MAX_TOKENS;
    const key = typeof route.key === "string" && route.key !== "" ? route.key : `${route.provider}/${route.model}`;
    capacities.set(key, { contextWindow, maxTokens });
  }
  return capacities;
}
var ModelChain = class {
  constructor(ctx, config, store, internals = {}, capacities, capacity) {
    this.ctx = ctx;
    this.config = config;
    this.store = store;
    this.now = internals.now ?? defaultNow;
    this.sleep = internals.sleep ?? defaultSleep;
    this.tiers = config.tiers;
    this.capacity = capacity;
    this.capacities = capacities;
    for (const tier of this.tiers) {
      for (const model of tier.models) {
        this.routes.set(model.key, model);
        this.inFlight.set(model.key, 0);
      }
    }
    this.cursorByTier = this.tiers.map(() => 0);
  }
  ctx;
  config;
  store;
  now;
  sleep;
  capacity;
  tiers;
  routes = /* @__PURE__ */ new Map();
  inFlight = /* @__PURE__ */ new Map();
  cursorByTier;
  capacities;
  _capacitiesPromise;
  cooldownEvents = [];
  localCooldown = /* @__PURE__ */ new Map();
  routeCooledUntil(key) {
    const stored = this.store.cooldownUntil(key);
    const local = this.localCooldown.get(key) ?? 0;
    return local > stored ? local : stored;
  }
  isRouteHealthy(key, now = this.now()) {
    return this.routeCooledUntil(key) <= now;
  }
  async clearAllCooldowns() {
    this.localCooldown.clear();
    await this.store.clearAll();
  }
  modelWindow(model, capacities = this.capacities) {
    const window = capacities?.get(model.key)?.contextWindow;
    return Number.isInteger(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
  }
  capacityFits(task, model, capacities = this.capacities) {
    const cap = capacities?.get(model.key);
    const window = Number.isInteger(cap?.contextWindow) && cap?.contextWindow > 0 ? cap?.contextWindow : DEFAULT_CONTEXT_WINDOW;
    const maxOutput = Number.isInteger(cap?.maxTokens) && cap?.maxTokens > 0 ? cap?.maxTokens : DEFAULT_MAX_TOKENS;
    const outputBudget = Math.min(maxOutput, computeOutputBudget(window));
    return (task.inputTokens ?? 0) + PROMPT_OVERHEAD_TOKENS + outputBudget <= window;
  }
  effectiveMaxTokens(task, model, capacities = this.capacities) {
    const cap = capacities?.get(model.key);
    const window = Number.isInteger(cap?.contextWindow) && cap?.contextWindow > 0 ? cap?.contextWindow : DEFAULT_CONTEXT_WINDOW;
    const hardLimit = window - (task.inputTokens ?? 0);
    if (hardLimit <= 0) return 0;
    const modelCap = Number.isInteger(cap?.maxTokens) && cap?.maxTokens > 0 ? cap?.maxTokens : DEFAULT_MAX_TOKENS;
    return Math.min(DEFAULT_MAX_TOKENS, modelCap, hardLimit);
  }
  pickChunkModel(capacities = this.capacities) {
    const now = this.now();
    for (let tierIndex = 0; tierIndex < this.tiers.length; tierIndex += 1) {
      const tier = this.tiers[tierIndex];
      const cursor = this.cursorByTier[tierIndex];
      for (let offset = 0; offset < tier.models.length; offset += 1) {
        const model = tier.models[(cursor + offset) % tier.models.length];
        if (!this.isRouteHealthy(model.key, now)) continue;
        const used = (this.inFlight.get(model.key) ?? 0) + capacityUsage(this.capacity, model);
        if (used < model.maxConcurrent) {
          this.cursorByTier[tierIndex] = (cursor + offset + 1) % Math.max(1, tier.models.length);
          return model;
        }
      }
    }
    return void 0;
  }
  /**
   * anchored 模式「先选模型」：按调度顺序（tier→成员序）取第一个健康的模型，
   * 用它决定是否切块及按它的窗口切块。用户 2026-11 定案「先选模型，再切块；
   * 模型列表里各模型上下文窗口不同」—— 所以切块预算必须由这一个被选中的
   * 模型的窗口决定，而不是每块各挑一个模型。
   *
   * @param minWindow 归并/单块要求的最小窗口；<=0 表示只要求健康即可。
   *                  当有多个健康模型时优先选窗口 >= minWindow 的第一个；
   *                  否则退回第一个健康模型（后续由 run 的 pickModel 按窗口
   *                  重试/再切分兜底）。
   */
  pickPrimaryModel(minWindow = 0, capacities = this.capacities) {
    const now = this.now();
    let fallback;
    for (const tier of this.tiers) {
      for (const model of tier.models) {
        if (!this.isRouteHealthy(model.key, now)) continue;
        fallback ??= model;
        if (minWindow > 0 && this.modelWindow(model, capacities) >= minWindow) return model;
      }
    }
    return fallback;
  }
  /**
   * 归并模型（用户 2026-11 定案）：优先选窗口 >= 192k 的健康模型；
   * 没有则选窗口最大的健康模型。`preferredKey` 让 run 的 pickModel 锁定它。
   */
  pickMergeModel(capacities = this.capacities) {
    const now = this.now();
    const healthy = [...this.routes.values()].filter((m) => this.isRouteHealthy(m.key, now));
    if (healthy.length === 0) return void 0;
    const big = healthy.find((m) => this.modelWindow(m, capacities) >= 192e3);
    if (big !== void 0) return big;
    return [...healthy].sort((a, b) => this.modelWindow(b, capacities) - this.modelWindow(a, capacities))[0];
  }
  canHoldMerge(mergeWindow, capacities = this.capacities) {
    const now = this.now();
    for (const model of this.routes.values()) {
      if (!this.isRouteHealthy(model.key, now)) continue;
      if (this.modelWindow(model, capacities) >= mergeWindow) return true;
    }
    return false;
  }
  pickModel(task, capacities = this.capacities) {
    const now = this.now();
    const rejected = task.capacityRejected;
    const isRetry = task.attempts.length > 0;
    const splittable = typeof task.split === "function" && (task.splitDepth ?? 0) < MAX_SPLIT_DEPTH;
    while (task.tierIndex < this.tiers.length) {
      const tier = this.tiers[task.tierIndex];
      const cursor = this.cursorByTier[task.tierIndex];
      const models = [];
      if (task.preferredKey !== void 0) {
        const preferred = tier.models.find((m) => m.key === task.preferredKey);
        if (preferred !== void 0) models.push(preferred);
      }
      const rest = tier.models.filter((m) => m.key !== task.preferredKey);
      models.push(...isRetry ? [...rest].sort((a, b) => this.modelWindow(b, capacities) - this.modelWindow(a, capacities)) : rest);
      let healthyFree;
      let anyHealthy = false;
      let anyFitting = false;
      for (const model of models) {
        if (rejected.has(model.key)) continue;
        const healthy = this.isRouteHealthy(model.key, now);
        if (healthy) anyHealthy = true;
        const fits = this.capacityFits(task, model, capacities);
        if (healthy && fits) anyFitting = true;
        const used = (this.inFlight.get(model.key) ?? 0) + capacityUsage(this.capacity, model);
        if (healthy && used < model.maxConcurrent && fits && healthyFree === void 0) healthyFree = model;
      }
      this.cursorByTier[task.tierIndex] = (cursor + 1) % Math.max(1, tier.models.length);
      if (healthyFree !== void 0) return healthyFree;
      if (isRetry && anyHealthy && !anyFitting && splittable) {
        task.splitRequested = true;
        return void 0;
      }
      if (!anyHealthy || !anyFitting) {
        task.tierIndex += 1;
        continue;
      }
      return void 0;
    }
    return void 0;
  }
  async run(jobs, agent, signal, options = {}) {
    if (jobs.length === 0) return [];
    const capacities = options.capacities ?? this.capacities ?? await this.resolveCapacities(signal);
    this.capacities = capacities;
    const makeTask = (job, index, root) => ({
      index,
      label: job.label,
      meta: job.meta,
      buildMessages: job.buildMessages,
      sourceText: job.text,
      digests: job.digests,
      inputTokens: job.inputTokens ?? 0,
      tierIndex: 0,
      running: false,
      done: false,
      aborted: false,
      attempts: [],
      result: void 0,
      preferredKey: job.preferredKey,
      capTokens: job.capTokens,
      split: job.split,
      splitDepth: 0,
      splitRequested: false,
      capacityRejected: /* @__PURE__ */ new Set(),
      needsImmediateReschedule: false,
      root
    });
    const pending = jobs.map((job, index) => makeTask(job, index));
    for (const task of pending) task.root = task;
    const settled = (task) => task.done || task.parts !== void 0 && task.parts.every(settled);
    const settledTexts = (task) => {
      if (task.parts === void 0) return task.result === void 0 ? [] : [task.result];
      return task.parts.flatMap(settledTexts);
    };
    const markSubtreeDone = (task) => {
      task.done = true;
      for (const part of task.parts ?? []) markSubtreeDone(part);
    };
    const combineParts = (task) => {
      const parts = settledTexts(task);
      const first = parts[0];
      return {
        text: parts.map((part) => part.text).join("\n\n"),
        provider: first?.provider ?? "",
        model: first?.model ?? "",
        usage: void 0,
        maxTokens: first?.maxTokens,
        attempts: parts.flatMap((part) => part.attempts ?? []),
        fallback: parts.some((part) => part.fallback === true),
        splitInto: parts.length,
        models: [...new Set(parts.map((part) => `${part.provider}/${part.model}`))]
      };
    };
    const results = new Array(jobs.length);
    const collectAttempts = () => pending.flatMap((task) => task.attempts);
    const wake = wakeHandle();
    let cooldownSerial = 0;
    const batchStartedAt = Date.now();
    const callsByRoute = /* @__PURE__ */ new Map();
    let totalCalls = 0;
    let failureCount = 0;
    let fallbackUsed = false;
    const armCooldownWake = () => {
      const serial = ++cooldownSerial;
      const now = this.now();
      let earliest = Infinity;
      for (const key of this.routes.keys()) {
        const until = this.routeCooledUntil(key);
        if (until > now && until < earliest) earliest = until;
      }
      if (earliest === Infinity) return;
      void this.sleep(Math.max(0, earliest - now)).then(() => {
        if (serial === cooldownSerial) wake.fire();
      });
    };
    const startCall = (task, model, caps) => {
      const messages = task.buildMessages(this.config);
      const actualInputTokens = messages.reduce((sum, message) => sum + messageTokens(message), 0);
      const maxTokens = this.effectiveMaxTokens({ inputTokens: actualInputTokens }, model, caps);
      if (maxTokens <= 0) {
        task.capacityRejected.add(model.key);
        task.needsImmediateReschedule = true;
        this.ctx.logger?.warn?.(`[as-one compaction] route ${model.key} cannot hold job=${task.label} (real input ${actualInputTokens} >= window)`);
        return false;
      }
      task.running = true;
      this.inFlight.set(model.key, (this.inFlight.get(model.key) ?? 0) + 1);
      callsByRoute.set(model.key, (callsByRoute.get(model.key) ?? 0) + 1);
      totalCalls += 1;
      const options2 = {
        provider: model.provider,
        model: model.model,
        messages,
        maxTokens,
        sessionId: agent.session.id,
        purpose: "compaction",
        ...signal === void 0 ? {} : { signal }
      };
      const inputText = task.sourceText ?? (task.digests ?? []).join("\n\n");
      const input = textStats(inputText);
      const startedAt = Date.now();
      this.ctx.logger?.debug?.(`[as-one compaction] call job=${task.label} route=${model.key} inputTokens~=${input.tokens} maxTokens=${maxTokens} sha=${fingerprint(inputText)} preview="${preview(inputText)}"`);
      void (async () => {
        try {
          const { summary, usage } = await streamTextWithRetry(this.ctx, options2);
          const text = blocksToText(summary);
          this.ctx.logger?.debug?.(`[as-one compaction] call ok job=${task.label} route=${model.key} outputChars=${text.length} durationMs=${Date.now() - startedAt}`);
          task.result = {
            text,
            provider: model.provider,
            model: model.model,
            usage,
            maxTokens,
            attempts: task.attempts
          };
          task.done = true;
        } catch (error) {
          if (signal?.aborted === true) {
            task.aborted = true;
            this.ctx.logger?.debug?.(`[as-one compaction] call aborted job=${task.label} route=${model.key}`);
          } else {
            failureCount += 1;
            const until = computeCooldownUntil(model.cooldownHours, this.now());
            try {
              await this.store.applyCooldown(model.key, until);
            } catch (storeError) {
              this.localCooldown.set(model.key, until);
              this.ctx.logger?.warn?.(`[as-one compaction] cooldown write failed for ${model.key}: ${errorChainOf(storeError)}; quarantining locally`);
            }
            const reason = errorChainOf(error);
            const detail = String(error?.message ?? error).slice(0, 300);
            this.ctx.logger?.warn?.(`[as-one compaction] route ${model.key} failed (${reason}: ${detail}) for job=${task.label}; cooling`);
            this.cooldownEvents.push({ model: model.key, job: task.label, error: reason, until, hours: model.cooldownHours });
            task.attempts.push({ model: model.key, error: reason });
            task.running = false;
          }
        } finally {
          task.running = false;
          this.inFlight.set(model.key, Math.max(0, (this.inFlight.get(model.key) ?? 1) - 1));
          wake.fire();
        }
      })();
      return true;
    };
    try {
      for (; ; ) {
        signal?.throwIfAborted();
        wake.reset();
        armCooldownWake();
        let dispatchedAny = false;
        const blocked = [];
        for (const task of pending) {
          if (task.parts !== void 0 || task.done || task.running) continue;
          if (task.splitRequested) {
            task.splitRequested = false;
            const halves = typeof task.split === "function" ? task.split() : void 0;
            if (halves === void 0 || halves.length < 2) {
              task.split = void 0;
              task.needsImmediateReschedule = true;
              blocked.push(task);
              continue;
            }
            const parts = halves.map((job) => {
              const part = makeTask(job, -1, task.root);
              part.attempts = [...task.attempts];
              part.splitDepth = (task.splitDepth ?? 0) + 1;
              return part;
            });
            task.parts = parts;
            pending.push(...parts);
            dispatchedAny = true;
            continue;
          }
          const model = this.pickModel(task, capacities);
          if (model !== void 0) {
            if (startCall(task, model, capacities)) dispatchedAny = true;
            else blocked.push(task);
          } else {
            blocked.push(task);
          }
        }
        for (const task of pending) {
          if (task.parts === void 0 || task.done) continue;
          if (!task.parts.every(settled)) continue;
          task.result = combineParts(task);
          task.done = true;
        }
        const running = pending.some((task) => task.running);
        const activeCount = pending.filter((task) => task.parts === void 0 && !task.done && !task.running).length;
        if (!running && pending.every(settled)) break;
        const fullyDegraded = blocked.length > 0 && blocked.length === activeCount && blocked.every((task) => task.tierIndex >= this.tiers.length);
        if (fullyDegraded && !running) {
          const target = sessionTarget(agent);
          if (this.config.fallbackToSessionModel) {
            if (target === void 0) {
              throw collapsedBatchError("[as-one compaction] all tiers have no healthy model and no session-model target for fallback", collectAttempts());
            }
            fallbackUsed = true;
            let collapsed;
            try {
              collapsed = await this.fallbackCall(blocked, target, agent, signal, options);
            } catch (error) {
              if (signal?.aborted !== true && error instanceof Error && !Array.isArray(error.attempts)) {
                error.attempts = collectAttempts();
              }
              throw error;
            }
            for (const root of new Set(blocked.map((task) => task.root))) {
              const finished = settledTexts(root);
              root.result = {
                text: [...finished.map((part) => part.text), collapsed.text].join("\n\n"),
                provider: collapsed.provider,
                model: collapsed.model,
                usage: collapsed.usage,
                maxTokens: collapsed.maxTokens,
                attempts: [...collapsed.attempts ?? []],
                fallback: true,
                collapsedFrom: blocked.length
              };
              markSubtreeDone(root);
            }
            break;
          }
          throw collapsedBatchError("[as-one compaction] all tiers have no healthy model and session-model fallback is disabled", collectAttempts());
        }
        if (!running && blocked.some((task) => task.needsImmediateReschedule || task.splitRequested)) continue;
        await wake.promise;
        void dispatchedAny;
      }
      for (const task of pending) {
        if (task.result !== void 0 && task.index >= 0) results[task.index] = task.result;
      }
      this.ctx.logger?.info?.(`[as-one compaction] batch jobs=${jobs.length} calls=${totalCalls} byRoute=${[...callsByRoute.entries()].map(([k, c]) => `${k}:${c}`).join(",")} failures=${failureCount} fallback=${fallbackUsed} durationMs=${Date.now() - batchStartedAt}`);
      return results;
    } catch (error) {
      if (error instanceof Error && !Array.isArray(error.cooldownEvents) && this.cooldownEvents.length > 0) {
        try {
          error.cooldownEvents = [...this.cooldownEvents];
        } catch {
        }
      }
      throw error;
    } finally {
      cooldownSerial += 1;
    }
  }
  async resolveCapacities(signal) {
    if (this.capacities !== void 0) return this.capacities;
    this._capacitiesPromise ??= Promise.resolve(
      resolveRouteCapacities(this.routes.values(), this.ctx.capacityOf)
    );
    void signal;
    return this._capacitiesPromise;
  }
  async fallbackCall(tasks, target, agent, signal, options) {
    const summarize = options.defaultSummarize;
    if (summarize !== void 0 && options.fallbackInput !== void 0) {
      const result = await summarize(options.fallbackInput, agent, signal);
      return {
        text: blocksToText(result.summary),
        provider: result.provider ?? target.provider,
        model: result.model ?? target.model,
        usage: result.usage,
        attempts: tasks.flatMap((task) => task.attempts),
        fallback: true
      };
    }
    const texts = [];
    for (const task of tasks) {
      if (task.label === "merge") texts.push(`--- digest ---
${(task.digests ?? []).join("\n\n")}`);
      else texts.push(task.sourceText ?? "");
    }
    const joined = texts.join("\n\n");
    const callMessages = [
      { role: "user", content: [{ type: "text", text: joined }] },
      { role: "user", content: [{ type: "text", text: fallbackInstruction(this.config) }] }
    ];
    const actualInputTokens = callMessages.reduce((sum, message) => sum + messageTokens(message), 0);
    const maxTokens = this.effectiveMaxTokens({ inputTokens: actualInputTokens }, { key: `${target.provider}/${target.model}` });
    if (maxTokens <= 0) throw new Error(`[as-one compaction] session-model fallback cannot hold the region (input ${actualInputTokens} >= window)`);
    const { summary, usage } = await streamTextWithRetry(this.ctx, {
      provider: target.provider,
      model: target.model,
      messages: callMessages,
      maxTokens,
      sessionId: agent.session.id,
      purpose: "compaction",
      ...signal === void 0 ? {} : { signal }
    });
    return {
      text: blocksToText(summary),
      provider: target.provider,
      model: target.model,
      usage,
      attempts: tasks.flatMap((task) => task.attempts),
      fallback: true
    };
  }
};
function sessionTarget(agent) {
  const header = agent.session.requestHeader?.();
  const config = header?.config;
  if (config !== void 0 && typeof config.provider === "string" && config.provider.length > 0 && typeof config.model === "string" && config.model.length > 0) {
    return { provider: config.provider, model: config.model };
  }
  if (agent.options?.provider !== void 0 && agent.options.provider.length > 0 && agent.options?.model !== void 0 && agent.options.model.length > 0) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  return void 0;
}
function chunkJob(label, text, meta, preferredKey, capTokens, promptOverride) {
  const ownTokens = meta.tokens ?? textStats(text).tokens;
  const lineTokens = String(text).split("\n").reduce((sum, line) => sum + lineTokenCost(line), 0);
  const job = {
    label,
    text,
    meta,
    preferredKey,
    capTokens,
    inputTokens: ownTokens,
    buildMessages: (config) => promptOverride !== void 0 ? [
      { role: "user", content: [{ type: "text", text }] },
      { role: "user", content: [{ type: "text", text: promptOverride }] }
    ] : chunkMessages(text, config, job.capTokens),
    split: () => {
      const lines = String(text).split("\n");
      if (lines.length < 2) return void 0;
      const mid = Math.max(1, Math.floor(lines.length / 2));
      const halves = [lines.slice(0, mid), lines.slice(mid)];
      const shares = halves.map((halfLines) => halfLines.reduce((sum, line) => sum + lineTokenCost(line), 0));
      const measure = Math.max(1, lineTokens);
      const childTokens = shares.map((share) => Math.floor(ownTokens * share / measure));
      if (childTokens.some((tokens) => tokens < 1 || tokens >= ownTokens)) return void 0;
      const lineStart = meta.lineStart;
      const lineEnd = meta.lineEnd;
      return halves.map((halfLines, index) => {
        const tokens = childTokens[index];
        const childMeta = {
          ...meta,
          tokens,
          ...lineStart === void 0 || lineEnd === void 0 ? {} : {
            lineStart: index === 0 ? lineStart : lineStart + mid,
            lineEnd: index === 0 ? lineStart + mid : lineEnd
          }
        };
        const childCap = Math.max(1, Math.floor(capTokens * shares[index] / measure));
        return chunkJob(`${label}/2-${index + 1}`, halfLines.join("\n"), childMeta, preferredKey, childCap);
      });
    }
  };
  return job;
}
function mergeJob(digests, meta) {
  const joined = digests.join("\n\n");
  return {
    label: "merge",
    digests,
    meta,
    inputTokens: textStats(joined).tokens,
    buildMessages: (config) => mergeMessages(digests, config)
  };
}

// src/components/compaction/intercept.ts
function isCompactionRequest(options) {
  return options?.purpose === "compaction";
}
function regionMessages(options) {
  const messages = Array.isArray(options?.messages) ? [...options.messages] : [];
  const last = messages.at(-1);
  const text = Array.isArray(last?.content) ? last.content.filter((block) => block && typeof block === "object" && block.type === "text").map((block) => String(block.text ?? "")).join("\n") : typeof last?.content === "string" ? last.content : "";
  if (last?.role === "user" && /compaction engine|condense the conversation|structured checkpoint/i.test(text)) {
    messages.pop();
  }
  return messages;
}
function messageFingerprint(message) {
  const content = message.content;
  if (typeof content === "string") return `${message.role ?? ""}:${content}`;
  if (!Array.isArray(content)) return `${message.role ?? ""}:${JSON.stringify(content ?? "")}`;
  return `${message.role ?? ""}:${content.map((block) => {
    const b = block;
    return `${b?.type ?? ""}:${String(b?.text ?? b?.arguments ?? "")}`;
  }).join("|")}`;
}
function deriveSpan(ctx, options) {
  const sessionId = options?.sessionId;
  if (sessionId === void 0) return { sessionId: null, seqStart: null, seqEnd: null };
  let session;
  try {
    const sessions = ctx.get?.("sessions");
    session = sessions?.get?.(sessionId);
  } catch {
    session = void 0;
  }
  if (session === void 0) return { sessionId: String(sessionId), seqStart: null, seqEnd: null };
  const nodes = session.surface?.nodes ?? [];
  const replayed = regionMessages(options);
  const replayKeys = replayed.map(messageFingerprint);
  if (replayKeys.length === 0 || nodes.length < replayKeys.length) {
    return { sessionId: String(sessionId), seqStart: null, seqEnd: null };
  }
  const surfaceKeys = [];
  for (const seq of nodes) {
    const event = session.eventAt?.(seq);
    const message = event === void 0 ? void 0 : session.deriveEventMessage?.(event);
    surfaceKeys.push(message === null || message === void 0 ? "" : messageFingerprint(message));
  }
  const headOffset = replayed[0]?.role === "system" ? 0 : 1;
  for (let i = 0; i < replayKeys.length; i += 1) {
    if (surfaceKeys[headOffset + i] !== replayKeys[i]) {
      return { sessionId: String(sessionId), seqStart: null, seqEnd: null };
    }
  }
  const first = replayed[0]?.role === "system" ? 1 : 0;
  const last = first + replayKeys.length - 1;
  if (last >= nodes.length) return { sessionId: String(sessionId), seqStart: null, seqEnd: null };
  return { sessionId: String(sessionId), seqStart: Number(nodes[first]), seqEnd: Number(nodes[last]) };
}
function messagesToRegion(messages) {
  return messages.map((message) => {
    const role = typeof message.role === "string" ? message.role : "message";
    const content = message.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.map((block) => {
        const b = block;
        if (b?.type === "text" || b?.type === "reasoning") return String(b.text ?? "");
        if (b?.type === "tool-call") return `${String(b.name ?? "")} ${String(b.arguments ?? "")}`;
        return JSON.stringify(b ?? "");
      }).join("\n");
    } else text = JSON.stringify(content ?? "");
    return `[${role}]
${text}`;
  }).join("\n");
}
async function* syntheticChunks(text, signal) {
  if (signal?.aborted) return;
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}
function applyCompaction(opts) {
  const { ctx, runtime, capacity, getSetting } = opts;
  const readConfigSafe = (getSetting2) => {
    const cfg = readCompactionConfig(getSetting2);
    if (cfg.tiers.length === 0 && cfg.logicalModel !== "") {
      cfg.tiers = tiersFromLogicalModel(runtime.registry, cfg.logicalModel);
    }
    return cfg;
  };
  let config;
  try {
    config = readConfigSafe(getSetting);
  } catch (error) {
    ctx.logger?.warn?.("[as-one compaction] invalid config, enhancement disabled:", error);
    return () => {
    };
  }
  const chainCtx = {
    llm: ctx.llm,
    logger: ctx.logger,
    // 容量真值口（2026-11 改进）：ModelChain 没拿到显式 capacities 时逐条问这里，
    // 用 registry 里该真实模型的 maxInputTokens / maxOutputTokens 取代 262144 的
    // 保守默认 —— 小窗口模型被当成「装得下」只会在上游吃 400。
    capacityOf: (provider, model) => {
      const info = runtime.registry.getRealModel(provider, model);
      if (!info) return null;
      const positive = (value) => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
      return { contextWindow: positive(info.maxInputTokens), maxTokens: positive(info.maxOutputTokens) };
    },
    // ⚠️ as-one 适配（2026-11）：组件调 ctx.llm.stream 前必须把 provider/model
    // 翻译成 as-one 适配器能识别的「provider=as-one + model=provider/model +
    // 无 purpose」，否则真实 provider 会 NO_ADAPTER（压缩失败根因）。
    asOneCall: true
  };
  if (!chainCtx.llm || typeof chainCtx.llm.stream !== "function") {
    ctx.logger?.warn?.("[as-one compaction] no llm service available, enhancement disabled");
    return () => {
    };
  }
  let quilt;
  try {
    quilt = toQuiltConfig(config);
  } catch (error) {
    ctx.logger?.warn?.("[as-one compaction] invalid pool config, enhancement disabled:", error);
    return () => {
    };
  }
  const store = new MemoryCooldownStore();
  let inflight = 0;
  let disposed = false;
  const host = ctx;
  const off = host.on(
    "llm/stream",
    (options, next) => {
      if (!isCompactionRequest(options)) return next();
      ctx.logger?.debug?.(`[as-one compaction] intercept compaction request; mode=${config.promptMode} enabled=${config.enabled} tiers=${config.tiers.length}`);
      try {
        config = readConfigSafe(getSetting);
        quilt = toQuiltConfig(config);
      } catch (error) {
        ctx.logger?.warn?.("[as-one compaction] config reload rejected, delegating:", error);
        return next();
      }
      if (!config.enabled || config.tiers.length === 0) return next();
      return decide(options, next);
    },
    { global: true, prepend: true }
  );
  console.info(`[as-one compaction] listener registered mode=${config.promptMode} enabled=${config.enabled} tiers=${config.tiers.length} logicalModel=${config.logicalModel}`);
  async function* stream(options, next) {
    if (inflight > 0) {
      yield* next();
      return;
    }
    inflight += 1;
    try {
      const assembled = config.promptMode === "default" ? await compressOnce(options) : await compress(options);
      if (assembled !== void 0) {
        yield* syntheticChunks(assembled, options.signal);
        return;
      }
    } catch (error) {
      ctx.logger?.warn?.("[as-one compaction] compression failed, delegating to host summary:", error);
    } finally {
      inflight -= 1;
    }
    yield* next();
  }
  async function compressOnce(options) {
    if (disposed) return void 0;
    const messages = regionMessages(options);
    if (messages.length === 0) return void 0;
    const stage0Lines = runStage0(messages, quilt.preprocessing);
    if (stage0Lines.length === 0) return void 0;
    const regionTokens = stage0Lines.reduce((sum, line) => sum + lineTokenCost(line), 0);
    if (regionTokens <= 0) return void 0;
    const candidates = [];
    for (const tier of quilt.tiers) {
      for (const model of tier.models) {
        const info = runtime.registry.getRealModel(model.provider, model.model);
        const rawWindow = info?.maxInputTokens;
        const window = typeof rawWindow === "number" && Number.isInteger(rawWindow) && rawWindow > 0 ? rawWindow : 0;
        if (window <= 0) continue;
        const usable = computeUsableInputTokens(window);
        if (usable < regionTokens) continue;
        candidates.push(model);
      }
    }
    if (candidates.length === 0) {
      ctx.logger?.debug?.(
        `[as-one compaction] no model can hold ${regionTokens} tokens in one pass; delegating to host summary`
      );
      return void 0;
    }
    const unique = /* @__PURE__ */ new Map();
    for (const model of candidates) unique.set(`${model.provider}/${model.model}`, model);
    const pool = [...unique.values()];
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const rawRequest = { ...options, provider: chosen.provider, model: chosen.model };
    const request = toAsOneStreamOptions(rawRequest);
    const { blocks } = await collectTextBlocks(chainCtx.llm.stream(request));
    const text = blocks.map((b) => b.text ?? "").join("").trim();
    if (text === "") return void 0;
    ctx.logger?.info?.(
      `[as-one compaction] one-pass summary via ${chosen.provider}/${chosen.model} (region ~${regionTokens} tok)`
    );
    return text;
  }
  function decide(options, next) {
    return stream(options, next);
  }
  async function compress(options) {
    if (disposed) return void 0;
    const messages = regionMessages(options);
    if (messages.length === 0) return void 0;
    const span = deriveSpan(ctx, options);
    const rawRegion = messagesToRegion(messages);
    const stage0Lines = runStage0(messages, quilt.preprocessing);
    if (stage0Lines.length === 0) {
      ctx.logger?.info?.("[as-one compaction] stage0 lines empty; delegating to host summary");
      return void 0;
    }
    const regionTokens = stage0Lines.reduce((sum, line) => sum + lineTokenCost(line), 0);
    if (regionTokens <= 0) {
      ctx.logger?.info?.("[as-one compaction] region token count is zero; delegating to host summary");
      return void 0;
    }
    const capacities = /* @__PURE__ */ new Map();
    for (const tier of quilt.tiers) {
      for (const model of tier.models) {
        const info = runtime.registry.getRealModel(model.provider, model.model);
        const window = info?.maxInputTokens ?? void 0;
        capacities.set(model.key, {
          contextWindow: Number.isInteger(window) && window > 0 ? window : 262144,
          maxTokens: info?.maxOutputTokens && info.maxOutputTokens > 0 ? info.maxOutputTokens : 32768
        });
      }
    }
    const mergeWindow = quilt.mergeMaxContextTokens;
    const mergeUsableInput = computeUsableInputTokens(mergeWindow);
    const chain = new ModelChain(chainCtx, quilt, store, {}, capacities, capacity);
    const mergeChain = new ModelChain(chainCtx, quilt, store, {}, capacities, capacity);
    const primary = chain.pickPrimaryModel(0, capacities);
    if (primary === void 0) {
      ctx.logger?.warn?.("[as-one compaction] no healthy model in pool; delegating to host summary");
      return void 0;
    }
    const primaryWindow = chain.modelWindow(primary, capacities);
    const budget = computeChunkBudget(primaryWindow, quilt.chunkRatio);
    const overlap = Math.max(0, Math.floor(budget * quilt.chunkOverlapRatio));
    ctx.logger?.info?.(
      `[as-one compaction] primary model ${primary.key} window=${primaryWindow} chunkBudget=${budget} regionTokens~=${regionTokens}`
    );
    const jobs = [];
    let cursor = 0;
    let coreStart = 0;
    let index = 0;
    while (cursor < stage0Lines.length) {
      const { end, next } = sliceNextChunk(stage0Lines, cursor, budget, overlap);
      const slice = stage0Lines.slice(cursor, end);
      if (slice.length === 0) break;
      const tokens = slice.reduce((sum, line) => sum + lineTokenCost(line), 0);
      const coreTokens = stage0Lines.slice(coreStart, end).reduce((sum, line) => sum + lineTokenCost(line), 0);
      const cap = Math.max(1, Math.floor(mergeUsableInput * coreTokens / Math.max(1, regionTokens)));
      index += 1;
      const meta = {
        chunk: index,
        lineStart: cursor,
        lineEnd: end,
        coreStart,
        coreEnd: end,
        tokens,
        coreTokens,
        sessionId: span.sessionId,
        seqStart: span.seqStart,
        seqEnd: span.seqEnd
      };
      jobs.push(chunkJob(`chunk ${index}`, slice.join("\n"), meta, primary.key, cap));
      cursor = next;
      coreStart = end;
    }
    if (jobs.length === 0) {
      ctx.logger?.info?.("[as-one compaction] no chunk produced; delegating to host summary");
      return void 0;
    }
    const anchorInstruction = config.promptMode === "anchored" ? anchoredInstruction(span.sessionId, span.seqStart, span.seqEnd) : "";
    if (jobs.length === 1) {
      const only = jobs[0];
      const text2 = String(only.text ?? "");
      const finalPrompt = anchorInstruction === "" ? SINGLE_CHUNK_PROMPT : `${SINGLE_CHUNK_PROMPT}

${anchorInstruction}`;
      only.buildMessages = () => [
        { role: "user", content: [{ type: "text", text: text2 }] },
        { role: "user", content: [{ type: "text", text: finalPrompt }] }
      ];
      ctx.logger?.info?.("[as-one compaction] single chunk → one-pass prompt (no merge)");
    }
    const total = jobs.reduce((sum, job) => sum + (job.capTokens ?? 0), 0);
    if (total > mergeUsableInput) {
      const scale = mergeUsableInput / total;
      for (const job of jobs) job.capTokens = Math.max(1, Math.floor((job.capTokens ?? 0) * scale));
    }
    const agent = {
      session: {
        id: String(options.sessionId ?? "anon"),
        requestHeader: () => void 0,
        toolHistory: () => []
      },
      options: { provider: options.provider, model: options.model }
    };
    const fallbackOptions = {
      fallbackInput: { messages },
      defaultSummarize: async (input, _agent, abort) => {
        ctx.logger?.info?.("[as-one compaction] falling back to host summary path");
        const { blocks, usage } = await collectTextBlocks(chainCtx.llm.stream({
          ...options,
          messages: input.messages,
          signal: abort ?? options.signal
        }));
        return { summary: blocks, usage };
      },
      capacities
    };
    const chunkResults = await chain.run(jobs, agent, options.signal, fallbackOptions);
    const digests = chunkResults.filter((result) => result !== void 0).map((result) => result.text);
    if (digests.length === 0 || digests.some((text2) => !text2 || text2.trim().length === 0)) {
      ctx.logger?.info?.("[as-one compaction] empty digest; delegating to host summary");
      return void 0;
    }
    let finalText;
    if (digests.length === 1) {
      finalText = digests[0];
    } else if (mergeChain.canHoldMerge(mergeWindow, capacities)) {
      const mergeModel = mergeChain.pickMergeModel(capacities);
      const merge = mergeJob(digests, { sourceChunks: digests.length });
      if (anchorInstruction !== "") {
        const base = merge.buildMessages;
        merge.buildMessages = (promptConfig) => {
          const messages2 = base(promptConfig);
          const last = messages2.at(-1);
          if (last?.content?.[0]?.type === "text") {
            last.content[0].text = `${last.content[0].text ?? ""}

${anchorInstruction}`;
          }
          return messages2;
        };
      }
      if (mergeModel !== void 0) merge.preferredKey = mergeModel.key;
      ctx.logger?.info?.(
        `[as-one compaction] merge via ${mergeModel?.key ?? "auto"} window=${mergeModel ? mergeChain.modelWindow(mergeModel, capacities) : "?"} chunks=${digests.length}`
      );
      const mergeResult = await mergeChain.run([merge], agent, options.signal, fallbackOptions);
      finalText = mergeResult[0]?.text;
    } else {
      ctx.logger?.info?.("[as-one compaction] no merge route can hold the digests; delegating to host summary");
      return void 0;
    }
    if (!finalText || finalText.trim().length === 0) {
      ctx.logger?.info?.("[as-one compaction] final text empty; delegating to host summary");
      return void 0;
    }
    const text = finalText.trim();
    if (text.length >= rawRegion.length) {
      ctx.logger?.info?.(`[as-one compaction] ${rawRegion.length} chars region would not shrink (digest ${text.length} chars); keeping host summary`);
      return void 0;
    }
    ctx.logger?.info?.(
      `[as-one compaction] checkpoint via component chunks=${digests.length} rawChars=${rawRegion.length} digestChars=${text.length} anchor=${text.includes("<session-search-anchors>") ? "model" : "none"}`
    );
    return text;
  }
  return () => {
    disposed = true;
    try {
      off?.();
    } catch {
    }
    capacity.reset();
    void store.clearAll();
  };
}

// src/index.ts
var name = "@bvbhu/as-one";
var inject = ["webServer", "asOneCore"];
function apply(ctx) {
  const core = ctx.get("asOneCore");
  if (!core) {
    ctx.logger?.warn?.("[as-one] core service unavailable, gateway row skipped");
    return;
  }
  const runtime = core.runtime;
  let disposeCompaction;
  ctx.effect(
    () => {
      const panelRoutes = buildPanelRoutes(runtime);
      ctx.inject(["llm"], (child) => {
        child.effect(() => {
          const adapter = new AsOneLlmAdapter(runtime, {
            // ⚠️ DSH 的对话请求走这条进程内路径（`adapter.stream()` → `resolveUpstream`），
            // **不经过** `/v1/chat/completions` 路由 —— 所以预热门必须在这里再注入一次，
            // 否则启动后首个请求仍会拿空额度快照排成 members 配置序（恒走 trae）。
            warmup: core.warmup,
            // 宿主 attachments 服务的惰性取用口 —— adapter 靠它把 `read_image`
            // 与用户附件的「附件引用」读成字节再编成 data URL。
            //
            // ⚠️ 故意不把 attachments 写进 `ctx.inject([...])`:纯 Web 宿主 / 没挂
            // 附件服务的部署里,整个 adapter 都不该因此消失(那样连文本模型都选不到)。
            // 服务缺失时 adapter 如实降级(丢图片块),文本请求照常。
            // 现读 setting 表:面板保存后下一个请求就换车道。
            reroutes: () => rerouteSettingsFrom(runtime.getSetting),
            // 只对**已创建的子代理会话**返回替代模型；创建期并发拦截不在此路径。
            subagentFallback: (sessionId, model) => {
              if (sessionId === void 0 || !core.subagentSessions.has(sessionId)) return void 0;
              const fallback = fallbackModelOf(runtime.getSetting);
              return fallback === model ? void 0 : fallback;
            },
            resolveAttachments: () => {
              try {
                return child.get("attachments") ?? void 0;
              } catch {
                return void 0;
              }
            }
          });
          let unregister;
          try {
            unregister = child.llm.registerAdapter([AS_ONE_PROVIDER], adapter);
            child.logger?.info?.(`[as-one] llm adapter registered as "${AS_ONE_PROVIDER}"`);
          } catch (err) {
            child.logger?.warn?.("[as-one] llm adapter registration failed:", err);
          }
          try {
            disposeCompaction = applyCompaction({
              ctx: child,
              runtime,
              capacity: createCapacityView(runtime.ledger),
              getSetting: (key) => runtime.getSetting(key)
            });
          } catch (err) {
            child.logger?.warn?.("[as-one] compaction enhancement setup failed:", err);
          }
          return () => {
            try {
              unregister?.();
            } catch (err) {
              child.logger?.warn?.("[as-one] llm adapter dispose failed:", err);
            }
          };
        }, "@bvbhu/as-one: llm adapter");
      });
      warmupDeepseekTokenizer();
      setCompactHost({
        compaction: (() => {
          try {
            return ctx.get("compaction") ?? void 0;
          } catch {
            return void 0;
          }
        })(),
        warn: (message, error) => ctx.logger?.warn?.(message, error)
      });
      try {
        const host = ctx;
        host.on(
          "agent/request",
          (payload, next) => internalSwitch.onAgentRequest(
            payload,
            next
          ),
          { prepend: true }
        );
      } catch (err) {
        ctx.logger?.warn?.("[as-one] compact trigger registration skipped:", err);
      }
      const disposers = [];
      for (const route of panelRoutes) {
        try {
          disposers.push(ctx.webServer.register(route));
        } catch (err) {
          ctx.logger?.warn?.(`[as-one] register route ${route.path} failed:`, err);
        }
      }
      ctx.logger?.info?.(
        `[as-one] mounted ${panelRoutes.length} panel route(s)`
      );
      return () => {
        disposeCompaction?.();
        for (const dispose of disposers) dispose();
      };
    },
    "@bvbhu/as-one: gateway core (panel routes + llm adapter + compaction)"
  );
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
