const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const start = source.indexOf("function isExtendedThinkingNotice(value)");
const end = source.indexOf("async function recoverExtendedThinking()", start);
assert.ok(start >= 0 && end > start, "thinking watchdog helpers not found");

let now = 100000;
let generating = true;
let statuses = [];
let turns = [];
const publishedTimers = [];
const diagnostics = [];
let lastPublishedTimer;
const sandbox = {
  Date: { now: () => now },
  location: { href: "https://chatgpt.com/c/current" },
  document: { body: {}, scrollingElement: null, querySelectorAll: (selector) =>
    selector === "[role='status']" ? statuses : selector === "[data-turn-key]" ? turns : [] },
  getComputedStyle: (element) => ({ overflowY: element.overflowY || "visible" }),
  isGenerating: () => generating,
  assistantTurns: () => turns,

  visible: (element) => !element.hidden,
  normalizedControlText: (text) => (text || "").replace(/\s+/g, " ").trim(),
  reportDiagnostic: (event, reason) => diagnostics.push({ event, reason }),
  publishThinkingNoticeTimer: (startedAt) => {
    if (lastPublishedTimer !== startedAt) {
      lastPublishedTimer = startedAt;
      publishedTimers.push(startedAt);
    }
  },
};

vm.runInNewContext(`
  let extendedThinkingTurnIdentity = null;
  let extendedThinkingSince = 0;
  let extendedThinkingRecoveryRequested = false;
  let extendedThinkingRetryAt = 0;
  let extendedThinkingStopFailures = 0;
  let lastFollowLatestAt = 0;
  let extendedThinkingLimitMs = 10 * 60 * 1000;
  const FOLLOW_LATEST_INTERVAL_MS = 30 * 1000;
  ${source.slice(start, end)}
  this.isExtendedThinkingTimedOut = extendedThinkingTimedOut;
  this.followLatestWhileGenerating = followLatestConversation;
`, sandbox);

function turn({ id, order, parentElement = null }) {
  return {
    hidden: false,
    parentElement,
    id,
    order,
    getAttribute(name) {
      return name === "data-turn-key" ? id : null;
    },
    closest(selector) {
      return selector === "[data-turn-key]" ? this : null;
    },
    contains(other) {
      return other === this;
    },
    compareDocumentPosition(other) {
      return this.order < other.order ? 4 : 2;
    },
    scrollIntoView() {
      this.scrolledIntoView = true;
    },
  };
}

function status(text, owner) {
  return {
    hidden: false,
    innerText: text,
    textContent: text,
    closest(selector) {
      return selector === "[data-turn-key]" ? owner : null;
    },
  };
}

const exactNotice = "Our systems are thinking a bit more about this request before responding.";
const oldAssistant = turn({ id: "old-assistant", order: 1 });
const currentAssistant = turn({ id: "current-turn-with-user-and-assistant", order: 2 });
turns = [oldAssistant, currentAssistant];
statuses = [status(exactNotice, oldAssistant)];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false,
  "a status in an older turn cannot start recovery");

const currentStatus = status(exactNotice, currentAssistant);
statuses = [currentStatus];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, "the live status starts a fresh timer");
assert.equal(publishedTimers.at(-1), now,
  "the current turn can contain both the user message and live assistant status");
now += 8 * 60 * 1000;
currentStatus.innerText = "Our systems are thinking a little longer before responding.";
currentStatus.textContent = currentStatus.innerText;
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, "small wording changes keep the same timer");
now += 2 * 60 * 1000 - 1;
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, "do not stop before ten full minutes");
now += 1;
assert.equal(sandbox.isExtendedThinkingTimedOut(), true, "the watchdog is eligible at ten minutes");

const nextAssistant = turn({ id: "next-turn-with-user-and-assistant", order: 3 });
turns.push(nextAssistant);
statuses = [status("We're thinking for a bit longer before we respond.", nextAssistant)];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false,
  "a new user and assistant pair starts a fresh timer with a fuzzy phrase");

statuses = [status("Our systems are thinking before responding.", nextAssistant)];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false,
  "ordinary thinking status without an extended-delay cue does not match");
statuses = [status("Working for a bit longer before responding.", nextAssistant)];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false,
  "an unrelated status without a systems-thinking cue does not match");

statuses = [status("Our systems are thinking a bit more before responding.", nextAssistant)];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false,
  "a matching notice can start a fresh timer after a non-matching status cleared the prior one");
