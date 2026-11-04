const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
let nodes = [];
const currentTurn = {
  hasAttribute: name => name === 'data-turn-key',
  querySelectorAll: () => nodes,
};
const ctx = {
  document: { querySelectorAll: () => [currentTurn] },
  assistantTurns: () => [],
};
vm.runInNewContext(source.slice(source.indexOf('function responseFromTurn'), source.indexOf('function latestUserText')), ctx);
for (const text of ['Everything is still stable. More work remains.', 'All work is verified.\nTASK_FINISHED']) {
  nodes = [{ innerText: text, contains: () => false }];
  assert.equal(ctx.latestAssistantResponse().text, text, 'read final answer without an English heading');
  assert.equal(ctx.latestAssistantResponse().substantive, true);
}
nodes = [];
assert.equal(ctx.latestAssistantResponse().text, '', 'a new user-only turn cannot reuse an older answer');
const review = 'Before accepting TASK_BLOCKED, check the original blocker.';
const collapsedBubble = {
  innerText: `${review}\n…\nShow more`,
  querySelector: selector => selector === '.whitespace-pre-wrap' ? { textContent: review } : null,
};
ctx.document.querySelectorAll = selector => selector.includes('data-user-message-bubble') ? [collapsedBubble] : [];
ctx.normalizedText = value => value.trim();
const userTextStart = source.indexOf('function latestUserText');
vm.runInNewContext(source.slice(userTextStart, source.indexOf('\n}', userTextStart) + 2), ctx);
assert.equal(ctx.latestUserText(), review, 'collapsed user prompts exclude expand controls');
console.log('response_reading_ok');
