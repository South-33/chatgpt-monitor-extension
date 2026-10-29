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
let pendingModelWrites = 0;
let modelSaveQueue = Promise.resolve();
const chooseLogFolderButton = document.querySelector("#chooseLogFolder");
const logFolderStatus = document.querySelector("#logFolderStatus");
const notice = document.querySelector("#notice");
const version = document.querySelector("#version");

const PHASE_LABELS = {
  watching: "Watching",
  working: "Watching",
  "sending-continue": "Continuing",
  "waiting-for-response": "Waiting for response",
  "sending-handoff": "Requesting handoff",
  "waiting-for-handoff": "Waiting for handoff",
  "sending-block-review": "Rechecking blocker",
  "waiting-for-block-review": "Waiting for recheck",
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
  if (!pendingModelWrites) {
    if (document.activeElement !== preferredModel) preferredModel.value = settings.preferredModel || "";
    preferredReasoning.value = settings.preferredReasoning || "";
    enforceModelPreferences.checked = settings.enforceModelPreferences !== false;
    updateModelControls();
  }
  const profile = settings.tabContinuePresets?.[promptTabId];
  const nextPresets = settings.continuePresets;
  const nextIndex = profile?.index ?? 0;
  if (!promptTimer && !pendingPromptWrites && !switchingPreset && !saveFailed
      && continuePrompt.value.trim() === presets[activePreset]) {
    presets = [...nextPresets];
    activePreset = nextIndex;
    continuePrompt.value = presets[activePreset];
    renderPresetButtons();
  }
  if (!thresholdTimer && document.activeElement !== threshold && document.activeElement !== thinkingMinutes) {
    threshold.value = settings.thresholdMinutes;
    thinkingMinutes.value = settings.thinkingMinutes || 10;
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
  const value = result.status || "off";
  const thresholdSeconds = Math.max(60, Number(result.thresholdMinutes || threshold.value || 130) * 60);
  const workedSeconds = Number(result.workedSeconds) || 0;
  workedText.textContent = `${formatMinutes(workedSeconds)} / ${Math.round(thresholdSeconds / 60)}m`;
  const countdown = renderProgress(result, monitoring, paused, workedSeconds, thresholdSeconds);

  let label = "Off";
  let detail = "";
  if (result.lookupFailed) { label = "Unavailable"; detail = "Reload the extension"; }
  else if (!monitoring) detail = result.currentTabSupported ? "" : "Open a ChatGPT tab";
  else if (paused) label = "Paused";
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
  const text = continuePrompt.value.trim();
  if (!text) {
    promptState.textContent = "Prompt cannot be empty";
    return saveQueue;
  }
  presets[index] = text;
  promptState.textContent = "Saving…";
  saveFailed = false;
  pendingPromptWrites++;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const result = await chrome.runtime.sendMessage({ type: "saveContinuePreset", tabId, index, text });
    if (!result?.ok) throw new Error(result?.error || "Could not save prompt");
    if (activePreset === index && continuePrompt.value.trim() === text) promptState.textContent = "Saved";
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
  try {
    if (promptTimer) await savePrompt();
    else await saveQueue;
    if (saveFailed) return;
    const result = await chrome.runtime.sendMessage({ type: "saveContinuePreset", tabId: promptTabId, index });
    if (!result?.ok) { showNotice("Could not switch prompt.", true); return; }
    activePreset = index;
    continuePrompt.value = presets[index];
    promptState.textContent = "";
    renderPresetButtons();
  } catch { showNotice("Could not switch prompt.", true); }
  finally {
    switchingPreset = false;
    if (savedSettings) syncSavedSettings(savedSettings);
  }
}

async function saveThreshold() {
  clearTimeout(thresholdTimer);
  thresholdTimer = null;
  const minutes = Number(threshold.value);
  const thinking = Number(thinkingMinutes.value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720
      || !Number.isFinite(thinking) || thinking < 1 || thinking > 60) return;
  try {
    await chrome.runtime.sendMessage({ type: "saveSettings", settings: {
      thresholdMinutes: minutes, thinkingMinutes: thinking,
    } });
    await refreshStatus();
  } catch { showNotice("Could not save timers.", true); }
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
    preferredModel.value = settings.preferredModel || "";
    preferredReasoning.value = settings.preferredReasoning || "";
    enforceModelPreferences.checked = settings.enforceModelPreferences !== false;
    enforceModelPreferences.disabled = false;
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
  version.textContent = `v${chrome.runtime.getManifest().version}`;
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
threshold.addEventListener("input", () => {
  clearTimeout(thresholdTimer);
  thresholdTimer = setTimeout(saveThreshold, 400);
});
threshold.addEventListener("change", () => { void saveThreshold(); });
thinkingMinutes.addEventListener("input", () => {
  clearTimeout(thresholdTimer);
  thresholdTimer = setTimeout(saveThreshold, 400);
});
thinkingMinutes.addEventListener("change", () => { void saveThreshold(); });
async function saveModelPreferences() {
  const settings = {
    enforceModelPreferences: enforceModelPreferences.checked,
    preferredModel: preferredModel.value,
    preferredReasoning: preferredReasoning.value,
  };
  pendingModelWrites++;
  modelSaveQueue = modelSaveQueue.catch(() => {}).then(async () => {
    await chrome.runtime.sendMessage({ type: "saveSettings", settings });
  }).catch(() => showNotice("Could not save model settings.", true)).finally(() => {
    pendingModelWrites--;
    if (savedSettings) syncSavedSettings(savedSettings);
  });
  return modelSaveQueue;
}
preferredModel.addEventListener("change", () => void saveModelPreferences());
preferredReasoning.addEventListener("change", () => void saveModelPreferences());
enforceModelPreferences.addEventListener("change", () => {
  updateModelControls();
  void saveModelPreferences();
});
chooseLogFolderButton.addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("logs.html") });
});
window.addEventListener("pagehide", () => {
  if (promptTimer) void savePrompt();
  if (thresholdTimer) void saveThreshold();
});

void load();
setInterval(() => void refreshStatus(), 1200);