generating = false;
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, "the status is ignored when Stop is absent");
assert.deepEqual(diagnostics.at(-1), { event: 'watchdog-reset', reason: 'generation-ended' },
  'generation ending clears the watchdog without treating it as a notice-only disappearance');
generating = true;
now += 10 * 60 * 1000;
assert.equal(sandbox.isExtendedThinkingTimedOut(), false,
  "a stopped run cannot leave a stale timer for a later generation");
now += 10 * 60 * 1000;
assert.equal(sandbox.isExtendedThinkingTimedOut(), true, "a new active run gets its own ten-minute timer");
statuses = [];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, "removing the transient status resets the timer");
assert.equal(publishedTimers.at(-1), null, "clear the popup timer when the notice disappears");
assert.deepEqual(diagnostics.at(-1), { event: 'watchdog-reset', reason: 'notice-disappeared' },
  'notice disappearance while Stop is still visible only clears the watchdog');

statuses = [status(exactNotice, nextAssistant)];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false,
  "the live status starts a timer without a separate user-turn anchor");
assert.equal(publishedTimers.at(-1), now,
  "publish the timer even when the user-turn anchor is unavailable");

// The live connection banner has role=status inside the latest turn, just
// like the system-thinking notice. It shares the same timer and eligibility.
const interruptedNotice = 'Connection interrupted. Waiting for the complete answer';
statuses = [];
sandbox.isExtendedThinkingTimedOut();
statuses = [status(interruptedNotice, oldAssistant)];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, 'old interruption banners cannot start recovery');
const connectionStatus = status(interruptedNotice, nextAssistant);
connectionStatus.hidden = true;
statuses = [connectionStatus];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, 'hidden interruption banners are ignored');
connectionStatus.hidden = false;
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, 'a current interruption starts the configured timer');
const interruptedStartedAt = publishedTimers.at(-1);
now += 5 * 60 * 1000;
connectionStatus.innerText = 'Connection lost. Reconnecting and waiting for the answer.';
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, 'small interruption wording changes keep the timer');
assert.equal(publishedTimers.at(-1), interruptedStartedAt);
connectionStatus.innerText = exactNotice;
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, 'switching delay notices in the same turn preserves elapsed time');
now += 5 * 60 * 1000;
connectionStatus.innerText = interruptedNotice;
assert.equal(sandbox.isExtendedThinkingTimedOut(), true, 'an interruption uses the same ten-minute threshold');
generating = false;
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, 'a connection banner without Stop cannot trigger recovery');
assert.equal(publishedTimers.at(-1), null);
generating = true;
statuses = [status('The connection is working. Waiting for a tool result.', nextAssistant)];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, 'waiting alone is insufficient');
statuses = [status('A connection interrupted our experiment yesterday.', nextAssistant)];
assert.equal(sandbox.isExtendedThinkingTimedOut(), false, 'interruption alone is insufficient');

const scroller = { scrollHeight: 5000, clientHeight: 800, scrollTop: 100, overflowY: "auto", parentElement: sandbox.document.body };
const scrollingTurn = turn({ id: "scrolling-turn", order: 6, parentElement: scroller });
statuses = [status("Generating", scrollingTurn)];
turns = [scrollingTurn];
assert.equal(sandbox.followLatestWhileGenerating(), true, "follow the current status on the first active scan");
assert.equal(scroller.scrollTop, scroller.scrollHeight, "scroll the conversation pane to its bottom");
assert.equal(sandbox.followLatestWhileGenerating(), false, "do not scroll on every five-second scan");
now += 30 * 1000 - 1;
assert.equal(sandbox.followLatestWhileGenerating(), false, "respect the 30-second scroll interval");
now += 1;
scroller.scrollTop = 100;
assert.equal(sandbox.followLatestWhileGenerating(), true, "follow again after 30 seconds");
generating = false;
assert.equal(sandbox.followLatestWhileGenerating(), false, "idle scans still respect the interval");
now += 30 * 1000;
scroller.scrollTop = 100;
assert.equal(sandbox.followLatestWhileGenerating(), true, "load newer content even when the Stop button disappeared");
now += 30 * 1000;
assert.equal(sandbox.followLatestWhileGenerating(), false, "already at the bottom needs no render delay");

console.log("extended_thinking_detection_ok");
