/**
 * as-one-settings 行 —— bot.mhy.* 配置的 DSH 设置页入口。
 *
 * patch 行 `@bvbhu/as-one/settings`。函数式插件 + 模块级 Config（schemastery
 * schema，全字段 volatile）—— dsh-settings 的 describe() 自动把它投影成设置
 * 表单（只显示 volatile 字段），settings UI 写入走 profile patch yml 的
 * config 段 → loader commit → fiber live 更新（无需重启）。
 *
 * apply 只做一件事：provide `asOneMhySettings` 服务对象（config 字段是
 * Volatile 引用）给 bot-mhy 行读取 live 值。缺省值常量与 bot-mhy 行保持一致。
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import type { AsOneMhySettingsService } from "./settings-service.js";

export const name = "@bvbhu/as-one/settings";
export const inject: string[] = [];

/** 与 bot-mhy 行缺省值一致（src/bot-mhy-row.ts 的 DEFAULT_* 常量）。 */
const DEFAULT_YUNZAI_DIR = "D:\\projects\\bot\\yunzai-qqbot\\app";
/** server.yaml 缺 port 时的兜底端口（trss-yunzai 默认 2536）。 */
const DEFAULT_YUNZAI_PORT = 2536;
/** 心跳间隔缺省 60s。 */
const DEFAULT_HEARTBEAT_MS = 60_000;
/** 签到时刻缺省 00:02。 */
const DEFAULT_SIGNIN_TIME = "00:02";
/** 主人 QQ（私聊直推目标）。 */
const DEFAULT_OWNER_QQ = "3187192488";

/** Plugin config: the bot.mhy.* settings exposed in the DSH settings UI. */
export interface SettingsConfig {
  yunzai: {
    /** Yunzai app 目录（trss-yunzai 3.1.3，可裸跑 `node app.js`）。 */
    dir: string;
    /** 探测端口（缺省 2536；server.yaml 有配时以 yaml 为准——settings 值优先）。 */
    port: number;
    /** 缺省开（探测先行，pm2 在跑时不会双开）。 */
    autoStart: boolean;
    /** 心跳间隔毫秒（bot-mhy 行钳制 5s..1h）。 */
    heartbeatMs: number;
  };
  signin: {
    /** 签到开关（缺省 true）。 */
    enabled: boolean;
    /** 每天签到时刻 HH:MM（缺省 "00:02"）。 */
    time: string;
    /** 直推主人 QQ（缺省 3187192488）。 */
    ownerQQ: string;
  };
}

/** Runtime schema for the settings row (all volatile → settings UI editable).
 *  不加 `z<SettingsConfig>` 注解：volatile 字段的 resolve 类型是 Volatile<T>
 *  包装，注解会与纯接口不匹配（schemastery 惯用法——dsh-bash-local 同样裸导出）。 */
export const Config = z.object({
  yunzai: z.object({
    dir: z.string().default(DEFAULT_YUNZAI_DIR).volatile(),
    port: z.number().default(DEFAULT_YUNZAI_PORT).volatile(),
    autoStart: z.boolean().default(true).volatile(),
    heartbeatMs: z.number().default(DEFAULT_HEARTBEAT_MS).volatile(),
  }),
  signin: z.object({
    enabled: z.boolean().default(true).volatile(),
    time: z.string().default(DEFAULT_SIGNIN_TIME).volatile(),
    ownerQQ: z.string().default(DEFAULT_OWNER_QQ).volatile(),
  }),
});

/**
 * Provide the live settings service for the bot-mhy row.
 * @param ctx - the mounting context.
 * @param config - resolved plugin config (Volatile references for volatile fields).
 */
export function apply(ctx: Context, config: SettingsConfig): void {
  ctx.provide("asOneMhySettings", {
    config: config as unknown as AsOneMhySettingsService["config"],
  });
}
