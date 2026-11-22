/**
 * /lapp/api 路由表：POST + JSON 的小 RPC。
 *
 * 单条 `kind:'prefix'` 路由（与 dsh-usage-statistics-panel 的 /usage/api 同形）。
 * 注意：因为注册的是前缀，匹配必须用**去掉 query 后的完整路径**精确比较 —— 用裸
 * endsWith 会连更深的路径一起吞掉，带上 query 又会把合法请求比成 404。
 */
import { admitRoute, readJsonBody, replyJson } from './http-guard.js'

/** 本插件的路由前缀。 */
export const ROUTE_PREFIX = '/lapp/api'

/**
 * 构造路由。
 * @param {any} ctx Host context
 * @param {import('./supervisor.js').Supervisor} supervisor
 * @param {() => object} config 实时读取配置（volatile 字段可免重载变化）
 * @returns {{kind: 'prefix', path: string, handler: (req: any, res: any) => Promise<void>}}
 */
export function buildAppRoute(ctx, supervisor, config) {
  const handler = async (req, res) => {
    if (!admitRoute(ctx, req, res, ['POST'])) return

    const path = (req.url ?? '').split(/[?#]/, 1)[0]
    try {
      let body = undefined
      try {
        body = await readJsonBody(req)
      } catch {
        replyJson(res, 400, { ok: false, error: 'invalid json body' })
        return
      }

      if (path === `${ROUTE_PREFIX}/status`) {
        replyJson(res, 200, { ok: true, value: { ...supervisor.status(), config: config() } })
        return
      }
      if (path === `${ROUTE_PREFIX}/start`) {
        const value = await supervisor.start()
        replyJson(res, 200, { ok: true, value })
        return
      }
      if (path === `${ROUTE_PREFIX}/stop`) {
        await supervisor.stop()
        replyJson(res, 200, { ok: true, value: supervisor.status() })
        return
      }
      if (path === `${ROUTE_PREFIX}/restart`) {
        const value = await supervisor.restart()
        replyJson(res, 200, { ok: true, value })
        return
      }
      if (path === `${ROUTE_PREFIX}/logs`) {
        const requested = Number(body?.tailBytes)
        const tailBytes = Number.isFinite(requested) && requested > 0
          ? Math.min(requested, 64 * 1024)
          : 8000
        replyJson(res, 200, { ok: true, value: { text: supervisor.logTail.slice(-tailBytes) } })
        return
      }
      replyJson(res, 404, { ok: false, error: `unknown endpoint ${path}` })
    } catch (err) {
      ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
      replyJson(res, 500, { ok: false, error: 'internal error' })
    }
  }

  return { kind: 'prefix', path: ROUTE_PREFIX, handler }
}
