if (typeof importScripts === "function") importScripts("log-files.js");

const DEFAULT_SETTINGS = {
  preferredModel: "GPT-5.6 Sol",
  preferredReasoning: "high",
  enforceModelPreferences: true,
  reviewWorkflow: false,
  housekeeping: false,
  globalAgentInstructions: "",
  enabled: false,
  targetTabIds: [],
  thresholdMinutes: 130,
  thinkingMinutes: 10,
  pluginName: "DevSpace",
  handoffPrompt:
    "Write a concise handoff for an agent resuming this task in a fresh chat. Give the workspace path when available, the original goal and constraints, what is verified, what remains uncertain, and the most useful next steps. Point to the current files or evidence the next agent needs. Include past decisions when they prevent repeated work. If needed, save essential results before handing off.",
  continuePrompt:
    "Continue the original user task. Check the current state, identify the most useful unfinished step within the agreed scope, perform it with available authorized tools, and verify the result. Work through meaningful remaining steps before stopping. Do not repeat settled work, widen the goal, or invent extra tasks just to keep working. If the goal is already complete or genuinely blocked, say so instead of creating more work.",
  continuePresetIndex: 0,
  continuePresets: null,
  tabContinuePresets: {},
  tabControls: {},

};

const LEGACY_GOAL_CONTRACT =
  "Completion contract: Work only toward the original user's goal and constraints. Complete useful, authorized steps and verify results; do not invent extra work. When the original goal is complete and verified, end with TASK_FINISHED on a line by itself. If you cannot proceed without user action after checking reasonable alternatives, explain the blocker and end with TASK_BLOCKED on a line by itself. Otherwise use neither marker and keep working on the original goal.";

const CONTINUE_TERMINAL_NOTE =
  "If the original task is complete and verified, end with TASK_FINISHED on its own final line. If no authorized progress is possible without user action, end with TASK_BLOCKED on its own final line.";

const GOAL_CONTRACT = `Goal contract\n${CONTINUE_TERMINAL_NOTE} Otherwise use neither marker and keep working toward the original goal.`;

const AUTOMATION_NOTE =
  "This is an automated continuation. Use your judgment. Pick up the original goal from its current state and apply the guidance below where it helps.";

const LEGACY_AUTOMATION_NOTE =
  "This is an automated continuation message and may be sent repeatedly. Continue the original user task. Treat the selected prompt below as contextual guidance for the next useful step: follow it when relevant to the current state, but do not restart settled work, create a new goal, or invent work just because this message repeated.";

const HOUSEKEEPING_GUIDANCE =
  "Make the active work easy to find, understand, and maintain. Use your judgment to consolidate scattered work and remove redundant code, tests, docs, or artifacts where it helps. Preserve useful checks, unique evidence, and unrelated work. Finish when the next person or agent can pick up the work easily and further cleanup would add little value.";

const GIT_GUIDANCE =
  "If the task calls for commits, group related changes into one meaningful checkpoint per coherent decision. Let work accumulate while a decision is still in progress. Use the project's style. Write a title that explains why the change matters and a body that records the reason, evidence, and what a reviewer may need to rerun.";

const GOAL_TURNS_PER_ROUND = 3;
// Estimated 128k context plus 16k headroom, at 809 tokens per 9.5 seconds.
const INSTRUCTION_REFRESH_SECONDS = Math.ceil(144000 * 9.5 / 809);
const GLOBAL_INSTRUCTIONS_HEADER = "\n\nGlobal AGENTS.md (user instructions)\n";
const GIT_INSTRUCTIONS_HEADER = "\n\nGit guidance from global AGENTS.md\n";

