const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

const helpersStart = source.indexOf("function normalizedControlText");
const helpersEnd = source.indexOf("function devSpaceMaterializationDialog", helpersStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, "materialization label helpers not found");

const sandbox = {};
vm.runInNewContext(
  `${source.slice(helpersStart, helpersEnd)}; matchesDialog = isDevSpaceMaterializationText; matchesScope = isConversationPermissionLabel;`,
  sandbox,
);

assert.equal(sandbox.matchesDialog(
  "Allow file materialization? ChatGPT needs your approval to materialize 1 file attachments returned by Devspace.",
), true);
assert.equal(sandbox.matchesDialog(
  "Allow file materialization? ChatGPT needs your approval to materialize 2 file attachments returned by DevSpace.",
), true);
assert.equal(sandbox.matchesDialog("Allow file materialization? Returned by another app."), false);
assert.equal(sandbox.matchesDialog("Allow Devspace to run this command?"), false);

assert.equal(sandbox.matchesScope("Allow Devspace for this conversation"), true);
assert.equal(sandbox.matchesScope("Allow for this conversation"), true);
assert.equal(sandbox.matchesScope("Always allow for this conversation"), true);
assert.equal(sandbox.matchesScope("Allow for the whole conversation"), false);
assert.equal(sandbox.matchesScope("  Allow   Devspace for this conversation  "), true);
assert.equal(sandbox.matchesScope("Allow Devspace once"), false);
assert.equal(sandbox.matchesScope("Allow another app for this conversation"), false);

const dialogStart = source.indexOf("function devSpaceMaterializationDialog()");
const dialogEnd = source.indexOf("function conversationPermissionOption", dialogStart);
assert.ok(dialogStart >= 0 && dialogEnd > dialogStart, "materialization card finder not found");

{
  const exactCard = {
    innerText: "Allow file materialization? ChatGPT needs your approval to materialize 1 file attachments returned by Devspace. Deny Allow",
    textContent: "",
  };
  const exactCardSandbox = {
    document: {
      querySelectorAll(selector) {
        if (selector === '[data-testid="tool-approval-card"]') return [exactCard];
        return [];
      },
    },
    visible: () => true,
    normalizedControlText: sandbox.normalizedControlText,
    isDevSpaceMaterializationText: sandbox.matchesDialog,
    hasDevSpaceApprovalControls: () => true,
  };
  vm.runInNewContext(`${source.slice(dialogStart, dialogEnd)}; findCard = devSpaceMaterializationDialog;`, exactCardSandbox);
  assert.equal(exactCardSandbox.findCard(), exactCard,
    "ChatGPT tool-approval-card must be the primary materialization anchor");
}

{
  const denyButton = makeElement({ text: "Deny" });
  const allowButton = makeElement({ text: "Allow" });
  const card = {
    innerText: "Allow file materialization? ChatGPT needs your approval to materialize 1 file attachments returned by Devspace. Deny Allow",
    textContent: "",
    parentElement: null,
    querySelectorAll(selector) {
      return selector === "button" ? [denyButton, allowButton] : [];
    },
  };
  const heading = {
    innerText: "Allow file materialization?",
    textContent: "Allow file materialization?",
    parentElement: card,
    querySelectorAll() {
      return [];
    },
  };
  const cardSandbox = {
    document: {
      querySelectorAll(selector) {
        if (selector === '[data-testid="tool-approval-card"]') return [];
        if (selector === "button") return [];
        if (selector.includes("role='dialog'")) return [];
        return [heading];
      },
    },
    visible: () => true,
    normalizedControlText: sandbox.normalizedControlText,
    isDevSpaceMaterializationText: sandbox.matchesDialog,
    hasDevSpaceApprovalControls: () => true,
  };
  vm.runInNewContext(`${source.slice(dialogStart, dialogEnd)}; findCard = devSpaceMaterializationDialog;`, cardSandbox);
  assert.equal(cardSandbox.findCard(), card,
    "role-less ChatGPT materialization cards must still be detected from their visible text");
}

const scanStart = source.indexOf("async function scan()");
const scanEnd = source.indexOf("function scheduleScan", scanStart);
assert.ok(scanStart >= 0 && scanEnd > scanStart, "scan function not found");
const scanSource = source.slice(scanStart, scanEnd);
assert.ok((scanSource.match(/resolveDevSpaceMaterialization\(\)/g) || []).length >= 3,
  "blocking permission UI must be checked before scan work, before status, and before actions");
assert.match(scanSource, /if \(result\?\.action && !manualActionRunning && !hasBlockingUi\(\)\) await handleAction\(result\);/,
  "continuation actions must never run while blocking UI is active");

const assistStart = source.indexOf("function conversationPermissionOption");
const assistEnd = source.indexOf("function stopMonitor", assistStart);
assert.ok(assistStart >= 0 && assistEnd > assistStart, "materialization assist function not found");

