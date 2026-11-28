/**
 * `asOneCore` 服务的形状 —— 核心行 provide、其余四行 inject 的**唯一跨行通道**。
 *
 * 单独成模块而不是放在 core-row.ts:行与行之间禁止互相 import（R1 规则,
 * 见 docs/plugin-bundle-plan.md），而 subagent / external-port / external-usage /
 * 网关核心四行都要按类型取用这个服务。类型模块不是行，import 它不产生运行时
 * 耦合（`import type` 在构建期即被擦除）。
 */

import type { AsOneRuntime } from "./setup.js";
import type { WarmupGate } from "./warmup-gate.js";

export interface AsOneCoreService {
  /** 网关运行时（db / registry / vault / repo / scheduler / router / ledger …）。 */
  runtime: AsOneRuntime;
  /** 已创建的子代理会话 id（请求期并发兜底判定）。 */
  subagentSessions: Set<string>;
  /** 额度预热门（挂在 runtime 上，所有异步调度入口 await 它）。 */
  warmup: WarmupGate;
}
