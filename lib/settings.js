import "./chunk-BJ7B4R26.js";

// src/settings-row.ts
import z from "@deepseek-ai/schemastery";
var name = "@bvbhu/as-one/settings";
var inject = [];
var DEFAULT_YUNZAI_DIR = "D:\\projects\\bot\\yunzai-qqbot\\app";
var DEFAULT_YUNZAI_PORT = 2536;
var DEFAULT_HEARTBEAT_MS = 6e4;
var DEFAULT_SIGNIN_TIME = "00:02";
var DEFAULT_OWNER_QQ = "3187192488";
var Config = z.object({
  yunzai: z.object({
    dir: z.string().default(DEFAULT_YUNZAI_DIR).volatile(),
    port: z.number().default(DEFAULT_YUNZAI_PORT).volatile(),
    autoStart: z.boolean().default(true).volatile(),
    heartbeatMs: z.number().default(DEFAULT_HEARTBEAT_MS).volatile()
  }),
  signin: z.object({
    enabled: z.boolean().default(true).volatile(),
    time: z.string().default(DEFAULT_SIGNIN_TIME).volatile(),
    ownerQQ: z.string().default(DEFAULT_OWNER_QQ).volatile()
  })
});
function apply(ctx, config) {
  ctx.provide("asOneMhySettings", {
    config
  });
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=settings.js.map
