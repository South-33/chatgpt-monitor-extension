const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const start = source.indexOf('function syncSavedSettings(');
const end = source.indexOf('function formatMinutes(', start);

function popup(tabId, index) {
  let changed;
  const sandbox = {
    settingsLoaded: true, promptTabId: tabId, savedSettings: null,
    pendingModelWrites: 0, preferredModel: { value: '', disabled: false },
    preferredReasoning: { value: '', disabled: false },
    enforceModelPreferences: { checked: true },
    updateModelControls() {
      sandbox.preferredModel.disabled = !sandbox.enforceModelPreferences.checked;
      sandbox.preferredReasoning.disabled = !sandbox.enforceModelPreferences.checked;
    },
    promptTimer: null, thresholdTimer: null, pendingPromptWrites: 0,
    switchingPreset: false, saveFailed: false,
    presets: ['one', 'two', 'three', 'four'], activePreset: index,
    continuePrompt: { value: ['one', 'two', 'three', 'four'][index] },
    threshold: { value: 400 }, thinkingMinutes: { value: 15 },
    document: { activeElement: null }, renderPresetButtons() {},
    chrome: { storage: { onChanged: { addListener(fn) { changed = fn; } } } },
  };
  vm.runInNewContext(source.slice(start, end), sandbox);
  return { sandbox, update: settings => changed({ settings: { newValue: settings } }, 'local') };
}
const left = popup(1, 0);
const right = popup(2, 1);
const settings = {
  continuePresets: ['updated one', 'updated two', 'three', 'four'],
  tabContinuePresets: { 1: { index: 0 }, 2: { index: 1 } },
  thresholdMinutes: 300, thinkingMinutes: 10,
  preferredModel: 'GPT-5.6 Sol', preferredReasoning: 'high',
  enforceModelPreferences: true,
};
left.update(settings);
right.update(settings);
assert.equal(left.sandbox.continuePrompt.value, 'updated one');
assert.equal(right.sandbox.continuePrompt.value, 'updated two');
assert.equal(right.sandbox.activePreset, 1, 'shared text must not synchronize selected slots');
assert.equal(right.sandbox.preferredModel.value, 'GPT-5.6 Sol');
assert.equal(left.sandbox.preferredReasoning.value, 'high');
left.update({ ...settings, enforceModelPreferences: false });
assert.equal(left.sandbox.enforceModelPreferences.checked, false);
assert.equal(left.sandbox.preferredModel.disabled, true);
assert.equal(left.sandbox.preferredReasoning.disabled, true);
left.update(settings);
assert.equal(left.sandbox.preferredModel.disabled, false);
right.sandbox.pendingModelWrites = 1;
right.sandbox.preferredModel.value = 'GPT-6';
right.update(settings);
assert.equal(right.sandbox.preferredModel.value, 'GPT-6', 'model saves must not erase a queued edit');
right.sandbox.pendingModelWrites = 0;

right.sandbox.continuePrompt.value = 'a draft being typed';
right.sandbox.promptTimer = 1;
right.update({ ...settings, continuePresets: ['updated one', 'remote change', 'three', 'four'] });
assert.equal(right.sandbox.continuePrompt.value, 'a draft being typed', 'remote saves must not erase local typing');
right.sandbox.promptTimer = null;
right.sandbox.pendingPromptWrites = 1;
right.sandbox.presets[1] = right.sandbox.continuePrompt.value;
right.update(settings);
assert.equal(right.sandbox.continuePrompt.value, 'a draft being typed', 'queued saves must finish before resync');
right.sandbox.pendingPromptWrites = 0;
right.update({ ...settings, continuePresets: ['updated one', 'a draft being typed', 'three', 'four'] });
assert.equal(right.sandbox.presets[1], 'a draft being typed');
console.log('popup_sync_ok');
