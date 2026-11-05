const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
assert.doesNotMatch(source, /copy-turn-action-button|navigator\.clipboard/,
  "response capture must not depend on ChatGPT's clipboard control");
const start = source.indexOf("function normalizedPluginLabel");
const end = source.indexOf("function pluginMenuItem", start);
assert.ok(start >= 0 && end > start, "plugin label helpers not found");

const sandbox = {};
vm.runInNewContext(`${source.slice(start, end)}; matches = isPluginLabel;`, sandbox);

for (const label of ["DevSpace", "Devspace", "devspace", "Dev Space", "Devspace Devspace", "spacedev", "SpaceDev", "Space Dev", "Remove spacedev"]) {
  assert.equal(sandbox.matches(label), true, `expected ${label} to match`);
}
assert.equal(sandbox.matches("Devspace Devspace local tools"), true);
assert.equal(sandbox.matches("Remove Devspace"), true,
  "accessible labels that put the remove action before the plugin name must match");
assert.equal(sandbox.matches("Devspace plugin, remove"), true);
sandbox.configuredPluginName = "codespace";
for (const label of ["codespace", "Codespace", "CODESPACE", "Code Space", "CODE SPACE", "Remove codespace"]) {
  assert.equal(sandbox.matches(label), true, `expected ${label} to match the configured plugin`);
}
assert.equal(sandbox.matches("Unrelated Plugin"), false);
delete sandbox.configuredPluginName;
for (const label of ["Deep research", "OpenAI Platform", "Development Space"]) {
  assert.equal(sandbox.matches(label), false, `expected ${label} not to match`);
}

const selectedContext = {
  findComposer() { return { querySelectorAll() { return []; } }; },
  composerScope() {
    return {
      parentElement: null,
      matches() { return false; },
      querySelectorAll() { return [selectedChip]; },
    };
  },
  visible() { return true; },
  buttonLabel(element) { return `${element.getAttribute("aria-label") || ""} ${element.innerText || ""}`.trim(); },
};
const selectedChip = {
  innerText: "×",
  textContent: "×",
  getAttribute(name) { return name === "aria-label" ? "Remove Devspace" : null; },
};
vm.runInNewContext(`${source.slice(start, end)}; selected = pluginSelected;`, selectedContext);
assert.equal(selectedContext.selected(), true,
  "a selected Devspace chip with an action-prefixed label must not be clicked again");

const stopStart = source.indexOf("function isStopControl");
const stopEnd = source.indexOf("function findStopButton", stopStart);
assert.ok(stopStart >= 0 && stopEnd > stopStart, "stop-control helper not found");
vm.runInNewContext(`${source.slice(stopStart, stopEnd)}; isStop = isStopControl;`, sandbox);
assert.equal(sandbox.isStop("Stop generating", "stop-button"), true);
assert.equal(sandbox.isStop("Stop answering", "stop-button"), true);
assert.equal(sandbox.isStop("Stop generating response", ""), true);
assert.equal(sandbox.isStop("Stop", ""), true);
assert.equal(sandbox.isStop("Start Voice", "stop-button"), false);
assert.equal(sandbox.isStop("Stop Voice", "stop-button"), false);
assert.equal(sandbox.isStop("", "stop-button"), true);

const generationStart = source.indexOf("function findStopButton");
const generationEnd = source.indexOf("function findComposer", generationStart);
const controls = [{
  getAttribute() { return "Start Voice"; }, innerText: "", dataset: {},
}];
const generationContext = {
  document: { querySelectorAll() { return controls; } },
  visible() { return true; },
  isStopControl: sandbox.isStop,
};
vm.runInNewContext(`${source.slice(generationStart, generationEnd)}; generating = isGenerating;`, generationContext);
assert.equal(generationContext.generating(), false);
controls.push({ getAttribute() { return "Stop"; }, innerText: "", dataset: {} });
assert.equal(generationContext.generating(), true);

const durationStart = source.indexOf("function workedDurations");
const durationEnd = source.indexOf("function collectWorkedEntries", durationStart);
assert.ok(durationStart >= 0 && durationEnd > durationStart, "duration helper not found");
vm.runInNewContext(`${source.slice(durationStart, durationEnd)}; durations = workedDurations;`, sandbox);
assert.deepEqual(Array.from(sandbox.durations("Worked for 40s")), [40]);
assert.deepEqual(Array.from(sandbox.durations("Worked for 12m 3s")), [723]);
assert.deepEqual(Array.from(sandbox.durations("Worked for 1h 7m 12s")), [4032]);

