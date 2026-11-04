const taskStatus = document.querySelector("#taskStatus");
const statusDetail = document.querySelector("#statusDetail");
const progress = document.querySelector("#progress");
const progressFill = document.querySelector("#progressFill");
const workedText = document.querySelector("#workedText");
const retryButton = document.querySelector("#retryButton");
const monitorButton = document.querySelector("#monitorButton");
const pauseButton = document.querySelector("#pauseButton");
const swapButton = document.querySelector("#swapButton");
const continuePrompt = document.querySelector("#continuePrompt");
const presetSlots = document.querySelector("#presetSlots");
const promptState = document.querySelector("#promptState");
const threshold = document.querySelector("#threshold");
const thinkingMinutes = document.querySelector("#thinkingMinutes");
const preferredModel = document.querySelector("#preferredModel");
const preferredReasoning = document.querySelector("#preferredReasoning");
const enforceModelPreferences = document.querySelector("#enforceModelPreferences");
const reviewWorkflow = document.querySelector("#reviewWorkflow");
const housekeeping = document.querySelector("#housekeeping");
const cycleStage = document.querySelector("#cycleStage");
const pluginName = document.querySelector("#pluginName");
let pendingControlWrites = 0;
let controlSaveQueue = Promise.resolve();
const chooseLogFolderButton = document.querySelector("#chooseLogFolder");
const logFolderStatus = document.querySelector("#logFolderStatus");
const notice = document.querySelector("#notice");

const PHASE_LABELS = {
  watching: "Watching",
  working: "Watching",
  "sending-continue": "Continuing",
  "waiting-for-response": "Waiting for response",
  "sending-handoff": "Requesting handoff",
  "waiting-for-handoff": "Waiting for handoff",
  "sending-terminal-review": "Rechecking stop result",
  "waiting-for-terminal-review": "Checking stop reply",
  "opening-new-chat": "Opening fresh chat",
  "threshold-waiting": "Handoff due",
};

let activeTab = null;
let popupTabId = null;
let currentStatus = null;
let presets = [];
let activePreset = 0;
let logFolderName = "";
let promptTimer;
let thresholdTimer;
let noticeTimer;
let saveQueue = Promise.resolve();
let saveFailed = false;
let switchingPreset = false;
let settingsLoaded = false;
let settingsLoading = false;
let settingsRetryId;
let statusRefresh = null;
let promptTabId = null;
let pendingPromptWrites = 0;
let savedSettings = null;

function updateModelControls() {
  preferredModel.disabled = !settingsLoaded || !enforceModelPreferences.checked;
  preferredReasoning.disabled = !settingsLoaded || !enforceModelPreferences.checked;
}

function syncSavedSettings(settings) {
  savedSettings = settings;
  if (!settingsLoaded) return;
  if (!pendingControlWrites) {
    const controls = settings.tabControls?.[promptTabId] || settings;
    if (document.activeElement !== preferredModel) preferredModel.value = controls.preferredModel || "";
    preferredReasoning.value = controls.preferredReasoning || "";
    enforceModelPreferences.checked = controls.enforceModelPreferences !== false;
    reviewWorkflow.checked = controls.reviewWorkflow === true;
    housekeeping.checked = controls.housekeeping === true;
    updateModelControls();
  }
  const profile = settings.tabContinuePresets?.[promptTabId];
  const nextPresets = settings.continuePresets;
  const nextIndex = profile?.index ?? 0;
  if (!promptTimer && !pendingPromptWrites && !switchingPreset && !saveFailed
      && continuePrompt.value === presets[activePreset]) {
    presets = [...nextPresets];
    activePreset = nextIndex;
    if (continuePrompt.value !== presets[activePreset]) continuePrompt.value = presets[activePreset];
    renderPresetButtons();
  }
  if (!thresholdTimer && document.activeElement !== threshold && document.activeElement !== thinkingMinutes) {
    threshold.value = settings.thresholdMinutes;
    thinkingMinutes.value = settings.thinkingMinutes || 10;
  }
  if (typeof pluginName !== "undefined" && !thresholdTimer && document.activeElement !== pluginName) {
    pluginName.value = settings.pluginName || "DevSpace";
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings?.newValue) syncSavedSettings(changes.settings.newValue);
});

