/**
 * bot-assistant 跨行服务类型模块（**只 import type**，无运行时代码）。
 *
 * 事实来源：docs/bot-integration-design.md（确认版，2026-11-26）§二/§四；lead 契约修正
 * （m00208/m00212）：助理类型单独文件（不并入 bot-channel-service.ts），交付物 =
 * 「单向投递工具 + 实际送达」一个功能两面，结果不回传。
 *
 * bot-assistant 行 provide 本服务；bot-notify 等下游行只 import type 消费。
 * arch.test R1（行间零互 import）不禁止类型模块。
 */

/**
 * bot-assistant 行 provide 的服务：助理会话的投递与检索。
 *
 * - deliver：向另一个 DSH 会话单向发一条用户消息（agent.steer/followup 同款 API），
 *   送达即返回，不等待对方回复、不回传结果。不做状态机、不做故障降级——
 *   目标会话不存在或投递失败时记日志（调用方/实现内部 warn）。
 * - search：会话检索，实现细节由该行自定（QQ 记录 + DSH 会话），
 *   供模型推断投递目标。
 */
export interface AsOneBotAssistantService {
  /** 单向投递：向另一个 DSH 会话发一条用户消息，结果不回传。 */
  deliver(sessionId: string, text: string): Promise<void> | void;
  /** 会话检索：QQ 记录 + DSH 会话（实现细节由该行自定）。 */
  search(query: string): unknown[] | Promise<unknown[]>;
}