const recoveryStart = source.indexOf("function streamRecoveryFailure");
const recoveryEnd = source.indexOf("function fingerprint", recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, "stream recovery helper not found");
const failedTurn = {
  hasAttribute(name) { return name === "data-turn-key"; },
  getAttribute(name) { return name === "data-turn-key" ? "failed-turn" : null; },
  querySelectorAll(selector) {
    return selector === '[role="alert"]' ? [{ innerText: "ChatGPT stream recovery polling timed out\nRetry" }] : [];
  },
};
const recoveryContext = {
  document: { querySelectorAll() { return [failedTurn]; } },
  isGenerating() { return false; },
};
vm.runInNewContext(`${source.slice(recoveryStart, recoveryEnd)}; recovery = streamRecoveryFailure;`, recoveryContext);
assert.equal(recoveryContext.recovery().key, "failed-turn");
recoveryContext.isGenerating = () => true;
assert.equal(recoveryContext.recovery(), null, "an active response must not be recovered");
recoveryContext.isGenerating = () => false;
recoveryContext.visible = () => true;
recoveryContext.normalizedControlText = text => text.trim();
failedTurn.querySelectorAll = selector => selector === '[role="status"]'
  ? [{ innerText: "Connection interrupted. Waiting for the complete answer" }] : [];
const newerTurn = { hasAttribute: () => true, querySelectorAll: () => [] };
recoveryContext.document.querySelectorAll = () => [failedTurn, newerTurn];
assert.equal(recoveryContext.recovery(), null, "a banner on an older turn cannot interrupt the current one");

const incompleteStart = source.indexOf("function incompleteTurnKey");
assert.ok(incompleteStart > recoveryStart && incompleteStart < recoveryEnd);
const incompleteContext = {
  document: {
    querySelectorAll() {
      return [{
        querySelector() { return {}; },
        getAttribute() { return "idle-turn"; },
      }];
    },
  },
  findComposer() { return {}; },
  visible() { return true; },
  isGenerating() { return false; },
  latestAssistantResponse() { return { text: "" }; },
};
vm.runInNewContext(`${source.slice(incompleteStart, recoveryEnd)}; incomplete = incompleteTurnKey;`, incompleteContext);
assert.equal(incompleteContext.incomplete(), "idle-turn");
incompleteContext.latestAssistantResponse = () => ({ text: "Finished answer" });
assert.equal(incompleteContext.incomplete(), "", "a completed answer must use the normal path");
incompleteContext.latestAssistantResponse = () => ({ text: "" });
incompleteContext.isGenerating = () => true;
assert.equal(incompleteContext.incomplete(), "", "the Stop state must keep the turn active");

const composerStart = source.indexOf("function normalizedText");
const composerEnd = source.indexOf("async function setComposerText", composerStart);
const composerContext = {};
vm.runInNewContext(`${source.slice(composerStart, composerEnd)}; readComposer = composerText;`, composerContext);
assert.equal(composerContext.readComposer({
  innerText: "alpha\n\nbeta",
  textContent: "alphabeta",
  querySelector() { return null; },
}), "alpha\n\nbeta", "multiline prompts must be checked against rendered editor text");
assert.equal(
  composerContext.comparableText("alpha\n\nbeta"),
  composerContext.comparableText("alpha beta"),
  "editor paragraph formatting must not make an identical prompt fail validation",
);
const insertStart = source.indexOf("async function setComposerText");
const insertEnd = source.indexOf("async function clearComposer", insertStart);
assert.doesNotMatch(source.slice(insertStart, insertEnd), /replaceChildren|appendChild/,
  "failed insertion must not create text outside the editor's own state");

const stopMonitorStart = source.indexOf("function stopMonitor");
const stopMonitorEnd = source.indexOf("async function sendRuntime", stopMonitorStart);
const stopMonitorSource = source.slice(stopMonitorStart, stopMonitorEnd);
assert.match(stopMonitorSource, /clearInterval\(intervalId\)/);
assert.match(stopMonitorSource, /clearTimeout\(observerScanTimer\)/);
assert.match(stopMonitorSource, /observer\?\.disconnect\(\)/);
assert.match(stopMonitorSource, /removeEventListener/);
assert.match(stopMonitorSource, /onMessage\.removeListener/);

const observerStart = source.indexOf("observer = new MutationObserver");
const observerEnd = source.indexOf("observer.observe", observerStart);
assert.ok(observerStart >= 0 && observerEnd > observerStart, "mutation observer not found");
assert.doesNotMatch(source.slice(observerStart, observerEnd), /isGenerating\(/,
  "mutation callbacks must not perform full generation-state DOM scans");
assert.match(source, /setInterval\(\(\) => void scan\(\), 5000\)/);

console.log("plugin_labels_ok");
