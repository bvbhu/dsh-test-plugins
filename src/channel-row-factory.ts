/**
 * 渠道子组件行的工厂 —— 六个渠道行共享的装配逻辑（用户 m11109 定案：
 * Trae / WorkBuddy / SenseNova / MiniMax / Qoder / CodeArts 各自注册成
 * 一个子组件，DSH 设置页出现一个 `enabled` 开关，可单独关闭该渠道）。
 *
 * 为什么要工厂而不是六份复制:六个行的**生命周期完全同构** ——
 * ① provide `asOneChannel<Provider>` live 服务(设置页写 schemastery
 *    Volatile,`.get()` 即当前值,**免重启**);
 * ② 向 `asOneCore.runtime` 登记 live 源(行 → core 单向,R1 规则允许);
 * ③ 把 live 值镜像进 `setting` 表(`channel.enabled.<provider>`),
 *    供同 bundle 的其他实例/行回退读取,并跨进程一致。
 *
 * 工厂模块不是行,不参与 arch.test.ts 的 R1(行间零互 import)约束 ——
 * 六个行文件各自 `import { defineChannelRow } from "./channel-row-factory.js"`。
 */

import type { Volatile } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import type { Context } from "./context-types.js";
import type { AsOneChannelService } from "./channel-service.js";

/** 渠道行的配置形状:enabled 是 Volatile live 引用(`.get()` 读当前值)。 */
export interface ChannelRowConfig {
  /** 渠道总开关(DSH 设置页可编辑;Volatile 引用,免重启)。 */
  enabled: Volatile<boolean>;
}

/** 六个渠道行共用的 schema(全字段 volatile;输出型 = ChannelRowConfig)。 */
const channelConfigSchema = z.object({
  enabled: z.boolean().default(true).volatile(),
});
type ChannelRowSchema = typeof channelConfigSchema;

/** 一个渠道行的完整定义(导出给 cordis 直接加载)。 */
export interface ChannelRowDefinition {
  name: string;
  inject: string[];
  /**
   * schemastery schema(全字段 volatile)—— 不加 `z<ChannelRowConfig>` 注解:
   * volatile 字段的 resolve 类型是 Volatile<T> 包装,注解会与纯接口不匹配
   * (schemastery 惯用法,同 settings-row.ts)。
   */
  Config: ChannelRowSchema;
  apply(ctx: Context, config: ChannelRowConfig): void;
}

/** 镜像写入节流间隔:live 值漂移后最长 1s 落库(免重启语义下 db 只是镜像)。 */
const CHANNEL_MIRROR_INTERVAL_MS = 1_000;

/**
 * 构造一个渠道行定义。
 *
 * @param provider provider 主键(trae / workbuddy / sensenova / minimax / qoder / codearts)
 * @param label    展示名(设置页与日志)
 */
export function defineChannelRow(provider: string, label: string): ChannelRowDefinition {
  const serviceName = `asOneChannel${provider[0]!.toUpperCase()}${provider.slice(1)}`;
  const settingKey = `channel.enabled.${provider}`;

  /** 读 live 开关(任何异常回退启用 —— 配置 bug 不许拖垮行,同 settings-row 哲学)。 */
  const readEnabled = (config: ChannelRowConfig): boolean => {
    try {
      return config.enabled.get();
    } catch {
      return true;
    }
  };

  const apply = (ctx: Context, config: ChannelRowConfig): void => {
    // ① live 服务:enabled 是 getter,每次读都取当前 Volatile 值 —— 设置页
    //    拨动后下一个调度决策就生效,不需要重启 DSH。
    const service: AsOneChannelService = {
      provider,
      label,
      get enabled(): boolean {
        return readEnabled(config);
      },
    };
    ctx.provide(serviceName, service);

    // ② 登记 live 源给 core runtime(网关选路过滤的第一优先源)。
    const core = (ctx as unknown as { get(name: string): unknown }).get("asOneCore") as
      | { runtime?: { setChannelLive?: (provider: string, live: unknown) => void } }
      | undefined;
    core?.runtime?.setChannelLive?.(provider, service);

    // ③ setting 表镜像:跨实例/跨进程一致(其他实例的 LiveChannelOverlay 靠
    //    PRAGMA data_version 感知),也让行缺席时回退读取。写失败静默 ——
    //    live 值才是真源,db 只是镜像。
    const writeMirror = (value: boolean): void => {
      const runtime = (ctx as unknown as { get(name: string): unknown }).get("asOneCore") as
        | { runtime?: { db?: { setting?: { set(key: string, value: string): void } } } }
        | undefined;
      try {
        runtime?.runtime?.db?.setting?.set(settingKey, value ? "1" : "0");
      } catch {
        /* 镜像写失败不影响 live 语义 */
      }
    };

    let last = readEnabled(config);
    writeMirror(last);
    const timer = setInterval(() => {
      const cur = readEnabled(config);
      if (cur === last) return;
      last = cur;
      writeMirror(cur);
    }, CHANNEL_MIRROR_INTERVAL_MS);
    timer.unref?.();

    ctx.effect(
      () => () => clearInterval(timer),
      `@bvbhu/as-one/channel-${provider}: live 镜像`,
    );
  };

  return {
    name: `@bvbhu/as-one/channel-${provider}`,
    inject: ["asOneCore"],
    // schema 输出型 = ChannelRowConfig(enabled 是 Volatile 包装),无需桥接。
    Config: channelConfigSchema,
    apply,
  };
}
