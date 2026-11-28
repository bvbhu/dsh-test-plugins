/**
 * 提示音轮询器(client 半)—— dsh-chime 功能的合并形态。
 *
 * host 半在 bot-notify 行:通知发出时把音效入队,webServer 路由
 * `/as-one/chime/poll` 供取走(15s 内新鲜,超过即弃)。本模块每 250ms
 * 轮询一次,取到就播 —— 与 dsh-chime client.js 同机制(HTMLAudio
 * 直接播 base64 data URL,零依赖)。
 *
 * 为什么走轮询而不是宿主事件直推:client 半只拿得到 slots/locale 这类
 * 浏览器侧服务,没有 host emit 的订阅口;轮询是 dsh-chime 验证过的
 * 最小通路(250ms 延迟对提示音无感)。
 */

import { CHIME_SOUNDS } from "./chime-sounds.js";

/** 轮询间隔(与 dsh-chime 一致)。 */
const POLL_INTERVAL_MS = 250;

/** 入队超过这个时长还没被取走就丢弃(宿主重启/页面没开时的兜底)。 */
const FRESH_WINDOW_MS = 15_000;

/** 播一段音效(资产缺失/浏览器不支持时静默)。 */
function play(name: string): void {
  const src = CHIME_SOUNDS[name];
  if (!src) return;
  try {
    if (typeof Audio === "undefined") return;
    const el = new Audio();
    el.src = src;
    el.volume = 1;
    void el.play().catch(() => {
      /* 自动播放策略拦截等播放失败:静默,下次轮询继续 */
    });
  } catch {
    /* 播放失败不影响页面其它功能 */
  }
}

/**
 * 启动轮询;返回停止函数(client 半 ctx.effect 里挂生命周期)。
 * 页面隐藏时浏览器照常计时,后台标签页也能响 —— 与 dsh-chime 一致。
 */
export function startChimePoller(): () => void {
  const timer = setInterval(() => {
    void fetch("/as-one/chime/poll")
      .then((r) => r.json())
      .then((res: { sounds?: unknown }) => {
        if (res && Array.isArray(res.sounds)) {
          for (const s of res.sounds) play(String(s));
        }
      })
      .catch(() => {
        /* 路由未注册/网络抖动:静默重试 */
      });
  }, POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}