function formatMinutes(seconds) {
  return `${Math.floor((Number(seconds) || 0) / 60)}m`;
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function renderProgress(result, monitoringThisTab, paused, workedSeconds, thresholdSeconds) {
  const startedAt = Number(result.extendedThinkingStartedAt);
  const limitMs = Number(result.extendedThinkingLimitMs) || 10 * 60 * 1000;
  const thinking = monitoringThisTab && !paused && !result.issue && result.isGenerating
    && Number.isFinite(startedAt) && startedAt > 0;
  const elapsedMs = thinking ? Math.max(0, Date.now() - startedAt) : 0;
  const remainingMs = thinking ? Math.max(0, limitMs - elapsedMs) : 0;
  const percent = thinking
    ? Math.min(100, elapsedMs / limitMs * 100)
    : Math.min(100, workedSeconds / thresholdSeconds * 100);
  progress.classList.toggle("thinking", thinking);
  progress.setAttribute("aria-label", thinking ? "Thinking recovery progress" : "Handoff progress");
  progress.setAttribute("aria-valuenow", String(Math.round(percent)));
  progressFill.style.width = `${percent}%`;
  return thinking
    ? remainingMs ? `Check-in in ${formatCountdown(remainingMs)}` : "Stopping, then asking for an update"
    : "";
}

function showNotice(text, isError = false) {
  clearTimeout(noticeTimer);
  notice.textContent = text;
  notice.style.color = isError ? "var(--red)" : "var(--muted)";
  noticeTimer = setTimeout(() => { notice.textContent = ""; }, 2500);
}

function renderStatus(result) {
  currentStatus = result;
  const monitoring = result.enabled && result.isCurrentTab;
  const paused = monitoring && result.paused;
  const stage = monitoring ? result.cycleStage : null;
  cycleStage.hidden = !stage;
  if (stage) {
    const position = `${stage.step}/${stage.total}`;
    const description = `${stage.label} · Step ${stage.step} of ${stage.total}`;
    if (cycleStage.textContent !== position) cycleStage.textContent = position;
    cycleStage.title = description;
    cycleStage.setAttribute("aria-label", description);
  }
  const value = result.status || "off";
  const thresholdSeconds = Math.max(60, Number(result.thresholdMinutes || threshold.value || 130) * 60);
  const workedSeconds = Number(result.workedSeconds) || 0;
  workedText.textContent = `${formatMinutes(workedSeconds)} / ${Math.round(thresholdSeconds / 60)}m`;
  const countdown = renderProgress(result, monitoring, paused, workedSeconds, thresholdSeconds);

  let label = "Off";
  let detail = "";
  if (result.lookupFailed) { label = "Unavailable"; detail = "Reload the extension"; }
  else if (!monitoring) detail = result.currentTabSupported ? "" : "Open a ChatGPT tab";
  else if (paused) { label = "Paused"; detail = result.issue || ""; }
  else if (value === "finished") label = "Finished";
  else if (value === "blocked") { label = "Blocked"; detail = "Waiting for you"; }
  else if (result.issue) { label = "Attention"; detail = result.issue; }
  else if (result.isGenerating) { label = "Working"; detail = countdown; }
  else if (!result.connected) label = "Reconnecting";
  else label = PHASE_LABELS[result.phase] || "Watching";

  taskStatus.textContent = label;
  taskStatus.className = `task-status ${paused ? "paused" : result.issue || result.lookupFailed ? "error" : value}`;
  statusDetail.textContent = detail;
  statusDetail.hidden = !detail;
  statusDetail.className = `status-detail${result.issue || result.lookupFailed ? " error" : ""}`;
  retryButton.className = `retry-button${result.issue && monitoring ? " visible" : ""}`;
  monitorButton.textContent = monitoring ? "Stop" : "Monitor this tab";
  monitorButton.className = `monitor-button${monitoring ? " stop" : ""}`;
  monitorButton.disabled = !activeTab?.url || (!monitoring && !result.currentTabSupported);
  pauseButton.textContent = paused ? "Resume" : "Pause";
  pauseButton.className = `pause-button${monitoring ? " visible" : ""}`;
  pauseButton.disabled = !monitoring;
  swapButton.className = `swap-button${result.currentTabSupported ? " visible" : ""}`;
  swapButton.disabled = !isConversationUrl(activeTab?.url)
    || (monitoring && (value !== "ongoing"
      || ["sending-handoff", "waiting-for-handoff", "opening-new-chat"].includes(result.phase)));
  if (result.logFileError) logFolderStatus.textContent = result.logFileError;
  else logFolderStatus.textContent = logFolderName ? `Logs: ${logFolderName}` : "Logs: no folder";
  logFolderStatus.title = monitoring ? `Log files for this tab end in -tab-${activeTab.id}.jsonl` : "Automatic diagnostic logs";
  chooseLogFolderButton.hidden = false;
}

function isChatUrl(url) {
  try { return ["chatgpt.com", "chat.openai.com"].includes(new URL(url).hostname); }
  catch { return false; }
}

function isConversationUrl(url) {
  if (!isChatUrl(url)) return false;
  const parsed = new URL(url);
  return parsed.pathname.startsWith("/c/") || parsed.searchParams.get("temporary-chat") === "true";
}

async function findActiveTab() {
  // Bind this popup to its own tab. Focusing another Chrome window must not
  // redirect its controls or status to that window's task.
  if (popupTabId !== null) return chrome.tabs.get(popupTabId);
  const [candidate] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!candidate) return null;
  const tab = candidate.url ? candidate : await chrome.tabs.get(candidate.id);
  popupTabId = tab.id;
  return tab;
}

