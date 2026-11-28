/**
 * 网关 resolveUpstream —— 网关网络层的**唯一实现**。
 *
 * 历史:本文件原是一份 557 行的简化移植(只处理 openai 直连路径)。
 * 2026-10-30 起改为整份复用 electron 版实现(gateway-upstream.ts 及
 * gateway-upstream-{body,errors,peers,stream}.ts 共 5 个文件),当时约束是
 * 「electron 侧改动后 cp 到本包 + typecheck 兜底」,以求两形态行为一致。
 *
 * ⚠️ **electron 版已于后续彻底废弃**(单包插件重构,见 git 历史 46bd60a 起)。
 * 这 5 个文件现在是网关的**唯一实现**,不再存在跨形态副本,也就没有了
 * 需要人工 `cp` 同步的第二份真源 —— 原先的 parity 同步纪律作废。改动这
 * 组文件直接改本包即可,无同步义务。
 */

export { buildResolveUpstream, type UpstreamRuntime } from "./gateway-upstream.js";
