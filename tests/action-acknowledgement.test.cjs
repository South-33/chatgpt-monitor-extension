const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const background = fs.readFileSync(require('node:path').join(__dirname, '..', 'background.js'), 'utf8');
const event = () => ({ addListener() {} });

const local = {};
let listener;
const chrome = {
  runtime: { onInstalled: event(), onStartup: event(),
    onMessage: { addListener(fn) { listener = fn; } } },
  storage: { local: { async get(key) { return { [key]: local[key] }; },
    async set(value) { Object.assign(local, value); } },
    session: { async get() { return {}; } } },
  scripting: { async executeScript() {} },
  tabs: { async get(id) { return { id, url: `https://chatgpt.com/c/${id}` }; },
    async sendMessage() { return { ok: true }; }, onRemoved: event() },
  alarms: { create() {}, onAlarm: event() },
};
vm.runInNewContext(background, { chrome, console, URL, Date });
const send = (message, tabId) => new Promise(resolve => listener(message,
  { tab: { id: tabId, url: `https://chatgpt.com/c/${tabId}` } }, resolve));
const url = tabId => `https://chatgpt.com/c/${tabId}`;
const reply = 'The agent completed the first investigation and recorded the tested result. The remaining work includes verifying all edge cases, documenting the important constraints, and identifying the next useful action. A second agent can resume from these recorded observations and avoid repeating previous tests.';

(async () => {
  await send({ type: 'setMonitoring', tabId: 1, url: url(1), enabled: true }, 1);
  assert.equal((await send({ type: 'manualSwap', tabId: 1 }, 1)).ok, true);
  assert.equal(local.runtime.states[1].phase, 'sending-handoff');

  const oldReply = await send({ type: 'status', url: url(1), isGenerating: false,
    responseKey: 'reply-before-handoff', latestResponseText: reply,
    latestResponseIsSubstantive: true, latestUserText: 'Original user prompt',
    composerEmpty: true }, 1);
  assert.equal(oldReply.action, undefined,
    'a visible old reply must not be captured as a new handoff');
  assert.equal(local.runtime.states[1].phase, 'sending-handoff');

  await send({ type: 'status', url: url(1), isGenerating: true,
    latestUserText: 'Original user prompt' }, 1);
  assert.equal(local.runtime.states[1].phase, 'sending-handoff',
    'generation from the original turn does not confirm the handoff send');
  const stillOld = await send({ type: 'status', url: url(1), isGenerating: false,
    responseKey: 'reply-before-handoff', latestResponseText: reply,
    latestResponseIsSubstantive: true, latestUserText: 'Original user prompt',
    composerEmpty: true }, 1);
  assert.equal(stillOld.action, undefined);

  await send({ type: 'commandResult', action: 'sendHandoff', ok: true, url: url(1) }, 1);
  assert.equal(local.runtime.states[1].phase, 'waiting-for-handoff');
  const handoffReply = await send({ type: 'status', url: url(1), isGenerating: false,
    responseKey: 'actual-handoff-reply', latestResponseText: reply,
    latestResponseIsSubstantive: true, latestUserText: 'Handoff prompt',
    composerEmpty: true }, 1);
  assert.equal(handoffReply.action, 'rotateWithHandoff');

  await send({ type: 'setMonitoring', tabId: 2, url: url(2), enabled: true }, 2);
  const first = await send({ type: 'status', url: url(2), isGenerating: false,
    responseKey: 'first-reply', latestResponseText: 'Continue the task.' }, 2);
  assert.equal(first.action, 'sendContinue');
  const prior = await send({ type: 'status', url: url(2), isGenerating: false,
    responseKey: 'unrelated-old-reply', latestResponseText: 'Old reply.',
    latestUserText: 'Prior user message', composerEmpty: true }, 2);
  assert.equal(prior.action, undefined, 'unacknowledged continuation cannot dispatch a second prompt');
  assert.equal(local.runtime.states[2].phase, 'sending-continue');

  await send({ type: 'commandResult', action: 'sendContinue', ok: false,
    reason: 'composer-blocked', url: url(2) }, 2);
  const diagnostics = await send({ type: 'getDiagnostics' }, 2);
  const failedSend = diagnostics.events.findLast(entry =>
    entry.event === 'action-result' && entry.tabId === 2 && entry.success === false);
  assert.equal(failedSend.reason, 'composer-blocked',
    'failed continuation diagnostics keep the exact content-script reason');
  assert.match(local.runtime.states[2].issue, /became busy/i,
    'the popup issue explains the fast precondition failure');
  console.log('action_acknowledgement_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
