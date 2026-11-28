const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const adapter = fs.readFileSync(path.join(__dirname, '..', 'gemini.js'), 'utf8');

test('every Gemini continuation requires a fresh composer connector and preserves human drafts', async () => {
  let draft = '', chip = false, mentions = 0, sends = 0;
  const location = { href: 'https://gemini.google.com/u/2/app/test' };
  const composer = {};
  const ctx = {
    location, stopped: false, lastPromptFailureReason: '',
    sendRuntime: async () => ({ target: true, paused: false }),
    sameConversation: url => url === location.href,
    isGenerating: () => false, hasBlockingUi: () => false,
    findComposer: () => composer, visible: () => true,
    waitFor: async predicate => Boolean(predicate()),
    normalizedText: text => text.trim(), comparableText: text => text.trim(),
    composerText: () => draft,
    clearComposer: async () => { draft = ''; return true; },
    setComposerText: async (_, text) => { draft = text; return true; },
    pluginSelected: () => chip, isPluginLabel: text => text.includes('DevSpace'),
    submitComposer: async (_, url, requirePlugin) => {
      assert.equal(requirePlugin, true);
      assert.equal(chip, true);
      assert.equal(url, location.href);
      sends++; chip = false; draft = ''; return true;
    },
    AgentMonitorGemini: {
      ensureTask: async () => true,
      selectConnector: async ({ canAct }) => {
        if (draft || !await canAct()) return false;
        mentions++; chip = true; return true;
      },
    },
  };
  vm.runInNewContext(content.slice(content.indexOf('async function geminiCanAct('),
    content.indexOf('async function manualSwap(')), ctx);
  for (const prompt of ['Goal contract', 'Housekeeping contract', 'Reconsider contract']) {
    assert.equal(await ctx.sendPrompt(prompt), true);
  }
  assert.equal(mentions, 3);
  assert.equal(sends, 3);
  draft = 'A human draft';
  assert.equal(await ctx.sendPrompt('Goal contract'), false);
  assert.equal(draft, 'A human draft');
  assert.equal(sends, 3);
  draft = '';
  ctx.AgentMonitorGemini.selectConnector = async () => false;
  assert.equal(await ctx.sendPrompt('Goal contract'), false);
  assert.equal(sends, 3, 'a missing connector must prevent sending');
  ctx.AgentMonitorGemini.ensureTask = async () => false;
  assert.equal(await ctx.sendPrompt('Goal contract'), false);
  assert.equal(ctx.lastPromptFailureReason, 'task-mode-required');
});

test('Task selection reads Gemini buttons with aria-pressed and never treats Chat as Task', async () => {
  let selected = false;
  const task = { textContent: 'Task', getBoundingClientRect: () => ({ width: 50, height: 30 }),
    getAttribute: name => name === 'aria-pressed' ? String(selected) : null,
    click() { selected = true; } };
  const ctx = { location: { hostname: 'gemini.google.com' },
    document: { querySelector: () => null, querySelectorAll: () => [task] },
    getComputedStyle: () => ({ visibility: 'visible' }) };
  vm.runInNewContext(adapter, ctx);
  assert.equal(ctx.AgentMonitorGemini.taskSelected(), false);
  assert.equal(await ctx.AgentMonitorGemini.ensureTask({ waitFor: async predicate => predicate(), canAct: async () => true }), true);
  assert.equal(ctx.AgentMonitorGemini.taskSelected(), true);
});

test('quota text must show an exhausted limit or a reset notice with a disabled composer', () => {
  const ctx = { location: { hostname: 'gemini.google.com' } };
  vm.runInNewContext(adapter, ctx);
  const detect = ctx.AgentMonitorGemini.isQuotaNotice;
  assert.equal(detect("You've hit your usage limit. Try again later."), true);
  assert.equal(detect('Neon limit reached. Resets at 4 PM.'), true);
  assert.equal(detect('Your usage quota resets tomorrow.', true), true);
  assert.equal(detect('Your usage quota resets tomorrow.', false), false);
  assert.equal(detect('A file exceeded the size limit.', true), false);
  assert.equal(detect('Training completed. Please review the results.'), false);
});

test('quota evidence comes from the composer area and excludes conversation text and its ancestors', () => {
  const node = (text, { inChat = false, containsChat = false } = {}) => ({
    innerText: text, textContent: text, tagName: 'DIV', classList: ['usage-banner'],
    getBoundingClientRect: () => ({ width: 200, height: 40 }),
    getAttribute: name => name === 'role' ? 'alert' : null,
    closest: () => inChat ? {} : null,
    querySelector: () => containsChat ? {} : null,
    contains: () => false,
  });
  const chat = node('You have reached your usage limit. Try again tomorrow.', { inChat: true });
  const wrapper = node(chat.innerText, { containsChat: true });
  const banner = node('Neon usage limit reached. Resets tomorrow.');
  let nodes = [wrapper, chat, banner];
  const root = { querySelectorAll: () => nodes };
  const input = { parentElement: { parentElement: root } };
  const composer = { closest: () => input, getAttribute: name => name === 'contenteditable' ? 'false' : null };
  const ctx = { location: { hostname: 'gemini.google.com' },
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => composer } };
  vm.runInNewContext(adapter, ctx);
  const evidence = ctx.AgentMonitorGemini.quotaEvidence();
  assert.equal(evidence.text, banner.innerText);
  assert.equal(evidence.composerDisabled, true);
  assert.equal(evidence.structure, 'div.usage-banner role=alert');
  nodes = [wrapper, chat];
  assert.equal(ctx.AgentMonitorGemini.quotaEvidence(), null);
});