function customContinueText(text) {
  const original = String(text || "");
  let cleaned = promptWithoutInstructions(original.trim())
    .replace(/^this is an? automated system message\(\(user may include[\s\S]*?extra notes\/messages\)\.?\s*/i, '')
    .trim();
  const preamble = [AUTOMATION_NOTE, LEGACY_AUTOMATION_NOTE].find(note => cleaned.startsWith(note));
  if (preamble) cleaned = cleaned.slice(preamble.length).trim();
  const contract = [GOAL_CONTRACT, LEGACY_GOAL_CONTRACT, CONTINUE_TERMINAL_NOTE]
    .find(note => cleaned.endsWith(note));
  if (contract) cleaned = cleaned.slice(0, -contract.length).trim();
  return cleaned === original.trim() ? original : cleaned;
}
const RECOVERY_CHECK_PROMPT = "Just reply to me: how is everything? Give me a brief, honest, realistic update on the current state and progress.";

function promptWithoutInstructions(prompt) {
  return String(prompt || "").split(GLOBAL_INSTRUCTIONS_HEADER)[0].split(GIT_INSTRUCTIONS_HEADER)[0];
}

function globalInstructionSuffix() {
  if (!settings.globalAgentInstructions) return "";
  return `${GLOBAL_INSTRUCTIONS_HEADER}Apply these instructions within the original task. If working in a project, reread its applicable AGENTS.md files.\n\n${settings.globalAgentInstructions}`;
}

function globalGitGuidance() {
  const lines = settings.globalAgentInstructions.split(/\r?\n/);
  const start = lines.findIndex(line => /^#{1,6}\s+git\s*#*\s*$/i.test(line));
  if (start < 0) return "";
  const depth = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((line, index) => index > start
    && (line.match(/^(#{1,6})\s+/)?.[1].length ?? Infinity) <= depth);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

function continuationPrompt(text) {
  return `${AUTOMATION_NOTE}\n\n${text.trim() || "Continue."}\n\n${GOAL_CONTRACT}`;
}

const CYCLE_GUIDANCE = new Map([
  ["improve", "Improve the agent harness where it will most help the remaining work. Use recent delays, errors, or poor evidence to choose what to improve. Try a new tool or replace the workflow if that would help more. Finish once you verify a meaningful gain in speed, reliability, or evidence quality on representative work, or judge that further changes would add little value."],
  ["housekeeping", `${HOUSEKEEPING_GUIDANCE}\n\n${GIT_GUIDANCE}`],
]);

function cycleTaskPrompt(task) {
  const guidance = CYCLE_GUIDANCE.get(task);
  if (!guidance) return "";
  const marker = task.toUpperCase();
  const label = task === "improve" ? "Improve" : "Housekeeping";
  return `This is an automated continuation. Use your judgment and pick up this step from where it stands.\n\n${label} contract\n${guidance}\n\nEnd with ${marker}_FINISHED on its own final line when this step is done, including when no worthwhile change is needed. If something prevents useful work on this step, explain why and end with ${marker}_BLOCKED. Use neither marker while work on this step remains. The Goal contract resumes separately.`;
}

function sameSubmittedPrompt(actual, expected) {
  const normalize = (text) => String(text || "").trim().replace(/\s+/g, " ");
  const sent = normalize(expected);
  const shown = normalize(actual);
  if (!sent) return false;
  if (shown === sent) return true;
  const custom = String(settings?.pluginName || "").trim().toLowerCase().replace(/[^a-z0-9\s]+/g, "").replace(/\s+/g, "\\s*");
  const pattern = new RegExp(`^@?(?:${[custom, "dev\\s*space", "spacedev"].filter(Boolean).join("|")})\\s+`, "i");
  return shown.replace(pattern, "") === sent;
}

function handoffPrompt() {
  return `${settings.handoffPrompt.trim()} Include the state of any active Improve or Housekeeping work. Reply with the handoff only.`;
}

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
const cyclePromptsInFlight = new Set();
const MAX_DIAGNOSTIC_EVENTS = 500;
const DIAGNOSTIC_EVENTS = new Set([
  "approval_detected", "approval_resolved", "approval_pending",
  "model-selection-changed", "model-selection-failed", "model-selection-verified",
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
  "prompt-submission-failed",
  "recovery-check-completed",
  "cycle-step-ended",
  "response-recovery",
  "logging-configured",
  "handoff-incomplete",
  "handoff-captured",
  "handoff-delivered",
  "heartbeat",
]);
const DIAGNOSTIC_PROMPT_MODES = new Set(["recovery-check", "custom-continue", "workflow-review", "housekeeping", "handoff", "terminal-review", "none"]);
const CONTENT_DIAGNOSTIC_REASONS = new Set([
  "timer-started", "notice-or-generation-ended", "notice-disappeared", "generation-ended", "monitor-reset",
  "configured-limit", "ten-minute-limit",
  "stop-control-visible", "stop-control-disappeared", "stop-control-remained-visible",
  "permission-card", "conversation-scope",
  "chevron-not-ready", "chevron-missing", "conversation-option-not-found", "card-did-not-close",
]);
let diagnosticWrites = Promise.resolve();
let settingsWrites = Promise.resolve();
let runtimeWrites = Promise.resolve();
let logFileError = "";
let settings = { ...DEFAULT_SETTINGS };
const ready = initialize();

function promptKind(action, prompt) {
  prompt = promptWithoutInstructions(prompt);
  if (action === "sendTerminalReview") return "terminal-review";
  if (action === "sendContinue" && prompt === RECOVERY_CHECK_PROMPT) return "recovery-check";
  if (action === "sendContinue") {
    if (prompt === cycleTaskPrompt("improve")) return "workflow-review";
    if (prompt === cycleTaskPrompt("housekeeping")) return "housekeeping";
    return "custom-continue";
  }
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
      "extended-thinking-threshold", "manual-continue", "manual-contract", "manual-handoff",
      "incomplete-handoff", "terminal-review",
    ]),
    action: new Set([
      "sendContinue", "sendHandoff", "rotateWithHandoff",
      "deliverHandoff", "sendTerminalReview",
    ]),
    phase: new Set([
      "watching", "working", "paused", "sending-continue", "waiting-for-response",
      "sending-handoff", "sending-terminal-review", "waiting-for-terminal-review",
      "waiting-for-handoff", "opening-new-chat", "threshold-waiting", "finished",
    ]),
    promptMode: DIAGNOSTIC_PROMPT_MODES,
    reviewCheck: new Set(["no-new-response", "user-message-missing", "prompt-mismatch", "reply-empty"]),
    observedTerminal: new Set(["blocked", "finished", "continue"]),
    contract: new Set(["goal", "improve", "housekeeping", "reconsider"]),
    reason: new Set([
      ...CONTENT_DIAGNOSTIC_REASONS,
      "started", "stopped", "paused", "resumed", "finished", "blocked",
      "unreadable-check-in",
      "connection-interrupted", "stream-error", "missing-final-answer",
      "review-reply-unconfirmed",
      "picker-unavailable", "model-unavailable", "reasoning-unavailable",
      "unknown", "monitor-not-ready", "composer-blocked", "composer-unavailable",
      "model-preference", "conversation-changed", "composer-changed",
      "composer-has-draft", "composer-insert-failed", "composer-text-mismatch",
      "plugin-selection-lost",
      "tab-unavailable", "content-attach-failed", "content-unreachable", "command-unconfirmed",
      "send-button-unavailable", "send-conditions-changed", "send-not-confirmed",
    ]),
  };
  for (const [key, values] of Object.entries(enumFields)) {
    if (typeof details[key] === "string" && values.has(details[key])) entry[key] = details[key];
  }
  if (Number.isInteger(details.tabId)) {
    entry.tabId = details.tabId;
    const state = states.get(details.tabId);
    const stage = state && cycleStage(details.tabId, state.cycleTask);
    if (!entry.contract && state) entry.contract = state.phase?.includes("terminal-review")
      ? "reconsider" : state.cycleTask || "goal";
    if (stage && (event === "action-requested" || event === "action-result" || event === "heartbeat")) {
      entry.cycleStep = stage.step;
      entry.cycleTotal = stage.total;
      if (entry.contract === "goal") entry.goalTurns = state.goalTurns || 0;
    }
  }
  if (typeof details.success === "boolean") entry.success = details.success;
  if (Number.isFinite(details.elapsedMs)) entry.elapsedMs = Math.max(0, details.elapsedMs);
  if (Number.isFinite(details.workedSeconds)) entry.workedSeconds = Math.max(0, Math.round(details.workedSeconds));
  if (Number.isInteger(details.attempt)) entry.attempt = details.attempt;
  if (details.instructionsAttached === true) entry.instructionsAttached = true;
  if (event === "model-selection-changed" || event === "model-selection-verified") {
    if (["GPT-6", "GPT-5.6 Sol", "GPT-5.5"].includes(details.model)) entry.model = details.model;
    if (["instant", "medium", "high"].includes(details.reasoning)) entry.reasoning = details.reasoning;
    if (typeof details.changed === "boolean") entry.changed = details.changed;
  }

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
  const [savedSettings, savedRuntime] = await Promise.all([
    chrome.storage.local.get("settings"),
    chrome.storage.local.get("runtime"),
  ]);

  settings = { ...DEFAULT_SETTINGS, ...(savedSettings.settings || {}) };
  if (typeof settings.pluginName !== "string" || !settings.pluginName.trim()) {
    settings.pluginName = DEFAULT_SETTINGS.pluginName;
  }
  let settingsChanged = false;

  settings.targetTabIds = Array.isArray(settings.targetTabIds)
    ? [...new Set(settings.targetTabIds.filter(Number.isInteger))]
    : [];
  settings.enabled = settings.targetTabIds.length > 0;

  settings.handoffPrompt = DEFAULT_SETTINGS.handoffPrompt;
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
    tabProfiles[id] = { index: profile.index };
  }
  settings.tabContinuePresets = tabProfiles;
  settings.continuePrompt = settings.continuePresets[settings.continuePresetIndex];
  if (!savedSettings.settings || settingsChanged) {
    await chrome.storage.local.set({ settings });
  }

  const runtime = savedRuntime.runtime || {};
  for (const [tabId, state] of Object.entries(runtime.states || {})) {
    const id = Number(tabId);
    state.tabId = id;
    const blockedReviewMigration = state.blockedReviewAttempted === true
      || ["sending-block-review", "waiting-for-block-review"].includes(state.phase);
    const persistedReviewPhase = [
      "sending-block-review", "waiting-for-block-review",
      "sending-terminal-review", "waiting-for-terminal-review",
    ].includes(state.phase);
    if (persistedReviewPhase && !state.terminalReviewPrompt && state.actionPrompt) {
      state.terminalReviewPrompt = state.actionPrompt;
    }
    // 1.5.44 used blocker-only review names. Preserve an in-flight review
    // during the 1.5.45 upgrade, then persist only the current state shape.
    if (state.phase === "sending-block-review") state.phase = "sending-terminal-review";
    if (state.phase === "waiting-for-block-review") state.phase = "waiting-for-terminal-review";
    delete state.terminalReviewAttempted;
    if (!state.terminalReviewKind && blockedReviewMigration) {
      state.terminalReviewKind = "blocked";
    }
    delete state.blockedReviewAttempted;
    if (!state.cycleTask && state.cycleStage?.label === "Improve harness") state.cycleTask = "improve";
    if (!state.cycleTask && state.cycleStage?.label === "Housekeeping") state.cycleTask = "housekeeping";
    if (!state.cycleTask && state.cycleStage?.label === "Follow-through") {
      state.cycleTask = state.cycleStage.step === 4 && controlsForTab(id).reviewWorkflow ? "improve" : "housekeeping";
    }
    delete state.cycleStage;
    delete state.lastCustomContinue;
    delete state.genericContinuesRemaining;
    delete state.pendingNormalContinue;
    delete state.queuedPrompt;
    delete state.lastReview;
    if (state.taskStatus === "finished" || state.taskStatus === "blocked") {
      state.paused = true;
      state.phase = "paused";
      state.activeStartedAt = null;
    }
    states.set(id, state);
  }
  for (const [tabId, handoff] of Object.entries(runtime.pendingHandoffs || {})) {
    pendingHandoffs.set(Number(tabId), handoff);
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
    cycleTask: "",
    goalTurns: 0,
    maxWorkedSeconds: 0,
    historyWorkedSeconds: 0,
    trackedSeconds: 0,
    activeStartedAt: null,
    historyScanned: false,
    lastResponseKey: "",
    terminalReviewKind: "",
    terminalReviewPrompt: "",
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

function trackedWork(state, now = Date.now()) {
  if (!state) return 0;
  const active = state.activeStartedAt
    ? Math.max(0, (now - state.activeStartedAt) / 1000)
    : 0;
  return (Number(state.trackedSeconds) || 0) + active;
}

function workedTotal(state, now = Date.now()) {
  if (!state) return 0;
  const baseline = Math.max(
    Number(state.historyWorkedSeconds) || 0,
    Number(state.maxWorkedSeconds) || 0,
  );
  return Math.max(baseline, (Number(state.historyWorkedSeconds) || 0)
    + trackedWork(state, now));
}

function handoffProgress(state) {
  if (!Number.isFinite(state?.handoffOffsetSeconds)) return workedTotal(state);
  return Math.max(0, state.handoffOffsetSeconds + trackedWork(state));
}

function thresholdReached(state) {
  const thresholdSeconds = Math.max(1, Number(settings.thresholdMinutes) || 130) * 60;
  return handoffProgress(state) >= thresholdSeconds;
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

function terminalStatus(text, task = "goal") {
  const finalLine = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || "";
  const marker = task === "goal" ? "TASK|GOAL" : task.toUpperCase();
  const outcomes = task === "reconsider" ? "FINISHED|BLOCKED|CONTINUE" : "FINISHED|BLOCKED";
  const match = finalLine.match(new RegExp(`^(?:${marker})[\\s_:-]*(${outcomes})[.!]?$`, "i"));
  return match ? match[1].toLowerCase() : null;
}

function relayPrompt(handoff, state) {
  const relay = `${HANDOFF_RELAY}\n\n${handoff}`;
  const activeStep = cycleTaskPrompt(state?.cycleTask);
  return activeStep ? `${relay}\n\nResume the current step first.\n\n${activeStep}`
    : `${relay}\n\n${continuationPrompt(customContinueText(continuePromptForTab(state?.tabId)))}`;
}


function validHandoffText(text) {
  const normalized = (text || "").trim();
  return normalized.length >= 200 && normalized.split(/\s+/).length >= 30;
}

function nextAction(state, phase, name, prompt) {
  const mode = promptKind(name, prompt);
  const retry = state.nextActionSource === "action-retry" && prompt === state.actionPrompt;
  if (!retry) {
    state.pendingInstructionRefreshAt = null;
    if (prompt && settings.globalAgentInstructions) {
      const worked = workedTotal(state);
      if (worked - (state.instructionRefreshAt || 0) >= INSTRUCTION_REFRESH_SECONDS) {
        prompt += globalInstructionSuffix();
        state.pendingInstructionRefreshAt = worked;
      } else if (mode === "housekeeping") {
        const git = globalGitGuidance();
        if (git) prompt += GIT_INSTRUCTIONS_HEADER + git;
      }
    }
  }
  if (state.phase !== phase) state.sendFailures = 0;
  state.retryAt = null;
  state.phase = phase;
  state.actionStartedAt = Date.now();
  state.actionPrompt = prompt || "";
  state.actionPromptMode = mode;
  if (name === "sendTerminalReview") state.terminalReviewPrompt = prompt;
  if (mode === "recovery-check") state.recoveryCheckPrompt = prompt;
  state.actionSource = state.nextActionSource || "automatic";
  state.nextActionSource = null;
  state.issue = "";
  void recordDiagnostic("action-requested", {
    tabId: state.tabId,
    source: state.actionSource,
    action: name,
    promptMode: mode,
    observedTerminal: name === "sendTerminalReview" ? state.terminalReviewKind : undefined,
    instructionsAttached: state.pendingInstructionRefreshAt != null,
    phase,
  });
  return { action: name, prompt };
}

function requestHandoff(state, prompt = handoffPrompt(), source = "automatic") {
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
    return requestHandoff(state, handoffPrompt(), "incomplete-handoff");
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

function controlsForTab(tabId) {
  return settings.tabControls?.[tabId] || settings;
}

function cycleTasks(tabId, active) {
  const { reviewWorkflow, housekeeping } = controlsForTab(tabId);
  const tasks = ["goal"];
  if (reviewWorkflow || active === "improve") tasks.push("improve");
  if (housekeeping || active === "housekeeping") tasks.push("housekeeping");
  return tasks;
}

function cycleStage(tabId, task) {
  const tasks = cycleTasks(tabId, task);
  const labels = { goal: "Goal", improve: "Improve", housekeeping: "Housekeeping" };
  return { step: tasks.indexOf(task || "goal") + 1, total: tasks.length, label: labels[task || "goal"] };
}

function requestContinue(state, prompt, source = "automatic") {
  if (prompt === undefined) {
    state.cycleTask ||= "goal";
    prompt = cycleTaskPrompt(state.cycleTask)
      || continuationPrompt(customContinueText(continuePromptForTab(state.tabId)));
  }
  state.nextActionSource = source;
  return nextAction(state, "sending-continue", "sendContinue", prompt);
}

function terminalReviewPromptFor(kind) {
  const review = kind === "blocked"
    ? "Check the exact blocker and look for a reasonable, authorized way to make progress."
    : "Check the original goal and acceptance criteria against the evidence. Verify any clear gap.";
  return `This is an automated check. Use your judgment.\n\nReconsider contract\n${review} Check only what you need to make the decision.\n\nOnce you have enough evidence, end with one marker on its own final line. Use RECONSIDER_FINISHED if the goal is verified. Use RECONSIDER_BLOCKED if progress needs user action and say what is needed. Use RECONSIDER_CONTINUE if you see a useful path and say what the Goal contract should do next. While the decision is still open, use no marker.`;
}

function requestTerminalReview(state, kind, prompt = terminalReviewPromptFor(kind), source = "terminal-review") {
  // Reconsider does not consume a Goal turn.
  state.terminalReviewKind = kind || state.terminalReviewKind || "finished";
  state.terminalReviewIdleSince = null;
  state.recoveryCheckPrompt = "";
  state.nextActionSource = source;
  return nextAction(state, "sending-terminal-review", "sendTerminalReview", prompt);
}

function requestRecoveryCheck(state, source = "extended-thinking-watchdog") {
  state.recoveryCheckPrompt = RECOVERY_CHECK_PROMPT;
  return requestContinue(state, RECOVERY_CHECK_PROMPT, source);
}


function requestAutomaticFollowUp(state, source = "completed-response") {
  return thresholdReached(state)
    ? requestHandoff(state, handoffPrompt(), source)
    : requestContinue(state, undefined, source);
}

function handoffInProgress(state) {
  return ["sending-handoff", "waiting-for-handoff"].includes(state.phase);
}


function markTransientActionAccepted(state) {
  if (state.pendingInstructionRefreshAt != null) {
    state.instructionRefreshAt = state.pendingInstructionRefreshAt;
    state.pendingInstructionRefreshAt = null;
  }
  if (state.phase === "sending-handoff") state.phase = "waiting-for-handoff";
  if (state.phase === "sending-terminal-review") state.phase = "waiting-for-terminal-review";
  if (state.phase === "sending-continue") state.phase = "waiting-for-response";
  state.actionStartedAt = null;
  state.actionPrompt = "";
  state.retryAt = null;
  state.sendFailures = 0;
  state.issue = "";
}

function transientActionTimedOut(state, now = Date.now()) {
  return ["sending-continue", "sending-handoff", "sending-terminal-review"].includes(state?.phase)
    && (!state.actionStartedAt || now - state.actionStartedAt >= 30000);
}

function retryTransientAction(state) {
  if (state.phase === "sending-terminal-review") return requestTerminalReview(
    state,
    state.terminalReviewKind,
    state.terminalReviewPrompt || state.actionPrompt || terminalReviewPromptFor(state.terminalReviewKind),
    "action-retry",
  );
  if (state.phase === "waiting-for-handoff" && state.handoffShortRetryUsed) {
    return requestHandoff(state, handoffPrompt(), "incomplete-handoff");
  }
  if (state.phase === "sending-handoff") {
    return requestHandoff(state, state.actionPrompt || handoffPrompt(), "action-retry");
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

async function injectTargetTab(tabId, direct = false) {
  const sending = cyclePromptsInFlight.has(tabId);
  if (direct ? !sending : sending || !targetMatches(tabId)) return false;
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
      sendResponse({ settings: { ...settings, ...settings.tabControls?.[message.tabId], continuePresets: profile.presets,
        continuePresetIndex: profile.index, continuePrompt: profile.presets[profile.index] } });
      return;
    }

    if (message.type === "getDiagnostics") {
      await diagnosticWrites;
      const { diagnostics } = await chrome.storage.local.get("diagnostics");
      sendResponse({ events: Array.isArray(diagnostics) ? diagnostics : [] });
      return;
    }

    if (message.type === "getAgentInstructions" || message.type === "saveAgentInstructions") {
      if (message.type === "saveAgentInstructions") {
        if (typeof message.text !== "string" || message.text.length > 32000) {
          sendResponse({ ok: false, error: "Choose an AGENTS.md file under 32,000 characters." });
          return;
        }
        settings.globalAgentInstructions = message.text.trim();
        await persistSettings();
      }
      sendResponse({ ok: true, configured: Boolean(settings.globalAgentInstructions), hasGit: Boolean(globalGitGuidance()) });
      return;
    }

    if (message.type === "logFolderChanged") {
      logFileError = "";
      await recordDiagnostic("logging-configured");
      sendResponse({ ok: !logFileError, logFileError });
      return;
    }

    if (message.type === "saveSettings") {
      const tabId = message.tabId;
      if (tabId !== undefined && !Number.isInteger(tabId)) {
        sendResponse({ ok: false });
        return;
      }
      const previous = controlsForTab(tabId);
      const controls = {
        reviewWorkflow: typeof message.settings?.reviewWorkflow === "boolean"
          ? message.settings.reviewWorkflow : previous.reviewWorkflow,
        housekeeping: typeof message.settings?.housekeeping === "boolean"
          ? message.settings.housekeeping : previous.housekeeping,
        enforceModelPreferences: typeof message.settings?.enforceModelPreferences === "boolean"
          ? message.settings.enforceModelPreferences : previous.enforceModelPreferences,
        preferredModel: typeof message.settings?.preferredModel === "string"
          ? message.settings.preferredModel.trim().slice(0, 80) : previous.preferredModel,
        preferredReasoning: ["", "instant", "medium", "high"].includes(message.settings?.preferredReasoning)
          ? message.settings.preferredReasoning : previous.preferredReasoning,
      };
      settings = {
        ...settings,
        ...(tabId === undefined ? controls : {}),
        thresholdMinutes: Math.min(720, Math.max(1, Number(message.settings?.thresholdMinutes) || settings.thresholdMinutes || 130)),
        thinkingMinutes: Math.min(60, Math.max(1, Number(message.settings?.thinkingMinutes) || settings.thinkingMinutes || 10)),
        pluginName: typeof message.settings?.pluginName === "string"
          ? (message.settings.pluginName.trim().slice(0, 80) || DEFAULT_SETTINGS.pluginName)
          : (settings.pluginName || DEFAULT_SETTINGS.pluginName),
      };
      if (tabId !== undefined) settings.tabControls[tabId] = controls;
      const modelChanged = previous.preferredModel !== controls.preferredModel
        || previous.preferredReasoning !== controls.preferredReasoning
        || previous.enforceModelPreferences !== controls.enforceModelPreferences;
      if (modelChanged) {
        for (const state of states.values()) {
          if (tabId !== undefined && state.tabId !== tabId) continue;
          if (tabId === undefined && settings.tabControls?.[state.tabId]) continue;
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
        if (!text.trim()) {
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
        const existing = states.get(tabId);
        const state = newState(message.url, null, tabId);
        if (!targetMatches(tabId) && existing?.conversationKey === state.conversationKey
            && Number.isFinite(existing.handoffOffsetSeconds)) {
          state.handoffOffsetSeconds = existing.handoffOffsetSeconds;
        }
        if (!settings.targetTabIds.includes(tabId)) settings.targetTabIds.push(tabId);
        settings.enabled = true;
        states.set(tabId, state);
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

    if (message.type === "setHandoffProgress") {
      const { tabId, url, minutes } = message;
      if (!Number.isInteger(tabId) || !isConversationUrl(url) || !Number.isFinite(minutes)) {
        sendResponse({ ok: false, error: "Open a ChatGPT conversation first." });
        return;
      }
      const existing = states.get(tabId);
      if (targetMatches(tabId) && existing?.conversationKey !== conversationKey(url)) {
        sendResponse({ ok: false, error: "The monitored chat changed. Try again once it loads." });
        return;
      }
      const state = getState(tabId, url);
      const seconds = Math.min(settings.thresholdMinutes, Math.max(0, Math.round(minutes))) * 60;
      // The slider sets a new baseline. Future history scans must not add
      // the old conversation's time back on top of it.
      state.handoffOffsetSeconds = seconds - trackedWork(state);
      await persistRuntime();
      sendResponse({ ok: true });
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
      const saved = states.get(tabId);
      const progressState = saved?.conversationKey === conversationKey(message.url) ? saved : null;
      const lastSeen = isCurrentTab ? lastSeenAt.get(tabId) || 0 : 0;
      const stale = isCurrentTab && Date.now() - lastSeen >= 15000;
      const recoveryProtected = ["sending-continue", "sending-handoff", "sending-terminal-review"].includes(state?.phase)
        && !transientActionTimedOut(state);
      const lastAttempt = lastRecoveryAttemptAt.get(tabId) || 0;
      if (stale && !recoveryProtected && !cyclePromptsInFlight.has(tabId) && Date.now() - lastAttempt >= 10000) {
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
        cycleStage: isCurrentTab ? cycleStage(tabId, state?.cycleTask) : null,
        isGenerating: Boolean(isCurrentTab && state?.activeStartedAt),
        extendedThinkingStartedAt: isCurrentTab ? state?.extendedThinkingStartedAt || null : null,
        extendedThinkingLimitMs: settings.thinkingMinutes * 60 * 1000,
        workedSeconds: workedTotal(state),
        handoffSeconds: handoffProgress(progressState),
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

    if (message.type === "sendCyclePrompt") {
      const tabId = Number(message.tabId);
      const basePrompt = cycleTaskPrompt(message.kind);
      if (!basePrompt || !Number.isInteger(tabId) || !isConversationUrl(message.url)) {
        sendResponse({ ok: false, error: "Open a ChatGPT conversation first." });
        return;
      }
      if (cyclePromptsInFlight.has(tabId) || manualSwapsInFlight.has(tabId) || pendingHandoffs.has(tabId)) {
        sendResponse({ ok: false, error: "Another prompt or handoff is already in progress." });
        return;
      }
      cyclePromptsInFlight.add(tabId);
      const diagnostic = {
        tabId, source: "manual-contract", action: "sendContinue",
        contract: message.kind, promptMode: promptKind("sendContinue", basePrompt),
      };
      void recordDiagnostic("action-requested", diagnostic);
      let failure = "tab-unavailable";
      try {
        const tab = await chrome.tabs.get(tabId);
        const key = conversationKey(message.url);
        if (conversationKey(tab.url) !== key) {
          void recordDiagnostic("action-result", { ...diagnostic, success: false, reason: "conversation-changed" });
          sendResponse({ ok: false, error: "The conversation changed. Open the popup and try again." });
          return;
        }
        const git = message.kind === "housekeeping" ? globalGitGuidance() : "";
        const prompt = git ? basePrompt + GIT_INSTRUCTIONS_HEADER + git : basePrompt;
        const deliver = () => chrome.tabs.sendMessage(tabId, {
          type: "sendCyclePrompt", prompt, expectedUrl: message.url,
        }, { frameId: 0 });
        let result;
        failure = "content-unreachable";
        try {
          result = await deliver();
        } catch (error) {
          // Only retry when Chrome confirms no listener could have run.
          if (!/receiving end does not exist/i.test(error?.message || "")) {
            failure = "command-unconfirmed";
            throw error;
          }
          if (!await injectTargetTab(tabId, true)) {
            failure = "content-attach-failed";
            throw error;
          }
          result = await deliver();
        }
        failure = "command-unconfirmed";
        const state = targetMatches(tabId) ? states.get(tabId) : null;
        if (result?.ok && state?.conversationKey === key && state.taskStatus === "ongoing") {
          state.phase = "sending-continue";
          state.cycleTask = message.kind;
          state.pendingInstructionRefreshAt = null;
          state.actionSource = "";
          state.actionPromptMode = "none";
          state.recoveryCheckPrompt = "";
          state.terminalReviewPrompt = "";
          state.terminalReviewKind = "";
          state.terminalReviewIdleSince = null;
          state.resumeContinuePending = false;
          markTransientActionAccepted(state);
          if (state.paused) {
            state.resumePhase = state.phase;
            state.phase = "paused";
          }
          await persistRuntime();
        }
        void recordDiagnostic("action-result", {
          ...diagnostic, success: result?.ok === true,
          reason: result?.ok ? undefined : result?.reason || failure,
        });
        const errors = {
          "stop-control-remained-visible": "ChatGPT did not stop. Try again when it is idle.",
          "composer-has-draft": "Clear or send the draft in ChatGPT first.",
          "model-preference": "Could not verify the model. Check the model settings.",
          "send-not-confirmed": "Check ChatGPT to see whether the prompt was sent.",
          "composer-blocked": "ChatGPT is busy or has a dialog open.",
          "monitor-not-ready": "The monitor is still checking the page. Try again shortly.",
          "conversation-changed": "The conversation changed before the prompt could be sent.",
        };
        sendResponse(result?.ok ? { ok: true } : {
          ok: false, error: errors[result?.reason] || "Check ChatGPT to see whether the prompt was sent.",
        });
      } catch {
        void recordDiagnostic("action-result", { ...diagnostic, success: false, reason: failure });
        sendResponse({ ok: false, error: failure === "command-unconfirmed"
          ? "Check ChatGPT to see whether the prompt was sent."
          : "Could not connect to this ChatGPT tab. Refresh it and try again." });
      } finally {
        cyclePromptsInFlight.delete(tabId);
      }
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
      const pendingAction = ["sending-handoff", "sending-continue", "sending-terminal-review"].includes(state.phase);
      if (!pendingAction && state.phase !== "waiting-for-terminal-review") state.phase = "watching";
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
      if (manualSwapsInFlight.has(tabId) || cyclePromptsInFlight.has(tabId)) {
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
        state.recoveryCheckPrompt = "";
        state.handoffShortRetryUsed = false;
        const manualHandoffPrompt = requestHandoff(state, undefined, "manual-handoff").prompt;
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
      if (cyclePromptsInFlight.has(tabId)) {
        sendResponse({ ok: false, error: "Another prompt is already in progress." });
        return;
      }
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
          if (message.verifiedForSend || message.changed) {
            await recordDiagnostic(message.verifiedForSend ? "model-selection-verified" : "model-selection-changed", {
              tabId, success: true, model: message.model, reasoning: message.reasoning, changed: message.changed,
            });
          }
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
      if (targetMatches(tabId)
          && DIAGNOSTIC_EVENTS.has(message.event)
          && (message.event.startsWith("watchdog-") || message.event.startsWith("approval_"))
          && CONTENT_DIAGNOSTIC_REASONS.has(message.reason)) {
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
      const controls = controlsForTab(tabId);
      const cyclePromptPending = cyclePromptsInFlight.has(tabId);
      sendResponse({ target: message.cyclePrompt ? cyclePromptPending : target,
        paused: !message.cyclePrompt && Boolean(state?.paused || cyclePromptPending), cyclePromptPending,
        pendingDelivery: pendingHandoffs.has(tabId), scanHistory: state?.historyScanned !== true,
        waitingForTerminalReview: state?.phase === "waiting-for-terminal-review",
        thinkingMinutes: settings.thinkingMinutes,
        enforceModelPreferences: controls.enforceModelPreferences !== false,
        preferredModel: controls.preferredModel, preferredReasoning: controls.preferredReasoning,
        pluginName: settings.pluginName || DEFAULT_SETTINGS.pluginName });
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
          ? (handoff.prompt || relayPrompt(handoff.text, states.get(tabId))) + (handoff.instructions || "")
          : null,
      });
      return;
    }

    if (message.type === "handoffDelivered") {
      if (targetMatches(tabId) && pendingHandoffs.has(tabId)) {
        const instructionsAttached = Boolean(pendingHandoffs.get(tabId).instructions);
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
          const previous = states.get(tabId);
          const freshState = newState(sender.tab?.url || message.url || "", previous, tabId);
          freshState.cycleTask = previous?.cycleTask || "goal";
          freshState.goalTurns = previous?.goalTurns || 0;
          freshState.awaitingFreshConversation = !freshState.conversationKey.includes("/c/");
          states.set(tabId, freshState);
          await persistRuntime();
        }
        await recordDiagnostic("handoff-delivered", { tabId, instructionsAttached });
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "handoffCaptured") {
      if (cyclePromptsInFlight.has(tabId)) { sendResponse({ ok: false }); return; }
      if (targetMatches(tabId) && validHandoffText(message.text)) {
        const state = getState(tabId, message.url || sender.tab?.url || "");
        const text = message.text.slice(0, 40000);
        pendingHandoffs.set(tabId, {
          text,
          prompt: relayPrompt(text, state),
          instructions: globalInstructionSuffix(),
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
            if (["sending-handoff", "sending-continue", "sending-terminal-review"].includes(state.phase)) state.retryAt = Date.now();
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
      const action = state.phase === "waiting-for-terminal-review"
        ? requestTerminalReview(state, state.terminalReviewKind, state.terminalReviewPrompt, "extended-thinking-watchdog")
        : requestRecoveryCheck(state);
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
          reason: message.ok ? undefined : message.reason || "unknown",
          success: Boolean(message.ok),
          instructionsAttached: state.pendingInstructionRefreshAt != null,
          attempt: (state.sendFailures || 0) + 1,
        });
        state.actionSource = "";
        state.actionPromptMode = "none";
        if (state.paused && state.resumePhase) state.phase = state.resumePhase;
        if (!message.ok) {
          const promptFailureMessages = {
            "monitor-not-ready": "The monitor was no longer ready to send.",
            "composer-blocked": "ChatGPT became busy before the prompt could be sent.",
            "composer-has-draft": "The composer contains a different unsent draft. Clear it or send it manually, then Retry.",
            "plugin-selection-lost": "The configured plugin was not selected before sending. Reconnect it, then Retry.",
            "composer-insert-failed": "Could not insert the prompt into ChatGPT's composer. Refresh ChatGPT, then Retry.",
            "composer-text-mismatch": "ChatGPT did not retain the inserted prompt text. Refresh ChatGPT, then Retry.",
            "model-preference": "Could not verify the selected model before sending. Check the model settings.",
            "composer-unavailable": "ChatGPT's composer is not available. Refresh the tab, then Retry.",
            "conversation-changed": "The monitored conversation changed before the prompt could be sent.",
            "composer-changed": "ChatGPT replaced the composer before the prompt could be sent.",
            "send-button-unavailable": "The prompt was prepared, but ChatGPT's Send button did not become ready.",
            "send-conditions-changed": "ChatGPT changed state before the Send click could run.",
            "send-not-confirmed": "Could not confirm that ChatGPT sent the prompt. Check for an unsent draft before Retry.",
          };
          const handoffFailureMessages = {
            "composer-insert-failed": "Could not insert the handoff into ChatGPT's composer. Refresh ChatGPT, then Retry.",
            "composer-text-mismatch": "ChatGPT did not retain the inserted handoff text. Refresh ChatGPT, then Retry.",
            "send-button-unavailable": "The handoff was prepared, but ChatGPT's Send button did not become ready.",
            "send-not-confirmed": "Could not confirm that ChatGPT sent the handoff. Check for an unsent draft before Retry.",
          };
          if (message.action === "deliverHandoff") {
            await recordDiagnostic("prompt-submission-failed", {
              tabId, reason: message.reason || "unknown", phase: state.phase,
            });
          }
          const pendingHandoff = pendingHandoffs.get(tabId);
          if (pendingHandoff && message.action === "deliverHandoff") {
            pendingHandoff.deliveryFailed = true;
            pendingHandoff.attempts = (pendingHandoff.attempts || 0) + 1;
            pendingHandoff.retryAt = pendingHandoff.attempts < 3
              ? Date.now() + 30000 * pendingHandoff.attempts : null;
          }
          const retryable = ["sendHandoff", "sendContinue", "sendTerminalReview"].includes(message.action);
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
            deliverHandoff: "Could not submit the handoff in the fresh chat.",
          };
          state.issue = state.modelPreferenceIssue
            || (message.action === "deliverHandoff" && handoffFailureMessages[message.reason])
            || promptFailureMessages[message.reason]
            || issueByAction[message.action] || "Could not submit the prompt.";
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

    if (message.type !== "status" || !targetMatches(tabId) || cyclePromptsInFlight.has(tabId)) {
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
      if (state.terminalReviewIdleSince) {
        state.terminalReviewIdleSince = null;
        changed = true;
      }
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
      } else if (["sending-handoff", "sending-continue", "sending-terminal-review"].includes(state.phase)) {
        // Generation may belong to the previous user message (manual handoff
        // can stop it). It is not proof that our prompt was submitted.
      } else if (state.phase === "waiting-for-terminal-review") {
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
      const result = state.terminalReviewPrompt
        ? requestTerminalReview(state, state.terminalReviewKind, state.terminalReviewPrompt, "manual-continue")
        : requestContinue(state, undefined, "manual-continue");
      await persistRuntime();
      sendResponse(result);
      return;
    }

    if (["sending-continue", "sending-handoff", "sending-terminal-review"].includes(state.phase)
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

    const sideTask = CYCLE_GUIDANCE.has(state.cycleTask);
    if (state.retryAt && (state.phase === "sending-terminal-review"
        || sideTask || !terminalStatus(message.latestResponseText))) {
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
      if (message.composerEmpty === false) { sendResponse({}); return; }
      if (state.recoveryCheckPrompt) {
        state.paused = true;
        state.phase = "paused";
        state.issue = "Could not read the check-in reply. Check ChatGPT, then Resume.";
        state.recoveryCheckPrompt = "";
        state.resumeContinuePending = true;
        state.actionPrompt = "";
        state.actionStartedAt = null;
        state.retryAt = null;
        await recordDiagnostic("response-recovery", { tabId, phase: state.phase, reason: message.recoveryReason });
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
      void recordDiagnostic("response-recovery", { tabId, phase: state.phase, reason: message.recoveryReason });
      const result = state.phase === "waiting-for-terminal-review"
        ? requestTerminalReview(state, state.terminalReviewKind, state.terminalReviewPrompt, "stream-recovery")
        : handoffInProgress(state) ? requestHandoff(state, handoffPrompt(), "stream-recovery")
        : message.recoveryReason === "connection-interrupted" && !thresholdReached(state)
          ? requestRecoveryCheck(state, "stream-recovery")
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
    // Only the reply to our reconsideration can resolve the terminal review.
    // A stale assistant turn must not be accepted as the review's answer.
    let reviewCheck;
    const reconsidering = state.phase === "waiting-for-terminal-review";
    if (reconsidering) {
      if (!isNewResponse) reviewCheck = "no-new-response";
      else if (!message.latestUserText) reviewCheck = "user-message-missing";
      else if (!sameSubmittedPrompt(message.latestUserText,
        state.terminalReviewPrompt || terminalReviewPromptFor(state.terminalReviewKind))) reviewCheck = "prompt-mismatch";
      else if (!message.latestResponseText || message.latestResponseIsSubstantive === false) reviewCheck = "reply-empty";
    }
    if (reviewCheck) {
      if (!state.terminalReviewIdleSince) {
        state.terminalReviewIdleSince = Date.now();
        await persistRuntime();
      } else if (Date.now() - state.terminalReviewIdleSince >= 30000) {
        state.paused = true;
        state.phase = "paused";
        state.resumeContinuePending = true;
        state.issue = "Could not verify the final review reply. Resume to retry Reconsider.";
        await recordDiagnostic("pause-changed", {
          tabId, phase: state.phase, reason: "review-reply-unconfirmed", reviewCheck,
          observedTerminal: terminalStatus(message.latestResponseText),
          elapsedMs: Date.now() - state.terminalReviewIdleSince,
        });
        await persistRuntime();
      }
      sendResponse({});
      return;
    }
    if (state.recoveryCheckPrompt && isNewResponse
        && !sameSubmittedPrompt(message.latestUserText, state.recoveryCheckPrompt)) {
      sendResponse({});
      return;
    }
    const legacyReview = reconsidering && state.terminalReviewPrompt
      && !state.terminalReviewPrompt.includes("RECONSIDER_CONTINUE");
    const reviewOutcome = reconsidering
      ? terminalStatus(message.latestResponseText, legacyReview ? "goal" : "reconsider") || (legacyReview ? "continue" : null)
      : null;
    if (reconsidering) {
      if (message.composerEmpty === false) { sendResponse({}); return; }
      if (!reviewOutcome) {
        state.lastResponseKey = message.responseKey;
        const action = requestTerminalReview(state, state.terminalReviewKind, state.terminalReviewPrompt);
        await persistRuntime();
        sendResponse(action);
        return;
      }
      void recordDiagnostic("cycle-step-ended", { tabId, contract: "reconsider", observedTerminal: reviewOutcome });
    }
    const terminal = reconsidering ? (reviewOutcome === "continue" ? null : reviewOutcome)
      : isNewResponse && message.latestResponseIsSubstantive !== false && !sideTask && !handoffInProgress(state)
        ? terminalStatus(message.latestResponseText) : null;
    if (terminal) {
      if (!reconsidering) {
        // An unsubmitted user draft must never be overwritten by automation.
        if (message.composerEmpty === false) { sendResponse({}); return; }
        state.lastResponseKey = message.responseKey;
        const review = requestTerminalReview(state, terminal);
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
      state.terminalReviewKind = "";
      state.terminalReviewPrompt = "";
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
    const wasRecoveryCheck = Boolean(state.recoveryCheckPrompt);
    if (wasRecoveryCheck) {
      void recordDiagnostic("recovery-check-completed", { tabId });
      state.recoveryCheckPrompt = "";
    }
    if (reconsidering) {
      // This reconsideration found a path forward. A later, genuinely new
      // terminal result is a new stop attempt and gets one fresh review.
      state.phase = "watching";
      state.terminalReviewKind = "";
      state.terminalReviewPrompt = "";
    }
    if (handoffInProgress(state)) {
      const result = completedHandoffAction(state, message.latestResponseText, message.latestResponseIsSubstantive);
      await persistRuntime();
      sendResponse(result);
      return;
    }

    if (state.cycleTask && !reconsidering && !wasRecoveryCheck && message.latestResponseIsSubstantive !== false) {
      const marker = state.cycleTask.toUpperCase();
      const matchingPrompt = !message.latestUserText || (
        message.latestUserText.includes(`${marker}_FINISHED`)
        && message.latestUserText.includes(`${marker}_BLOCKED`)
      );
      const outcome = sideTask && matchingPrompt ? terminalStatus(message.latestResponseText, state.cycleTask) : null;
      if (outcome) {
        void recordDiagnostic("cycle-step-ended", {
          tabId, contract: state.cycleTask, observedTerminal: outcome,
        });
        state.goalTurns = 0;
        const tasks = cycleTasks(tabId, state.cycleTask);
        state.cycleTask = tasks[tasks.indexOf(state.cycleTask) + 1] || "goal";
      } else if (!sideTask) {
        state.goalTurns = (state.goalTurns || 0) + 1;
        if (state.goalTurns >= GOAL_TURNS_PER_ROUND) {
          state.goalTurns = 0;
          state.cycleTask = cycleTasks(tabId)[1] || "goal";
        }
      }
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
  delete settings.tabControls?.[tabId];
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
