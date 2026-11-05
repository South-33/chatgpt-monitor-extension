const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
const start = source.indexOf("function formatCountdown(milliseconds)");
const end = source.indexOf("function showNotice", start);
assert.ok(start >= 0 && end > start, "progress renderer not found");

let now = 1_000_000;
const attributes = new Map();
const sandbox = {
  Date: { now: () => now },
  progress: {
    setAttribute(name, value) { attributes.set(name, value); },
    style: { setProperty(name, value) { attributes.set(name, value); } },
  },
  workedText: {},
  formatMinutes: seconds => `${Math.floor(seconds / 60)}m`,
};
vm.runInNewContext(source.slice(start, end), sandbox);

const result = { extendedThinkingStartedAt: null, extendedThinkingLimitMs: 600_000, isGenerating: true };
assert.equal(sandbox.thinkingCountdown(result, true, false), "");
sandbox.renderHandoffProgress(75, 150);
assert.equal(sandbox.progress.value, 75);
assert.equal(attributes.get("--handoff-fill"), "50%");

result.extendedThinkingStartedAt = now - 60_000;
assert.equal(sandbox.thinkingCountdown(result, true, false), "Check-in in 9:00");

now = result.extendedThinkingStartedAt + result.extendedThinkingLimitMs;
assert.equal(sandbox.thinkingCountdown(result, true, false), "Stopping, then asking for an update");

assert.equal(sandbox.thinkingCountdown(result, true, true), "");
result.isGenerating = false;
assert.equal(sandbox.thinkingCountdown(result, true, false), "");

console.log("thinking_timer_ui_ok");

const controls = Object.fromEntries([
  "workedText", "taskStatus", "statusDetail", "retryButton", "monitorButton",
  "pauseButton", "swapButton", "logFolderStatus", "chooseLogFolderButton",
].map(name => [name, {}]));
const statusSandbox = {
  ...controls, threshold: { value: 400 }, activeTab: { url: "https://chatgpt.com/c/test" },
  cycleStage: { setAttribute() {} },
  sendNowButtons: [{}, {}], sendingCyclePrompt: false,
  progress: {}, handoffEdit: null,
  renderHandoffProgress() {}, thinkingCountdown: () => "", PHASE_LABELS: {},
  isConversationUrl: () => true, logFolderName: "logs",
};
vm.runInNewContext(source.slice(source.indexOf("function renderStatus"), source.indexOf("function isChatUrl")), statusSandbox);
const blocked = { enabled: true, isCurrentTab: true, status: "blocked" };
statusSandbox.renderStatus(blocked);
assert.equal(controls.pauseButton.disabled, false, "blocked monitoring must still be pausable");
statusSandbox.renderStatus({ ...blocked, paused: true });
assert.equal(controls.pauseButton.textContent, "Resume");
assert.equal(controls.pauseButton.disabled, false, "blocked monitoring must also be resumable");
statusSandbox.renderStatus({ ...blocked, isCurrentTab: false });
assert.equal(controls.pauseButton.disabled, true, "do not pause another tab's monitoring");
assert.equal(statusSandbox.cycleStage.hidden, true);
assert.ok(statusSandbox.sendNowButtons.every(button => !button.disabled), "arrows work with monitoring off");
statusSandbox.sendingCyclePrompt = true;
statusSandbox.renderStatus(blocked);
assert.ok(statusSandbox.sendNowButtons.every(button => button.disabled), "both arrows wait for the in-flight send");
statusSandbox.sendingCyclePrompt = false;
statusSandbox.renderStatus({ ...blocked, cycleStage: { step: 4, total: 4, label: "Housekeeping" } });
assert.equal(statusSandbox.cycleStage.textContent, "4/4");
assert.match(statusSandbox.cycleStage.title, /Housekeeping/);
