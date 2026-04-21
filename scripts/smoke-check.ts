import { getBotConfig, getBotState, updateBotConfig } from "../ultra-bot";

const before = getBotConfig();
const updated = updateBotConfig({ pollIntervalSecs: before.pollIntervalSecs + 1 });
const state = getBotState();

if (updated.pollIntervalSecs !== before.pollIntervalSecs + 1) {
  throw new Error("Config update smoke check failed.");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      updatedPollInterval: updated.pollIntervalSecs,
      running: state.running,
      openPositionCount: state.openPositionCount,
    },
    null,
    2,
  ),
);
