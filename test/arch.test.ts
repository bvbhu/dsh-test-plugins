/**
 * 架构静态扫描 —— bundle 拆分后的行隔离规则（R1）。
 *
 * 断言:
 * 1. 十个行文件都存在,且各自导出 name / inject / apply;
 * 2. 行文件只 import 三类来源:相对模块(自身作用域/共享服务模块)、
 *    `@as-one/*` 别名、宿主包(node:* 与裸包名);
 * 3. **没有任何行 import 另一个行**(R1:行之间只经 asOneCore 服务或宿主事件)。
 *
 * 实现刻意保持零依赖(fs + 正则),跑得快。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/** 十六个 patch 行（根入口 = 网关核心行；settings 行默认关闭暂缓；
 *  六个渠道子组件行 = 每渠道一个子组件,设置页一个 enabled 开关,用户 m11109）。 */
const ROWS = [
  "index.ts",
  "core-row.ts",
  "subagent-row.ts",
  "external-port-row.ts",
  "external-usage-row.ts",
  "bot-channel-row.ts",
  "bot-mhy-row.ts",
  "bot-chat-row.ts",
  "bot-assistant-row.ts",
  "bot-notify-row.ts",
  "channel-trae-row.ts",
  "channel-workbuddy-row.ts",
  "channel-sensenova-row.ts",
  "channel-minimax-row.ts",
  "channel-qoder-row.ts",
  "channel-codearts-row.ts",
] as const;

/** 从源码文本里抓 import / export … from 的模块说明符(含动态 import())。 */
function specifiersOf(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/from\s+["']([^"']+)["']/g)) out.add(m[1]);
  for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.add(m[1]);
  return [...out];
}

describe("bundle 行隔离(R1)", () => {
  for (const row of ROWS) {
    describe(row, () => {
      const file = join(srcDir, row);
      const code = existsSync(file) ? readFileSync(file, "utf8") : "";

      it("文件存在", () => {
        expect(existsSync(file), `missing ${file}`).toBe(true);
      });

      it("导出 name / inject / apply", () => {
        expect(code).toMatch(/export const name = /);
        expect(code).toMatch(/export const inject\b/);
        expect(code).toMatch(/export function apply\(/);
      });

      it("不 import 另一个行", () => {
        const otherRows = ROWS.filter((r) => r !== row);
        for (const spec of specifiersOf(code)) {
          if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
          const resolved = join(srcDir, spec.replace(/^\.\//, ""));
          const base = resolved.split(/[\\/]/).pop()?.replace(/\.js$/, ".ts");
          expect(
            otherRows,
            `${row} imports row module "${spec}" — rows must communicate via the asOneCore service or host events only`,
          ).not.toContain(base);
        }
      });

      it("import 来源仅限:相对模块 / @as-one 别名 / 宿主包", () => {
        for (const spec of specifiersOf(code)) {
          const ok =
            spec.startsWith("node:") ||
            spec.startsWith("@as-one/") ||
            spec.startsWith("./") ||
            spec.startsWith("../") ||
            (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("@as-one/"));
          expect(ok, `${row} has unexpected import "${spec}"`).toBe(true);
        }
      });
    });
  }
});