function refreshStatus() {
  if (statusRefresh) return statusRefresh;
  statusRefresh = (async () => {
    try {
      activeTab = await findActiveTab();
      const result = await chrome.runtime.sendMessage({
        type: "getMonitorStatus", tabId: activeTab?.id, url: activeTab?.url,
      });
      renderStatus(result || { lookupFailed: true });
    } catch {
      renderStatus({ lookupFailed: true });
    } finally {
      statusRefresh = null;
    }
  })();
  return statusRefresh;
}

function renderPresetButtons() {
  for (const button of presetSlots.querySelectorAll("button")) {
    const active = Number(button.dataset.preset) === activePreset;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function savePrompt() {
  clearTimeout(promptTimer);
  promptTimer = null;
  const index = activePreset;
  const tabId = promptTabId;
  const text = continuePrompt.value;
  if (!text.trim()) {
    promptState.textContent = "Prompt cannot be empty";
    return saveQueue;
  }
  presets[index] = text;
  promptState.textContent = "Saving…";
  pendingPromptWrites++;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const result = await chrome.runtime.sendMessage({ type: "saveContinuePreset", tabId, index, text });
    if (!result?.ok) throw new Error(result?.error || "Could not save prompt");
    saveFailed = false;
    if (activePreset === index && continuePrompt.value === text) promptState.textContent = "";
  }).catch((error) => {
    saveFailed = true;
    promptState.textContent = error.message || "Could not save prompt";
  }).finally(() => {
    pendingPromptWrites--;
    if (savedSettings) syncSavedSettings(savedSettings);
  });
  return saveQueue;
}

async function switchPreset(index) {
  if (switchingPreset || index === activePreset || !presets[index]) return;
  switchingPreset = true;
  continuePrompt.disabled = true;
  try {
    if (promptTimer) await savePrompt();
    else await saveQueue;
    if (saveFailed) return;
    const result = await chrome.runtime.sendMessage({ type: "saveContinuePreset", tabId: promptTabId, index });
    if (!result?.ok) throw new Error("Could not switch prompt.");
    presets = result.settings.continuePresets;
    activePreset = index;
    continuePrompt.value = presets[index];
    promptState.textContent = "";
    renderPresetButtons();
  } catch { showNotice("Could not switch prompt.", true); }
  finally {
    switchingPreset = false;
    continuePrompt.disabled = false;
  }
}

async function saveThreshold() {
  clearTimeout(thresholdTimer);
  thresholdTimer = null;
  pluginNameTimer = null;
  const minutes = Number(threshold.value);
  const thinking = Number(thinkingMinutes.value);
  const settings = { pluginName: pluginName.value.trim() || "DevSpace" };
  if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 720) settings.thresholdMinutes = minutes;
  if (Number.isFinite(thinking) && thinking >= 1 && thinking <= 60) settings.thinkingMinutes = thinking;
  try {
    await chrome.runtime.sendMessage({ type: "saveSettings", settings });
    await refreshStatus();
  } catch { showNotice("Could not save settings.", true); }
}

async function loadSettings() {
  if (settingsLoaded || settingsLoading) return;
  settingsLoading = true;
  try {
    if (!Number.isInteger(activeTab?.id)) throw new Error("Tab unavailable");
    promptTabId = activeTab.id;
    const { settings } = await chrome.runtime.sendMessage({ type: "getSettings", tabId: promptTabId });
    if (!settings?.continuePresets?.length) throw new Error("Settings unavailable");
    threshold.value = settings.thresholdMinutes;
    thinkingMinutes.value = settings.thinkingMinutes || 10;
    if (pluginName) {
      pluginName.value = settings.pluginName || "DevSpace";
      pluginName.disabled = false;
    }
    preferredModel.value = settings.preferredModel || "";
    preferredReasoning.value = settings.preferredReasoning || "";
    enforceModelPreferences.checked = settings.enforceModelPreferences !== false;
    enforceModelPreferences.disabled = false;
    reviewWorkflow.checked = settings.reviewWorkflow === true;
    reviewWorkflow.disabled = false;
    housekeeping.checked = settings.housekeeping === true;
    housekeeping.disabled = false;
    presets = settings.continuePresets;
    activePreset = settings.continuePresetIndex;
    continuePrompt.value = presets[activePreset];
    renderPresetButtons();
    settingsLoaded = true;
    updateModelControls();
    if (settingsRetryId) clearInterval(settingsRetryId);
    continuePrompt.disabled = false;
    threshold.disabled = false;
    thinkingMinutes.disabled = false;
    for (const button of presetSlots.querySelectorAll("button")) button.disabled = false;
    promptState.textContent = "";
  } catch {
    promptState.textContent = "Connecting…";
  } finally {
    settingsLoading = false;
  }
}

