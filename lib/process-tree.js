/**
 * 进程树终止。Windows 在父进程仍存活时直接 taskkill /T，避免先杀父丢失后代；
 * POSIX 子进程以 detached 启动成为独立进程组，故按组发信号。
 * 与 dsh-vscode-mode/src/processTree.ts 同款。
 */
import { spawn, spawnSync } from 'node:child_process'
import { childEnv } from './child-env.js'

/**
 * 按平台回收进程树。
 * @param {import('node:child_process').ChildProcess} child 进程树根
 * @param {(line: string) => void} [logger] 可选错误记录器
 * @param {boolean} [sync] 宿主 exit 事件中必须同步完成
 * @param {NodeJS.Platform} [platform]
 */
export function killTree(child, logger, sync = false, platform = process.platform) {
  if (!child.pid) return
  try {
    if (platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL')
      return
    }
    const args = ['/PID', String(child.pid), '/T', '/F']
    const options = { windowsHide: true, stdio: /** @type {const} */ ('ignore'), env: childEnv() }
    if (sync) {
      const result = spawnSync('taskkill', args, { ...options, timeout: 5000 })
      if (result.error) logger?.('taskkill error: ' + String(result.error))
      return
    }
    const killer = spawn('taskkill', args, options)
    killer.once('error', (error) => logger?.('taskkill error: ' + String(error)))
    killer.unref()
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') {
      logger?.('kill tree error: ' + String(error))
    }
  }
}
