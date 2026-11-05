const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
const start = source.indexOf('async function recoverExtendedThinking()');
const end = source.indexOf('function findComposer()', start);

async function scenario(stopSucceeds) {
  let generating = true;
  const events = [];
  const sandbox = {
    extendedThinkingRecoveryRequested: false, extendedThinkingRetryAt: 0, extendedThinkingStopFailures: 0,
    location: { href: 'https://chatgpt.com/c/current' }, Date,
    sameConversation: url => url === 'https://chatgpt.com/c/current',
    console: { info() {} }, setTimeout: callback => callback(),
    extendedThinkingTimedOut: () => true,
    findStopButton: () => generating ? {} : null,
    HTMLButtonElement: { prototype: { click() { events.push('stop'); if (stopSucceeds) generating = false; } } },
    isGenerating: () => generating,
    waitFor: async predicate => Boolean(predicate()),
    reportDiagnostic: event => events.push(event),
    terminalMarker: () => null, captureResponse: () => ({ text: '' }),
    sendRuntime: async message => {
      events.push(message.type);
      return { action: 'sendContinue', prompt: 'status-check' };
    },
    handleAction: async action => { assert.equal(generating, false); events.push(`send:${action.prompt}`); },
  };
  vm.runInNewContext(source.slice(start, end), sandbox);
  await sandbox.recoverExtendedThinking();
  return { events, sandbox };
}

async function sendNow({ stopSucceeds, draft = '' }) {
  const events = [];
  let generating = true;
  const url = 'https://chatgpt.com/c/current';
  const sandbox = {
    location: { href: url }, stopped: false, manualActionRunning: false, scanRunning: false,
    lastPromptFailureReason: 'unknown', hasBlockingUi: () => false,
    sameConversation: expected => expected === url,
    findComposer: () => ({}), composerText: () => draft,
    findStopButton: () => generating ? {} : null,
    isGenerating: () => generating,
    HTMLButtonElement: { prototype: { click() { events.push('stop'); generating = !stopSucceeds; } } },
    waitFor: async predicate => Boolean(predicate()), setTimeout: callback => callback(),
    async sendPrompt(prompt, requirePlugin, cyclePrompt) {
      assert.equal(generating, false);
      assert.equal(cyclePrompt, true);
      events.push(prompt);
      return true;
    },
    sendRuntime() { assert.fail('a direct send must not report itself as a handoff'); },
  };
  vm.runInNewContext(source.slice(source.indexOf('async function manualSwap'), source.indexOf('async function waitForSettledAssistantResponse')), sandbox);
  return { ok: await sandbox.manualSwap('Improve', url, true), events };
}

(async () => {
  const recovered = await scenario(true);
  assert.deepEqual(recovered.events, ['watchdog-stop-requested', 'stop', 'watchdog-stop-confirmed',
    'extendedThinkingRecoveryReady', 'send:status-check'], 'Stop must complete before requesting the status check');
  const failed = await scenario(false);
  assert.equal(failed.events.includes('extendedThinkingStopFailed'), true);
  assert.equal(failed.events.some(event => event.startsWith('send:')), false, 'a failed Stop must never send a follow-up');
  assert.equal(failed.sandbox.extendedThinkingStopFailures, 1);
  assert.deepEqual(await sendNow({ stopSucceeds: true }), { ok: true, events: ['stop', 'Improve'] });
  assert.deepEqual(await sendNow({ stopSucceeds: false }), { ok: false, events: ['stop'] });
  assert.deepEqual(await sendNow({ stopSucceeds: true, draft: 'Unsent draft' }), { ok: false, events: [] });
  console.log('delay_recovery_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
