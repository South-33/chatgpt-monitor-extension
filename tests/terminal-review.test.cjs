const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const local = {};
const session = {};
const event = () => ({ addListener() {} });
let now = Date.now();
const Clock = class extends Date {
  static now() { return now; }
  constructor(...args) { super(...(args.length ? args : [now])); }
};

function worker() {
  let listener;
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(),
      onMessage: { addListener(fn) { listener = fn; } } },
    storage: {
      local: { async get(key) { return { [key]: structuredClone(local[key]) }; },
        async set(value) { Object.assign(local, structuredClone(value)); } },
      session: { async get(key) { return { [key]: structuredClone(session[key]) }; },
        async set(value) { Object.assign(session, structuredClone(value)); } },
    },
    scripting: { async executeScript() {} },
    tabs: { async get(id) { return { id, url: 'https://chatgpt.com/c/reconsider' }; },
      onRemoved: event() },
    alarms: { create() {}, onAlarm: event() },
  };
  vm.runInNewContext(source, { chrome, console, URL, Date: Clock });
  return (message, url = 'https://chatgpt.com/c/reconsider') => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No response to ${message.type}`)), 1500);
    listener(message, { tab: { id: 64, url } }, response => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

const url = 'https://chatgpt.com/c/reconsider';
const blocked = 'Access is required to make progress.\nTASK_BLOCKED';
const status = (key, text, latestUserText, composerEmpty = true) => ({
  type: 'status', url, isGenerating: false, responseKey: key,
  latestResponseText: text, latestUserText, composerEmpty,
});

(async () => {
  const send = worker();
  await send({ type: 'setMonitoring', enabled: true, tabId: 64, url });

  // Do not overwrite a human draft and do not consume the blocked turn.
  const withDraft = await send(status('first-block', blocked, '', false));
  assert.equal(withDraft.action, undefined);
  assert.equal(local.runtime.states[64].lastResponseKey, '');
  const first = await send(status('first-block', blocked, '', true));
  assert.equal(first.action, 'sendTerminalReview');
  assert.equal(local.runtime.states[64].terminalReviewAttempted, true);
  assert.equal(local.runtime.states[64].phase, 'sending-terminal-review');
  assert.equal(local.runtime.states[64].genericContinuesRemaining, 0,
    'reconsideration must not count against normal continuation cadence');
  assert.match(first.prompt, /exact blocker/i);
  assert.match(first.prompt, /clean and current/i);
  assert.match(first.prompt, /TASK_FINISHED/);
  assert.match(first.prompt, /TASK_BLOCKED/);
  assert.doesNotMatch(first.prompt, /system message/i,
    'terminal review is an ordinary user-level instruction, not a fake system prompt');
  const { events } = await send({ type: 'getDiagnostics' });
  assert.ok(events.some(entry => entry.action === 'sendTerminalReview'
    && entry.promptMode === 'terminal-review'
    && entry.source === 'terminal-review'),
    'the one-time review is recorded as its own diagnostic action');
  assert.match(content, /\["sendHandoff", "sendContinue", "sendTerminalReview"\]/,
    'content script must be able to deliver the review action');

  // Repeated scans or a worker restart cannot create another review request.
  const restarted = worker();
  assert.equal((await restarted(status('first-block', blocked, '', true))).action, undefined);
  assert.equal(local.runtime.states[64].phase, 'sending-terminal-review');
  assert.equal(local.runtime.states[64].terminalReviewAttempted, true);

  // Failed prompt send retries the exact review, not a normal continuation.
  await restarted({ type: 'commandResult', action: 'sendTerminalReview', ok: false, url });
  assert.equal(local.runtime.states[64].phase, 'sending-terminal-review');
  now += 31000;
  const retry = await restarted(status('first-block', blocked, '', true));
  assert.equal(retry.action, 'sendTerminalReview');
  assert.equal(retry.prompt, first.prompt);
  await restarted({ type: 'commandResult', action: 'sendTerminalReview', ok: true, url });
  assert.equal(local.runtime.states[64].phase, 'waiting-for-terminal-review');

  // A prior reply and an incompletely rendered review cannot advance the flow.
  assert.equal((await restarted(status('older', 'Earlier answer.', 'Old message'))).action, undefined);
  assert.equal((await restarted(status('review-partial', '', first.prompt))).action, undefined);
  assert.equal(local.runtime.states[64].phase, 'waiting-for-terminal-review');

  // Real reconsideration may find a path forward and resume normal work.
  const resumed = await restarted(status('review-answer',
    'I found an authorized method to complete the requested validation. I tested the method.', first.prompt));
  assert.equal(resumed.action, 'sendContinue');
  assert.equal(local.runtime.states[64].terminalReviewAttempted, false,
    'a successful reconsideration resets the budget for a later blocked episode');
  await restarted({ type: 'commandResult', action: 'sendContinue', ok: true, url });

  // A later genuine block after more work is a new episode and gets exactly
  // one reconsideration. If that reconsideration is also blocked, stop.
  const laterReview = await restarted(status('later-block', blocked, 'Previously submitted continuation'));
  assert.equal(laterReview.action, 'sendTerminalReview');
  assert.equal(local.runtime.states[64].terminalReviewAttempted, true);
  await restarted({ type: 'commandResult', action: 'sendTerminalReview', ok: true, url });
  assert.equal((await restarted(status('later-review-blocked', blocked, laterReview.prompt))).action, undefined);
  assert.equal(local.runtime.states[64].taskStatus, 'blocked');
  assert.equal(local.runtime.states[64].paused, true);
  assert.equal((await restarted(status('later-review-blocked', blocked, laterReview.prompt))).action, undefined);

  // Explicit Resume starts a fresh authorized attempt; terminal marker from
  // the prior turn does not trigger another immediate reconsideration.
  await restarted({ type: 'setPaused', tabId: 64, paused: false });
  assert.equal(local.runtime.states[64].terminalReviewAttempted, false);
  const manual = await restarted(status('later-review-blocked', blocked, '', true));
  assert.equal(manual.action, 'sendContinue');

  // A new conversation has a separate reconsideration budget.
  const otherUrl = 'https://chatgpt.com/c/another-goal';
  const newChat = await restarted({ ...status('new-block', blocked), url: otherUrl }, otherUrl);
  assert.equal(newChat.action, 'sendTerminalReview');
  await restarted({ type: 'commandResult', action: 'sendTerminalReview', ok: true, url: otherUrl }, otherUrl);
  const completedReview = await restarted({ ...status('review-finished',
    'The original goal is now fully verified.\nTASK_FINISHED', newChat.prompt), url: otherUrl }, otherUrl);
  assert.equal(completedReview.action, undefined,
    'verified completion after reconsideration must stop instead of inventing more work');
  assert.equal(local.runtime.states[64].taskStatus, 'finished');
  assert.equal(local.runtime.states[64].paused, true);

  // TASK_FINISHED also gets exactly one review before the stop is accepted.
  await restarted({ type: 'setMonitoring', enabled: true, tabId: 64, url });
  const finished = await restarted(status('finished', 'Verified complete.\nTASK_FINISHED'));
  assert.equal(finished.action, 'sendTerminalReview');
  assert.match(finished.prompt, /acceptance criteria/i);
  assert.match(finished.prompt, /clean and current/i);
  assert.notEqual(finished.prompt, first.prompt,
    'completion and blocker reviews must use distinct prompts');
  assert.equal(local.runtime.states[64].terminalReviewAttempted, true);
  assert.equal(local.runtime.states[64].paused, false);
  await restarted({ type: 'commandResult', action: 'sendTerminalReview', ok: true, url });
  const confirmedFinished = await restarted(status('finished-review',
    'I rechecked the requested result and its verification. It is complete.\nTASK_FINISHED', finished.prompt));
  assert.equal(confirmedFinished.action, undefined,
    'a terminal marker in the review reply must stop without a second review');
  assert.equal(local.runtime.states[64].taskStatus, 'finished');
  assert.equal(local.runtime.states[64].paused, true);

  // A completion review can reject a premature finish, resume useful work,
  // and grant a later genuine stop attempt one fresh review.
  const prematureUrl = 'https://chatgpt.com/c/premature-finish';
  await restarted({ type: 'setMonitoring', enabled: true, tabId: 64, url: prematureUrl }, prematureUrl);
  const premature = await restarted({ ...status('premature-finish',
    'Everything looks complete.\nTASK_FINISHED'), url: prematureUrl }, prematureUrl);
  assert.equal(premature.action, 'sendTerminalReview');
  await restarted({ type: 'commandResult', action: 'sendTerminalReview', ok: true,
    url: prematureUrl }, prematureUrl);
  const foundGap = await restarted({ ...status('premature-review',
    'The final validation was not run. I can run it with the existing authorized tools.', premature.prompt),
    url: prematureUrl }, prematureUrl);
  assert.equal(foundGap.action, 'sendContinue');
  assert.equal(local.runtime.states[64].terminalReviewAttempted, false);
  await restarted({ type: 'commandResult', action: 'sendContinue', ok: true,
    url: prematureUrl }, prematureUrl);
  const laterFinish = await restarted({ ...status('later-finish',
    'The missing validation now passes.\nTASK_FINISHED'), url: prematureUrl }, prematureUrl);
  assert.equal(laterFinish.action, 'sendTerminalReview',
    'a later stop after more work receives a fresh one-shot review');
  await restarted({ type: 'commandResult', action: 'sendTerminalReview', ok: true,
    url: prematureUrl }, prematureUrl);
  const unmatched = { ...status('unconfirmed-review', blocked, 'Unmatched user message'), url: prematureUrl };
  await restarted(unmatched, prematureUrl);
  now += 31_000;
  assert.equal((await restarted(unmatched, prematureUrl)).action, undefined);
  assert.equal(local.runtime.states[64].paused, true);
  assert.match(local.runtime.states[64].issue, /Could not verify the final review reply/);
  const { events: finalEvents } = await restarted({ type: 'getDiagnostics' });
  const pause = finalEvents.find(entry => entry.reason === 'review-reply-unconfirmed');
  assert.equal(pause.reviewCheck, 'prompt-mismatch');
  assert.equal(pause.observedTerminal, 'blocked');

  console.log('terminal_review_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
