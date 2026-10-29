if (typeof importScripts === "function") importScripts("log-files.js");

const DEFAULT_SETTINGS = {
  preferredModel: "GPT-5.6 Sol",
  preferredReasoning: "high",
  enforceModelPreferences: true,
  enabled: false,
  targetTabIds: [],
  thresholdMinutes: 130,
  thinkingMinutes: 10,
  handoffPrompt:
    "You are performing a CONTEXT CHECKPOINT COMPACTION. Write a concise handoff for another agent continuing this task in a fresh chat. State the repository or workspace being worked in, including its absolute path when available. Preserve the original goal, important user decisions and constraints, current progress, verified results, unresolved questions, and the most useful next steps. Include reasoning or references only when they help the next agent make a decision, find essential work, or avoid repeating a mistake. Distinguish facts from assumptions. Skip routine environment metadata, tool versions, commit hashes, and details the next agent can easily inspect, unless the task specifically depends on them. Include only what matters for continuing the work; omit empty sections and incidental history. Before writing the handoff, take a brief preparation pass when useful: finish a small in-progress step, save important results, clean up loose ends, or update an existing note so the next agent can continue smoothly. Use judgment about what helps, but keep this bounded and do not start a major new work phase.",
  continuePrompt:
    "Continue the original user task. Check the current state, identify the most useful unfinished step within the agreed scope, perform it with available authorized tools, and verify the result. Work through meaningful remaining steps before stopping. Do not repeat settled work, widen the goal, or invent extra tasks just to keep working. If the goal is already complete or genuinely blocked, say so instead of creating more work.",
  continuePresetIndex: 0,
  continuePresets: null,
  tabContinuePresets: {},

};

const GOAL_CONTRACT =
  "Completion contract: Work only toward the original user's goal and constraints. Complete useful, authorized steps and verify results; do not invent extra work. When the original goal is complete and verified, end with TASK_FINISHED on a line by itself. If you cannot proceed without user action after checking reasonable alternatives, explain the blocker and end with TASK_BLOCKED on a line by itself. Otherwise use neither marker and keep working on the original goal.";

const BLOCKED_REVIEW_PROMPT =
  "Before stopping, reconsider the blocker against the ORIGINAL user's goal and constraints. Identify what specifically prevents progress. Check for a reasonable, safe, authorized alternative that would advance the same goal without user action; if one exists, try it and verify the outcome. Do not invent a new goal, repeat a failed step without new evidence, bypass permissions, or claim success without verification. If useful work on the original goal can continue, do it and omit the terminal markers. If the goal is fully complete and verified, end with TASK_FINISHED on its own final line. If no viable authorized next step remains and user action is genuinely required, explain exactly what is needed and end with TASK_BLOCKED on its own final line. This is the single reconsideration request; do not request another review.";

const SHORT_CONTINUES = ["continue", "keep going"];
const AUTOMATION_NOTE = "Automated continuation of the original user task. Keep the user's goal and constraints; do meaningful remaining work and verify it. Do not invent extra goals or tasks to stay active. If the original goal is verified complete, end with TASK_FINISHED on its own final line. If no authorized next step is possible without user action, explain the blocker and end with TASK_BLOCKED on its own final line. Otherwise omit both markers and keep working.";

function customContinueText(text) {
  // Remove only the user's explicit automation preamble; preserve task notes.
  return String(text || "").trim().replace(/^this is an? automated system message\(\(user may include[\s\S]*?extra notes\/messages\)\.?\s*/i, '').trim();
}
const RECOVERY_CHECK_PROMPT = "Just reply to me: how is everything? Give me a brief, honest, realistic update on the current state and progress.";
const HANDOFF_OPENERS = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION.",
  "This is a CONTEXT CHECKPOINT COMPACTION.",
];

