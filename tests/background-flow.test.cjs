const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

const local = {};
const session = {};
local.settings = {
  enabled: false,
  continuePrompt: "A saved user prompt.",
};
const sentToContent = [];
const powerCalls = [];
const validHandoffA = "Handoff for task A. The goal is to preserve the current implementation and finish the remaining verified validation work. The repository state, important constraints, measured results, unresolved questions, and concrete files are recorded here so the next agent can continue without repeating prior investigation or losing user decisions.";
const validHandoffB = "Handoff for task B. The goal is different and this payload contains its independent progress, constraints, evidence, unresolved work, and relevant references. The next agent should verify the current state, preserve the established decisions, and continue from this checkpoint without confusing it with any other monitored browser tab.";
const runtime = { onInstalled: event(), onStartup: event(), onMessage: event() };
const chrome = {
  runtime,
  storage: {
    local: {
      async get(key) { return { [key]: local[key] }; },
      async set(value) { Object.assign(local, value); },
    },
    session: {
      async get(key) { return { [key]: session[key] }; },
      async set(value) { Object.assign(session, value); },
    },
    onChanged: event(),
  },
  scripting: { async executeScript() {} },
  tabs: {
    async get(id) { return { id, url: "https://chatgpt.com/c/original" }; },
    async sendMessage(tabId, message) {
      sentToContent.push({ tabId, message });
      return { ok: true };
    },
    onRemoved: event(),
  },
  alarms: { create() {}, onAlarm: event() },
  power: {
    requestKeepAwake(level) { powerCalls.push(["request", level]); },
    releaseKeepAwake() { powerCalls.push(["release"]); },
  },
};

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
vm.runInNewContext(source, { chrome, console, URL, Date, setTimeout, clearTimeout });

