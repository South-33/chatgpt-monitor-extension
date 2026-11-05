const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'logs.js'), 'utf8');
assert.ok(fs.existsSync(path.join(__dirname, '..', 'logs')), 'a selectable logs directory must exist');

async function fixture({ pickerWorks = true, currentFolder = null } = {}) {
  const buttons = new Map(['chooseFolder', 'reconnectFolder', 'downloadLogs', 'agentInstructions',
    'clearAgentInstructions', 'agentInstructionsStatus'].map(id => [id, {
    disabled: false, hidden: false, addEventListener(_event, handler) { this.click = handler; },
  }]));
  const status = { textContent: '' };
  const events = [{ time: '2026-10-29T01:00:00Z', event: 'test-event' }];
  let folder = currentFolder;
  let pickCount = 0;
  let savedCount = 0;
  let permissionCount = 0;
  let downloaded = false;
  const handle = {
    name: 'logs',
    async queryPermission() { return 'granted'; },
    requestPermission() { permissionCount++; return Promise.resolve('granted'); },
  };
  const context = {
    window: { showDirectoryPicker: () => {
      pickCount++;
      if (!pickerWorks) throw new DOMException('Picker blocked', 'SecurityError');
      return Promise.resolve(handle);
    } },
    document: {
      querySelector(selector) { return selector === '#status' ? status : buttons.get(selector.slice(1)); },
      createElement() { return { click() { downloaded = true; }, remove() {} }; },
      body: { append() {} },
    },
    AgentMonitorLogFiles: {
      async directory() { return folder; },
      async pendingEntries() { return events; },
      async setDirectory(next) { folder = next; savedCount++; },
    },
    chrome: { runtime: { async sendMessage(message) {
      if (message.type === 'getDiagnostics') return { events };
      return { ok: true };
    } } },
    Blob, DOMException, Date, Promise,
    setTimeout: (callback, delay) => { assert.equal(delay, 30000); },
    URL: { createObjectURL: () => 'blob:logs', revokeObjectURL() {} },
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    buttons, status, handle,
    click: id => buttons.get(id).click(),
    pickCount: () => pickCount, savedCount: () => savedCount,
    permissionCount: () => permissionCount, downloaded: () => downloaded,
  };
}

(async () => {
  const fresh = await fixture();
  const pick = fresh.click('chooseFolder');
  assert.equal(fresh.pickCount(), 1, 'folder picker starts directly in click handler before asynchronous work');
  await pick;
  assert.equal(fresh.savedCount(), 1);
  assert.match(fresh.status.textContent, /Logging to logs/);

  const blocked = await fixture({ pickerWorks: false });
  await blocked.click('chooseFolder');
  assert.match(blocked.status.textContent, /Chrome blocked the folder picker/);
  await blocked.click('downloadLogs');
  assert.equal(blocked.downloaded(), true, 'user can download diagnostics without folder-picker support');
  assert.match(blocked.status.textContent, /Downloaded 1 event/);

  const existing = await fixture({ currentFolder: {
    name: 'logs',
    async queryPermission() { return 'prompt'; },
    requestPermission() { return Promise.resolve('granted'); },
  } });
  assert.equal(existing.buttons.get('reconnectFolder').hidden, false);
  await existing.click('reconnectFolder');
  assert.equal(existing.savedCount(), 1);
  assert.equal(existing.pickCount(), 0, 'renew permissions without picking a new directory');
  console.log('log_page_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