function choose(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function varySpacing(text) {
  return text.replace(/\. (?=[A-Z])/, () => `. ${" ".repeat(Math.floor(Math.random() * 3))}`);
}

function isShortContinuePrompt(prompt) {
  const text = String(prompt || "").trim();
  const body = text.startsWith(AUTOMATION_NOTE) ? text.slice(AUTOMATION_NOTE.length).trim() : text;
  return SHORT_CONTINUES.includes(body.replace(/\s+/g, " ").toLowerCase());
}

function sameSubmittedPrompt(actual, expected) {
  const normalize = (text) => String(text || "").trim().replace(/\s+/g, " ");
  const sent = normalize(expected);
  const shown = normalize(actual);
  return Boolean(sent && (shown === sent || shown.replace(/^@?(?:devspace|spacedev)\s+/i, "") === sent));
}

function handoffPrompt() {
  return varySpacing(settings.handoffPrompt.replace(HANDOFF_OPENERS[0], choose(HANDOFF_OPENERS)));
}

const LEGACY_CONTINUE_PROMPTS = new Set([
  "Continue the original task only if meaningful work remains. Reassess the real goal, hard constraints, current evidence, and largest remaining gap, then choose the highest-value next move yourself. Use available files, tools, experiments, or research the internet and papers and good quality recourses as needed, act on the decision, and verify the result. Preserve user decisions, but change direction when evidence supports a better approach. Do not merely summarize, report status, repeat settled work without reason, or invent work after the goal is complete.",
]);

const STARTER_CONTINUE_PRESETS = [
  DEFAULT_SETTINGS.continuePrompt,
  "continue",
  "Review the current state of the original user task. Identify the most important remaining gap, question assumptions that affect it, and choose the simplest useful next step. Use tools or research when they help, carry out the step, and verify the result. Improve supporting code or process only when it directly advances the requested goal. Do not broaden the scope or repeat work without a reason.",
  "Critically reassess the original user goal, constraints, evidence and remaining work. Consider alternative approaches or a larger redesign only if evidence shows it would materially improve completing that goal. Run focused experiments or checks, preserve verified progress, and act on the best supported option. Finish the goal thoroughly, but do not expand it into unrelated research, cleanup, or optimizations merely to stay busy.",
];


const HANDOFF_RELAY =
  "Another agent worked on this task and left the handoff below. Use it to build on that work and avoid duplication. Preserve the original user's goal and constraints, verify the current state as needed, and complete meaningful remaining work using your own judgment. Do not merely summarize the handoff or invent new goals to prolong the task.";

const states = new Map();
const lastSeenAt = new Map();
const lastDiagnosticHeartbeatAt = new Map();
const lastRecoveryAttemptAt = new Map();
const pendingHandoffs = new Map();
const manualSwapsInFlight = new Set();
const MAX_DIAGNOSTIC_EVENTS = 500;
const DIAGNOSTIC_EVENTS = new Set([
  "approval_detected", "approval_resolved", "approval_pending",
  "model-selection-changed", "model-selection-failed",
  "monitoring-changed",
  "pause-changed",
  "watchdog-detected",
  "watchdog-reset",
  "watchdog-timeout",
  "watchdog-stop-requested",
  "watchdog-stop-confirmed",
  "watchdog-stop-failed",
  "action-requested",
  "action-result",
  "recovery-check-completed",
  "logging-configured",
  "handoff-incomplete",
  "handoff-captured",
  "handoff-delivered",
  "heartbeat",
]);
const DIAGNOSTIC_PROMPT_MODES = new Set(["short-continue", "recovery-check", "custom-continue", "handoff", "blocked-review", "none"]);
let diagnosticWrites = Promise.resolve();
let settingsWrites = Promise.resolve();
let runtimeWrites = Promise.resolve();
let logFileError = "";
let settings = { ...DEFAULT_SETTINGS };
const ready = initialize();

function promptKind(action, prompt) {
  if (action === "sendBlockedReview") return "blocked-review";
  if (action === "sendContinue" && prompt === RECOVERY_CHECK_PROMPT) return "recovery-check";
  if (action === "sendContinue") return isShortContinuePrompt(prompt) ? "short-continue" : "custom-continue";
  if (action === "sendHandoff") return "handoff";
  return "none";
}

function recordDiagnostic(event, details = {}) {
  if (!DIAGNOSTIC_EVENTS.has(event)) return diagnosticWrites;
  const entry = {
    time: new Date().toISOString(),
    version: chrome.runtime.getManifest?.().version || "unknown",
    event,
  };
  const enumFields = {
    source: new Set([
      "automatic", "completed-response", "stream-recovery", "action-retry",
      "extended-thinking-watchdog", "extended-thinking-retry",
      "extended-thinking-handoff-priority",
      "extended-thinking-threshold", "manual-continue", "manual-handoff",
      "incomplete-handoff", "blocked-review",
    ]),
    action: new Set([
      "sendContinue", "sendHandoff", "rotateWithHandoff",
      "enableDevSpace", "deliverHandoff", "sendBlockedReview",
    ]),
    phase: new Set([
      "watching", "working", "paused", "sending-continue", "waiting-for-response",
      "sending-handoff", "sending-block-review", "waiting-for-block-review",
      "waiting-for-handoff", "opening-new-chat", "threshold-waiting", "finished",
    ]),
    promptMode: DIAGNOSTIC_PROMPT_MODES,
    reason: new Set([
      "timer-started", "notice-or-generation-ended", "configured-limit", "ten-minute-limit",
      "stop-control-visible", "stop-control-disappeared", "stop-control-remained-visible",
      "started", "stopped", "paused", "resumed", "finished", "blocked",
      "unreadable-check-in",
      "devspace", "permission-card", "conversation-scope",
      "chevron-not-ready", "chevron-missing", "conversation-option-not-found", "card-did-not-close",
      "picker-unavailable", "model-unavailable", "reasoning-unavailable",
    ]),
  };
  for (const [key, values] of Object.entries(enumFields)) {
    if (typeof details[key] === "string" && values.has(details[key])) entry[key] = details[key];
  }
  if (Number.isInteger(details.tabId)) entry.tabId = details.tabId;
  if (typeof details.success === "boolean") entry.success = details.success;
  if (Number.isFinite(details.elapsedMs)) entry.elapsedMs = Math.max(0, details.elapsedMs);
  if (Number.isFinite(details.workedSeconds)) entry.workedSeconds = Math.max(0, Math.round(details.workedSeconds));
  if (Number.isInteger(details.attempt)) entry.attempt = details.attempt;

  diagnosticWrites = diagnosticWrites.then(async () => {
    const { diagnostics } = await chrome.storage.local.get("diagnostics");
    const events = Array.isArray(diagnostics) ? diagnostics : [];
    events.push(entry);
    await chrome.storage.local.set({ diagnostics: events.slice(-MAX_DIAGNOSTIC_EVENTS) });
    if (typeof AgentMonitorLogFiles !== "undefined") {
      try {
        const written = await AgentMonitorLogFiles.append(entry);
        logFileError = written ? "" : "Logs buffered. Set folder to write them to disk.";
      } catch (error) {
        logFileError = error?.name === "NotAllowedError"
          ? "Logs buffered. Reconnect folder access under Set folder."
          : "Logs buffered. Could not write to the log folder.";
      }
    }
  }).catch((error) => {
    console.warn("ChatGPT Agent Monitor: could not save diagnostics", error?.name || "Error");
  });
  return diagnosticWrites;
}

async function initialize() {
  const [savedSettings, savedRuntime, legacyRuntime] = await Promise.all([
    chrome.storage.local.get("settings"),
    chrome.storage.local.get("runtime"),
    chrome.storage.session.get("runtime"),
  ]);

  settings = { ...DEFAULT_SETTINGS, ...(savedSettings.settings || {}) };
  let settingsChanged = false;

  const migratedTabIds = Array.isArray(settings.targetTabIds)
    ? settings.targetTabIds.filter(Number.isInteger)
    : [];
  if (settings.enabled && Number.isInteger(settings.targetTabId)) {
    migratedTabIds.push(settings.targetTabId);
    settingsChanged = true;
  }
  settings.targetTabIds = [...new Set(migratedTabIds)];
  settings.targetTabId = null;
  settings.enabled = settings.targetTabIds.length > 0;

  if ("savedGoal" in settings || !Array.isArray(settings.continuePresets)) settingsChanged = true;
  delete settings.savedGoal;
  settings.handoffPrompt = DEFAULT_SETTINGS.handoffPrompt;
  delete settings.blockedPrompt;
  if (LEGACY_CONTINUE_PROMPTS.has(settings.continuePrompt)) {
    settings.continuePrompt = DEFAULT_SETTINGS.continuePrompt;
    settingsChanged = true;
  }
  const previousPresets = settings.continuePresets;
  settings.continuePresets = STARTER_CONTINUE_PRESETS.map((starter, index) =>
    customContinueText(settings.continuePresets?.[index] || (index === 0 ? settings.continuePrompt : starter)).slice(0, 12000) || starter,
  );
  if (settings.continuePresets.some((text, index) => text !== previousPresets?.[index])) settingsChanged = true;
  settings.continuePresetIndex = Number.isInteger(settings.continuePresetIndex)
    && settings.continuePresetIndex >= 0 && settings.continuePresetIndex < 4
    ? settings.continuePresetIndex : 0;
  settings.continuePrompt = settings.continuePresets[settings.continuePresetIndex];
  const tabProfiles = {};
  for (const [id, profile] of Object.entries(settings.tabContinuePresets || {})) {
    if (!/^\d+$/.test(id) || !Number.isInteger(profile?.index) || profile.index < 0 || profile.index > 3) continue;
    // Preserve the selected text from the former per-tab copies when migrating.
    const selectedText = profile.presets?.[profile.index];
    if (typeof selectedText === "string" && selectedText.trim()) {
      settings.continuePresets[profile.index] = customContinueText(selectedText).slice(0, 12000) || settings.continuePresets[profile.index];
      settingsChanged = true;
    }
    tabProfiles[id] = { index: profile.index };
  }
  settings.tabContinuePresets = tabProfiles;
  settings.continuePrompt = settings.continuePresets[settings.continuePresetIndex];
  if (!savedSettings.settings || settingsChanged) {
    await chrome.storage.local.set({ settings });
  }

  const runtime = savedRuntime.runtime || legacyRuntime.runtime || {};
  for (const [tabId, state] of Object.entries(runtime.states || {})) {
    const id = Number(tabId);
    state.tabId = id;
    delete state.taskNote;
    delete state.useSavedGoal;
    delete state.blockReviewSent;
    delete state.handoffWasBlocked;
    // Keep the one-time review flag and its pending phase across worker restarts.
    state.blockedReviewAttempted = state.blockedReviewAttempted === true
      || ["sending-block-review", "waiting-for-block-review"].includes(state.phase);
    if (state.taskStatus === "finished" || state.taskStatus === "blocked") {
      state.paused = true;
      state.phase = "paused";
      state.activeStartedAt = null;
    }
    states.set(id, state);
  }
  for (const [tabId, handoff] of Object.entries(runtime.pendingHandoffs || {})) {
    delete handoff.taskNote;
    delete handoff.useSavedGoal;
    pendingHandoffs.set(Number(tabId), handoff);
  }
  if (runtime.pendingHandoff?.tabId) {
    delete runtime.pendingHandoff.taskNote;
    delete runtime.pendingHandoff.useSavedGoal;
    pendingHandoffs.set(runtime.pendingHandoff.tabId, runtime.pendingHandoff);
  }
  await persistRuntime();
  syncKeepAwake();
}

async function persistSettings() {
  // Chrome storage writes are asynchronous. Keep their order stable when the
  // popup, monitor, and recovery alarm update state at the same time.
  settingsWrites = settingsWrites.catch(() => {}).then(() => chrome.storage.local.set({ settings }));
  return settingsWrites;
}

async function persistRuntime() {
  runtimeWrites = runtimeWrites.catch(() => {}).then(() => chrome.storage.local.set({
    runtime: {
      states: Object.fromEntries(states),
      pendingHandoffs: Object.fromEntries(pendingHandoffs),
    },
  }));
  return runtimeWrites;
}

function syncKeepAwake() {
  if (!chrome.power) return;
  if (settings.enabled && settings.targetTabIds.length > 0) {
    chrome.power.requestKeepAwake("system");
  } else {
    chrome.power.releaseKeepAwake();
  }
}

function isChatUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "chatgpt.com" || hostname === "chat.openai.com";
  } catch {
    return false;
  }
}

