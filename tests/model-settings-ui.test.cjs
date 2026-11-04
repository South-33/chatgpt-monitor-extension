const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

assert.match(html, /id="enforceModelPreferences" type="checkbox"/);
assert.match(html, /<select id="preferredModel" disabled>/,
  'a real select shows all models instead of filtering a datalist to typed text');
assert.match(html, /<option value="GPT-6">GPT-6<\/option>/);
assert.match(html, /<option value="GPT-5\.6 Sol">GPT-5\.6 Sol<\/option>/);

(async () => {
  const sent = [];
  const ctx = {
    settingsLoaded: true,
    pendingControlWrites: 0, controlSaveQueue: Promise.resolve(), savedSettings: null,
    preferredModel: { value: 'GPT-6', disabled: false },
    preferredReasoning: { value: 'high', disabled: false },
    enforceModelPreferences: { checked: false },
    clearTimeout() {}, showNotice(text) { throw new Error(text); },
    chrome: { runtime: { async sendMessage(message) { sent.push(message); return { settings: message.settings }; } } },
  };
  vm.runInNewContext(script.slice(script.indexOf('function updateModelControls()'),
    script.indexOf('function syncSavedSettings(')), ctx);
  vm.runInNewContext(script.slice(script.indexOf('async function saveControlSettings('),
    script.indexOf('preferredModel.addEventListener(', script.indexOf('async function saveControlSettings('))), ctx);

  ctx.updateModelControls();
  assert.equal(ctx.preferredModel.disabled, true);
  assert.equal(ctx.preferredReasoning.disabled, true);
  await ctx.saveControlSettings();
  assert.equal(sent[0].settings.enforceModelPreferences, false);
  assert.equal(sent[0].settings.preferredModel, 'GPT-6',
    'turning automation off retains the preferred model');
  assert.equal(ctx.pendingControlWrites, 0);

  ctx.enforceModelPreferences.checked = true;
  ctx.updateModelControls();
  assert.equal(ctx.preferredModel.disabled, false);
  await ctx.saveControlSettings();
  assert.equal(sent[1].settings.enforceModelPreferences, true);
  assert.equal(sent[1].settings.preferredReasoning, 'high');
  console.log('model_settings_ui_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
