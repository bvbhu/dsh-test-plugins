/**
 * Config 读取：把 volatile 引用还原成普通值。
 *
 * DSH 0.1.7+ 把标了 `.volatile()` 的字段交给一个引用对象（见宿主里的
 * createVolatile / isVolatile：一个冻结的 `{ get() }`），插件拿到的是引用本身，
 * **不是**里面的值 —— 直接当字符串用会得到 `[object Object]`。官方插件的读法
 * 就是 `this.config.reasoningEffort.get()`。
 *
 * 这里统一解一层，顺便对缺失/未解析的输入做兜底。
 */

/**
 * 若 value 是 volatile 引用则返回其内部值，否则原样返回。
 * @param {unknown} value
 * @returns {unknown}
 */
export function unwrap(value) {
  if (typeof value === 'object' && value !== null && typeof /** @type {any} */ (value).get === 'function') {
    try {
      return /** @type {any} */ (value).get()
    } catch {
      return undefined
    }
  }
  return value
}

/**
 * 读一个字符串字段。
 * @param {Record<string, unknown>} config
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
export function str(config, key, fallback) {
  const value = unwrap(config?.[key])
  return typeof value === 'string' ? value : fallback
}

/**
 * 读一个布尔字段。
 * @param {Record<string, unknown>} config
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function bool(config, key, fallback) {
  const value = unwrap(config?.[key])
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 读一个字符串数组字段（argv）。
 * @param {Record<string, unknown>} config
 * @param {string} key
 * @returns {string[]}
 */
export function strArray(config, key) {
  const value = unwrap(config?.[key])
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string')
}

/**
 * 读一个字符串字典字段（env）。
 * @param {Record<string, unknown>} config
 * @param {string} key
 * @returns {Record<string, string>}
 */
export function strDict(config, key) {
  const value = unwrap(config?.[key])
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out = {}
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const item = unwrap(v)
    if (typeof item === 'string') out[k] = item
  }
  return out
}
