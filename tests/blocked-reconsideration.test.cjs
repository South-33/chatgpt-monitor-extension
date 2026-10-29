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
  assert.equal(first.action, 'sendBlockedReview');
  assert.equal(local.runtime.states[64].blockedReviewAttempted, true);
  assert.equal(local.runtime.states[64].phase, 'sending-block-review');
  assert.equal(local.runtime.states[64].genericContinuesRemaining, 0,
    'reconsideration must not count against normal continuation cadence');
  assert.match(first.prompt, /ORIGINAL user's goal/);
  assert.match(first.prompt, /Do not invent a new goal/);
  assert.match(first.prompt, /TASK_FINISHED/);
  assert.match(first.prompt, /TASK_BLOCKED/);
  const { events } = await send({ type: 'getDiagnostics' });
  assert.ok(events.some(entry => entry.action === 'sendBlockedReview'
    && entry.promptMode === 'blocked-review'
    && entry.source === 'blocked-review'),
    'the one-time review is recorded as its own diagnostic action');
  assert.match(content, /\["sendHandoff", "sendContinue", "sendBlockedReview"\]/,
    'content script must be able to deliver the review action');

  // Repeated scans or a worker restart cannot create another review request.
  const restarted = worker();
  assert.equal((await restarted(status('first-block', blocked, '', true))).action, undefined);
  assert.equal(local.runtime.states[64].phase, 'sending-block-review');
  assert.equal(local.runtime.states[64].blockedReviewAttempted, true);

  // Failed prompt send retries the exact review, not a normal continuation.
  await restarted({ type: 'commandResult', action: 'sendBlockedReview', ok: false, url });
  assert.equal(local.runtime.states[64].phase, 'sending-block-review');
  now += 31000;
  const retry = await restarted(status('first-block', blocked, '', true));
  assert.equal(retry.action, 'sendBlockedReview');
  assert.equal(retry.prompt, first.prompt);
  await restarted({ type: 'commandResult', action: 'sendBlockedReview', ok: true, url });
  assert.equal(local.runtime.states[64].phase, 'waiting-for-block-review');

  // A prior reply and an incompletely rendered review cannot advance the flow.
  assert.equal((await restarted(status('older', 'Earlier answer.', 'Old message'))).action, undefined);
  assert.equal((await restarted(status('review-partial', '', first.prompt))).action, undefined);
  assert.equal(local.runtime.states[64].phase, 'waiting-for-block-review');

  // Real reconsideration may find a path forward and resume normal work.
  const resumed = await restarted(status('review-answer',
    'I found an authorized method to complete the requested validation. I tested the method.', first.prompt));
  assert.equal(resumed.action, 'sendContinue');
  assert.equal(local.runtime.states[64].blockedReviewAttempted, true,
    'only one automatic reconsideration per conversation, even after continuing');
  await restarted({ type: 'commandResult', action: 'sendContinue', ok: true, url });

  // Another genuine block in this conversation now pauses. No infinite loops.
  assert.equal((await restarted(status('later-block', blocked, 'Previously submitted continuation'))).action, undefined);
  assert.equal(local.runtime.states[64].taskStatus, 'blocked');
  assert.equal(local.runtime.states[64].paused, true);
  assert.equal((await restarted(status('later-block', blocked, 'Previously submitted continuation'))).action, undefined);

  // Explicit Resume starts a fresh authorized attempt; terminal marker from
  // the old turn does not trigger another immediate reconsideration.
  await restarted({ type: 'setPaused', tabId: 64, paused: false });
  assert.equal(local.runtime.states[64].blockedReviewAttempted, false);
  const manual = await restarted(status('later-block', blocked, '', true));
  assert.equal(manual.action, 'sendContinue');

  // A new conversation has a separate reconsideration budget.
  const otherUrl = 'https://chatgpt.com/c/another-goal';
  const newChat = await restarted({ ...status('new-block', blocked), url: otherUrl }, otherUrl);
  assert.equal(newChat.action, 'sendBlockedReview');
  await restarted({ type: 'commandResult', action: 'sendBlockedReview', ok: true, url: otherUrl }, otherUrl);
  const completedReview = await restarted({ ...status('review-finished',
    'The original goal is now fully verified.\nTASK_FINISHED', newChat.prompt), url: otherUrl }, otherUrl);
  assert.equal(completedReview.action, undefined,
    'verified completion after reconsideration must stop instead of inventing more work');
  assert.equal(local.runtime.states[64].taskStatus, 'finished');
  assert.equal(local.runtime.states[64].paused, true);

  // TASK_FINISHED is terminal immediately, not followed by reconsideration.
  await restarted({ type: 'setMonitoring', enabled: true, tabId: 64, url });
  const finished = await restarted(status('finished', 'Verified complete.\nTASK_FINISHED'));
  assert.equal(finished.action, undefined);
  assert.equal(local.runtime.states[64].taskStatus, 'finished');
  assert.equal(local.runtime.states[64].paused, true);

  console.log('blocked_reconsideration_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
