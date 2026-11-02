const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const composerHelpers = source.slice(source.indexOf('function normalizedText('), source.indexOf('async function clearComposer('));
const sendSource = source.slice(source.indexOf('async function sendPrompt('), source.indexOf('async function sendPromptWithRetry('));
const deliverySource = source.slice(source.indexOf('async function preparePendingHandoff('), source.indexOf('function conversationLoadRetryButton('));

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

async function scenario(initialDraft = '', pluginPresent = true) {
  const composer = editor(initialDraft);
  let inserted = 0;
  let sendAttempts = 0;
  let forcedVerification;
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
    isGenerating: () => false,
    hasBlockingUi: () => false,
    sameConversation: () => true,
    visible: () => true,
    findComposer: () => composer,
    waitFor: async predicate => Boolean(predicate()),
    ensureModelPreferences: async (_preferences, force) => { forcedVerification = force; return true; },
    devSpaceSelected: () => pluginPresent,
    submitComposer: async () => { sendAttempts++; return true; },
  };
  vm.runInNewContext(`${composerHelpers}\n${sendSource}`, context);
  assert.equal(context.composerText(composer), initialDraft,
    'selected spacedev mention must not count as an unsent draft');
  const delivered = await context.sendPrompt(prompt, true);
  return { context, composer, delivered, inserted, sendAttempts, forcedVerification };
}

async function deliveryScenario({ modelOk = true, modelKeepsPlugin = true } = {}) {
  const events = [];
  let pluginSelected = false;
  let delivered = false;
  const prompt = 'Relay the captured handoff into this fresh chat.';
  const preferences = { preferredModel: 'GPT-5.6 Sol', preferredReasoning: 'high' };
  const context = {
    location: { href: 'https://chatgpt.com/' },
    lastPromptFailureReason: 'unknown',
    hasBlockingUi: () => false,
    sameConversation: () => true,
    isConversationPage: () => false,
    latestUserMatchesPrompt: () => false,
    devSpaceSelected: () => pluginSelected,
    enableDevSpace: async () => { events.push('devspace'); pluginSelected = true; return true; },
    ensureModelPreferences: async (_preferences, force) => {
      events.push(`model:${force}`);
      if (!modelKeepsPlugin) pluginSelected = false;
      return modelOk;
    },
    sendPromptWithRetry: async (_prompt, requireDevSpace) => {
      events.push(`send:${requireDevSpace}`);
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
  await context.deliverPendingHandoff(preferences);
  return { events, delivered, reason: context.lastPromptFailureReason };
}

(async () => {
  const clean = await scenario();
  assert.equal(clean.delivered, true, 'plugin-only editor accepts a handoff');
  assert.equal(clean.inserted, 1);
  assert.equal(clean.sendAttempts, 1);
  assert.equal(clean.forcedVerification, undefined,
    'sending reuses valid model verification instead of forcing a second model-menu click');
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
    'handoff must not be submitted without its selected DevSpace attachment');
  assert.equal(missingPlugin.inserted, 0);
  assert.equal(missingPlugin.context.lastPromptFailureReason, 'plugin-selection-lost');

  const fresh = await deliveryScenario();
  assert.deepEqual(fresh.events, ['devspace', 'model:true', 'send:true', 'delivered'],
    'fresh handoff selects DevSpace, then force-verifies the model before sending');
  assert.equal(fresh.delivered, true);

  const modelFailure = await deliveryScenario({ modelOk: false });
  assert.deepEqual(modelFailure.events, ['devspace', 'model:true', 'failed:model-preference']);
  assert.equal(modelFailure.delivered, false, 'handoff must not send when preferred model verification fails');

  const pluginLost = await deliveryScenario({ modelKeepsPlugin: false });
  assert.deepEqual(pluginLost.events,
    ['devspace', 'model:true', 'devspace', 'model:true', 'failed:plugin-selection-lost'],
    'retry the joint state once when model selection drops the plugin');
  assert.equal(pluginLost.delivered, false,
    'handoff must not send unless preferred model and DevSpace are valid together');
  console.log('handoff_composer_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