function makeElement({ ariaLabel = "", text = "" } = {}) {
  return {
    ariaLabel,
    innerText: text,
    textContent: text,
    clicks: 0,
    focused: false,
    parentElement: null,
    getAttribute(name) {
      return name === "aria-label" ? this.ariaLabel : null;
    },
    hasAttribute(name) {
      return name === "aria-expanded" && this.ariaExpanded !== undefined;
    },
    focus() {
      this.focused = true;
    },
    dispatchEvent(event) {
      this.onEvent?.(event);
      return true;
    },
  };
}

async function runAssistScenario() {
  const allowButton = makeElement({ text: "Allow" });
  const scopeButton = makeElement({ ariaLabel: "Allow Devspace for this conversation" });
  scopeButton.ariaExpanded = "false";
  scopeButton.getAttribute = function getAttribute(name) {
    if (name === "aria-label") return this.ariaLabel;
    if (name === "aria-haspopup") return "menu";
    if (name === "aria-expanded") return this.ariaExpanded;
    return null;
  };
  const option = makeElement({ text: "Allow for this conversation" });
  option.role = "menuitem";
  const split = {
    querySelectorAll(selector) {
      return selector === "button" ? [allowButton, scopeButton] : [];
    },
  };
  allowButton.parentElement = split;
  scopeButton.parentElement = split;
  const actions = {
    querySelectorAll(selector) {
      return selector === "button" ? [allowButton, scopeButton] : [];
    },
    contains(element) {
      return element === allowButton || element === scopeButton;
    },
  };
  const dialog = {
    querySelector(selector) {
      return selector === '[data-testid="tool-action-buttons"]' ? actions : null;
    },
    querySelectorAll(selector) {
      return selector === "button" ? [allowButton, scopeButton] : [];
    },
    contains(element) {
      return element === allowButton || element === scopeButton;
    },
  };
  let menuOpen = false;
  let dialogOpen = true;
  const menu = {
    matches: () => false,
    querySelectorAll: (selector) => selector.includes("role='menuitem'") && menuOpen ? [option] : [],
  };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("[role='menu']")) return menuOpen ? [menu] : [];
      if (selector.includes("[role='menuitem']")) return menuOpen ? [option] : [];
      if (selector === "button, [role='button'], [tabindex]") return [scopeButton];
      return [];
    },
  };

  const behaviorSandbox = {
    dialog,
    document,
    visible: () => true,
    normalizedControlText: (value) => (value || "").replace(/\s+/g, " ").trim(),
    isConversationPermissionLabel: (value) => /^allow(?:\s+devspace)?\s+for\s+this\s+conversation$/i.test(
      (value || "").replace(/\s+/g, " ").trim(),
    ),
    devSpaceMaterializationDialog: () => dialogOpen ? dialog : null,
    waitFor: async (predicate) => Boolean(predicate()),
    HTMLElement: function HTMLElement() {},
    MouseEvent: class MouseEvent {
      constructor(type) {
        this.type = type;
      }
    },
    PointerEvent: class PointerEvent {
      constructor(type) {
        this.type = type;
      }
    },
    setTimeout,
    blockingUiRunning: false,
    reportDiagnostic() {},
    console: { debug() {}, warn() {} },
  };
  behaviorSandbox.HTMLElement.prototype.click = function click() {
    this.clicks += 1;
    this.onNativeClick?.();
  };
  scopeButton.onEvent = (event) => {
    if (event.type === "pointerdown") {
      menuOpen = true;
      scopeButton.ariaExpanded = "true";
    }
  };
  option.onNativeClick = () => {
    menuOpen = false;
    dialogOpen = false;
  };

  vm.runInNewContext(`${source.slice(assistStart, assistEnd)}; assist = resolveDevSpaceMaterialization;`, behaviorSandbox);
  const handled = await behaviorSandbox.assist();
  return { handled, allowButton, scopeButton, option, dialog };
}

(async () => {
  const result = await runAssistScenario();
  assert.equal(result.handled, true);
  assert.equal(result.scopeButton.clicks, 1,
    "the small Allow dropdown trigger must be clicked exactly once");
  assert.equal(result.option.clicks, 1,
    "the conversation-scoped menu option must be clicked exactly once");
  assert.equal(result.allowButton.clicks, 0,
    "the main Allow button must never be clicked because that only grants one-time access");

  const sendPromptStart = source.indexOf("async function sendPrompt(text)");
  const sendPromptEnd = source.indexOf("async function sendPromptWithRetry", sendPromptStart);
  const sendPromptSource = source.slice(sendPromptStart, sendPromptEnd);
  assert.match(sendPromptSource, /hasBlockingUi\(\)/,
    "prompt submission must be blocked while permission UI exists");

  const observerStart = source.indexOf("observer = new MutationObserver");
  assert.ok(observerStart >= 0, "DOM observer not found");
  const observerSource = source.slice(observerStart, source.indexOf("observer.observe", observerStart));
  assert.doesNotMatch(observerSource, /resolveDevSpaceMaterialization\(\)/,
    "the observer must schedule work through the ownership and pause checks");

  assert.match(scanSource, /generationEnded && await settleBlockingUiAfterGeneration\(\)/,
    "generation end must pause briefly for delayed blocking UI before any continuation decision");

  console.log("materialization_permission_ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
