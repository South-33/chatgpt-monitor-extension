const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const event = () => ({ addListener() {} });

async function scenario({ error, baseline = 0, interruption = false }) {
  let now = 100000;
  let listener;
  const local = {};
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: { addListener(fn) { listener = fn; } } },
    storage: {
      local: { async get(key) { return { [key]: local[key] }; }, async set(value) { Object.assign(local, value); } },
      session: { async get() { return {}; } }, onChanged: event(),
    },
    scripting: { async executeScript() {} },
    tabs: { async get(id) { return { id, url: 'https://chatgpt.com/c/test' }; }, onRemoved: event() },
    alarms: { create() {}, onAlarm: event() },
  };
  const clock = class extends Date {
    static now() { return now; }
    constructor(...args) { super(...(args.length ? args : [now])); }
  };
  vm.runInNewContext(background, { chrome, console, URL, Date: clock });
  const sender = { tab: { id: 1, url: 'https://chatgpt.com/c/test' } };
  const send = message => new Promise(resolve => listener(message, sender, resolve));
  await send({ type: 'setMonitoring', enabled: true, tabId: 1, url: sender.tab.url });
  await send({ type: 'saveSettings', settings: { thresholdMinutes: 1 } });
  let generating = false;
  let draft = interruption ? 'Unsent draft' : '';
  const actions = [];
  const main = {
    innerText: 'Thinking\nTool activity from an interrupted response',
    hasAttribute(name) { return interruption && name === 'data-turn-key'; },
    getAttribute(name) { return this.hasAttribute(name) ? 'interrupted-turn' : null; },
    querySelectorAll(selector) {
      return error && selector === (interruption ? '[role="status"]' : '[role="alert"]')
        ? [{ innerText: error }] : [];
    },
  };
  const sandbox = {
    stopped: false, scanRunning: false, manualActionRunning: false, blockingUiRunning: false,
    idleSince: 0, lastScanGenerating: null, lastGeneratingReportAt: 0,
    domRevision: 0, lastProcessedRevision: -1,
    document: { querySelectorAll() { return interruption ? [main] : []; }, querySelector() { return main; } },
    location: { href: sender.tab.url }, Date: clock, console,
    sameConversation: url => url === sender.tab.url,
    sendRuntime: send,
    isConversationPage: () => true,
    isGenerating: () => generating,
    findComposer: () => ({}), visible: () => true,
    assistantTurns: () => [], latestAssistantResponse: () => ({ text: '' }),
    captureResponse: () => interruption
      ? { text: 'Partial reply', responseKey: 'partial', substantive: true }
      : { text: '', responseKey: '', substantive: false },
    latestUserText: () => 'Original goal',
    normalizedText: text => text.trim(), normalizedControlText: text => text.trim(), fingerprint: text => `key:${text}`,
    scanExistingHistory: async () => baseline,
    workedSeconds: () => baseline,
    waitForSettledAssistantResponse: async () => null,
    settleBlockingUiAfterGeneration: async () => false,
    resolveMaterializationPermission: async () => false,
    ensureModelPreferences: async () => true,
    recoverConversationLoad: async () => false,
    recoverExtendedThinking: async () => false,
    resetExtendedThinking: () => {},
    followLatestConversation: () => false,
    hasBlockingUi: () => false, composerText: () => draft,
    terminalMarker: () => null,
    scheduleScan() {},
    async handleAction(action) {
      actions.push(action.action);
      await send({ type: 'commandResult', action: action.action, ok: true, url: sender.tab.url });
    },
  };
  vm.runInNewContext(content.slice(content.indexOf('function streamRecoveryFailure'), content.indexOf('function fingerprint')), sandbox);
  vm.runInNewContext(content.slice(content.indexOf('async function scan()'), content.indexOf('function scheduleScan')), sandbox);
  await sandbox.scan();
  assert.equal(actions.length, 0, 'a transient absence of Stop must settle first');
  now += 6000;
  await sandbox.scan();
  if (interruption) {
    assert.equal(actions.length, 0, 'recovery must wait for an empty composer');
    draft = '';
    await sandbox.scan();
    const detected = local.diagnostics.find(event => event.event === 'response-recovery');
    assert.equal(detected.reason, 'connection-interrupted');
    assert.equal(local.diagnostics.find(event => event.source === 'stream-recovery').promptMode, 'recovery-check');
  }
  assert.deepEqual(actions, [baseline >= 60 ? 'sendHandoff' : 'sendContinue']);
  now += 6000;
  await sandbox.scan();
  assert.equal(actions.length, 1, 'an unchanged interrupted turn must not produce another prompt');

  generating = true;
  sandbox.latestUserText = () => { throw new Error('generating must not scan user history'); };
  sandbox.composerText = () => { throw new Error('generating must not read a submission draft'); };
  now += 10000;
  await sandbox.scan();
  now += 20000;
  const status = await send({ type: 'getMonitorStatus', tabId: 1, url: sender.tab.url });
  assert.ok(status.workedSeconds >= baseline + 20, 'live time must advance independently of Worked for text');
  await send({ type: 'setPaused', tabId: 1, paused: true });
  const phase = status.phase;
  await sandbox.scan();
  assert.equal(actions.length, 1, 'pause must stop automatic actions');
  await send({ type: 'setPaused', tabId: 1, paused: false });
  assert.equal((await send({ type: 'getMonitorStatus', tabId: 1, url: sender.tab.url })).phase, phase,
    'resume must preserve a pending handoff or response phase');
}

(async () => {
  await scenario({ error: 'Resume stream unavailable' });
  await scenario({ error: null });
  await scenario({ error: 'ChatGPT stream recovery polling timed out', baseline: 61 });
  await scenario({ error: 'Connection interrupted. Waiting for the complete answer', interruption: true });
  console.log('idle_lifecycle_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