async function load() {
  await refreshStatus();
  await loadSettings();
  if (!settingsLoaded) settingsRetryId = setInterval(() => void loadSettings(), 5000);
  try {
    logFolderName = (await AgentMonitorLogFiles.directory())?.name || "";
    logFolderStatus.textContent = logFolderName ? `Logs: ${logFolderName}` : "Logs: no folder";
    chooseLogFolderButton.hidden = false;
  } catch { logFolderStatus.textContent = "Logs: unavailable"; }
}

monitorButton.addEventListener("click", async () => {
  await refreshStatus();
  if (!activeTab || !isChatUrl(activeTab.url)) { showNotice("Open a ChatGPT tab first.", true); return; }
  const stopCurrent = currentStatus?.enabled && currentStatus?.isCurrentTab;
  const result = await chrome.runtime.sendMessage({
    type: "setMonitoring", enabled: !stopCurrent, tabId: activeTab.id, url: activeTab.url,
  });
  if (!result?.ok) showNotice(result?.error || "Could not change monitoring.", true);
  await refreshStatus();
});

pauseButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({
    type: "setPaused", tabId: activeTab?.id, paused: !currentStatus?.paused,
  });
  if (!result?.ok) showNotice(result?.error || "Could not change pause state.", true);
  await refreshStatus();
});

async function runAction(type, failure) {
  try {
    const result = await chrome.runtime.sendMessage({ type, tabId: activeTab?.id });
    if (!result?.ok) showNotice(result?.error || failure, true);
  } catch { showNotice(failure, true); }
  await refreshStatus();
}

swapButton.addEventListener("click", () => runAction("manualSwap", "Could not start the handoff."));
retryButton.addEventListener("click", () => runAction("retryNow", "Could not retry."));

presetSlots.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-preset]");
  if (button) void switchPreset(Number(button.dataset.preset));
});
continuePrompt.addEventListener("input", () => {
  promptState.textContent = "Saving…";
  clearTimeout(promptTimer);
  promptTimer = setTimeout(savePrompt, 350);
});
continuePrompt.addEventListener("blur", () => { if (promptTimer) void savePrompt(); });
for (const field of [threshold, thinkingMinutes, pluginName]) {
  field.addEventListener("input", () => {
    clearTimeout(thresholdTimer);
    thresholdTimer = setTimeout(saveThreshold, 400);
  });
  field.addEventListener("change", () => { void saveThreshold(); });
}
async function saveControlSettings(settings = {
  enforceModelPreferences: enforceModelPreferences.checked,
  preferredModel: preferredModel.value,
  preferredReasoning: preferredReasoning.value,
}) {
  pendingControlWrites++;
  controlSaveQueue = controlSaveQueue.catch(() => {}).then(async () => {
    await chrome.runtime.sendMessage({ type: "saveSettings", tabId: promptTabId, settings });
  }).catch(() => showNotice("Could not save settings.", true)).finally(() => {
    pendingControlWrites--;
    if (savedSettings) syncSavedSettings(savedSettings);
  });
  return controlSaveQueue;
}
preferredModel.addEventListener("change", () => void saveControlSettings());
preferredReasoning.addEventListener("change", () => void saveControlSettings());
enforceModelPreferences.addEventListener("change", () => {
  updateModelControls();
  void saveControlSettings();
});
reviewWorkflow.addEventListener("change", () => void saveControlSettings({ reviewWorkflow: reviewWorkflow.checked }));
housekeeping.addEventListener("change", () => void saveControlSettings({ housekeeping: housekeeping.checked }));
chooseLogFolderButton.addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("logs.html") });
});
window.addEventListener("pagehide", () => {
  if (promptTimer) void savePrompt();
  if (thresholdTimer) void saveThreshold();
});

void load();
setInterval(() => void refreshStatus(), 1200);
