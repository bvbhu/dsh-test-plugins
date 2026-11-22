/**
 * URL 抓取：把「服务什么时候吐出可访问的地址」这件事收敛成一处。
 *
 * 三段式，顺序不可换 —— 每一段都是从 dsh-desktop-webview（WPF 外壳）移植过来
 * 并被它的单元测试钉住的行为，不是这里发明的：
 *
 *   ① stripAnsi(line)   必须在匹配之前剥掉终端控制序列。工具会给关键行上色，
 *      结尾的复位序列会被 URL 正则的 `\S+` 一起吞进捕获组，拿去导航就是个 404。
 *   ② tryExtract(line)  按正则逐行匹配，取命名组 `url`。没取名就退 group(1)，
 *      再没有就退整个 match。
 *   ③ isSuccessMarker    可选的第二级：有些服务不打印 URL，只打印 "ready" 一类
 *      标志行，此时回退到配置里的 fixedUrl。
 *
 * 另外一个必须照搬的坑：**空串的“成功标志正则”必须当成“禁用”**。空模式匹配任意
 * 字符串，IsMatch 恒为 true —— 于是启动命令吐出的第一行就会被当成“服务已就绪”。
 * 所以这里 `successMarkerRegex` 为空串时返回 null，而不是交给 RegExp。
 */

/** 按最长匹配优先：CSI（颜色/光标）、OSC（终端超链接）、两字节 ESC + 0x40-0x5F。 */
const CONTROL_SEQUENCES = /\x1B(?:\[[0-?]*[\x20-\x2F]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[\x40-\x5F])/g

/**
 * 去掉一行里的终端控制序列；不做其他任何改写。
 * @param {string} text 原始行
 * @returns {string} 剥掉控制序列后的行
 */
export function stripAnsi(text) {
  if (!text) return ''
  let stripped = text.replace(CONTROL_SEQUENCES, '')
  // 收尾：正则没覆盖到的孤立 ESC / BEL 也一并去掉，别让它们继续污染 URL。
  if (stripped.includes('\x1B') || stripped.includes('\u0007')) {
    stripped = stripped.split('\x1B').join('').split('\u0007').join('')
  }
  return stripped
}

/**
 * 编译一个用户正则。编译失败返回 null（调用方按“该级禁用”处理），
 * 绝不把坏正则变成每次匹配都抛异常的热路径。
 * @param {string} source 正则源码
 * @returns {RegExp | null}
 */
function compile(source) {
  if (typeof source !== 'string' || source.trim() === '') return null
  try {
    return new RegExp(source)
  } catch {
    return null
  }
}

/** 一行一行地抓取 URL。 */
export class UrlExtractor {
  /**
   * @param {string} urlRegex 抓取 URL 的正则源码（建议含命名组 (?<url>...)）
   * @param {string} successRegex 成功标志正则源码；空串 = 禁用
   */
  constructor(urlRegex, successRegex) {
    this.url = compile(urlRegex)
    this.marker = compile(successRegex)
  }

  /**
   * 从一行里抓 URL。
   * @param {string} rawLine 未经处理的一行输出
   * @returns {string | null} 抓到的 URL，或 null
   */
  tryExtract(rawLine) {
    const line = stripAnsi(rawLine)
    if (line === '' || this.url === null) return null
    const match = this.url.exec(line)
    if (match === null) return null
    const named = match.groups && match.groups.url
    if (typeof named === 'string' && named !== '') return named
    if (match.length > 1 && typeof match[1] === 'string' && match[1] !== '') return match[1]
    return match[0]
  }

  /**
   * 该行是否命中成功标志。
   * @param {string} rawLine 未经处理的一行输出
   * @returns {boolean}
   */
  isSuccessMarker(rawLine) {
    const line = stripAnsi(rawLine)
    if (line === '' || this.marker === null) return false
    return this.marker.test(line)
  }
}

/**
 * 补全 scheme。设置里手输的 URL 常常没有 scheme（形如 `127.0.0.1:4000/?key=x`），
 * 这种值直接交给 iframe 不会导航。只补 scheme，绝不改写 host / 端口 / 路径 / query
 * —— key 就在 query 里。
 * @param {string} value 用户输入
 * @returns {string | null} 补全后的 URL；空输入返回 null
 */
export function ensureScheme(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  // 已是别的 scheme（如 file:）不加 http://，否则会改错用户原意；交由后续导航拒绝。
  if (hasAnyScheme(trimmed)) return trimmed
  return 'http://' + trimmed
}

/**
 * 形如 `scheme:` 且 scheme 合法（字母开头，后跟字母/数字/+/-/.）。
 * 难点是区分 scheme 与 host:port，故先单独认一遍 localhost。
 * @param {string} value
 * @returns {boolean}
 */
function hasAnyScheme(value) {
  const colon = value.indexOf(':')
  if (colon <= 0) return false
  const scheme = value.slice(0, colon)
  // localhost 是最常见的手输主机名，却碰巧长得跟 scheme 一样。
  if (scheme.toLowerCase() === 'localhost') return false
  if (!/[A-Za-z]/.test(scheme[0])) return false
  return /^[A-Za-z][A-Za-z0-9+\-.]*$/.test(scheme)
}

/**
 * 只接受 http/https：iframe 里渲染任意 scheme 是没意义的，
 * 而 `javascript:` 之类混进 src 就是把插件变成 XSS 放大器。
 * @param {string} value
 * @returns {boolean}
 */
export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}