function isConversationUrl(url) {
  try {
    const parsed = new URL(url);
    return isChatUrl(url) &&
      (parsed.pathname.startsWith("/c/") || parsed.searchParams.get("temporary-chat") === "true");
  } catch {
    return false;
  }
}

function conversationKey(url) {
  try {
    const parsed = new URL(url);
    if (!isChatUrl(url)) return "";
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    if (path.startsWith("/c/")) return `${parsed.hostname}${path}`;
    if (parsed.searchParams.get("temporary-chat") === "true") {
      return `${parsed.hostname}/?temporary-chat=true`;
    }
    return `${parsed.hostname}${path}`;
  } catch {
    return "";
  }
}

function newState(url, carry = null, tabId = carry?.tabId ?? null) {
  return {
    tabId,
    url,
    conversationKey: conversationKey(url),
    phase: "watching",
    taskStatus: "ongoing",
    resumeContinuePending: false,
    lastCustomContinue: "",
    genericContinuesRemaining: 0,
    pendingNormalContinue: null,
    maxWorkedSeconds: 0,
    historyWorkedSeconds: 0,
    trackedSeconds: 0,
    activeStartedAt: null,
    historyScanned: false,
    lastResponseKey: "",
    blockedReviewAttempted: false,
    lastRecoveryKey: "",
    issue: "",
    handoffShortRetryUsed: false,
    paused: Boolean(carry?.paused),
    actionStartedAt: null,
    actionPrompt: "",
    actionPromptMode: "none",
    recoveryCheckPrompt: "",
    oneShotHandoff: false,
    extendedThinkingStartedAt: null,
    awaitingFreshConversation: false,
  };
}

function workedTotal(state, now = Date.now()) {
  if (!state) return 0;
  const active = state.activeStartedAt
    ? Math.max(0, (now - state.activeStartedAt) / 1000)
    : 0;
  const baseline = Math.max(
    Number(state.historyWorkedSeconds) || 0,
    Number(state.maxWorkedSeconds) || 0,
  );
  return Math.max(baseline, (Number(state.historyWorkedSeconds) || 0)
    + (Number(state.trackedSeconds) || 0) + active);
}

function thresholdReached(state) {
  const thresholdSeconds = Math.max(1, Number(settings.thresholdMinutes) || 130) * 60;
  return workedTotal(state) >= thresholdSeconds;
}

function getState(tabId, url) {
  let state = states.get(tabId);
  if (state && !Number.isInteger(state.tabId)) state.tabId = tabId;
  const nextKey = conversationKey(url);
  const currentKey = state?.conversationKey || conversationKey(state?.url || "");
  const enteringDeliveredConversation = Boolean(
    state?.awaitingFreshConversation
    && nextKey.includes("/c/")
    && !currentKey.includes("/c/"),
  );
  if (!state || (currentKey !== nextKey && !pendingHandoffs.has(tabId) && !enteringDeliveredConversation)) {
    state = newState(url, state, tabId);
    states.set(tabId, state);
  } else if (url) {
    state.url = url;
    state.conversationKey = nextKey;
    if (enteringDeliveredConversation) state.awaitingFreshConversation = false;
  }
  return state;
}

function terminalStatus(text) {
  const finalLine = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || "";
  const match = finalLine.match(/^(?:TASK|GOAL)[\s_:-]*(FINISHED|BLOCKED)[.!]?$/i);
  return match ? match[1].toLowerCase() : null;
}

function addGoalContract(prompt) {
  return `${prompt.trim()}\n\n${GOAL_CONTRACT}`;
}

function relayPrompt(handoff) {
  return addGoalContract(`${HANDOFF_RELAY}\n\n${handoff}`);
}


function validHandoffText(text) {
  const normalized = (text || "").trim();
  return normalized.length >= 200 && normalized.split(/\s+/).length >= 30;
}

function nextAction(state, phase, name, prompt) {
  if (state.phase !== phase) state.sendFailures = 0;
  state.retryAt = null;
  state.phase = phase;
  state.actionStartedAt = Date.now();
  state.actionPrompt = prompt || "";
  state.actionPromptMode = promptKind(name, prompt);
  state.actionSource = state.nextActionSource || "automatic";
  state.nextActionSource = null;
  state.issue = "";
  void recordDiagnostic("action-requested", {
    tabId: state.tabId,
    source: state.actionSource,
    action: name,
    promptMode: promptKind(name, prompt),
    phase,
  });
  return { action: name, prompt };
}

function requestHandoff(state, prompt = addGoalContract(handoffPrompt()), source = "automatic") {
  state.pendingNormalContinue = null;
  if (!handoffInProgress(state) && source !== "incomplete-handoff") {
    state.handoffShortRetryUsed = false;
  }
  state.nextActionSource = source;
  return nextAction(state, "sending-handoff", "sendHandoff", prompt);
}

function completedHandoffAction(state, text, substantive) {
  if (substantive && validHandoffText(text)) {
    return nextAction(state, "opening-new-chat", "rotateWithHandoff");
  }
  if (!state.handoffShortRetryUsed) {
    void recordDiagnostic("handoff-incomplete", { tabId: state.tabId, attempt: 1 });
    state.handoffShortRetryUsed = true;
    return requestHandoff(state, addGoalContract(handoffPrompt()), "incomplete-handoff");
  }
  state.phase = "waiting-for-handoff";
  void recordDiagnostic("handoff-incomplete", { tabId: state.tabId, attempt: 2 });
  state.issue = "Handoff remained too short after one retry. Use Retry when ChatGPT is ready.";
  return {};
}

function continueProfile(tabId) {
  return {
    presets: settings.continuePresets,
    index: Number.isInteger(tabId) ? settings.tabContinuePresets?.[tabId]?.index ?? 0 : settings.continuePresetIndex,
  };
}

function continuePromptForTab(tabId) {
  const profile = continueProfile(tabId);
  return profile.presets[profile.index];
}

function requestContinue(state, prompt, source = "automatic") {
  if (prompt === undefined) {
    const custom = customContinueText(continuePromptForTab(state.tabId));
    const useCustom = custom !== state.lastCustomContinue || !(state.genericContinuesRemaining > 0);
    state.pendingNormalContinue = { custom, useCustom };
    prompt = `${AUTOMATION_NOTE}\n\n${useCustom ? addGoalContract(custom) : 'continue'}`;
  }
  state.nextActionSource = source;
  return nextAction(state, "sending-continue", "sendContinue", prompt);
}

function requestBlockedReview(state, source = "blocked-review") {
  // Mark the attempt before dispatch so a restart cannot start a second
  // reconsideration. It does not consume the normal continuation cadence.
  state.blockedReviewAttempted = true;
  state.pendingNormalContinue = null;
  state.recoveryCheckPrompt = "";
  state.nextActionSource = source;
  return nextAction(state, "sending-block-review", "sendBlockedReview", BLOCKED_REVIEW_PROMPT);
}

function requestRecoveryCheck(state, source = "extended-thinking-watchdog") {
  state.pendingNormalContinue = null;
  state.recoveryCheckPrompt = RECOVERY_CHECK_PROMPT;
  return requestContinue(state, RECOVERY_CHECK_PROMPT, source);
}


function requestAutomaticFollowUp(state, source = "completed-response") {
  return thresholdReached(state)
    ? requestHandoff(state, addGoalContract(handoffPrompt()), source)
    : requestContinue(state, undefined, source);
}

function handoffInProgress(state) {
  return ["sending-handoff", "waiting-for-handoff"].includes(state.phase);
}


