// Bundle the host half into ONE esbuild build with MULTIPLE entry points — one
// per cordis patch row (bundle refactor, user decision D1):
//   src/index.ts          → lib/index.js       (gateway core row, @bvbhu/as-one)
//   src/core-row.ts       → lib/core.js        (core service row, @bvbhu/as-one/core)
//   src/subagent-row.ts   → lib/subagent.js    (subagent row, @bvbhu/as-one/subagent)
//   src/external-port-row.ts → lib/external-port.js (external port row)
//   src/external-usage-row.ts → lib/external-usage.js (external usage row)
//   src/bot-channel-row.ts   → lib/bot-channel.js   (bot channel row)
//   src/bot-mhy-row.ts       → lib/bot-mhy.js       (Yunzai host row)
//   src/bot-chat-row.ts      → lib/bot-chat.js      (bound chat row)
//   src/bot-assistant-row.ts → lib/bot-assistant.js (bound assistant row)
//   src/bot-session-tools.ts  → lib/bot-session-tools.js (chat/assistant shared tools)
//   src/bot-notify-row.ts    → lib/bot-notify.js    (owner notify row)
//   src/settings-row.ts      → lib/settings.js      (bot.mhy.* settings row)
//   src/channel-trae-row.ts  → lib/channel-trae.js  (trae channel sub-row)
//   src/channel-workbuddy-row.ts → lib/channel-workbuddy.js (workbuddy channel sub-row)
//   src/channel-sensenova-row.ts → lib/channel-sensenova.js (sensenova channel sub-row)
//   src/channel-minimax-row.ts  → lib/channel-minimax.js  (minimax channel sub-row)
//   src/channel-qoder-row.ts    → lib/channel-qoder.js    (qoder channel sub-row)
//   src/channel-codearts-row.ts → lib/channel-codearts.js (codearts channel sub-row)
//
// `splitting: true` lets esbuild factor modules imported by several rows into
// shared chunks (lib/chunk-*.js) instead of duplicating them in every bundle.
// Run: node scripts/bundle-host.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

// esbuild is only a transitive dep in the workspace .pnpm store (tsdown pulls it in);
// resolve it from a few candidate locations so this script runs from any cwd.
async function loadEsbuild() {
  const candidates = [
    new URL("../node_modules/esbuild/lib/main.js", import.meta.url),
    new URL("../../../node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js", import.meta.url),
    new URL("../../node_modules/esbuild/lib/main.js", import.meta.url),
    new URL("../../../node_modules/esbuild/lib/main.js", import.meta.url),
  ];
  for (const c of candidates) {
    try {
      return await import(c);
    } catch {}
  }
  throw new Error("esbuild not found — install it or run pnpm install at the workspace root first");
}
const { build } = await loadEsbuild();

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const libDir = join(pkg, "lib");

// One entry per patch row. esbuild derives each output name from the entry
// basename, so the row entries land as lib/core-row.js etc.; the RENAMES below
// map them onto the package.json exports names (lib/core.js …).
const entries = [
  { entry: "src/index.ts", out: "index.js" },
  { entry: "src/core-row.ts", out: "core.js" },
  { entry: "src/subagent-row.ts", out: "subagent.js" },
  { entry: "src/external-port-row.ts", out: "external-port.js" },
  { entry: "src/external-usage-row.ts", out: "external-usage.js" },
  { entry: "src/bot-channel-row.ts", out: "bot-channel.js" },
  { entry: "src/bot-mhy-row.ts", out: "bot-mhy.js" },
  { entry: "src/bot-chat-row.ts", out: "bot-chat.js" },
  { entry: "src/bot-assistant-row.ts", out: "bot-assistant.js" },
  { entry: "src/bot-session-tools.ts", out: "bot-session-tools.js" },
  { entry: "src/bot-notify-row.ts", out: "bot-notify.js" },
  { entry: "src/settings-row.ts", out: "settings.js" },
  { entry: "src/channel-trae-row.ts", out: "channel-trae.js" },
  { entry: "src/channel-workbuddy-row.ts", out: "channel-workbuddy.js" },
  { entry: "src/channel-sensenova-row.ts", out: "channel-sensenova.js" },
  { entry: "src/channel-minimax-row.ts", out: "channel-minimax.js" },
  { entry: "src/channel-qoder-row.ts", out: "channel-qoder.js" },
  { entry: "src/channel-codearts-row.ts", out: "channel-codearts.js" },
];

const r = await build({
  entryPoints: entries.map((e) => join(pkg, e.entry)),
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: libDir,
  entryNames: "[name]",
  // shared code imported by several rows becomes lib/chunk-*.js
  splitting: true,
  external: [
    "node:*",
    // schemastery 及其依赖由宿主 profile 的 node_modules 解析（repo 不装实体包）。
    "@deepseek-ai/schemastery",
    "@deepseek-ai/cosmokit",
    "@standard-schema/spec",
  ],
  // charset 默认是 ascii —— 那会把内联的 DeepSeek 词表(127k 条 merges,大量
  // Ġ/Ċ 这类字节级字符)整片转成 \uXXXX,白白胀大 1MB 多。产物只给 Node 读,
  // UTF-8 原样保留,加载也更快。
  charset: "utf8",
  logLevel: "warning",
  sourcemap: true,
});

if (r.errors.length) {
  console.error(r.errors.map((e) => e.text).join("\n"));
  process.exit(1);
}

// Rename row outputs onto their export names (lib/core.js …) and keep the
// sourceMappingURL comment + .map file in sync.
for (const e of entries.filter((x) => x.out !== x.entry.replace(/^src\//, "").replace(/\.ts$/, ".js"))) {
  const built = join(libDir, e.entry.replace(/^src\//, "").replace(/\.ts$/, ".js"));
  const target = join(libDir, e.out);
  if (!existsSync(built)) continue;
  let js = readFileSync(built, "utf8");
  js = js.replace(
    new RegExp(`//# sourceMappingURL=${e.entry.replace(/^src\//, "").replace(/\.ts$/, ".js")}\\.map`),
    `//# sourceMappingURL=${e.out}.map`,
  );
  writeFileSync(target, js);
  const builtMap = `${built}.map`;
  if (existsSync(builtMap)) renameSync(builtMap, `${target}.map`);
  rmSync(built);
}

const sizes = entries
  .map((e) => `${e.out} (${(existsSync(join(libDir, e.out)) ? readFileSync(join(libDir, e.out)).length : 0)} bytes)`)
  .join(", ");
console.log(`bundled host rows → lib/ [${sizes}] (+ shared chunks)`);
