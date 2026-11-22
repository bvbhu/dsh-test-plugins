/**
 * 子进程环境：参照官方 dsh-subprocess 的 scrubbedParentEnv（口径与
 * dsh-vscode-mode/src/childEnv.ts 一致）。
 *
 * 为什么要清理：本 profile 的 webserver 绑在 0.0.0.0:19387（remote-web-ui 的
 * LAN bind），而这里要把环境交给一个用户配置的第三方进程。把宿主进程里的
 * KEY/TOKEN/SECRET 和 DSH_* 身份变量原样传出去，等于把凭据扩散到任意进程。
 */

const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * 清理父进程隐式凭据及 DSH 身份，再合并用户显式配置。
 * 用户**显式**配置的环境变量最后合并 —— 他有意传的凭据要能覆盖。
 * @param {Record<string, string | undefined>} explicit 用户显式配置
 * @param {NodeJS.ProcessEnv} parent 父环境，默认当前进程
 * @returns {NodeJS.ProcessEnv} 新环境对象，不修改任何输入
 */
export function childEnv(explicit = {}, parent = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV.test(key)) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    env[key] = value
  }
  return { ...env, ...explicit }
}
