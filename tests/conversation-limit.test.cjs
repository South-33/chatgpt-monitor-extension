const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const warning = "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.";
let nodes = [];
const context = {
  document: { querySelectorAll: () => nodes },
  visible: node => !node.hidden,
  normalizedText: text => text.replace(/\s+/g, ' ').trim(),
  pendingToolApproval: () => false,
  materializationDialog: () => null,
  blockingUiRunning: false,
};
vm.runInNewContext(source.slice(source.indexOf('function conversationLimitReached()'),
  source.indexOf('function reportApproval(')), context);
const notice = (text, quoted = false, hidden = false) => ({
  textContent: text, hidden, closest: () => quoted ? {} : null,
});
nodes = [notice(warning)];
assert.equal(context.hasBlockingUi(), true, 'the limit blocks every guarded send');
nodes = [notice(warning.replace("You've", 'You’ve'))];
assert.equal(context.conversationLimitReached(), true);
for (const node of [notice(warning, true), notice(warning, false, true),
  notice('An example warning is ' + warning), notice('Message delivery timed out. Please try again.')]) {
  nodes = [node];
  assert.equal(context.hasBlockingUi(), false, 'quotes, hidden warnings, and delivery errors are separate cases');
}

(async () => {
  nodes = [notice(warning)];
  const messages = [];
  Object.assign(context, {
    stopped: false, scanRunning: false, manualActionRunning: false,
    location: { href: 'https://chatgpt.com/c/full' },
    configuredPluginName: '', resetExtendedThinking() {},
    async sendRuntime(message) {
      messages.push(message);
      if (message.type === 'isTargetTab') return { target: true };
      return { ok: true };
    },
    recoverConversationLoad() { assert.fail('the limit must pause before load recovery'); },
  });
  vm.runInNewContext(source.slice(source.indexOf('async function scan()'),
    source.indexOf('function scheduleScan(', source.indexOf('async function scan()'))), context);
  await context.scan();
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: 'isTargetTab', url: context.location.href },
    { type: 'setPaused', paused: true, reason: 'conversation-limit', url: context.location.href },
  ]);
  console.log('conversation_limit_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