function markTransientActionAccepted(state) {
  if (state.phase === "sending-continue" && state.pendingNormalContinue) {
    const { custom, useCustom } = state.pendingNormalContinue;
    if (useCustom) {
      state.lastCustomContinue = custom;
      state.genericContinuesRemaining = 2;
    } else {
      state.genericContinuesRemaining = Math.max(0, state.genericContinuesRemaining - 1);
    }
    state.pendingNormalContinue = null;
  }
  if (state.phase === "sending-handoff") state.phase = "waiting-for-handoff";
  if (state.phase === "sending-block-review") state.phase = "waiting-for-block-review";
  if (state.phase === "sending-continue") state.phase = "waiting-for-response";
  state.actionStartedAt = null;
  state.actionPrompt = "";
  state.retryAt = null;
  state.sendFailures = 0;
  state.issue = "";
}

function transientActionTimedOut(state, now = Date.now()) {
  return ["sending-continue", "sending-handoff", "sending-block-review"].includes(state?.phase)
    && (!state.actionStartedAt || now - state.actionStartedAt >= 30000);
}

function retryTransientAction(state) {
  if (state.phase === "sending-block-review") return requestBlockedReview(state, "action-retry");
  if (state.phase === "waiting-for-handoff" && state.handoffShortRetryUsed) {
    return requestHandoff(state, addGoalContract(handoffPrompt()), "incomplete-handoff");
  }
  if (state.phase === "sending-handoff") {
    return requestHandoff(state, state.actionPrompt || addGoalContract(handoffPrompt()), "action-retry");
  }
  if (state.phase === "sending-continue" && state.actionPrompt) return requestContinue(
    state,
    state.actionPrompt,
    "action-retry",
  );
  return requestAutomaticFollowUp(state, "action-retry");
}

function targetMatches(tabId) {
  return settings.enabled && settings.targetTabIds.includes(tabId);
}

async function injectTargetTab(tabId) {
  if (!targetMatches(tabId)) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return true;
  } catch {
    // Declarative injection will attach when a matching ChatGPT page loads.
    return false;
  }
}

async function injectAllTargetTabs() {
  await Promise.all(settings.targetTabIds.map((tabId) => injectTargetTab(tabId)));
}

function ensureRecoveryAlarm() {
  chrome.alarms.create("monitor-recovery", { periodInMinutes: 0.5 });
}

async function validateTargetTabs() {
  if (!settings.enabled) return;
  const valid = [];
  for (const tabId of settings.targetTabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isChatUrl(tab.url)) {
        valid.push(tabId);
        continue;
      }
    } catch {
      // This monitored tab no longer exists.
    }
    states.delete(tabId);
    lastSeenAt.delete(tabId);
    lastDiagnosticHeartbeatAt.delete(tabId);
    lastRecoveryAttemptAt.delete(tabId);
    pendingHandoffs.delete(tabId);
  }
  settings.targetTabIds = valid;
  settings.enabled = valid.length > 0;
  await Promise.all([persistSettings(), persistRuntime()]);
  syncKeepAwake();
}

