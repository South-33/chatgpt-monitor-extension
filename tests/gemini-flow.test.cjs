const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const geminiUrl = 'https://gemini.google.com/u/2/app/task-one?pli=1&pageId=none';
const gptUrl = 'https://chatgpt.com/c/task-two';
const event = () => ({ addListener() {} });

function harness(initialSettings = {}) {
  const local = { settings: initialSettings };
  const session = {};
  let now = 1800000000000;
  const Clock = class extends Date { static now() { return now; } };
  const deliveries = [], injections = [];
  let listener, alarm;
  function boot() {
    const chrome = {
      runtime: { onInstalled: event(), onStartup: event(), onMessage: { addListener(fn) { listener = fn; } } },
      storage: {
        local: { async get(key) { return { [key]: structuredClone(local[key]) }; },
          async set(value) { Object.assign(local, structuredClone(value)); } },
        session: { async get(key) { return { [key]: structuredClone(session[key]) }; },
          async set(value) { Object.assign(session, structuredClone(value)); } },
      },
      scripting: { async executeScript(value) { injections.push(value); } },
      tabs: { async get(id) { return { id, url: id === 1 ? geminiUrl : gptUrl }; },
        async sendMessage(id, message) { deliveries.push({ id, message }); return { ok: true }; },
        onRemoved: event() },
      alarms: { create() {}, onAlarm: { addListener(fn) { alarm = fn; } } },
    };
    vm.runInNewContext(source, { chrome, console, URL, Date: Clock });
  }
  boot();
  const send = (message, id = 1) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${message.type}`)), 1500);
    listener(message, { tab: { id, url: id === 1 ? geminiUrl : gptUrl } }, result => {
      clearTimeout(timer); resolve(result);
    });
  });
  return {
    send, local, deliveries, injections, boot,
    advance(ms) { now += ms; },
    now: () => now,
    alarm: () => alarm({ name: 'monitor-recovery' }),
    start: (id = 1) => send({ type: 'setMonitoring', enabled: true, tabId: id, url: id === 1 ? geminiUrl : gptUrl }, id),
    status: (key, text, extra = {}, id = 1) => send({ type: 'status', url: id === 1 ? geminiUrl : gptUrl,
      isGenerating: false, responseKey: key, latestResponseText: text,
      latestResponseIsSubstantive: true, composerEmpty: true, ...extra }, id),
    ack: (action = 'sendContinue') => send({ type: 'commandResult', action, ok: true, url: geminiUrl }),
    view: () => send({ type: 'getMonitorStatus', tabId: 1, url: geminiUrl }),
  };
}

test('Gemini uses shared prompts, independent models, and no handoff threshold', async () => {
  const h = harness({ reviewWorkflow: true }); // Legacy global value must not opt new tabs in.
  await h.start();
  await h.start(2);
  assert.equal((await h.send({ type: 'getSettings', tabId: 1 })).settings.reviewWorkflow, false);
  const role = await h.send({ type: 'isTargetTab' });
  assert.equal(role.preferredModel, 'Neon');
  assert.equal(role.preferredReasoning, '');
  assert.equal((await h.send({ type: 'isTargetTab' }, 2)).preferredModel, 'GPT-6.2');
  await h.send({ type: 'saveSettings', tabId: 1, settings: { preferredGeminiModel: 'Hydrogen', reviewWorkflow: false } });
  await h.send({ type: 'saveContinuePreset', index: 0, text: 'Finish the agreed experiment.' });
  await h.send({ type: 'historyScanComplete', url: geminiUrl, workedSeconds: 20000 });
  const action = await h.status('first', 'More work remains.');
  assert.equal(action.action, 'sendContinue');
  assert.match(action.prompt, /Finish the agreed experiment/);
  assert.match(action.prompt, /MONITOR_SLEEP_MINUTES=N/);
  assert.match(action.prompt, /Goal contract/);
  const gptAction = await h.status('gpt-first', 'More work remains.', {}, 2);
  assert.match(gptAction.prompt, /Finish the agreed experiment/);
  assert.doesNotMatch(gptAction.prompt, /Gemini quota is counted per turn|MONITOR_SLEEP_MINUTES/);
  assert.equal((await h.send({ type: 'manualSwap', tabId: 1 })).ok, false);
  assert.deepEqual(Array.from(h.injections[0].files), ['gemini.js', 'content.js']);
  h.boot();
  const restarted = (await h.send({ type: 'getSettings', tabId: 1 })).settings;
  assert.equal(restarted.preferredGeminiModel, 'Hydrogen');
  assert.equal(restarted.preferredModel, 'GPT-6.2');
  assert.equal(restarted.reviewWorkflow, false);
  await h.send({ type: 'saveSettings', tabId: 1, settings: { reviewWorkflow: true } });
  h.boot();
  assert.equal((await h.send({ type: 'getSettings', tabId: 1 })).settings.reviewWorkflow, true);
});

test('timed waits survive restart, do not count as work, and resume once', async () => {
  const h = harness();
  await h.start();
  await h.status('', '', { isGenerating: true });
  h.advance(125000);
  const sleep = 'Training needs time.\nMONITOR_SLEEP_MINUTES=15';
  assert.equal((await h.status('sleep-one', sleep)).action, undefined);
  const state = await h.view();
  assert.equal(state.phase, 'sleeping');
  assert.equal(state.workedSeconds, 125);
  assert.equal(state.wakeAt, h.now() + 900000);
  h.advance(600000);
  h.boot();
  assert.equal((await h.status('sleep-one', sleep)).action, undefined);
  assert.equal((await h.view()).workedSeconds, 125);
  h.advance(300000);
  await h.alarm();
  assert.equal(h.deliveries.at(-1).message.type, 'wakeMonitor');
  assert.equal((await h.status('sleep-one', sleep, { composerEmpty: false })).action, undefined);
  const next = await h.status('sleep-one', sleep);
  assert.equal(next.action, 'sendContinue');
  await h.ack();
  assert.equal((await h.status('sleep-one', sleep)).action, undefined);
  assert.equal((await h.view()).wakeAt, null);
});

test('Housekeeping and Reconsider retain their contracts across waits', async () => {
  const h = harness();
  await h.start();
  await h.send({ type: 'saveSettings', tabId: 1, settings: { housekeeping: true } });
  let action = await h.status('initial', 'Work remains.');
  await h.ack();
  for (let i = 1; i <= 3; i++) {
    action = await h.status(`goal-${i}`, 'Work remains.', { latestUserText: action.prompt });
    await h.ack();
  }
  assert.match(action.prompt, /Housekeeping contract/);
  const sleep = 'Wait for the file operation.\nMONITOR_SLEEP_MINUTES=5';
  await h.status('cleanup-sleep', sleep, { latestUserText: action.prompt });
  h.advance(300000);
  action = await h.status('cleanup-sleep', sleep, { latestUserText: action.prompt });
  assert.match(action.prompt, /Housekeeping contract/);
  await h.ack();
  action = await h.status('cleanup-done', 'HOUSEKEEPING_FINISHED', { latestUserText: action.prompt });
  assert.match(action.prompt, /Goal contract/);
  await h.ack();
  action = await h.status('goal-done', 'TASK_FINISHED', { latestUserText: action.prompt });
  assert.equal(action.action, 'sendTerminalReview');
  await h.ack('sendTerminalReview');
  const reviewPrompt = action.prompt;
  await h.status('review-sleep', sleep, { latestUserText: reviewPrompt });
  h.advance(300000);
  action = await h.status('review-sleep', sleep, { latestUserText: reviewPrompt });
  assert.equal(action.action, 'sendTerminalReview');
  assert.match(action.prompt, /Reconsider contract/);
  await h.ack('sendTerminalReview');
  await h.status('review-done', 'RECONSIDER_FINISHED', { latestUserText: action.prompt });
  assert.equal((await h.view()).status, 'finished');
  assert.equal((await h.view()).paused, true);
});

test('only a final valid sleep marker from a completed Gemini reply can delay work', async () => {
  for (const text of ['MONITOR_SLEEP_MINUTES=0', 'MONITOR_SLEEP_MINUTES=1', 'MONITOR_SLEEP_MINUTES=4',
    'MONITOR_SLEEP_MINUTES=N', 'MONITOR_SLEEP_MINUTES=1441', 'MONITOR_SLEEP_MINUTES=1.5',
    'MONITOR_SLEEP_MINUTES=15\nStill working.', 'Example: MONITOR_SLEEP_MINUTES=15']) {
    const h = harness(); await h.start();
    assert.equal((await h.status('reply', text)).action, 'sendContinue', text);
    assert.equal((await h.view()).wakeAt, null);
  }
  const h = harness(); await h.start(2);
  const action = await h.status('reply', 'MONITOR_SLEEP_MINUTES=15', {}, 2);
  assert.equal(action.action, 'sendContinue');
  assert.doesNotMatch(action.prompt, /Gemini quota is counted per turn|MONITOR_SLEEP_MINUTES/);
});

test('manual activity and pause are respected during a wait', async () => {
  const h = harness(); await h.start();
  await h.status('sleep', 'MONITOR_SLEEP_MINUTES=5');
  await h.send({ type: 'setPaused', tabId: 1, paused: true });
  h.advance(300000);
  assert.equal((await h.status('sleep', 'MONITOR_SLEEP_MINUTES=5')).action, undefined);
  await h.send({ type: 'setPaused', tabId: 1, paused: false });
  assert.equal((await h.status('sleep', 'MONITOR_SLEEP_MINUTES=5')).action, 'sendContinue');
  await h.ack();
  await h.status('sleep-again', 'MONITOR_SLEEP_MINUTES=5');
  await h.status('', '', { isGenerating: true });
  assert.equal((await h.view()).wakeAt, null);
  assert.equal((await h.view()).isGenerating, true);
});

test('quota pauses stop continuations and retain sanitized banner evidence across restart', async () => {
  const h = harness(); await h.start();
  const evidence = { text: 'You have reached your Neon usage limit. Reset tomorrow. user@example.com https://example.com/private',
    structure: 'div.usage-limit-banner role=alert', composerDisabled: true };
  await h.send({ type: 'setPaused', tabId: 1, paused: true, reason: 'usage-limit', evidence });
  h.advance(3600000);
  assert.equal((await h.status('ready', 'Keep working.')).action, undefined);
  assert.equal((await h.view()).paused, true);
  assert.match((await h.view()).issue, /quota resets/);
  const logs = await h.send({ type: 'getDiagnostics' });
  const quota = logs.events.find(entry => entry.event === 'quota-limit');
  assert.match(quota.quotaNotice, /Neon usage limit/);
  assert.doesNotMatch(quota.quotaNotice, /user@example|https:/);
  assert.equal(quota.quotaStructure, 'div.usage-limit-banner role=alert');
  assert.equal(h.local.quotaObservations.length, 1);
  h.local.diagnostics = []; // Dedicated evidence outlives ordinary log rotation.
  h.boot();
  assert.equal((await h.view()).paused, true);
  assert.equal((await h.send({ type: 'getDiagnostics' })).events.filter(entry => entry.event === 'quota-limit').length, 1);
});

test('a stale reply cannot put Reconsider to sleep', async () => {
  const h = harness(); await h.start();
  const review = await h.status('finished', 'TASK_FINISHED');
  assert.equal(review.action, 'sendTerminalReview');
  await h.ack('sendTerminalReview');
  assert.equal((await h.status('old-sleep', 'MONITOR_SLEEP_MINUTES=15', { latestUserText: 'An older prompt' })).action, undefined);
  assert.equal((await h.view()).wakeAt, null);
  assert.equal((await h.view()).phase, 'waiting-for-terminal-review');
});

test('resuming after a quota reset retries an unsent automated prompt', async () => {
  const h = harness(); await h.start();
  const action = await h.status('before-quota', 'Work remains.');
  await h.send({ type: 'commandResult', url: geminiUrl, action: 'sendContinue', ok: false, reason: 'send-button-unavailable' });
  await h.send({ type: 'setPaused', tabId: 1, paused: true, reason: 'usage-limit', evidence: { text: 'Neon usage limit reached.' } });
  h.advance(3600000);
  await h.send({ type: 'setPaused', tabId: 1, paused: false });
  assert.equal((await h.view()).issue, '');
  const retry = await h.status('before-quota', 'Work remains.');
  assert.equal(retry.action, 'sendContinue');
  assert.equal(retry.prompt, action.prompt);
});

test('Gemini repeats full guidance after four short continuations across rounds and restarts', async () => {
  const h = harness(); await h.start();
  await h.send({ type: 'saveContinuePreset', index: 0, text: 'Finish the agreed experiment.' });
  await h.send({ type: 'saveAgentInstructions', text: '# Style\nKeep language clear.' });
  await h.send({ type: 'historyScanComplete', url: geminiUrl, workedSeconds: 20000 });
  const first = await h.status('initial', 'Work remains.');
  const footer = first.prompt.slice(first.prompt.indexOf("The user's Gemini quota"));
  assert.match(first.prompt, /^This is an automated continuation/);
  assert.doesNotMatch(first.prompt, /compaction|harness|Gemini Task guidance|If an external job|Do not create a Gemini scheduled/);
  assert.ok(first.prompt.indexOf('Global AGENTS.md') < first.prompt.indexOf(footer));
  assert.ok(first.prompt.endsWith('then sends the next prompt.'));
  await h.ack();
  let previous = first;
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i <= 4; i++) {
      const next = await h.status(`goal-${round}-${i}`, 'Work remains.', { latestUserText: `@DevSpace Laptop ${previous.prompt}` });
      assert.equal(next.prompt, 'Continue.');
      if (i === 2) {
        await h.send({ type: 'commandResult', url: geminiUrl, action: 'sendContinue', ok: false, reason: 'send-button-unavailable' });
        h.advance(60000);
        h.boot();
        const retry = await h.status(`goal-${round}-${i}`, 'Work remains.', { latestUserText: previous.prompt, composerEmpty: false });
        assert.equal(retry.prompt, next.prompt);
      }
      await h.ack();
      if (i === 2) h.boot();
      previous = next;
    }
    const refresh = await h.status(`refresh-${round}`, 'Work remains.', { latestUserText: previous.prompt });
    assert.equal(refresh.prompt, first.prompt);
    await h.ack();
    previous = refresh;
  }
  const next = await h.status('next-short', 'Work remains.', { latestUserText: previous.prompt });
  assert.equal(next.prompt, 'Continue.');
  const logs = await h.send({ type: 'getDiagnostics' });
  assert.equal(logs.events.filter(entry => entry.event === 'action-requested').at(-1).promptMode, 'goal-continue');
  await h.send({ type: 'sendCyclePrompt', tabId: 1, url: geminiUrl, kind: 'housekeeping' });
  assert.ok(h.deliveries.at(-1).message.prompt.endsWith(footer));
  await h.send({ type: 'saveContinuePreset', index: 0, text: first.prompt });
  assert.equal((await h.send({ type: 'getSettings', tabId: 1 })).settings.continuePrompt, 'Finish the agreed experiment.');
});

test('Gemini refreshes changed instructions immediately and counts only accepted sends', async () => {
  const h = harness(); await h.start();
  const first = await h.status('first', 'Work remains.');
  await h.send({ type: 'commandResult', url: geminiUrl, action: 'sendContinue', ok: false, reason: 'send-button-unavailable' });
  h.advance(60000);
  h.boot();
  const retry = await h.status('first', 'Work remains.');
  assert.equal(retry.prompt, first.prompt);
  await h.ack();
  let next = await h.status('second', 'Work remains.', { latestUserText: first.prompt });
  assert.equal(next.prompt, 'Continue.');
  await h.ack();
  await h.send({ type: 'saveContinuePreset', index: 0, text: 'Verify the updated goal.' });
  next = await h.status('third', 'Work remains.', { latestUserText: next.prompt });
  assert.match(next.prompt, /Verify the updated goal/);
  assert.match(next.prompt, /MONITOR_SLEEP_MINUTES=N/);
  await h.ack();
  await h.send({ type: 'saveAgentInstructions', text: '# Style\nUse clear language.' });
  next = await h.status('fourth', 'Work remains.', { latestUserText: next.prompt });
  assert.equal(next.prompt.split('Global AGENTS.md').length - 1, 1);
  await h.ack();
  const review = await h.status('finished', 'TASK_FINISHED', { latestUserText: next.prompt });
  await h.ack('sendTerminalReview');
  await h.status('review-sleep', 'MONITOR_SLEEP_MINUTES=5', { latestUserText: review.prompt });
  h.advance(300000);
  const wake = await h.status('review-sleep', 'MONITOR_SLEEP_MINUTES=5', { latestUserText: review.prompt });
  assert.equal(wake.prompt, review.prompt);
  assert.equal(wake.prompt.split('Global AGENTS.md').length - 1, 1);
});
