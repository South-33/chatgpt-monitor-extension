const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const oldUrl = 'https://chatgpt.com/c/task-one';
const newUrl = 'https://chatgpt.com/c/task-two';
const helper = content.slice(content.indexOf('function sameConversation('), content.indexOf('function visible('));

async function contentChecks() {
  const location = { href: oldUrl };
  let clicks = 0;
  let written = 0;
  let submitted = false;
  let switchOnOwnership = true;
  const composer = {};
  const button = {};
  const ctx = {
    location, URL,
    stopped: false,
    findComposer: () => composer,
    composerText: () => submitted ? '' : 'continue',
    findSendButton: () => button,
    sendButtonReady: () => true,
    waitFor: async predicate => Boolean(predicate()),
    sendRuntime: async () => {
      if (switchOnOwnership) location.href = newUrl;
      return { target: true, paused: false };
    },
    isGenerating: () => false,
    hasBlockingUi: () => false,
    comparableText: text => text,
    latestUserMatchesPrompt: () => submitted,
    HTMLButtonElement: { prototype: { click() { clicks++; submitted = true; } } },
    normalizedText: text => text.trim(),
    visible: () => true,
    ensureModelPreferences: async () => {
      if (switchOnOwnership) location.href = newUrl;
      return true;
    },
    setComposerText: async () => { written++; return true; },
  };
  const submit = content.slice(content.indexOf('async function submitComposer('), content.indexOf('function modelPickerTrigger('));
  const send = content.slice(content.indexOf('async function sendPrompt('), content.indexOf('async function manualSwap('));
  vm.runInNewContext(`${helper}\n${submit}\n${send}`, ctx);

  assert.equal(ctx.sameConversation(`${oldUrl}?messageId=abc`), true,
    'display query parameters must not interrupt the current chat');
  assert.equal(await ctx.submitComposer(composer, oldUrl), false,
    'navigation during the final ownership check must cancel the Send click');
  assert.equal(clicks, 0);

  location.href = oldUrl;
  assert.equal(await ctx.sendPrompt('continue'), false,
    'navigation while setting preferences must prevent text from being written');
  assert.equal(written, 0);
  assert.equal(clicks, 0);

  switchOnOwnership = false;
  location.href = `${oldUrl}?messageId=current`;
  assert.equal(await ctx.submitComposer(composer, oldUrl), true,
    'the same conversation can submit after harmless query-string changes');
  assert.equal(clicks, 1);
}

async function backgroundChecks() {
  const local = {};
  let listener;
  const event = { addListener() {} };
  const chrome = {
    runtime: { onInstalled: event, onStartup: event,
      onMessage: { addListener(callback) { listener = callback; } } },
    storage: { local: { async get(key) { return { [key]: local[key] }; },
      async set(value) { Object.assign(local, value); } },
      session: { async get() { return {}; } } },
    scripting: { async executeScript() {} },
    tabs: { async get(id) { return { id, url: oldUrl }; },
      async sendMessage() { return undefined; }, onRemoved: event },
    alarms: { create() {}, onAlarm: event },
  };
  vm.runInNewContext(background, { chrome, console, URL, Date });
  const sender = url => ({ tab: { id: 23, url } });
  const send = (message, from = sender(oldUrl)) => new Promise(resolve => listener(message, from, resolve));
  await send({ type: 'setMonitoring', enabled: true, tabId: 23, url: oldUrl });
  const first = await send({ type: 'status', url: oldUrl, responseKey: 'first',
    latestResponseText: 'Work remains.', isGenerating: false });
  assert.equal(first.action, 'sendContinue');
  assert.equal(local.runtime.states[23].phase, 'sending-continue');

  const staleStatus = await send({ type: 'status', url: oldUrl, responseKey: 'stale',
    latestResponseText: 'Wrong conversation.', isGenerating: false }, sender(newUrl));
  assert.equal(staleStatus.action, undefined);
  const staleAck = await send({ type: 'commandResult', action: 'sendContinue',
    ok: true, url: oldUrl }, sender(newUrl));
  assert.equal(staleAck.ok, false);
  assert.equal(local.runtime.states[23].phase, 'sending-continue',
    'stale messages must not mutate the pending action');

  const fresh = await send({ type: 'status', url: newUrl, responseKey: 'fresh',
    latestResponseText: 'Different task.', isGenerating: false }, sender(newUrl));
  assert.equal(fresh.action, 'sendContinue');
  assert.equal(local.runtime.states[23].conversationKey.includes('task-two'), true);
  const lateAck = await send({ type: 'commandResult', action: 'sendContinue',
    ok: true, url: oldUrl }, sender(oldUrl));
  assert.equal(lateAck.ok, false);
  assert.equal(local.runtime.states[23].phase, 'sending-continue');

  const manual = await send({ type: 'manualContinue', tabId: 23 }, sender(newUrl));
  assert.equal(manual.ok, false,
    'missing content-script acknowledgement must not be presented as a successful manual send');
}

(async () => {
  await contentChecks();
  await backgroundChecks();
  console.log('navigation_guards_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
