const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'background.js'), 'utf8');
const persistSource = source.slice(source.indexOf('async function persistSettings()'), source.indexOf('function syncKeepAwake()'));

(async () => {
  const pending = [];
  const writes = [];
  const stored = {};
  const state = { phase: 'watching' };
  const settings = { preferredModel: 'GPT-6' };
  const ctx = {
    settings, states: new Map([[1, state]]), pendingHandoffs: new Map(),
    settingsWrites: Promise.resolve(), runtimeWrites: Promise.resolve(),
    chrome: { storage: { local: { set(payload) {
      const copy = JSON.parse(JSON.stringify(payload));
      writes.push(copy);
      return new Promise(resolve => pending.push(() => { Object.assign(stored, copy); resolve(); }));
    } } } },
  };
  vm.runInNewContext(persistSource, ctx);

  const first = ctx.persistRuntime();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 1);
  state.phase = 'sending-handoff';
  const second = ctx.persistRuntime();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 1,
    'a second persistence call must not overtake an unfinished storage write');
  pending.shift()();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 1);
  pending.shift()();
  await second;
  assert.equal(stored.runtime.states[1].phase, 'sending-handoff',
    'the stored worker state must be the latest change');

  const pref1 = ctx.persistSettings();
  await new Promise(resolve => setImmediate(resolve));
  settings.preferredModel = 'GPT-5.6 Sol';
  const pref2 = ctx.persistSettings();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 1, 'settings writes must be serialized too');
  pending.shift()();
  await pref1;
  await new Promise(resolve => setImmediate(resolve));
  pending.shift()();
  await pref2;
  assert.equal(stored.settings.preferredModel, 'GPT-5.6 Sol');
  console.log('storage_order_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
