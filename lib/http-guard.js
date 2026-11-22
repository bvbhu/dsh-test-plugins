/**
 * HTTP 准入闸 + 有界 JSON 读写。
 *
 * 为什么必须有闸：本 profile 的 webserver 绑在 0.0.0.0:19387（remote-web-ui 的 LAN
 * bind）。一个无鉴权的“启动/停止本地进程 + 返回带 token 的 URL”接口，在局域网里
 * 就是远程代码执行 + 凭据泄露的入口。故每个请求先过 connection 的认证：
 *   - 返回 401/403 → 照传（未认证 / 被 Host 拒绝）
 *   - 返回 503     → 认证服务不可用，**一律拒绝**（缺失的认证服务不等于放行）
 *   - 返回 undefined → 放行
 */

/** 请求体上限：这里只收发极小的 JSON，64 KiB 是给异常客户端设的上界。 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * 写 JSON 响应。带 no-store：进程状态和服务地址都是实时事实，不能缓存。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
export function replyJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/**
 * 先过认证闸，再检查方法。
 * @param {any} ctx Host context
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string[]} methods 允许的 HTTP 方法
 * @returns {boolean} 是否放行
 */
export function admitRoute(ctx, req, res, methods) {
  let rejection = 503
  try {
    const connection = ctx.get('connection')
    if (typeof connection?.requestRejection === 'function') {
      rejection = connection.requestRejection(req)
    }
  } catch {
    // 认证服务缺失或抛错，绝不等于放行。
  }
  if (rejection !== undefined && rejection !== null) {
    const status = rejection === 401 || rejection === 403 ? rejection : 503
    replyJson(res, status, {
      ok: false,
      error: status === 503 ? 'Host authentication service unavailable' : 'Host authentication rejected this request',
    })
    return false
  }
  if (!methods.includes(req.method ?? '')) {
    res.setHeader('allow', methods.join(', '))
    replyJson(res, 405, { ok: false, error: 'Method not allowed' })
    return false
  }
  return true
}

/**
 * 读取有界 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>} 解析后的值；空体返回 undefined
 */
export async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : /** @type {Uint8Array} */ (chunk)
    bytes += data.byteLength
    if (bytes > MAX_BODY_BYTES) {
      req.resume()
      throw new Error('request body exceeds the supported size')
    }
    chunks.push(data)
  }
  if (bytes === 0) return undefined
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
}