chrome.runtime.onInstalled.addListener(async () => {
  await ready;
  ensureRecoveryAlarm();
  await validateTargetTabs();
  await persistRuntime();
  syncKeepAwake();
  await injectAllTargetTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  ensureRecoveryAlarm();
  await validateTargetTabs();
  syncKeepAwake();
  await injectAllTargetTabs();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ready;

    // A long-running content-script operation can finish after its tab moves
    // to another chat. Never apply its old URL report to the new conversation.
    if (message.url && sender.tab?.url
        && conversationKey(message.url) !== conversationKey(sender.tab.url)) {
      sendResponse({ ok: false });
      return;
    }

    if (message.type === "getSettings") {
      const profile = continueProfile(message.tabId);
      sendResponse({ settings: { ...settings, continuePresets: profile.presets,
        continuePresetIndex: profile.index, continuePrompt: profile.presets[profile.index] } });
      return;
    }

    if (message.type === "getDiagnostics") {
      await diagnosticWrites;
      const { diagnostics } = await chrome.storage.local.get("diagnostics");
      sendResponse({ events: Array.isArray(diagnostics) ? diagnostics : [] });
      return;
    }

    if (message.type === "logFolderChanged") {
      logFileError = "";
      await recordDiagnostic("logging-configured");
      sendResponse({ ok: !logFileError, logFileError });
      return;
    }

    if (message.type === "saveSettings") {
      const previousModel = settings.preferredModel;
      const previousReasoning = settings.preferredReasoning;
      const previousEnforcement = settings.enforceModelPreferences;
      settings = {
        ...settings,
        enforceModelPreferences: typeof message.settings?.enforceModelPreferences === "boolean"
          ? message.settings.enforceModelPreferences : settings.enforceModelPreferences,
        preferredModel: typeof message.settings?.preferredModel === "string"
          ? message.settings.preferredModel.trim().slice(0, 80) : settings.preferredModel,
        preferredReasoning: ["", "instant", "medium", "high"].includes(message.settings?.preferredReasoning)
          ? message.settings.preferredReasoning : settings.preferredReasoning,
        thresholdMinutes: Math.min(720, Math.max(1, Number(message.settings?.thresholdMinutes) || settings.thresholdMinutes || 130)),
        thinkingMinutes: Math.min(60, Math.max(1, Number(message.settings?.thinkingMinutes) || settings.thinkingMinutes || 10)),
      };
      if (previousModel !== settings.preferredModel || previousReasoning !== settings.preferredReasoning
          || previousEnforcement !== settings.enforceModelPreferences) {
        for (const state of states.values()) {
          if (state.modelPreferenceIssue && state.issue.startsWith(state.modelPreferenceIssue)) state.issue = "";
          state.modelPreferenceIssue = "";
        }
        await persistRuntime();
      }
      await persistSettings();
      syncKeepAwake();
      sendResponse({ settings });
      return;
    }

    if (message.type === "saveContinuePreset") {
      const index = Number(message.index);
      if (!Number.isInteger(index) || index < 0 || index > 3) {
        sendResponse({ ok: false });
        return;
      }
      const tabId = message.tabId;
      if (tabId !== undefined && !Number.isInteger(tabId)) {
        sendResponse({ ok: false });
        return;
      }
      const current = continueProfile(tabId);
      const profile = { presets: [...current.presets], index };
      if (typeof message.text === "string") {
        const text = customContinueText(message.text).slice(0, 12000);
        if (!text) {
          sendResponse({ ok: false, error: "The continue prompt cannot be empty." });
          return;
        }
        profile.presets[index] = text;
      }
      if (Number.isInteger(tabId)) {
        settings.tabContinuePresets[tabId] = { index };
      } else {
        settings.continuePresetIndex = index;
      }
      settings.continuePresets = profile.presets;
      settings.continuePrompt = profile.presets[settings.continuePresetIndex];
      await persistSettings();
      sendResponse({ ok: true, settings });
      return;
    }

    if (message.type === "setMonitoring") {
      const tabId = Number(message.tabId);
      if (message.enabled) {
        if (!Number.isInteger(tabId) || !isChatUrl(message.url)) {
          sendResponse({ ok: false, error: "Open a ChatGPT tab first." });
          return;
        }
        if (!settings.targetTabIds.includes(tabId)) settings.targetTabIds.push(tabId);
        settings.enabled = true;
        states.set(tabId, newState(message.url, null, tabId));
        await Promise.all([persistSettings(), persistRuntime()]);
        await recordDiagnostic("monitoring-changed", { tabId, reason: "started" });
        syncKeepAwake();
        const attached = await injectTargetTab(tabId);
        if (!attached) {
          const state = states.get(tabId);
          state.issue = "Could not attach to this tab. Refresh ChatGPT and retry.";
          await persistRuntime();
        }
      } else {
        const state = states.get(tabId);
        if (state) state.activeStartedAt = null;
        settings.targetTabIds = settings.targetTabIds.filter((id) => id !== tabId);
        settings.enabled = settings.targetTabIds.length > 0;
        states.delete(tabId);
        lastSeenAt.delete(tabId);
        lastDiagnosticHeartbeatAt.delete(tabId);
        lastRecoveryAttemptAt.delete(tabId);
        pendingHandoffs.delete(tabId);
        await Promise.all([persistSettings(), persistRuntime()]);
        await recordDiagnostic("monitoring-changed", { tabId, reason: "stopped" });
        syncKeepAwake();
      }
      sendResponse({ ok: true, settings });
      return;
    }

    if (message.type === "thinkingNoticeTimer") {
      const tabId = sender.tab?.id;
      const hasStartedAt = message.startedAt !== null && message.startedAt !== undefined;
      const startedAt = hasStartedAt ? Number(message.startedAt) : null;
      if (!targetMatches(tabId)
          || (hasStartedAt && (!Number.isFinite(startedAt) || startedAt <= 0 || startedAt > Date.now()))) {
        sendResponse({ ok: false });
        return;
      }
      const state = getState(tabId, message.url || sender.tab?.url || "");
      if (state.extendedThinkingStartedAt !== startedAt) {
        state.extendedThinkingStartedAt = startedAt;
        await persistRuntime();
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "getMonitorStatus") {
      const tabId = Number(message.tabId);
      const isCurrentTab = targetMatches(tabId);
      const state = isCurrentTab ? states.get(tabId) : null;
      const lastSeen = isCurrentTab ? lastSeenAt.get(tabId) || 0 : 0;
      const stale = isCurrentTab && Date.now() - lastSeen >= 15000;
      const recoveryProtected = ["sending-continue", "sending-handoff", "sending-block-review"].includes(state?.phase)
        && !transientActionTimedOut(state);
      const lastAttempt = lastRecoveryAttemptAt.get(tabId) || 0;
      if (stale && !recoveryProtected && Date.now() - lastAttempt >= 10000) {
        lastRecoveryAttemptAt.set(tabId, Date.now());
        await injectTargetTab(tabId);
      }
      sendResponse({
        enabled: settings.enabled,
        monitoredCount: settings.targetTabIds.length,
        isCurrentTab,
        currentTabSupported: isChatUrl(message.url),
        status: isCurrentTab ? state?.taskStatus || "ongoing" : "off",
        phase: isCurrentTab ? state?.phase || "watching" : "off",
        isGenerating: Boolean(isCurrentTab && state?.activeStartedAt),
        extendedThinkingStartedAt: isCurrentTab ? state?.extendedThinkingStartedAt || null : null,
        extendedThinkingLimitMs: settings.thinkingMinutes * 60 * 1000,
        workedSeconds: workedTotal(state),
        thresholdMinutes: settings.thresholdMinutes,
        issue: state?.issue || "",
        logFileError,
        connected: Boolean(lastSeen && Date.now() - lastSeen < 15000),
        paused: Boolean(state?.paused),
      });
      return;
    }

    if (message.type === "setPaused") {
      const tabId = Number(message.tabId);
      if (!targetMatches(tabId)) {
        sendResponse({ ok: false, error: "This tab is not being monitored." });
        return;
      }
      const state = getState(tabId, states.get(tabId)?.url || message.url || "");
      const paused = Boolean(message.paused);
      if (paused && state.activeStartedAt) {
        state.trackedSeconds = (Number(state.trackedSeconds) || 0)
          + Math.max(0, (Date.now() - state.activeStartedAt) / 1000);
        state.activeStartedAt = null;
      }
      if (paused && !state.paused) state.resumePhase = state.phase;
      state.paused = paused;
      if (!paused && (state.resumeContinuePending || state.taskStatus === "finished" || state.taskStatus === "blocked")) {
        state.taskStatus = "ongoing";
        // A deliberate user Resume starts a new attempt; otherwise a blocked
        // conversation gets at most one automated reconsideration.
        state.blockedReviewAttempted = false;
        state.resumeContinuePending = true;
        state.resumePhase = null;
        state.retryAt = null;
        state.actionStartedAt = null;
        state.actionPrompt = "";
        state.recoveryCheckPrompt = "";
        state.issue = "";
      }
      state.phase = paused ? "paused" : state.resumePhase || "watching";
      await persistRuntime();
      await recordDiagnostic("pause-changed", { tabId, reason: paused ? "paused" : "resumed", phase: state.phase });
      sendResponse({ ok: true, paused: state.paused });
      return;
    }

    if (message.type === "retryNow") {
      const tabId = Number(message.tabId);
      if (!targetMatches(tabId)) {
        sendResponse({ ok: false, error: "No task is being monitored." });
        return;
      }
      const state = getState(tabId, states.get(tabId)?.url || "");
      if (state.paused) {
        sendResponse({ ok: false, error: "Resume monitoring before retrying." });
        return;
      }
      state.lastResponseKey = "";
      state.lastRecoveryKey = "";
      state.lastRecoveryAt = null;
      state.recoveryStreak = 0;
      const pendingAction = ["sending-handoff", "sending-continue", "sending-block-review"].includes(state.phase);
      if (!pendingAction && state.phase !== "waiting-for-block-review") state.phase = "watching";
      state.sendFailures = 0;
      state.retryAt = pendingAction ? Date.now() : null;
      state.issue = "";
      const handoff = pendingHandoffs.get(tabId);
      if (handoff) {
        handoff.deliveryFailed = false;
        handoff.attempts = 0;
        handoff.retryAt = null;
      }
      await persistRuntime();
      await injectTargetTab(tabId);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "manualSwap") {
      const tabId = Number(message.tabId);
      if (manualSwapsInFlight.has(tabId)) {
        sendResponse({ ok: false, error: "Handoff is already starting." });
        return;
      }
      manualSwapsInFlight.add(tabId);
      try {
        let needsAttachment = false;
        if (!targetMatches(tabId)) {
          let tab;
          try { tab = await chrome.tabs.get(tabId); } catch { /* The tab may have closed. */ }
          if (!Number.isInteger(tabId) || !isConversationUrl(tab?.url || "")) {
            sendResponse({ ok: false, error: "Open a ChatGPT conversation first." });
            return;
          }
          settings.targetTabIds.push(tabId);
          settings.enabled = true;
          const oneShot = newState(tab.url, null, tabId);
          oneShot.oneShotHandoff = true;
          states.set(tabId, oneShot);
          await Promise.all([persistSettings(), persistRuntime()]);
          await recordDiagnostic("monitoring-changed", { tabId, reason: "started" });
          syncKeepAwake();
          needsAttachment = true;
        }
        if (pendingHandoffs.has(tabId)) {
          sendResponse({ ok: false, error: "A captured handoff is awaiting delivery. Use Retry to resume it." });
          return;
        }
        const state = getState(tabId, states.get(tabId)?.url || "");
        if (["sending-handoff", "waiting-for-handoff", "opening-new-chat"].includes(state.phase)) {
          sendResponse({ ok: false, error: "Handoff is already in progress." });
          return;
        }
        if (state.taskStatus === "finished" || state.taskStatus === "blocked") {
          sendResponse({ ok: false, error: "This task has already stopped." });
          return;
        }
        if (state.paused) {
          state.paused = false;
          state.resumePhase = null;
          await recordDiagnostic("pause-changed", { tabId, reason: "resumed", phase: state.phase });
        }
        const manualHandoffPrompt = addGoalContract(handoffPrompt());
        state.recoveryCheckPrompt = "";
            state.handoffShortRetryUsed = false;
        requestHandoff(state, manualHandoffPrompt, "manual-handoff");
        await persistRuntime();
        try {
          if (needsAttachment) await injectTargetTab(tabId);
          const result = await chrome.tabs.sendMessage(tabId, {
            type: "manualSwap",
            prompt: manualHandoffPrompt,
            expectedUrl: state.url,
          });
          sendResponse(result?.ok === true
            ? { ok: true }
            : { ok: false, error: "Could not stop the response or submit the handoff." });
        } catch {
          if (needsAttachment) {
            settings.targetTabIds = settings.targetTabIds.filter((id) => id !== tabId);
            settings.enabled = settings.targetTabIds.length > 0;
            states.delete(tabId);
            lastSeenAt.delete(tabId);
            lastDiagnosticHeartbeatAt.delete(tabId);
            lastRecoveryAttemptAt.delete(tabId);
            await Promise.all([persistSettings(), persistRuntime()]);
            await recordDiagnostic("monitoring-changed", { tabId, reason: "stopped" });
            syncKeepAwake();
            sendResponse({ ok: false, error: "Could not reach this ChatGPT tab. Refresh it and retry." });
          } else {
            state.phase = "watching";
            state.issue = "Could not reach the monitored page. Refresh ChatGPT and retry.";
            await persistRuntime();
            sendResponse({ ok: false, error: state.issue });
          }
        }
      } finally {
        manualSwapsInFlight.delete(tabId);
      }
      return;
    }

    if (message.type === "manualContinue") {
      const tabId = Number(message.tabId);
      if (!targetMatches(tabId)) {
        sendResponse({ ok: false, error: "No task is being monitored." });
        return;
      }
      if (pendingHandoffs.has(tabId)) {
        sendResponse({ ok: false, error: "A captured handoff is awaiting delivery. Use Retry to resume it." });
        return;
      }
      const state = getState(tabId, states.get(tabId)?.url || "");
      if (state.paused) {
        sendResponse({ ok: false, error: "Resume monitoring before continuing manually." });
        return;
      }
      if (state.taskStatus === "finished" || state.taskStatus === "blocked") {
        sendResponse({ ok: false, error: "This task has already stopped." });
        return;
      }
      state.recoveryCheckPrompt = "";
      const manualContinuePrompt = requestContinue(state, undefined, "manual-continue").prompt;
      await persistRuntime();
      try {
        const result = await chrome.tabs.sendMessage(tabId, {
          type: "manualContinue",
          prompt: manualContinuePrompt,
          expectedUrl: state.url,
        });
        sendResponse(result?.ok === true
          ? { ok: true }
          : { ok: false, error: "Could not confirm the continuation was submitted." });
      } catch {
        state.phase = "watching";
        state.issue = "Could not reach the monitored page. Refresh ChatGPT and retry.";
        await persistRuntime();
        sendResponse({ ok: false, error: state.issue });
      }
      return;
    }

    const tabId = sender.tab?.id;

    if (message.type === "modelPreferenceResult") {
      if (targetMatches(tabId)) {
        const state = getState(tabId, sender.tab?.url || "");
        const issues = {
          "picker-unavailable": "Waiting for the model picker. Retrying automatically.",
          "model-unavailable": "The selected model is unavailable. Check the model setting.",
          "reasoning-unavailable": "The selected reasoning level is unavailable. Check the reasoning setting.",
        };
        if (message.ok) {
          if (state.modelPreferenceIssue && state.issue.startsWith(state.modelPreferenceIssue)) state.issue = "";
          state.modelPreferenceIssue = "";
          if (message.changed) await recordDiagnostic("model-selection-changed", { tabId, success: true });
        } else if (issues[message.reason]) {
          state.modelPreferenceIssue = issues[message.reason];
          state.issue = state.modelPreferenceIssue;
          if (!message.repeated) await recordDiagnostic("model-selection-failed", { tabId, reason: message.reason, success: false });
        }
        await persistRuntime();
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "diagnosticEvent") {
      const allowedReasons = new Set([
        "timer-started", "notice-or-generation-ended", "configured-limit", "ten-minute-limit",
        "stop-control-visible", "stop-control-disappeared", "stop-control-remained-visible",
        "devspace", "permission-card", "conversation-scope",
        "chevron-not-ready", "chevron-missing", "conversation-option-not-found", "card-did-not-close",
      ]);
      if (targetMatches(tabId)
          && DIAGNOSTIC_EVENTS.has(message.event)
          && (message.event.startsWith("watchdog-") || message.event.startsWith("approval_"))
          && allowedReasons.has(message.reason)) {
        await recordDiagnostic(message.event, {
          tabId,
          reason: message.reason,
          elapsedMs: message.elapsedMs,
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "isTargetTab") {
      const target = targetMatches(tabId);
      const now = Date.now();
      if (target) {
        lastSeenAt.set(tabId, now);
        if (now - (lastDiagnosticHeartbeatAt.get(tabId) || 0) >= 5 * 60 * 1000) {
          lastDiagnosticHeartbeatAt.set(tabId, now);
          const current = states.get(tabId);
          void recordDiagnostic("heartbeat", {
            tabId, phase: current?.phase || "watching", workedSeconds: workedTotal(current, now),
          });
        }
      }
      const state = target ? states.get(tabId) : null;
      sendResponse({ target: targetMatches(tabId), paused: Boolean(state?.paused),
        pendingDelivery: pendingHandoffs.has(tabId), scanHistory: state?.historyScanned !== true,
        thinkingMinutes: settings.thinkingMinutes,
        enforceModelPreferences: settings.enforceModelPreferences !== false,
        preferredModel: settings.preferredModel, preferredReasoning: settings.preferredReasoning });
      return;
    }

    if (message.type === "historyScanComplete") {
      if (targetMatches(tabId)) {
        const state = getState(tabId, message.url || sender.tab?.url || "");
        const measured = Math.max(0, Number(message.workedSeconds) || 0);
        state.historyWorkedSeconds = Math.max(
          measured - (Number(state.trackedSeconds) || 0),
          Number(state.historyWorkedSeconds) || 0,
        );
        state.maxWorkedSeconds = Math.max(measured, Number(state.maxWorkedSeconds) || 0);
        state.historyScanned = true;
        await persistRuntime();
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "getPendingHandoff") {
      const handoff = pendingHandoffs.get(tabId);
      if (handoff && !validHandoffText(handoff.text)) {
        pendingHandoffs.delete(tabId);
        const state = getState(tabId, message.url || sender.tab?.url || "");
        state.phase = "waiting-for-handoff";
        state.issue = "The captured handoff was incomplete. The fresh chat was not started.";
        await persistRuntime();
        sendResponse({ prompt: null });
        return;
      }
      sendResponse({
        prompt: targetMatches(tabId) && !states.get(tabId)?.paused && handoff
          && (!handoff.deliveryFailed || (handoff.retryAt && Date.now() >= handoff.retryAt))
          ? relayPrompt(handoff.text)
          : null,
      });
      return;
    }

    if (message.type === "handoffDelivered") {
      if (targetMatches(tabId) && pendingHandoffs.has(tabId)) {
        pendingHandoffs.delete(tabId);
        if (states.get(tabId)?.oneShotHandoff) {
          settings.targetTabIds = settings.targetTabIds.filter((id) => id !== tabId);
          settings.enabled = settings.targetTabIds.length > 0;
          states.delete(tabId);
          lastSeenAt.delete(tabId);
          lastDiagnosticHeartbeatAt.delete(tabId);
          lastRecoveryAttemptAt.delete(tabId);
          await Promise.all([persistSettings(), persistRuntime()]);
          await recordDiagnostic("monitoring-changed", { tabId, reason: "stopped" });
          syncKeepAwake();
        } else {
          const freshState = newState(sender.tab?.url || message.url || "", states.get(tabId), tabId);
          freshState.awaitingFreshConversation = !freshState.conversationKey.includes("/c/");
          states.set(tabId, freshState);
          await persistRuntime();
        }
        await recordDiagnostic("handoff-delivered", { tabId });
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "handoffCaptured") {
      if (targetMatches(tabId) && validHandoffText(message.text)) {
        const state = getState(tabId, message.url || sender.tab?.url || "");
        pendingHandoffs.set(tabId, {
          text: message.text.slice(0, 40000),
        });
        state.phase = "opening-new-chat";
        state.issue = "";
        await persistRuntime();
        await recordDiagnostic("handoff-captured", { tabId });
        sendResponse({ ok: true });
        return;
      }
      if (targetMatches(tabId)) {
        const state = getState(tabId, message.url || sender.tab?.url || "");
        state.phase = "waiting-for-handoff";
        state.issue = "The handoff response was incomplete. Use Retry when ChatGPT is ready.";
        await persistRuntime();
      }
      sendResponse({ ok: false });
      return;
    }

    if (["conversationLoadRetry", "conversationLoadRecovered"].includes(message.type)) {
      let allowed = false;
      if (targetMatches(tabId)) {
        const state = getState(tabId, message.url || sender.tab?.url || "");
        if (!state.paused) {
          allowed = true;
          if (message.type === "conversationLoadRetry") {
            state.issue = "ChatGPT could not load this conversation. Retrying with increasing delays.";
          } else {
            state.issue = "";
            state.sendFailures = 0;
            if (["sending-handoff", "sending-continue", "sending-block-review"].includes(state.phase)) state.retryAt = Date.now();
          }
          await persistRuntime();
        }
      }
      sendResponse({ ok: allowed });
      return;
    }

    if (["extendedThinkingRecoveryReady", "extendedThinkingStopFailed"].includes(message.type)) {
      if (!targetMatches(tabId)) {
        sendResponse({});
        return;
      }
      const state = getState(tabId, message.url || sender.tab?.url || "");
      if (message.type === "extendedThinkingStopFailed") {
        await recordDiagnostic("watchdog-stop-failed", {
          tabId,
          reason: "stop-control-remained-visible",
          elapsedMs: settings.thinkingMinutes * 60 * 1000,
        });
        if (!state.paused) {
          state.issue = Number(message.attempt) >= 3
            ? "ChatGPT did not stop after three attempts. Use Retry."
            : "ChatGPT did not stop. Retrying shortly.";
          await persistRuntime();
        }
        sendResponse({ ok: false });
        return;
      }
      if (state.paused || state.taskStatus !== "ongoing" || pendingHandoffs.has(tabId)) {
        sendResponse({});
        return;
      }
      const action = requestRecoveryCheck(state);
      await persistRuntime();
      sendResponse(action);
      return;
    }

    if (message.type === "commandResult") {
      if (targetMatches(tabId)) {
        // Ignore completion from a prior conversation after this tab moved.
        // Do not let a stale acknowledgement reset the new conversation state.
        const current = states.get(tabId);
        if (current && !pendingHandoffs.has(tabId) && message.url
            && conversationKey(message.url) !== current.conversationKey) {
          sendResponse({ ok: false });
          return;
        }
        const state = getState(tabId, message.url || sender.tab?.url || "");
        await recordDiagnostic("action-result", {
          tabId,
          source: state.actionSource || "automatic",
          action: message.action,
          promptMode: state.actionPromptMode || promptKind(message.action, state.actionPrompt),
          phase: state.phase,
          success: Boolean(message.ok),
          attempt: (state.sendFailures || 0) + 1,
        });
        state.actionSource = "";
        state.actionPromptMode = "none";
        if (state.paused && state.resumePhase) state.phase = state.resumePhase;
        if (!message.ok) {
          const pendingHandoff = pendingHandoffs.get(tabId);
          if (pendingHandoff && ["enableDevSpace", "deliverHandoff"].includes(message.action)) {
            pendingHandoff.deliveryFailed = true;
            pendingHandoff.attempts = (pendingHandoff.attempts || 0) + 1;
            pendingHandoff.retryAt = pendingHandoff.attempts < 3
              ? Date.now() + 30000 * pendingHandoff.attempts : null;
          }
          const retryable = ["sendHandoff", "sendContinue", "sendBlockedReview"].includes(message.action);
          if (retryable) {
            state.sendFailures = (state.sendFailures || 0) + 1;
            state.retryAt = state.sendFailures < 3 ? Date.now() + 30000 * state.sendFailures : null;
          } else if (message.action === "rotateWithHandoff" && !state.handoffShortRetryUsed) {
            state.handoffShortRetryUsed = true;
            state.retryAt = Date.now() + 30000;
            state.phase = "waiting-for-handoff";
            state.actionPrompt = "";
          } else {
            state.actionStartedAt = null;
            state.actionPrompt = "";
            state.phase = message.action === "rotateWithHandoff" ? "waiting-for-handoff" : "opening-new-chat";
          }
          const issueByAction = {
            rotateWithHandoff: "Could not capture the handoff.",
            enableDevSpace: "Could not enable DevSpace in the fresh chat.",
            deliverHandoff: "Could not submit the handoff in the fresh chat.",
          };
          state.issue = state.modelPreferenceIssue || issueByAction[message.action] || "Could not submit the prompt.";
          if (state.retryAt || pendingHandoff?.retryAt) state.issue += " Retrying shortly.";
          if (state.paused) {
            state.resumePhase = state.phase;
            state.phase = "paused";
          }
          await persistRuntime();
        } else {
          state.sendFailures = 0;
          state.retryAt = null;
          markTransientActionAccepted(state);
          if (state.paused) {
            state.resumePhase = state.phase;
            state.phase = "paused";
          }
          state.issue = "";
          await persistRuntime();
        }
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type !== "status" || !targetMatches(tabId)) {
      sendResponse({});
      return;
    }

    lastSeenAt.set(tabId, Date.now());

    const url = message.url || sender.tab?.url || "";
    if (!isConversationUrl(url)) {
      sendResponse({});
      return;
    }

    const state = getState(tabId, url);
    if (state.paused) {
      if (state.activeStartedAt) {
        state.trackedSeconds = (Number(state.trackedSeconds) || 0)
          + Math.max(0, (Date.now() - state.activeStartedAt) / 1000);
        state.activeStartedAt = null;
      }
      if (state.phase !== "paused") state.phase = "paused";
      await persistRuntime();
      sendResponse({});
      return;
    }
    {
      state.maxWorkedSeconds = Math.max(
        Number(state.maxWorkedSeconds) || 0,
        Number(message.workedSeconds) || 0,
      );
    }

    if (message.isGenerating) {
      let changed = false;
      if (!state.activeStartedAt) {
        state.activeStartedAt = Date.now();
        changed = true;
      }
      if (state.taskStatus !== "ongoing") {
        state.taskStatus = "ongoing";
        state.phase = "watching";
        state.actionStartedAt = null;
        state.actionPrompt = "";
        state.recoveryCheckPrompt = "";
        state.issue = "";
        changed = true;
      } else if (["sending-handoff", "sending-continue", "sending-block-review"].includes(state.phase)) {
        // Generation may belong to the previous user message (manual handoff
        // can stop it). It is not proof that our prompt was submitted.
      } else if (state.phase === "waiting-for-block-review") {
        // A review response is being generated. It does not turn the review
        // into a normal working phase or trigger an early handoff.
      } else if (
        thresholdReached(state)
        && state.phase !== "waiting-for-handoff"
        && state.phase !== "threshold-waiting"
      ) {
        state.phase = "threshold-waiting";
        changed = true;
      } else if (state.phase === "watching") {
        state.phase = "working";
        changed = true;
      }
      if (changed) await persistRuntime();
      sendResponse({});
      return;
    }

    if (state.activeStartedAt) {
      state.trackedSeconds = (Number(state.trackedSeconds) || 0)
        + Math.max(0, (Date.now() - state.activeStartedAt) / 1000);
      state.activeStartedAt = null;
      await persistRuntime();
    }

    if (state.resumeContinuePending) {
      // Resume explicitly requests a continuation, even if the last visible
      // response is an old terminal marker. Wait for an idle, empty composer.
      if (message.composerEmpty === false) { sendResponse({}); return; }
      state.resumeContinuePending = false;
      state.lastResponseKey = message.responseKey || state.lastResponseKey;
      const result = requestContinue(state, undefined, "manual-continue");
      await persistRuntime();
      sendResponse(result);
      return;
    }

    if (["sending-continue", "sending-handoff", "sending-block-review"].includes(state.phase)
        && !state.retryAt) {
      // An old response may remain visible until the submitted prompt starts
      // its own turn. Do not act on it before a real send acknowledgement.
      if (transientActionTimedOut(state)) {
        if (sameSubmittedPrompt(message.latestUserText, state.actionPrompt)
            && message.composerEmpty !== false) {
          markTransientActionAccepted(state);
          await persistRuntime();
          sendResponse({});
          return;
        }
        if (!state.issue) {
          const retry = retryTransientAction(state);
          await persistRuntime();
          sendResponse(retry);
          return;
        }
      }
      sendResponse({});
      return;
    }

    if (state.retryAt && (state.phase === "sending-block-review"
        || !terminalStatus(message.latestResponseText))) {
      // A missing acknowledgement is reconciled before another click.
      if (sameSubmittedPrompt(message.latestUserText, state.actionPrompt) && message.composerEmpty) {
        markTransientActionAccepted(state);
        state.retryAt = null;
        state.issue = "";
        await persistRuntime();
      } else if (Date.now() >= state.retryAt) {
        state.retryAt = null;
        const result = retryTransientAction(state);
        await persistRuntime();
        sendResponse(result);
        return;
      } else {
        sendResponse({});
        return;
      }
    }

    // ChatGPT can stop generating without rendering a final answer. The
    // composer is idle, so recover once for this turn even without an error card.
    if (message.recoveryKey && message.recoveryKey !== state.lastRecoveryKey
        && state.taskStatus === "ongoing" && !message.latestResponseText) {
      if (state.phase === "waiting-for-block-review") {
        state.paused = true;
        state.phase = "paused";
        state.issue = "The reconsideration reply could not be read. Check ChatGPT, then Resume if more work is possible.";
        await persistRuntime();
        sendResponse({});
        return;
      }
      if (state.recoveryCheckPrompt) {
        state.paused = true;
        state.phase = "paused";
        state.issue = "Could not read the check-in reply. Check ChatGPT, then Resume.";
        state.recoveryCheckPrompt = "";
        state.resumeContinuePending = true;
        state.actionPrompt = "";
        state.actionStartedAt = null;
        state.retryAt = null;
        await recordDiagnostic("pause-changed", { tabId, reason: "unreadable-check-in", phase: "paused" });
        await persistRuntime();
        sendResponse({});
        return;
      }
      const cooldown = Math.min(300000, 30000 * 2 ** Math.max(0, (state.recoveryStreak || 1) - 1));
      if (state.lastRecoveryAt && Date.now() - state.lastRecoveryAt < cooldown) {
        const issue = "ChatGPT interrupted again. Waiting briefly before continuing.";
        if (state.issue !== issue) {
          state.issue = issue;
          await persistRuntime();
        }
        sendResponse({});
        return;
      }
      state.recoveryStreak = state.lastRecoveryAt && Date.now() - state.lastRecoveryAt < 600000
        ? (state.recoveryStreak || 0) + 1 : 1;
      state.lastRecoveryAt = Date.now();
      state.lastRecoveryKey = message.recoveryKey;
      const result = state.recoveryCheckPrompt
        ? requestRecoveryCheck(state, "stream-recovery")
        : handoffInProgress(state)
        ? requestHandoff(state)
        : requestAutomaticFollowUp(state, "stream-recovery");
      await persistRuntime();
      sendResponse(result);
      return;
    }

    // A generation-ended edge can arrive before ChatGPT has mounted its final
    // response. Treat only a new rendered assistant response as actionable.
    const isNewResponse = Boolean(
      message.responseKey && message.responseKey !== state.lastResponseKey,
    );
    // Only the reply to our reconsideration can resolve the blocked state.
    // A stale assistant turn must not be accepted as the review's answer.
    if (state.phase === "waiting-for-block-review"
        && (!isNewResponse || !sameSubmittedPrompt(message.latestUserText, BLOCKED_REVIEW_PROMPT))) {
      sendResponse({});
      return;
    }
    if (state.phase === "waiting-for-block-review" && !message.latestResponseText) {
      // The review may still be mounting. Do not consume the turn or lose the
      // review state until a readable answer or a clear recovery error arrives.
      sendResponse({});
      return;
    }
    if (state.recoveryCheckPrompt && isNewResponse
        && !sameSubmittedPrompt(message.latestUserText, state.recoveryCheckPrompt)) {
      sendResponse({});
      return;
    }
    const terminal = isNewResponse ? terminalStatus(message.latestResponseText) : null;
    if (terminal) {
      if (terminal === "blocked" && !state.blockedReviewAttempted) {
        // An unsubmitted user draft must never be overwritten by automation.
        if (message.composerEmpty === false) { sendResponse({}); return; }
        state.lastResponseKey = message.responseKey;
        const review = requestBlockedReview(state);
        await persistRuntime();
        sendResponse(review);
        return;
      }
      if (state.recoveryCheckPrompt) void recordDiagnostic("recovery-check-completed", { tabId });
      state.recoveryCheckPrompt = "";
      state.lastResponseKey = message.responseKey || state.lastResponseKey;
      state.taskStatus = terminal;
      state.paused = true;
      state.resumeContinuePending = false;
      state.resumePhase = null;
      state.retryAt = null;
      state.phase = "paused";
      state.actionStartedAt = null;
      state.actionPrompt = "";
      state.issue = "";
      await recordDiagnostic("pause-changed", { tabId, reason: terminal, phase: "paused" });
      await persistRuntime();
      sendResponse({});
      return;
    }

    if (!isNewResponse) {
      if (!state.issue && transientActionTimedOut(state)) {
        if (sameSubmittedPrompt(message.latestUserText, state.actionPrompt)) {
          markTransientActionAccepted(state);
          await persistRuntime();
          sendResponse({});
          return;
        }
        const result = retryTransientAction(state);
        await persistRuntime();
        sendResponse(result);
        return;
      }
      if (
        !state.issue
        && !state.recoveryCheckPrompt
        && thresholdReached(state)
        && ["watching", "working", "threshold-waiting"].includes(state.phase)
      ) {
        const result = requestHandoff(state);
        await persistRuntime();
        sendResponse(result);
        return;
      }
      if (!state.recoveryCheckPrompt && (state.phase === "working" || state.phase === "threshold-waiting")) {
        state.phase = "watching";
        await persistRuntime();
      }
      sendResponse({});
      return;
    }

    if (message.responseKey) state.lastResponseKey = message.responseKey;
    state.recoveryStreak = 0;
    state.lastRecoveryAt = null;
    state.issue = "";

    // Never send another prompt when ChatGPT has not exposed readable final
    // text yet. A later DOM mutation/resume scan will retry the same turn.
    if (!message.latestResponseText) {
      state.phase = "watching";
      state.issue = "Waiting for ChatGPT to expose the completed response.";
      await persistRuntime();
      sendResponse({});
      return;
    }
    if (state.recoveryCheckPrompt) {
      void recordDiagnostic("recovery-check-completed", { tabId });
      state.recoveryCheckPrompt = "";
    }
    if (state.phase === "waiting-for-block-review") state.phase = "watching";
    if (handoffInProgress(state)) {
      const result = completedHandoffAction(state, message.latestResponseText, message.latestResponseIsSubstantive);
      await persistRuntime();
      sendResponse(result);
      return;
    }

    const result = requestAutomaticFollowUp(state);
    await persistRuntime();
    sendResponse(result);
    return;
  })().catch((error) => {
    console.error("ChatGPT Agent Monitor", error);
    sendResponse({});
  });

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  states.delete(tabId);
  lastSeenAt.delete(tabId);
  lastDiagnosticHeartbeatAt.delete(tabId);
  lastRecoveryAttemptAt.delete(tabId);
  pendingHandoffs.delete(tabId);
  delete settings.tabContinuePresets?.[tabId];
  if (settings.targetTabIds.includes(tabId)) {
    settings.targetTabIds = settings.targetTabIds.filter((id) => id !== tabId);
    settings.enabled = settings.targetTabIds.length > 0;
  }
  await persistSettings();
  await persistRuntime();
  syncKeepAwake();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "monitor-recovery") return;
  await ready;
  if (!settings.enabled) return;

  syncKeepAwake();

  await validateTargetTabs();
  for (const tabId of settings.targetTabIds) {
    const lastSeen = lastSeenAt.get(tabId) || 0;
    if (Date.now() - lastSeen < 30000) continue;
    const state = states.get(tabId);
    if (
      ["sending-continue", "sending-handoff"].includes(state?.phase)
      && !transientActionTimedOut(state)
    ) continue;
    await injectTargetTab(tabId);
  }
});

ensureRecoveryAlarm();
