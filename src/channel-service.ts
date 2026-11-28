/**
 * 渠道子组件服务形状 —— 六个渠道行各自 provide、网关核心按名取用的**唯一跨行通道**。
 *
 * 单独成模块而不是放进某个行文件:行与行之间禁止互相 import(R1 规则,
 * 见 docs/plugin-bundle-plan.md),而网关核心行与六个渠道行都要按类型取用
 * 这个服务。类型模块不是行,`import type` 在构建期即被擦除。
 *
 * 语义(2026-11-27 用户 m11109 定案:每个渠道注册成子组件,可单独关闭):
 * - 一行 = 一个渠道 = 一个 patch 行 = DSH 设置页一个 `enabled` 开关;
 * - 行 provide `asOneChannel<Provider>` 服务,live 值由 schemastery Volatile
 *   引用承载,设置页写入后**无需重启**即变;
 * - 网关核心的 `LiveChannelOverlay` 优先读 live 服务,行缺席(被禁用/未装载)
 *   时回退 `setting` 表的 `channel.enabled.<provider>` 镜像,再回退缺省启用。
 */

/** 单个渠道的总开关服务(六个渠道各一个,名见 {@link channelServiceName})。 */
export interface AsOneChannelService {
  /** provider 主键(trae / workbuddy / sensenova / minimax / qoder / codearts)。 */
  readonly provider: string;
  /** 展示名(设置页与日志用)。 */
  readonly label: string;
  /**
   * live 开关:`true` = 渠道参与选路;`false` = 渠道总关闭(其账号全部不进链)。
   *
   * 读取即当前值(Volatile live),设置页拨动后下一个调度决策就能看到。
   */
  readonly enabled: boolean;
}

/** 六个渠道的 patch 行名 → 服务名(`asOneChannelTrae` …)。 */
export const CHANNEL_ROWS: ReadonlyArray<{
  provider: string;
  label: string;
  serviceName: string;
}> = [
  { provider: "trae", label: "Trae", serviceName: "asOneChannelTrae" },
  { provider: "workbuddy", label: "WorkBuddy", serviceName: "asOneChannelWorkbuddy" },
  { provider: "sensenova", label: "SenseNova", serviceName: "asOneChannelSensenova" },
  { provider: "minimax", label: "MiniMax", serviceName: "asOneChannelMinimax" },
  { provider: "qoder", label: "Qoder", serviceName: "asOneChannelQoder" },
  { provider: "codearts", label: "CodeArts", serviceName: "asOneChannelCodearts" },
];

/** provider → 服务名(未知 provider 返回 undefined,调用方按「行缺席」处理)。 */
export function channelServiceName(provider: string): string | undefined {
  return CHANNEL_ROWS.find((row) => row.provider === provider)?.serviceName;
}
