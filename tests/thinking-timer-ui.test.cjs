const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
const start = source.indexOf("function formatCountdown(milliseconds)");
const end = source.indexOf("function showNotice", start);
assert.ok(start >= 0 && end > start, "progress renderer not found");

let now = 1_000_000;
const classes = new Set();
const attributes = new Map();
const sandbox = {
  Date: { now: () => now },
  progress: {
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
    setAttribute(name, value) { attributes.set(name, value); },
  },
  progressFill: { style: { width: "" } },
};
vm.runInNewContext(`${source.slice(start, end)}; this.renderProgress = renderProgress;`, sandbox);

const result = { extendedThinkingStartedAt: null, extendedThinkingLimitMs: 600_000, isGenerating: true };
let detail = sandbox.renderProgress(result, true, false, 4500, 9000);
assert.equal(detail, "");
assert.equal(sandbox.progressFill.style.width, "50%");
assert.equal(attributes.get("aria-label"), "Handoff progress");

result.extendedThinkingStartedAt = now - 60_000;
detail = sandbox.renderProgress(result, true, false, 4500, 9000);
assert.equal(detail, "Check-in in 9:00");
assert.equal(sandbox.progressFill.style.width, "10%");
assert.ok(classes.has("thinking"));
assert.equal(attributes.get("aria-label"), "Thinking recovery progress");

now = result.extendedThinkingStartedAt + result.extendedThinkingLimitMs;
detail = sandbox.renderProgress(result, true, false, 4500, 9000);
assert.equal(detail, "Stopping, then asking for an update");
assert.equal(sandbox.progressFill.style.width, "100%");

detail = sandbox.renderProgress(result, true, true, 4500, 9000);
assert.equal(detail, "");
assert.ok(!classes.has("thinking"));
result.isGenerating = false;
detail = sandbox.renderProgress(result, true, false, 4500, 9000);
assert.equal(detail, "");
assert.equal(sandbox.progressFill.style.width, "50%");

console.log("thinking_timer_ui_ok");

const controls = Object.fromEntries([
  "workedText", "taskStatus", "statusDetail", "retryButton", "monitorButton",
  "pauseButton", "swapButton", "logFolderStatus", "chooseLogFolderButton",
].map(name => [name, {}]));
const statusSandbox = {
  ...controls, threshold: { value: 400 }, activeTab: { url: "https://chatgpt.com/c/test" },
  cycleStage: { setAttribute() {} },
  sendNowButtons: [],
  formatMinutes: () => "0m", renderProgress: () => "", PHASE_LABELS: {},
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
statusSandbox.renderStatus({ ...blocked, cycleStage: { step: 4, total: 4, label: "Housekeeping" } });
assert.equal(statusSandbox.cycleStage.textContent, "4/4");
assert.match(statusSandbox.cycleStage.title, /Housekeeping/);
