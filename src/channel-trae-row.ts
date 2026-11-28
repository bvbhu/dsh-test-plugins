/**
 * Trae 渠道子组件（用户 m11109 定案:每渠道一个子组件,设置页一个开关）。
 *
 * 本文件只做一件事:把 Trae 渠道包进 {@link defineChannelRow}。装配细节
 * (live 服务 + core 登记 + setting 镜像)全在工厂里 —— 六个渠道行的
 * 生命周期完全同构,复制六份只会分叉。
 */

import { defineChannelRow } from "./channel-row-factory.js";

const row = defineChannelRow("trae", "Trae");

export const name = row.name;
export const inject = row.inject;
export const Config = row.Config;
export function apply(ctx: Parameters<typeof row.apply>[0], config: Parameters<typeof row.apply>[1]): void {
  row.apply(ctx, config);
}
