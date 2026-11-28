/**
 * SenseNova 渠道子组件（用户 m11109 定案:每渠道一个子组件,设置页一个开关）。
 */

import { defineChannelRow } from "./channel-row-factory.js";

const row = defineChannelRow("sensenova", "SenseNova");

export const name = row.name;
export const inject = row.inject;
export const Config = row.Config;
export function apply(ctx: Parameters<typeof row.apply>[0], config: Parameters<typeof row.apply>[1]): void {
  row.apply(ctx, config);
}
