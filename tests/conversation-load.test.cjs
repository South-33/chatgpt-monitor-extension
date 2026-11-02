const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
let now = 1000, clicks = 0, present = true, composer = false, allowed = true, generating = false;
const messages = [];
const card = { innerText: 'Could not load this ChatGPT conversation', closest: () => null };
const button = { parentElement: card, getAttribute: () => null };
const context = {
  loadRecovery: { url: '/c/test', attempts: 0, retryAt: 0 }, location: { href: '/c/test' },
  stopped: false, Date: { now: () => now },
  isConversationPage: () => true, isGenerating: () => generating,
  document: { querySelectorAll: () => present ? [button] : [] },
  visible: Boolean, buttonLabel: () => 'Try again', findComposer: () => composer,
  sendRuntime: async m => { messages.push(m.type); return { ok: allowed }; },
  HTMLElement: { prototype: { click() { clicks++; } } },
};
vm.runInNewContext(src.slice(src.indexOf('function conversationLoadRetryButton'), src.indexOf('async function scan()')), context);
(async () => {
  assert.equal(await context.recoverConversationLoad(), true);
  assert.equal(clicks, 1);
  await context.recoverConversationLoad();
  assert.equal(clicks, 1, 'DOM churn must not repeat clicks');
  now += 30000;
  await context.recoverConversationLoad();
  assert.equal(clicks, 2);
  now += 30000;
  await context.recoverConversationLoad();
  assert.equal(clicks, 2, 'second backoff is 60 seconds');
  present = false;
  assert.equal(await context.recoverConversationLoad(), true, 'loading is not recovered');
  assert.equal(messages.includes('conversationLoadRecovered'), false);
  composer = true;
  assert.equal(await context.recoverConversationLoad(), false);
  assert.equal(messages.at(-1), 'conversationLoadRecovered');
  present = true; allowed = false;
  await context.recoverConversationLoad();
  assert.equal(clicks, 2, 'pause/ownership change prevents click');
  generating = true;
  assert.equal(context.conversationLoadRetryButton(), null);
  generating = false;
  card.closest = () => ({});
  assert.equal(context.conversationLoadRetryButton(), null, 'ignore errors quoted in chat');
  assert.ok(src.indexOf('if (tabRole.paused) { resetExtendedThinking("monitor-reset"); return; }')
    < src.indexOf('if (await recoverConversationLoad()) { resetExtendedThinking("monitor-reset"); return; }'));
  console.log('conversation_load_recovery_ok');
})().catch(e => { console.error(e); process.exitCode = 1; });
