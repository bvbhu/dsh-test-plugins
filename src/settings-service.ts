/**
 * `asOneMhySettings` 服务的形状 —— settings 行 provide、bot-mhy 行 inject。
 *
 * 类型模块而非行（同 core-service.ts 的 R1 规则）：行与行之间禁止互相
 * import，类型模块 `import type` 在构建期即被擦除，不产生运行时耦合。
 *
 * `config` 的字段是 schemastery `.volatile()` 字段的 resolve 产物 ——
 * `Volatile<T>` 引用，`.get()` 读 live 值（settings UI 写入后无需重启）。
 */
import type { Volatile } from "@deepseek-ai/cordis";

export interface AsOneMhySettingsService {
  /** Live 插件配置（Volatile 引用；读取一律走 `.get()`）。 */
  config: {
    yunzai: {
      dir: Volatile<string>;
      port: Volatile<number>;
      autoStart: Volatile<boolean>;
      heartbeatMs: Volatile<number>;
    };
    snowLuma: {
      autoStart: Volatile<boolean>;
      dir: Volatile<string>;
    };
    signin: {
      enabled: Volatile<boolean>;
      time: Volatile<string>;
      ownerQQ: Volatile<string>;
    };
  };
}
