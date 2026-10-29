const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const start = source.indexOf('async function findActiveTab()');
const end = source.indexOf('function refreshStatus()', start);
const tabs = new Map([
  [1, { id: 1, url: 'https://chatgpt.com/c/left' }],
  [2, { id: 2, url: 'https://chatgpt.com/c/right' }],
]);
let focusedTab = 2;
function popup(ownTab) {
  let queries = 0;
  const sandbox = { chrome: { tabs: {
    async query(options) {
      queries++;
      return [tabs.get(options.currentWindow ? ownTab : focusedTab)];
    },
    async get(id) {
      if (!tabs.has(id)) throw new Error('Tab closed');
      return tabs.get(id);
    },
  } } };
  vm.runInNewContext(`let popupTabId = null; ${source.slice(start, end)}`, sandbox);
  return { find: sandbox.findActiveTab, queries: () => queries };
}

(async () => {
  const left = popup(1);
  const right = popup(2);
  assert.equal((await left.find()).id, 1, 'the left popup must use its own window');
  assert.equal((await right.find()).id, 2);
  focusedTab = 1;
  assert.equal((await right.find()).id, 2, 'focus changes must not redirect popup actions');
  assert.equal(left.queries(), 1);
  assert.equal(right.queries(), 1, 'refreshes must reuse the bound tab rather than query all windows');
  tabs.delete(1);
  await assert.rejects(left.find(), /Tab closed/, 'a closed tab must not fall back to another task');
  console.log('popup_tab_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });