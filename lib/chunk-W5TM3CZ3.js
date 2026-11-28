// src/bot-channel-service.ts
function botTierSettingKey(scope, id) {
  return `bot.tier.${scope}.${id}`;
}
function parseBotTier(value) {
  return value === "assistant" ? "assistant" : "chat";
}
var GLOBAL_WAKEUP_SETTING_KEY = "bot.wakeup.enabled";
function botWakeupEnabledSettingKey(scope, id) {
  return `bot.wakeup.enabled.${scope}.${id}`;
}
var SEED_DISABLED_WAKEUPS = {
  private: [],
  group: ["180568043"]
};
function parseEnabledFlag(value, fallback = true) {
  if (value === null || value === void 0 || String(value).trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}
function isWakeupEnabledFor(scope, id, read) {
  if (!parseEnabledFlag(read(GLOBAL_WAKEUP_SETTING_KEY))) return false;
  const explicit = read(botWakeupEnabledSettingKey(scope, id));
  if (explicit !== null && explicit !== void 0 && String(explicit).trim() !== "") {
    return parseEnabledFlag(explicit);
  }
  return !SEED_DISABLED_WAKEUPS[scope].includes(id);
}
function handoffOnce(agent, message) {
  const a = agent;
  if (!a || typeof a !== "object") return;
  if (typeof a.steer === "function") {
    a.steer(message);
    return;
  }
  if (typeof a.followup === "function") {
    a.followup(message);
  }
}

export {
  botTierSettingKey,
  parseBotTier,
  GLOBAL_WAKEUP_SETTING_KEY,
  botWakeupEnabledSettingKey,
  SEED_DISABLED_WAKEUPS,
  parseEnabledFlag,
  isWakeupEnabledFor,
  handoffOnce
};
//# sourceMappingURL=chunk-W5TM3CZ3.js.map
