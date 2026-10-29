const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const start = source.indexOf('function refreshStatus()');
const end = source.indexOf('function renderPresetButtons()', start);

(async () => {
  let release;
  let requests = 0;
  const renders = [];
  const sandbox = {
    findActiveTab: async () => ({ id: 1, url: 'https://chatgpt.com/c/test' }),
    chrome: { runtime: { sendMessage() {
      requests++;
      return new Promise(resolve => { release = resolve; });
    } } },
    renderStatus: result => renders.push(result),
  };
  vm.runInNewContext(`let statusRefresh = null; let activeTab; ${source.slice(start, end)}`, sandbox);
  const first = sandbox.refreshStatus();
  assert.equal(sandbox.refreshStatus(), first, 'refresh callers must share the pending request');
  await new Promise(setImmediate);
  assert.equal(requests, 1);
  release({ enabled: true });
  await first;
  assert.equal(renders.length, 1);

  const next = sandbox.refreshStatus();
  await new Promise(setImmediate);
  assert.equal(requests, 2, 'a completed refresh must allow the next update');
  release(null);
  await next;
  assert.equal(renders[1].lookupFailed, true);
  console.log('popup_refresh_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });