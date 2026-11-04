const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const composerHelpers = source.slice(source.indexOf('function normalizedText('), source.indexOf('async function clearComposer('));
const sendSource = source.slice(source.indexOf('async function sendPrompt('), source.indexOf('async function manualSwap('));
const submitSource = source.slice(source.indexOf('async function submitComposer('), source.indexOf('function modelPickerTrigger('));
const deliverySource = source.slice(source.indexOf('async function deliverPendingHandoff('), source.indexOf('function conversationLoadRetryButton('));

const textNode = value => ({ nodeType: 3, textContent: value });
const mention = {
  nodeType: 1, tagName: 'SPAN', textContent: 'spacedev', childNodes: [textNode('spacedev')],
  matches(selector) { return selector.includes('[app-mention-name]'); },
};
const paragraph = children => ({
  nodeType: 1, tagName: 'P', childNodes: children,
  matches() { return false; },
});

function editor(initialDraft = '') {
  const composer = {
    nodeType: 1, tagName: 'DIV', childNodes: [paragraph([mention])],
    innerText: `spacedev${initialDraft ? `\n${initialDraft}` : ''}`,
    textContent: `spacedev${initialDraft}`,
    querySelector(selector) { return selector.includes('[app-mention-name]') ? mention : null; },
    matches() { return false; },
    focus() {}, dispatchEvent() {},
  };
  if (initialDraft) composer.childNodes.push(paragraph([textNode(initialDraft)]));
  return composer;
}

const prompt = 'Another agent worked on this original task. Continue using the verified evidence.';

async function scenario(initialDraft = '', pluginPresent = true, { modelOk = true, modelKeepsPlugin = true } = {}) {
  const composer = editor(initialDraft);
  let inserted = 0;
  let sendAttempts = 0;
  const verifications = [];
  let cleared = 0;
  const context = {
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document: {
      createRange: () => ({ selectNodeContents() {}, collapse() {} }),
      execCommand(command, _showUi, value) {
        assert.equal(command, 'insertText');
        inserted++;
        composer.childNodes.push(paragraph([textNode(value)]));
        return true;
      },
    },
    InputEvent: class { constructor(type, init) { Object.assign(this, init, { type }); } },
    Event: class { constructor(type, init) { Object.assign(this, init, { type }); } },
    location: { href: 'https://chatgpt.com/' },
    stopped: false,
    lastPromptFailureReason: 'unknown',
    sendRuntime: async () => ({ target: true, paused: false, preferredModel: 'GPT-6' }),
    isGenerating: () => sendAttempts > 0,
    hasBlockingUi: () => false,
    sameConversation: () => true,
    visible: () => true,
    findComposer: () => composer,
    findSendButton: () => ({ ready: inserted > 0 || initialDraft === prompt }),
    sendButtonReady: button => button.ready,
    waitFor: async predicate => Boolean(predicate()),
    ensureModelPreferences: async (_preferences, force) => {
      assert.equal(context.composerText(composer), prompt,
        'verify the model after the draft has reached the composer');
      verifications.push(force);
      if (!modelKeepsPlugin) pluginPresent = false;
      return modelOk;
    },
    pluginSelected: () => pluginPresent,
    HTMLButtonElement: class { click() { sendAttempts++; } },
    clearComposer: async () => { cleared++; },
  };
  vm.runInNewContext(`${composerHelpers}\n${submitSource}\n${sendSource}`, context);
  assert.equal(context.composerText(composer), initialDraft,
    'selected spacedev mention must not count as an unsent draft');
  const delivered = await context.sendPrompt(prompt, true);
  return { context, composer, delivered, inserted, sendAttempts, verifications, cleared };
}

async function deliveryScenario() {
  const events = [];
  let pluginSelected = false;
  let delivered = false;
  const prompt = 'Relay the captured handoff into this fresh chat.';
  const context = {
    location: { href: 'https://chatgpt.com/' },
    lastPromptFailureReason: 'unknown',
    hasBlockingUi: () => false,
    sameConversation: () => true,
    isConversationPage: () => false,
    latestUserMatchesPrompt: () => false,
    pluginSelected: () => pluginSelected,
    selectConfiguredPlugin: async () => { events.push('plugin'); pluginSelected = true; return true; },
    sendPrompt: async (_prompt, requirePlugin) => {
      events.push(`send:${requirePlugin}`);
      delivered = true;
      return true;
    },
    sendRuntime: async message => {
      if (message.type === 'getPendingHandoff') return { prompt };
      if (message.type === 'handoffDelivered') events.push('delivered');
      if (message.type === 'commandResult') events.push(`failed:${message.reason}`);
      return { ok: true };
    },
  };
  vm.runInNewContext(deliverySource, context);
  await context.deliverPendingHandoff();
  return { events, delivered, reason: context.lastPromptFailureReason };
}

(async () => {
  const clean = await scenario();
  assert.equal(clean.delivered, true, 'plugin-only editor accepts a handoff');
  assert.equal(clean.inserted, 1);
  assert.equal(clean.sendAttempts, 1);
  assert.deepEqual(clean.verifications, [true],
    'fresh handoff opens the picker once, immediately before send');
  assert.equal(clean.context.composerText(clean.composer), prompt,
    'handoff is inserted after and independently of the plugin mention');
  assert.strictEqual(clean.composer.childNodes[0].childNodes[0], mention,
    'the selected plugin mention remains attached');

  const unsafe = await scenario('My unfinished private draft');
  assert.equal(unsafe.delivered, false, 'do not overwrite an unrelated user draft');
  assert.equal(unsafe.inserted, 0);
  assert.equal(unsafe.sendAttempts, 0);
  assert.equal(unsafe.context.lastPromptFailureReason, 'composer-has-draft');

  const missingPlugin = await scenario('', false);
  assert.equal(missingPlugin.delivered, false,
    'handoff must not be submitted without its selected plugin');
  assert.equal(missingPlugin.inserted, 0);
  assert.equal(missingPlugin.context.lastPromptFailureReason, 'plugin-selection-lost');

  const fresh = await deliveryScenario();
  assert.deepEqual(fresh.events, ['plugin', 'send:true', 'delivered']);
  assert.equal(fresh.delivered, true);

  const modelFailure = await scenario('', true, { modelOk: false });
  assert.equal(modelFailure.context.lastPromptFailureReason, 'model-preference');
  assert.equal(modelFailure.delivered, false, 'handoff must not send when preferred model verification fails');

  const pluginLost = await scenario('', true, { modelKeepsPlugin: false });
  assert.equal(pluginLost.context.lastPromptFailureReason, 'plugin-selection-lost');
  assert.equal(pluginLost.cleared, 1, 'release the handoff draft for the retry');
  assert.equal(pluginLost.delivered, false,
    'handoff must not send unless preferred model and configured plugin are valid together');
  console.log('handoff_composer_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
