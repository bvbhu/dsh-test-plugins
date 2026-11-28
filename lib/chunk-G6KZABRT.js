// src/channel-row-factory.ts
import z from "@deepseek-ai/schemastery";
var channelConfigSchema = z.object({
  enabled: z.boolean().default(true).volatile()
});
var CHANNEL_MIRROR_INTERVAL_MS = 1e3;
function defineChannelRow(provider, label) {
  const serviceName = `asOneChannel${provider[0].toUpperCase()}${provider.slice(1)}`;
  const settingKey = `channel.enabled.${provider}`;
  const readEnabled = (config) => {
    try {
      return config.enabled.get();
    } catch {
      return true;
    }
  };
  const apply = (ctx, config) => {
    const service = {
      provider,
      label,
      get enabled() {
        return readEnabled(config);
      }
    };
    ctx.provide(serviceName, service);
    const core = ctx.get("asOneCore");
    core?.runtime?.setChannelLive?.(provider, service);
    const writeMirror = (value) => {
      const runtime = ctx.get("asOneCore");
      try {
        runtime?.runtime?.db?.setting?.set(settingKey, value ? "1" : "0");
      } catch {
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
      `@bvbhu/as-one/channel-${provider}: live 镜像`
    );
  };
  return {
    name: `@bvbhu/as-one/channel-${provider}`,
    inject: ["asOneCore"],
    // schema 输出型 = ChannelRowConfig(enabled 是 Volatile 包装),无需桥接。
    Config: channelConfigSchema,
    apply
  };
}

export {
  defineChannelRow
};
//# sourceMappingURL=chunk-G6KZABRT.js.map
