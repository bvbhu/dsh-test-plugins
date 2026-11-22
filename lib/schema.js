/**
 * 插件 Config schema（schemastery）。
 *
 * 用的说明符是 `@deepseek-ai/schemastery`（profile 的 node_modules 里确认存在），
 * **不是**裸名 `schemastery` —— 第三方包在 DSH 的闭包里解析不到裸名。
 *
 * 每个字段都带 `.volatile()`：DSH 0.1.7+ 的 SettingsForms.describe 按 volatileForm
 * 门槛下发 entry —— 不标记的字段既不会出现在设置页，改动也会触发 reload 而不是就地
 * 提交（dsh-vscode-mode/cordis.patch.yml 里记录的实测结论）。
 *
 * 两个实测事实（本机 node v24 直连 profile 里的 @deepseek-ai/schemastery 验证）：
 *  1. schema 对象本身**可调用**：`Config(raw)` 做解析，`Config.parse` 并不存在。
 *  2. 标了 `.volatile()` 的字段解析出来是引用对象 `{ get() }`，不是裸值 ——
 *     宿主侧 `createVolatile`/`isVolatile` 就是干这个的。读值必须走 unwrap()
 *     （见 lib/config-read.js），否则字符串字段会变成 `[object Object]`。
 *
 * ⚠️ 依赖解析失败必须降级而不是让模块炸掉：以 `link:` 安装时 Node 按 realpath 解析
 * 依赖，本包不一定看得到 profile 里的 @deepseek-ai。那种情况下宿主半仍能工作
 * （index.js 的 resolve() 自带默认值并通过 unwrap 兼容两种形态），只是设置页拿不到
 * schema 表单。故这里导出一个同形的兜底 Config。
 */

/** 抓 URL 的默认正则：命名组 url，非空白连续串。 */
export const DEFAULT_URL_REGEX = String.raw`(?<url>https?://\S+)`

/** 字段默认值。真 schema 与兜底 Config 共用这一份，避免两处漂移。 */
export const DEFAULTS = Object.freeze({
  argv: Object.freeze([]),
  cwd: '',
  env: Object.freeze({}),
  urlExtractRegex: DEFAULT_URL_REGEX,
  successMarkerRegex: '',
  fixedUrl: '',
  probeFirst: true,
  autoStart: true,
  killOnDispose: true,
  showInSettings: true,
  showInSidebar: true,
  panelHeight: 'min(720px, 82vh)',
  openInNewTab: false,
})

/** 按默认值补齐一个对象（兜底 Config：不校验，只补缺）。 */
function withDefaults(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const out = {}
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const given = source[key]
    if (given !== undefined) out[key] = given
    else if (Array.isArray(value)) out[key] = []
    else if (value !== null && typeof value === 'object') out[key] = { ...value }
    else out[key] = value
  }
  return out
}

let z = null
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  try {
    z = (await import('schemastery')).default
  } catch {
    z = null
  }
}

export const Config = z === null || typeof z?.object !== 'function'
  ? withDefaults
  : z.object({
      /** 启动命令（argv 数组，不经 shell 插值）。空数组 = 不托管进程，只渲染 fixedUrl。 */
      argv: z.array(z.string()).default([]).volatile(),
      /** 子进程工作目录。空串 = 宿主进程当前目录。 */
      cwd: z.string().default('').volatile(),
      /** 额外环境变量（显式合并，可有意传值；宿主凭据仍会被清理）。 */
      env: z.dict(z.string()).default({}).volatile(),
      /** 抓 URL 的正则源码。建议保留命名组 (?<url>...)。 */
      urlExtractRegex: z.string().default(DEFAULT_URL_REGEX).volatile(),
      /** 成功标志正则源码；**空串 = 禁用**（空模式匹配任意行，会造成“第一行即就绪”）。 */
      successMarkerRegex: z.string().default('').volatile(),
      /** 抓不到 URL 时使用的固定地址，同时也是启动前的探活地址。 */
      fixedUrl: z.string().default('').volatile(),
      /** 启动前先探活：已在线则接管（不重复拉起、也不杀别人的进程）。 */
      probeFirst: z.boolean().default(true).volatile(),
      /** 插件加载时自动启动。 */
      autoStart: z.boolean().default(true).volatile(),
      /** 插件卸载时是否终止自己拉起的进程（false = 放生，服务继续在后台跑）。 */
      killOnDispose: z.boolean().default(true).volatile(),
      /** 设置页「常规」区是否显示本插件的行。 */
      showInSettings: z.boolean().default(true).volatile(),
      /** 侧栏是否显示本插件的面板行。 */
      showInSidebar: z.boolean().default(true).volatile(),
      /** iframe 高度。 */
      panelHeight: z.string().default('min(720px, 82vh)').volatile(),
      /** 在新标签页打开（而不是 iframe 内嵌）—— 目标页有 X-Frame-Options / CSP 时的退路。 */
      openInNewTab: z.boolean().default(false).volatile(),
    })

/** 真 schema 是否可用（供日志/自检使用）。 */
export const HAS_SCHEMA = z !== null
