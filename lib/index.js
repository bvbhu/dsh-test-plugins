/**
 * dsh-local-app —— Host 半。
 *
 * 职责只有三件：
 *   1. 按配置拉起一个本地进程（或接管已经在跑的那个）；
 *   2. 用正则逐行抓它 stdout/stderr 里吐出的 URL（通常带 key/token），
 *      再等这个 URL 真的能应答；
 *   3. 通过一条认证过的 `/lapp/api` 路由把「状态 + URL」交给浏览器半去渲染。
 *
 * 除此之外不做任何事：不注册工具、不监听会话事件、不写存储。
 *
 * 为什么 URL 是靠“抓输出”而不是“拼配置”：本地服务的地址经常不是静态的 —— 端口
 * 由 OS 分配、路径带一次性 token（dsh-desktop-webview 处理的就是这一类）。把 URL
 * 写进配置等于让用户每次重启都改一遍；而 **key 天然在 URL 里**，抓行的过程同时就
 * 把凭据带出来了，不需要额外的凭据通道，也不需要落盘。
 */
import { Config, DEFAULT_URL_REGEX } from './schema.js'
import { Supervisor } from './supervisor.js'
import { buildAppRoute } from './routes.js'
import { bool, str, strArray, strDict } from './config-read.js'

export const name = 'dsh-local-app'

/** 所需服务：webserver 挂路由，connection 做认证闸。 */
export const inject = ['webServer', 'connection']

export { Config }

/**
 * 把（可能带 volatile 引用的）配置解成普通值，并套用默认值。
 * @param {Record<string, unknown> | undefined} raw
 * @returns {Record<string, unknown>}
 */
function resolve(raw) {
  const input = raw ?? {}
  return {
    argv: strArray(input, 'argv'),
    cwd: str(input, 'cwd', ''),
    env: strDict(input, 'env'),
    urlExtractRegex: str(input, 'urlExtractRegex', DEFAULT_URL_REGEX),
    successMarkerRegex: str(input, 'successMarkerRegex', ''),
    fixedUrl: str(input, 'fixedUrl', ''),
    probeFirst: bool(input, 'probeFirst', true),
    autoStart: bool(input, 'autoStart', true),
    killOnDispose: bool(input, 'killOnDispose', true),
    showInSettings: bool(input, 'showInSettings', true),
    showInSidebar: bool(input, 'showInSidebar', true),
    panelHeight: str(input, 'panelHeight', 'min(720px, 82vh)'),
    openInNewTab: bool(input, 'openInNewTab', false),
  }
}

/**
 * 插件加载：挂路由 +（可选）自动拉起进程。
 * @param {any} ctx Host context
 * @param {Record<string, unknown>} [rawConfig] loader 按 Config schema 校验后的配置
 */
export function apply(ctx, rawConfig) {
  const current = resolve(rawConfig)

  const supervisor = new Supervisor({
    argv: current.argv,
    cwd: current.cwd,
    env: current.env,
    urlExtractRegex: current.urlExtractRegex,
    successMarkerRegex: current.successMarkerRegex,
    fixedUrl: current.fixedUrl,
    probeFirst: current.probeFirst,
  })

  // 只下发浏览器真正需要知道的字段。注意不含 argv / env —— 它们是宿主事实，
  // 浏览器既不需要也不该看到（URL 里可能带 key，但那是要渲染的目标本身）。
  const clientConfig = () => ({
    panelHeight: current.panelHeight,
    openInNewTab: current.openInNewTab,
    autoStart: current.autoStart,
    probeFirst: current.probeFirst,
  })

  ctx.effect(() => {
    const route = buildAppRoute(ctx, supervisor, clientConfig)
    try {
      return ctx.webServer.register(route)
    } catch (err) {
      // 路由重名只警告，不炸启动树。
      ctx.logger?.warn?.(`dsh-local-app: 路由注册失败 ${String(err)}`)
      return undefined
    }
  }, 'dsh-local-app: routes')

  ctx.effect(() => {
    if (current.autoStart) void supervisor.start()
    return () => {
      if (current.killOnDispose) void supervisor.dispose()
    }
  }, 'dsh-local-app: supervisor')
}