function send(message, sender = {}) {
  return new Promise((resolve, reject) => {
    const listener = runtime.onMessage.listeners[0];
    if (!listener) return reject(new Error("message listener missing"));
    const timeout = setTimeout(() => reject(new Error(`message timed out: ${message.type}`)), 1000);
    listener(message, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

(async () => {
  const migratedSettings = await send({ type: "getSettings" });
  assert.equal(migratedSettings.settings.continuePrompt, "A saved user prompt.",
    "startup preserves saved continue text without a wording-based migration");

  assert.equal(migratedSettings.settings.continuePresets[1], "continue");
  assert.equal(migratedSettings.settings.continuePresets.length, 4);
  await send({ type: "saveContinuePreset", index: 1 });
  assert.equal((await send({ type: "getSettings" })).settings.continuePrompt, "continue");
  await send({ type: "saveContinuePreset", index: 0, text: "A custom saved continue prompt." });
  assert.equal((await send({ type: "getSettings" })).settings.continuePresets[0], "A custom saved continue prompt.");
  await send({ type: "saveSettings", settings: { thresholdMinutes: 130, thinkingMinutes: 2 } });

  const tab = { tab: { id: 7, url: "https://chatgpt.com/c/original" } };
  await send({ type: "setMonitoring", enabled: true, tabId: 7, url: tab.tab.url });
  const ownership = await send({ type: "isTargetTab" }, tab);
  assert.equal(ownership.target, true);
  assert.equal(ownership.scanHistory, true);
  assert.equal(ownership.thinkingMinutes, 2);
  assert.equal(ownership.preferredModel, 'GPT-5.6 Sol');
  assert.equal(ownership.preferredReasoning, 'high');
  assert.equal(ownership.enforceModelPreferences, true, 'existing settings keep their previous behavior');
  await send({ type: 'saveSettings', settings: { enforceModelPreferences: false } });
  assert.equal((await send({ type: 'isTargetTab' }, tab)).enforceModelPreferences, false,
    'checkbox off is persisted and returned to the monitor');
  assert.equal((await send({ type: 'getSettings' })).settings.preferredModel, 'GPT-5.6 Sol',
    'disabling automation must retain the chosen model for future use');
  await send({ type: 'saveSettings', settings: { enforceModelPreferences: true } });
  await send({ type: 'saveSettings', settings: { preferredModel: ' GPT-6 ', preferredReasoning: 'medium' } });
  const modelSettings = (await send({ type: 'getSettings' })).settings;
  assert.equal(modelSettings.preferredModel, 'GPT-6');
  assert.equal(modelSettings.thinkingMinutes, 2, 'editing the model must preserve timers');
  assert.equal(modelSettings.thresholdMinutes, 130);
  await send({ type: 'saveSettings', settings: { preferredModel: '', preferredReasoning: '' } });
  assert.equal((await send({ type: 'isTargetTab' }, tab)).preferredModel, '', 'keep current is explicit');
  await send({ type: 'saveSettings', settings: { preferredModel: 'GPT-5.6 Sol', preferredReasoning: 'high' } });
  assert.equal((await send({ type: "getMonitorStatus", tabId: 7, url: tab.tab.url })).extendedThinkingLimitMs, 120000);
  await send({ type: "saveSettings", settings: { thresholdMinutes: 130, thinkingMinutes: 10 } });
  assert.ok(powerCalls.some(([action, level]) => action === "request" && level === "system"));

  await send({ type: "historyScanComplete", url: tab.tab.url, workedSeconds: 7800 }, tab);
  await send({ type: "status", url: tab.tab.url, isGenerating: true, workedSeconds: 7800 }, tab);
  const thresholdStatus = await send({ type: "getMonitorStatus", tabId: 7, url: tab.tab.url });
  assert.equal(thresholdStatus.phase, "threshold-waiting");

  let action = await send({
    type: "status",
    url: tab.tab.url,
    isGenerating: false,
    workedSeconds: 7800,
    responseKey: "response-1",
    latestResponseText: "Substantive work remains.",
  }, tab);
  assert.equal(action.action, "sendHandoff");
  assert.match(action.prompt, /concise handoff/i);

  await send({ type: "commandResult", action: "sendHandoff", ok: true, url: tab.tab.url }, tab);
  const decoratedUrl = `${tab.tab.url}?messageId=finalAgentTurnStart`;
  await send({ type: "status", url: decoratedUrl, isGenerating: true, workedSeconds: 7800 }, tab);
  action = await send({
    type: "status",
    url: decoratedUrl,
    isGenerating: false,
    workedSeconds: 7800,
    responseKey: "handoff-response",
    latestResponseText: validHandoffA,
    latestResponseIsSubstantive: true,
  }, tab);
  assert.equal(action.action, "rotateWithHandoff");
  assert.ok(local.runtime?.states?.[7], "runtime state should survive an extension worker restart");

  await send({
    type: "handoffCaptured",
    text: validHandoffA,
    url: tab.tab.url,
  }, tab);
  const freshTab = { tab: { id: 7, url: "https://chatgpt.com/" } };
  const pending = await send({ type: "getPendingHandoff" }, freshTab);
  assert.match(pending.prompt, /Another agent worked on this task/);
  assert.match(pending.prompt, /your own judgment/);
  assert.match(pending.prompt, /Handoff for task A/);
  assert.match(pending.prompt, /TASK_FINISHED/);

  await send({ type: "handoffDelivered", url: freshTab.tab.url }, freshTab);
  const continuedTab = { tab: { id: 7, url: "https://chatgpt.com/c/continued" } };
  await send({ type: "historyScanComplete", url: continuedTab.tab.url, workedSeconds: 0 }, continuedTab);
  await send({ type: "status", url: continuedTab.tab.url, isGenerating: true, workedSeconds: 0 }, continuedTab);
  await send({
    type: "status",
    url: continuedTab.tab.url,
    isGenerating: false,
    workedSeconds: 0,
    responseKey: "completed-response",
    latestResponseText: "The original goal is verified complete.\n\nTASK_FINISHED",
  }, continuedTab);

  const status = await send({ type: "getMonitorStatus", tabId: 7, url: continuedTab.tab.url });
  assert.equal(status.status, "finished");
  assert.equal(status.phase, "paused");
  assert.equal(status.paused, true);
  assert.equal(status.isCurrentTab, true);
  const finishedTime = local.runtime.states[7].trackedSeconds;
  await send({ type: "setPaused", tabId: 7, paused: false });
  const resumedFinished = await send({ type: "status", url: continuedTab.tab.url,
    isGenerating: false, composerEmpty: true, responseKey: "completed-response",
    latestResponseText: "The original goal is verified complete.\n\nTASK_FINISHED" }, continuedTab);
  assert.equal(resumedFinished.action, "sendContinue", "Resume must work for a finished task too");
  assert.equal(local.runtime.states[7].trackedSeconds, finishedTime);

  await send({ type: "setMonitoring", enabled: true, tabId: 8, url: "https://chatgpt.com/c/manual" });
  const manualResult = await send({ type: "manualSwap", tabId: 8 });
  assert.equal(manualResult.ok, true);
  assert.equal(sentToContent.at(-1).tabId, 8);
  assert.equal(sentToContent.at(-1).message.type, "manualSwap");
  assert.match(sentToContent.at(-1).message.prompt, /concise handoff/i);

  await send({ type: "setMonitoring", enabled: true, tabId: 9, url: "https://chatgpt.com/c/blocked" });
  const blockedTab = { tab: { id: 9, url: "https://chatgpt.com/c/blocked" } };
  await send({ type: "historyScanComplete", url: blockedTab.tab.url, workedSeconds: 30 }, blockedTab);
  let blockedAction = await send({
    type: "status",
    url: blockedTab.tab.url,
    isGenerating: false,
    workedSeconds: 30,
    responseKey: "blocked-response",
    latestResponseText: "No safe work remains because user input is required.\n\nTASK_BLOCKED",
  }, blockedTab);
  assert.equal(blockedAction.action, "sendBlockedReview", "the first block triggers exactly one reconsideration");
  assert.match(blockedAction.prompt, /ORIGINAL user's goal/);
  assert.match(blockedAction.prompt, /Do not invent a new goal/);
  assert.equal(local.runtime.states[9].blockedReviewAttempted, true);
  assert.equal(local.runtime.states[9].paused, false);
  const repeatedBlock = await send({ type: "status", url: blockedTab.tab.url,
    isGenerating: false, responseKey: "blocked-response",
    latestResponseText: "No safe work remains.\nTASK_BLOCKED",
  }, blockedTab);
  assert.equal(repeatedBlock.action, undefined, "the same blocked response cannot send a second review");
  await send({ type: "commandResult", action: "sendBlockedReview", ok: true,
    url: blockedTab.tab.url }, blockedTab);
  const unrelatedOldResponse = await send({ type: "status", url: blockedTab.tab.url,
    isGenerating: false, responseKey: "older-response", latestResponseText: "Unrelated reply.",
    latestUserText: "Old user message", composerEmpty: true,
  }, blockedTab);
  assert.equal(unrelatedOldResponse.action, undefined, "an old response cannot satisfy reconsideration");
  const secondBlock = await send({ type: "status", url: blockedTab.tab.url,
    isGenerating: false, responseKey: "review-blocked-response",
    latestResponseText: "The missing user approval is still required.\nTASK_BLOCKED",
    latestUserText: blockedAction.prompt, composerEmpty: true,
  }, blockedTab);
  assert.equal(secondBlock.action, undefined, "a confirmed second block stops without another prompt");
  const blockedTime = local.runtime.states[9].maxWorkedSeconds;
  await send({ type: "status", url: blockedTab.tab.url, isGenerating: true, workedSeconds: 90 }, blockedTab);
  assert.equal(local.runtime.states[9].paused, true, "manual work cannot resume paused automation");
  const manuallyEnded = await send({ type: "status", url: blockedTab.tab.url,
    isGenerating: false, responseKey: "manual-response", latestResponseText: "Manual work is done.",
    recoveryKey: "manually-cancelled" }, blockedTab);
  assert.equal(manuallyEnded.action, undefined, "manual completion or cancellation stays paused");
  const blockedStatus = await send({ type: "getMonitorStatus", tabId: 9, url: blockedTab.tab.url });
  assert.equal(blockedStatus.status, "blocked");
  assert.equal(blockedStatus.phase, "paused");

  assert.equal(blockedStatus.paused, true);
  assert.equal(blockedStatus.isCurrentTab, true, "terminal tasks remain monitored");
  await send({ type: "setPaused", tabId: 9, paused: false });
  assert.equal(local.runtime.states[9].maxWorkedSeconds, blockedTime, "Resume retains the tracked clock");
  const resumeWhileGenerating = await send({ type: "status", url: blockedTab.tab.url,
    isGenerating: true, responseKey: "manual-response" }, blockedTab);
  assert.equal(resumeWhileGenerating.action, undefined, "Resume waits for generation to end");
  const resumeWithDraft = await send({ type: "status", url: blockedTab.tab.url,
    isGenerating: false, composerEmpty: false, responseKey: "manual-response" }, blockedTab);
  assert.equal(resumeWithDraft.action, undefined, "Resume preserves a manual draft");
  const resumed = await send({ type: "status", url: blockedTab.tab.url,
    isGenerating: false, composerEmpty: true, responseKey: "manual-response",
    latestResponseText: "The manual turn ended.\nTASK_BLOCKED" }, blockedTab);
  assert.equal(resumed.action, "sendContinue", "Resume posts the selected continuation, ignoring the stale marker");
  assert.ok(resumed.prompt.includes(local.settings.continuePresets[local.settings.tabContinuePresets[9]?.index ?? 0]),
    "Resume uses this tab's selected preset");
  assert.match(resumed.prompt, /Completion contract/);
  const repeatedResume = await send({ type: "setPaused", tabId: 9, paused: false });
  assert.equal(repeatedResume.ok, true);
  const repeatedScan = await send({ type: "status", url: blockedTab.tab.url,
    isGenerating: false, composerEmpty: true, responseKey: "manual-response",
    latestResponseText: "The manual turn ended.\nTASK_BLOCKED" }, blockedTab);
  assert.equal(repeatedScan.action, undefined, "the resumed prompt is requested once");

  // A failed DevSpace selection is held for an explicit retry instead of
  // re-opening and clicking the plugin picker on every content scan.
  await send({ type: "setMonitoring", enabled: true, tabId: 20, url: "https://chatgpt.com/c/handoff-retry" });
  const retryHandoffTab = { tab: { id: 20, url: "https://chatgpt.com/c/handoff-retry" } };
  await send({ type: "historyScanComplete", url: retryHandoffTab.tab.url, workedSeconds: 7800 }, retryHandoffTab);
  const retryHandoffAction = await send({
    type: "status",
    url: retryHandoffTab.tab.url,
    isGenerating: false,
    workedSeconds: 7800,
    responseKey: "retry-handoff-trigger",
    latestResponseText: "The handoff threshold has been reached.",
  }, retryHandoffTab);
  assert.equal(retryHandoffAction.action, "sendHandoff");
  await send({ type: "commandResult", action: "sendHandoff", ok: true, url: retryHandoffTab.tab.url }, retryHandoffTab);
  const rotateRetryHandoff = await send({
    type: "status",
    url: retryHandoffTab.tab.url,
    isGenerating: false,
    workedSeconds: 7800,
    responseKey: "retry-handoff-response",
    latestResponseText: validHandoffA,
    latestResponseIsSubstantive: true,
  }, retryHandoffTab);
  assert.equal(rotateRetryHandoff.action, "rotateWithHandoff");
  await send({ type: "handoffCaptured", text: validHandoffA, url: retryHandoffTab.tab.url }, retryHandoffTab);
  const freshRetryTab = { tab: { id: 20, url: "https://chatgpt.com/" } };
  assert.ok((await send({ type: "getPendingHandoff" }, freshRetryTab)).prompt);
  await send({
    type: "commandResult",
    action: "enableDevSpace",
    ok: false,
    url: freshRetryTab.tab.url,
  }, freshRetryTab);
  assert.equal((await send({ type: "getPendingHandoff" }, freshRetryTab)).prompt, null);
  assert.equal((await send({ type: "getPendingHandoff" }, freshRetryTab)).prompt, null,
    "consecutive page scans must not retry a failed plugin selection");
  const failedDeliveryStatus = await send({
    type: "getMonitorStatus",
    tabId: 20,
    url: freshRetryTab.tab.url,
  });
  assert.match(failedDeliveryStatus.issue, /Could not enable DevSpace/);
  await send({ type: "retryNow", tabId: 20 }, freshRetryTab);
  assert.ok((await send({ type: "getPendingHandoff" }, freshRetryTab)).prompt,
    "Retry must re-enable the pending handoff attempt");
  await send({
    type: "commandResult",
    action: "deliverHandoff",
    ok: false,
    reason: "composer-insert-failed",
    url: freshRetryTab.tab.url,
  }, freshRetryTab);
  const failedInsertion = await send({ type: "getMonitorStatus", tabId: 20,
    url: freshRetryTab.tab.url });
  assert.match(failedInsertion.issue, /Could not insert the handoff/,
    "popup must explain what failed instead of showing only a generic handoff error");
  const handoffFailures = await send({ type: "getDiagnostics" });
  assert.ok(handoffFailures.events.some(entry => entry.event === "prompt-submission-failed"
    && entry.reason === "composer-insert-failed" && entry.tabId === 20),
    "logs must record the insertion stage without recording private prompt text");
  assert.equal((await send({ type: "getPendingHandoff" }, freshRetryTab)).prompt, null,
    "failed prompt delivery must also wait for Retry");
  await send({ type: "retryNow", tabId: 20 }, freshRetryTab);
  assert.ok((await send({ type: "getPendingHandoff" }, freshRetryTab)).prompt);

  // A terminal block gets one reconsideration even at the handoff threshold.
  await send({ type: "setMonitoring", enabled: true, tabId: 19, url: "https://chatgpt.com/c/blocked-at-threshold" });
  const blockedAtThresholdTab = { tab: { id: 19, url: "https://chatgpt.com/c/blocked-at-threshold" } };
  await send({ type: "historyScanComplete", url: blockedAtThresholdTab.tab.url, workedSeconds: 7800 }, blockedAtThresholdTab);
  const blockedAtThresholdAction = await send({
    type: "status",
    url: blockedAtThresholdTab.tab.url,
    isGenerating: false,
    workedSeconds: 7800,
    responseKey: "blocked-at-threshold-response",
    latestResponseText: "User action appears necessary.\n\nTASK_BLOCKED",
    consecutiveBlockedResponses: 1,
  }, blockedAtThresholdTab);
  assert.equal(blockedAtThresholdAction.action, "sendBlockedReview", "block review takes priority over handoff");
  assert.equal(local.runtime.states[19].paused, false);
  await send({ type: "commandResult", action: "sendBlockedReview", ok: true,
    url: blockedAtThresholdTab.tab.url }, blockedAtThresholdTab);
  const thresholdSecondBlock = await send({ type: "status", url: blockedAtThresholdTab.tab.url,
    isGenerating: false, responseKey: "blocked-at-threshold-review",
    latestResponseText: "User action is still required.\nTASK_BLOCKED",
    latestUserText: blockedAtThresholdAction.prompt, composerEmpty: true,
  }, blockedAtThresholdTab);
  assert.equal(thresholdSecondBlock.action, undefined);
  assert.equal(local.runtime.states[19].paused, true);

  // Historical blocked responses alone are not proof of a completed review.
  await send({ type: "setMonitoring", enabled: true, tabId: 15, url: "https://chatgpt.com/c/reloaded-blocked" });
  const reloadedBlockedTab = { tab: { id: 15, url: "https://chatgpt.com/c/reloaded-blocked" } };
  await send({ type: "historyScanComplete", url: reloadedBlockedTab.tab.url, workedSeconds: 60 }, reloadedBlockedTab);
  const reloadedBlockedAction = await send({
    type: "status",
    url: reloadedBlockedTab.tab.url,
    isGenerating: false,
    responseKey: "latest-blocked-response",
    latestResponseText: "Specific user action is required.\n\nTASK_BLOCKED",
    terminalStatus: "blocked",
    consecutiveBlockedResponses: 2,
  }, reloadedBlockedTab);
  assert.equal(reloadedBlockedAction.action, "sendBlockedReview");
  await send({ type: "commandResult", action: "sendBlockedReview", ok: true,
    url: reloadedBlockedTab.tab.url }, reloadedBlockedTab);
  const reloadedReview = await send({ type: "status", url: reloadedBlockedTab.tab.url,
    isGenerating: false, responseKey: "reloaded-review-response",
    latestResponseText: "Cannot proceed without the owner's credential.\nTASK_BLOCKED",
    latestUserText: reloadedBlockedAction.prompt, composerEmpty: true,
  }, reloadedBlockedTab);
  assert.equal(reloadedReview.action, undefined);
  const reloadedBlockedStatus = await send({ type: "getMonitorStatus", tabId: 15, url: reloadedBlockedTab.tab.url });
  assert.equal(reloadedBlockedStatus.status, "blocked");

  // Mentioning a marker in explanatory prose is not a completion signal.
  await send({ type: "setMonitoring", enabled: true, tabId: 17, url: "https://chatgpt.com/c/marker-in-prose" });
  const markerInProseTab = { tab: { id: 17, url: "https://chatgpt.com/c/marker-in-prose" } };
  await send({ type: "historyScanComplete", url: markerInProseTab.tab.url, workedSeconds: 15 }, markerInProseTab);
  const markerInProseAction = await send({
    type: "status",
    url: markerInProseTab.tab.url,
    isGenerating: false,
    responseKey: "marker-in-prose-response",
    latestResponseText: "I considered TASK_BLOCKED, but found another useful experiment and completed it successfully.",
    terminalStatus: null,
    consecutiveBlockedResponses: 0,
  }, markerInProseTab);
  assert.equal(markerInProseAction.action, "sendContinue");

  // A generation-ended edge with no newly rendered response is not a turn.
  await send({ type: "setMonitoring", enabled: true, tabId: 16, url: "https://chatgpt.com/c/dom-lag" });
  const domLagTab = { tab: { id: 16, url: "https://chatgpt.com/c/dom-lag" } };
  await send({ type: "historyScanComplete", url: domLagTab.tab.url, workedSeconds: 10 }, domLagTab);
  const domLagAction = await send({
    type: "status",
    url: domLagTab.tab.url,
    isGenerating: false,
    generationEnded: true,
    responseKey: "",
    latestResponseText: "",
  }, domLagTab);
  assert.equal(domLagAction.action, undefined);

  await send({ type: "setMonitoring", enabled: true, tabId: 10, url: "https://chatgpt.com/c/idle" });
  const idleTab = { tab: { id: 10, url: "https://chatgpt.com/c/idle" } };
  await send({ type: "historyScanComplete", url: idleTab.tab.url, workedSeconds: 0 }, idleTab);
  await send({ type: "status", url: idleTab.tab.url, isGenerating: true, workedSeconds: 0 }, idleTab);
  await send({ type: "status", url: idleTab.tab.url, isGenerating: false, workedSeconds: 0 }, idleTab);
  const idleStatus = await send({ type: "getMonitorStatus", tabId: 10, url: idleTab.tab.url });
  assert.equal(idleStatus.phase, "watching");

  // An idle composer with no final response must recover once for that turn,
  // close its live timer, and leave later interrupted turns recoverable.
  await send({ type: "setMonitoring", enabled: true, tabId: 26, url: "https://chatgpt.com/c/stream-timeout" });
  const timeoutTab = { tab: { id: 26, url: "https://chatgpt.com/c/stream-timeout" } };
  await send({ type: "historyScanComplete", url: timeoutTab.tab.url, workedSeconds: 0 }, timeoutTab);
  await send({ type: "status", url: timeoutTab.tab.url, isGenerating: true, workedSeconds: 0 }, timeoutTab);
  const timeoutAction = await send({
    type: "status", url: timeoutTab.tab.url, isGenerating: false,
    recoveryKey: "failed-turn-1", responseKey: "", latestResponseText: "",
  }, timeoutTab);
  assert.equal(timeoutAction.action, "sendContinue");
  assert.equal(local.runtime.states[26].activeStartedAt, null);
  await send({ type: "commandResult", action: "sendContinue", ok: true,
    url: timeoutTab.tab.url }, timeoutTab);
  // The next interruption is independent only after the previous send was
  // acknowledged. An unacknowledged request must never start a second one.
  const duplicateTimeout = await send({
    type: "status", url: timeoutTab.tab.url, isGenerating: false,
    recoveryKey: "failed-turn-1", responseKey: "", latestResponseText: "",
  }, timeoutTab);
  assert.equal(duplicateTimeout.action, undefined);
  const nextTimeout = await send({
    type: "status", url: timeoutTab.tab.url, isGenerating: false,
    recoveryKey: "failed-turn-2", responseKey: "", latestResponseText: "",
  }, timeoutTab);
  assert.equal(nextTimeout.action, undefined, "consecutive interruptions must wait before retrying");
  local.runtime.states[26].lastRecoveryAt -= 31000;
  const cooledDownTimeout = await send({
    type: "status", url: timeoutTab.tab.url, isGenerating: false,
    recoveryKey: "failed-turn-2", responseKey: "", latestResponseText: "",
  }, timeoutTab);
  assert.equal(cooledDownTimeout.action, "sendContinue", "recovery must resume after the cooldown");
  await send({ type: "retryNow", tabId: 26 });
  const retriedTimeout = await send({
    type: "status", url: timeoutTab.tab.url, isGenerating: false,
    recoveryKey: "failed-turn-2", responseKey: "", latestResponseText: "",
  }, timeoutTab);
  assert.equal(retriedTimeout.action, "sendContinue", "Retry must re-arm the same incomplete turn");

  await send({ type: "setMonitoring", enabled: true, tabId: 28, url: "https://chatgpt.com/c/threshold-recovery" });
  const thresholdRecoveryTab = { tab: { id: 28, url: "https://chatgpt.com/c/threshold-recovery" } };
  await send({ type: "historyScanComplete", url: thresholdRecoveryTab.tab.url, workedSeconds: 0 }, thresholdRecoveryTab);
  local.runtime.states[28].trackedSeconds = 7800;
  const thresholdRecovery = await send({
    type: "status", url: thresholdRecoveryTab.tab.url, isGenerating: false,
    recoveryKey: "interrupted-at-threshold", responseKey: "", latestResponseText: "",
  }, thresholdRecoveryTab);
  assert.equal(thresholdRecovery.action, "sendHandoff");

  await send({ type: "setMonitoring", enabled: true, tabId: 29, url: "https://chatgpt.com/c/threshold-send-timeout" });
  const thresholdSendTimeoutTab = { tab: { id: 29, url: "https://chatgpt.com/c/threshold-send-timeout" } };
  await send({ type: "historyScanComplete", url: thresholdSendTimeoutTab.tab.url, workedSeconds: 0 }, thresholdSendTimeoutTab);
  Object.assign(local.runtime.states[29], {
    trackedSeconds: 7800,
    phase: "sending-continue",
    actionStartedAt: Date.now() - 31000,
  });
  const thresholdSendTimeout = await send({
    type: "status", url: thresholdSendTimeoutTab.tab.url, isGenerating: false,
    responseKey: "", latestResponseText: "",
  }, thresholdSendTimeoutTab);
  assert.equal(thresholdSendTimeout.action, "sendHandoff");

  await send({ type: "setMonitoring", enabled: true, tabId: 11, url: "https://chatgpt.com/c/continue" });
  const continueTab = { tab: { id: 11, url: "https://chatgpt.com/c/continue" } };
  await send({
    type: "saveTaskNote",
    tabId: 11,
    url: continueTab.tab.url,
    taskNote: "Prefer the smallest verified implementation.",
  });
  await send({ type: "historyScanComplete", url: continueTab.tab.url, workedSeconds: 0 }, continueTab);
  const continueAction = await send({
    type: "status",
    url: continueTab.tab.url,
    isGenerating: false,
    workedSeconds: 0,
    responseKey: "continue-response",
    latestResponseText: "Useful work remains.",
  }, continueTab);
  assert.equal(continueAction.action, "sendContinue");
  assert.match(continueAction.prompt, /custom saved continue prompt/i);

  // Losing the acknowledgement during a worker restart must not leave the
  // tab permanently stuck in a transient sending phase.
  const submittedContinuation = local.runtime.states[11].actionPrompt;
  local.runtime.states[11].actionStartedAt = Date.now() - 31000;
  const acknowledgedContinue = await send({
    type: "status",
    url: continueTab.tab.url,
    isGenerating: false,
    workedSeconds: 0,
    responseKey: "continue-response",
    latestResponseText: "Useful work remains.",
    latestUserText: `@Devspace ${submittedContinuation.replace(/\. /, ".  ")}`,
  }, continueTab);
  assert.equal(acknowledgedContinue.action, undefined);
  let recoveredStatus = await send({ type: "getMonitorStatus", tabId: 11, url: continueTab.tab.url });
  assert.equal(recoveredStatus.phase, "waiting-for-response");

  local.runtime.states[11].phase = "sending-continue";
  local.runtime.states[11].actionPrompt = submittedContinuation;
  local.runtime.states[11].actionStartedAt = Date.now() - 31000;
  const recoveredContinue = await send({
    type: "status",
    url: continueTab.tab.url,
    isGenerating: false,
    workedSeconds: 0,
    responseKey: "continue-response",
    latestResponseText: "Useful work remains.",
    latestUserText: "A different earlier user message",
  }, continueTab);
  assert.equal(recoveredContinue.action, "sendContinue");

  await send({ type: "setMonitoring", enabled: true, tabId: 12, url: "https://chatgpt.com/c/tool-only" });
  const toolOnlyTab = { tab: { id: 12, url: "https://chatgpt.com/c/tool-only" } };
  await send({ type: "historyScanComplete", url: toolOnlyTab.tab.url, workedSeconds: 0 }, toolOnlyTab);
  const toolOnlyAction = await send({
    type: "status",
    url: toolOnlyTab.tab.url,
    isGenerating: false,
    generationEnded: false,
    workedSeconds: 0,
    responseKey: "turn:conversation-turn-2",
    latestResponseText: "",
    latestResponseIsSubstantive: false,
  }, toolOnlyTab);
  assert.equal(toolOnlyAction.action, undefined);
  const toolOnlyStatus = await send({ type: "getMonitorStatus", tabId: 12, url: toolOnlyTab.tab.url });
  assert.match(toolOnlyStatus.issue, /waiting for ChatGPT/i);


  const manualContinueResult = await send({ type: "manualContinue", tabId: 12 });
  assert.equal(manualContinueResult.ok, true);
  assert.equal(sentToContent.at(-1).tabId, 12);
  assert.equal(sentToContent.at(-1).message.type, "manualContinue");

  // Monitoring a second tab must not detach the first one.
  const firstStillOwned = await send({ type: "isTargetTab" }, { tab: { id: 7, url: "https://chatgpt.com/c/continued" } });
  const secondStillOwned = await send({ type: "isTargetTab" }, { tab: { id: 12, url: toolOnlyTab.tab.url } });
  assert.equal(firstStillOwned.target, true);
  assert.equal(secondStillOwned.target, true);
  const multiStatus = await send({ type: "getMonitorStatus", tabId: 12, url: toolOnlyTab.tab.url });
  assert.ok(multiStatus.monitoredCount >= 2);

  await send({ type: "setMonitoring", enabled: true, tabId: 20, url: "https://chatgpt.com/c/handoff-a" });
  await send({ type: "setMonitoring", enabled: true, tabId: 21, url: "https://chatgpt.com/c/handoff-b" });
  const handoffATab = { tab: { id: 20, url: "https://chatgpt.com/c/handoff-a" } };
  const handoffBTab = { tab: { id: 21, url: "https://chatgpt.com/c/handoff-b" } };
  await send({ type: "handoffCaptured", text: validHandoffA, url: handoffATab.tab.url }, handoffATab);
  await send({ type: "handoffCaptured", text: validHandoffB, url: handoffBTab.tab.url }, handoffBTab);
  const pendingA = await send({ type: "getPendingHandoff" }, handoffATab);
  const pendingB = await send({ type: "getPendingHandoff" }, handoffBTab);
  assert.match(pendingA.prompt, /Handoff for task A/);
  assert.doesNotMatch(pendingA.prompt, /Handoff for task B/);
  assert.match(pendingB.prompt, /Handoff for task B/);
  assert.doesNotMatch(pendingB.prompt, /Handoff for task A/);

  await send({ type: "setMonitoring", enabled: true, tabId: 22, url: "https://chatgpt.com/c/incomplete-handoff" });
  const incompleteTab = { tab: { id: 22, url: "https://chatgpt.com/c/incomplete-handoff" } };
  const rejectedCapture = await send({
    type: "handoffCaptured",
    text: "Handoff",
    url: incompleteTab.tab.url,
  }, incompleteTab);
  assert.equal(rejectedCapture.ok, false);
  const rejectedPending = await send({ type: "getPendingHandoff" }, incompleteTab);
  assert.equal(rejectedPending.prompt, null);
  const rejectedStatus = await send({ type: "getMonitorStatus", tabId: 22, url: incompleteTab.tab.url });
  assert.match(rejectedStatus.issue, /incomplete/i);

  await send({ type: "setMonitoring", enabled: true, tabId: 13, url: "https://chatgpt.com/c/empty-handoff" });
  const emptyHandoffTab = { tab: { id: 13, url: "https://chatgpt.com/c/empty-handoff" } };
  await send({ type: "historyScanComplete", url: emptyHandoffTab.tab.url, workedSeconds: 7800 }, emptyHandoffTab);
  await send({
    type: "status",
    url: emptyHandoffTab.tab.url,
    isGenerating: false,
    workedSeconds: 7800,
    responseKey: "before-handoff",
    latestResponseText: "Work remains.",
  }, emptyHandoffTab);
  await send({ type: "commandResult", action: "sendHandoff", ok: true, url: emptyHandoffTab.tab.url }, emptyHandoffTab);
  await send({ type: "status", url: emptyHandoffTab.tab.url, isGenerating: true, workedSeconds: 7800 }, emptyHandoffTab);
  const noTextRotation = await send({
    type: "status",
    url: emptyHandoffTab.tab.url,
    isGenerating: false,
    generationEnded: true,
    workedSeconds: 7800,
    responseKey: "turn:conversation-turn-4",
    latestResponseText: "",
    latestResponseIsSubstantive: false,
  }, emptyHandoffTab);
  assert.equal(noTextRotation.action, undefined);
  const noTextStatus = await send({ type: "getMonitorStatus", tabId: 13, url: emptyHandoffTab.tab.url });
  assert.match(noTextStatus.issue, /waiting for ChatGPT/i);

  await send({ type: "setMonitoring", enabled: true, tabId: 14, url: "https://chatgpt.com/c/restart" });
  const restartTab = { tab: { id: 14, url: "https://chatgpt.com/c/restart" } };
  await send({ type: "historyScanComplete", url: restartTab.tab.url, workedSeconds: 45 }, restartTab);
  let restartAction = await send({
    type: "status",
    url: restartTab.tab.url,
    isGenerating: false,
    workedSeconds: 45,
    responseKey: "same-final-turn",
    latestResponseText: "More work remains.",
  }, restartTab);
  assert.equal(restartAction.action, "sendContinue");
  await send({ type: "setMonitoring", enabled: false, tabId: 14, url: restartTab.tab.url });
  await send({ type: "setMonitoring", enabled: true, tabId: 14, url: restartTab.tab.url });
  await send({ type: "historyScanComplete", url: restartTab.tab.url, workedSeconds: 45 }, restartTab);
  restartAction = await send({
    type: "status",
    url: restartTab.tab.url,
    isGenerating: false,
    workedSeconds: 45,
    responseKey: "same-final-turn",
    latestResponseText: "More work remains.",
  }, restartTab);
  assert.equal(restartAction.action, "sendContinue");

  await send({ type: "setMonitoring", enabled: true, tabId: 30, url: "https://chatgpt.com/c/long-thinking" });
  const longThinkingTab = { tab: { id: 30, url: "https://chatgpt.com/c/long-thinking" } };
  const thinkingStartedAt = Date.now() - 60_000;
  await send({
    type: "thinkingNoticeTimer",
    url: longThinkingTab.tab.url,
    startedAt: thinkingStartedAt,
  }, longThinkingTab);
  let thinkingStatus = await send({
    type: "getMonitorStatus",
    tabId: 30,
    url: longThinkingTab.tab.url,
  });
  assert.equal(thinkingStatus.extendedThinkingStartedAt, thinkingStartedAt,
    "the popup receives the current notice start time");
  assert.equal(thinkingStatus.extendedThinkingLimitMs, 10 * 60 * 1000);
  await send({ type: "diagnosticEvent", event: "watchdog-timeout",
    reason: "configured-limit", elapsedMs: 600000 }, longThinkingTab);
  assert.ok((await send({ type: "getDiagnostics" })).events.some((entry) =>
    entry.event === "watchdog-timeout" && entry.reason === "configured-limit"),
  "the configured watchdog limit is recorded in diagnostics");
  await send({ type: "thinkingNoticeTimer", url: longThinkingTab.tab.url, startedAt: null }, longThinkingTab);
  thinkingStatus = await send({
    type: "getMonitorStatus",
    tabId: 30,
    url: longThinkingTab.tab.url,
  });
  assert.equal(thinkingStatus.extendedThinkingStartedAt, null,
    "the popup timer clears when the live notice disappears");

  const plainRecovery = await send({
    type: "extendedThinkingRecoveryReady",
    url: longThinkingTab.tab.url,
  }, longThinkingTab);
  assert.equal(plainRecovery.action, "sendContinue");
  assert.equal(plainRecovery.prompt, "Just reply to me: how is everything? Give me a brief, honest, realistic update on the current state and progress.",
    "long-thinking recovery first asks for an update");
  const shortContinueLog = await send({ type: "getDiagnostics" });
  const shortContinueEvent = shortContinueLog.events.findLast((entry) =>
    entry.event === "action-requested" && entry.tabId === 30,
  );
  assert.equal(shortContinueEvent.promptMode, "recovery-check");
  assert.equal(shortContinueEvent.source, "extended-thinking-watchdog");
  await send({
    type: "commandResult", action: "sendContinue", ok: false, url: longThinkingTab.tab.url,
  }, longThinkingTab);
  local.runtime.states[30].retryAt = Date.now() - 1;
  const retriedPlainRecovery = await send({
    type: "status", url: longThinkingTab.tab.url, isGenerating: false,
    latestResponseText: "", latestUserText: "", composerEmpty: false,
  }, longThinkingTab);
  assert.equal(retriedPlainRecovery.action, "sendContinue");
  assert.equal(retriedPlainRecovery.prompt, plainRecovery.prompt,
    "a failed check-in retries the exact same prompt");
  await send({ type: "commandResult", action: "sendContinue", ok: true,
    url: longThinkingTab.tab.url }, longThinkingTab);
  const noCheckInReply = await send({ type: "status", url: longThinkingTab.tab.url,
    isGenerating: false, latestResponseText: "", latestUserText: plainRecovery.prompt,
    composerEmpty: true }, longThinkingTab);
  assert.equal(noCheckInReply.action, undefined,
    "the normal continuation waits for a completed check-in reply");
  const unrelatedReply = await send({ type: "status", url: longThinkingTab.tab.url,
    isGenerating: false, responseKey: "older-reply",
    latestResponseText: "An earlier response.", latestResponseIsSubstantive: true,
    latestUserText: "An earlier user prompt", composerEmpty: true }, longThinkingTab);
  assert.equal(unrelatedReply.action, undefined,
    "an older assistant response cannot finish the check-in");
  const afterCheckIn = await send({ type: "status", url: longThinkingTab.tab.url,
    isGenerating: false, responseKey: "recovery-check-reply",
    latestResponseText: "Pretty good. The next step is ready.", latestResponseIsSubstantive: true,
    recoveryKey: "stale-interruption-banner",
    latestUserText: plainRecovery.prompt, composerEmpty: true }, longThinkingTab);
  assert.equal(afterCheckIn.action, "sendContinue");
  assert.match(afterCheckIn.prompt, /Completion contract:/,
    "the check-in reply is followed by the configured continuation");
  assert.ok((await send({ type: "getDiagnostics" })).events.some((entry) =>
    entry.event === "recovery-check-completed" && entry.tabId === 30));

  const repeatedCheck = await send({ type: 'extendedThinkingRecoveryReady', url: longThinkingTab.tab.url }, longThinkingTab);
  await send({ type: 'commandResult', action: 'sendContinue', ok: true, url: longThinkingTab.tab.url }, longThinkingTab);
  const unreadable = await send({ type: 'status', url: longThinkingTab.tab.url, isGenerating: false,
    latestUserText: repeatedCheck.prompt, latestResponseText: '', recoveryKey: 'unreadable-check-in-turn',
    composerEmpty: true }, longThinkingTab);
  assert.equal(unreadable.action, undefined, 'an unreadable check-in cannot request another check-in');
  assert.equal((await send({ type: 'getMonitorStatus', tabId: 30, url: longThinkingTab.tab.url })).paused, true);
  await send({ type: 'setPaused', tabId: 30, paused: false });
  const resumedCheck = await send({ type: 'status', url: longThinkingTab.tab.url, isGenerating: false,
    latestResponseText: '', recoveryKey: 'unreadable-check-in-turn', composerEmpty: true }, longThinkingTab);
  assert.equal(resumedCheck.action, 'sendContinue');
  assert.notEqual(resumedCheck.prompt, repeatedCheck.prompt, 'Resume returns to normal work, not another check-in');

  await send({ type: "setMonitoring", enabled: true, tabId: 31, url: "https://chatgpt.com/c/long-thinking-threshold" });
  const longThinkingThresholdTab = { tab: { id: 31, url: "https://chatgpt.com/c/long-thinking-threshold" } };
  await send({
    type: "historyScanComplete",
    url: longThinkingThresholdTab.tab.url,
    workedSeconds: 7800,
  }, longThinkingThresholdTab);
  const longThinkingThresholdRecovery = await send({
    type: "extendedThinkingRecoveryReady",
    url: longThinkingThresholdTab.tab.url,
  }, longThinkingThresholdTab);
  assert.equal(longThinkingThresholdRecovery.action, "sendContinue",
    "the long-thinking watchdog always sends the check-in first");
  assert.equal(longThinkingThresholdRecovery.prompt, plainRecovery.prompt);
  await send({
    type: "commandResult", action: "sendContinue", ok: false, url: longThinkingThresholdTab.tab.url,
  }, longThinkingThresholdTab);
  local.runtime.states[31].retryAt = Date.now() - 1;
  const thresholdRetry = await send({
    type: "status", url: longThinkingThresholdTab.tab.url, isGenerating: false,
    latestResponseText: "", latestUserText: "", composerEmpty: false,
  }, longThinkingThresholdTab);
  assert.equal(thresholdRetry.prompt, longThinkingThresholdRecovery.prompt,
    "a failed watchdog submission keeps the exact check-in prompt even past the handoff timer");
  await send({ type: "commandResult", action: "sendContinue", ok: true,
    url: longThinkingThresholdTab.tab.url }, longThinkingThresholdTab);
  await send({ type: "status", url: longThinkingThresholdTab.tab.url,
    isGenerating: true, workedSeconds: 7800 }, longThinkingThresholdTab);
  const afterShortRecovery = await send({ type: "status", url: longThinkingThresholdTab.tab.url,
    isGenerating: false, workedSeconds: 7800, responseKey: "after-short-recovery",
    latestResponseText: "The task can continue.", latestResponseIsSubstantive: true,
    latestUserText: longThinkingThresholdRecovery.prompt, composerEmpty: true }, longThinkingThresholdTab);
  assert.equal(afterShortRecovery.action, "sendHandoff",
    "the usual handoff priority follows the check-in response");

  await send({ type: "setMonitoring", enabled: true, tabId: 32, url: "https://chatgpt.com/c/long-thinking-paused" });
  const longThinkingPausedTab = { tab: { id: 32, url: "https://chatgpt.com/c/long-thinking-paused" } };
  await send({ type: "setPaused", tabId: 32, paused: true });
  const pausedRecovery = await send({
    type: "extendedThinkingRecoveryReady",
    url: longThinkingPausedTab.tab.url,
  }, longThinkingPausedTab);
  assert.equal(pausedRecovery.action, undefined,
    "long-thinking recovery must not act while the monitor is paused");

  await send({ type: "setMonitoring", enabled: true, tabId: 33,
    url: "https://chatgpt.com/c/paused-handoff" });
  await send({ type: "setPaused", tabId: 33, paused: true });
  const pausedHandoff = await send({ type: "manualSwap", tabId: 33 });
  assert.equal(pausedHandoff.ok, true, "manual handoff works while monitoring is paused");
  const afterPausedHandoff = await send({ type: "getMonitorStatus", tabId: 33,
    url: "https://chatgpt.com/c/paused-handoff" });
  assert.equal(afterPausedHandoff.paused, false);
  assert.equal(afterPausedHandoff.phase, "sending-handoff");

  console.log("background_flow_ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
