const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const local = {};
const event = () => ({ addListener() {} });
function worker() {
  let listener;
  let removed;
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(),
      onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      async get(key) { return { [key]: structuredClone(local[key]) }; },
      async set(value) { Object.assign(local, structuredClone(value)); },
    }, session: { async get() { return {}; } }, onChanged: event() },
    scripting: { async executeScript() {} },
    tabs: { async get(id) { return { id, url: `https://chatgpt.com/c/${id}` }; },
      onRemoved: { addListener(fn) { removed = fn; } } },
    alarms: { create() {}, onAlarm: event() },
  };
  vm.runInNewContext(source, { chrome, console, URL, Date });
  return {
    send: (message, sender = {}) => new Promise(resolve => listener(message, sender, resolve)),
    remove: id => removed(id),
  };
}

(async () => {
  let harness = worker();
  await Promise.all([1, 2, 3, 4].map(tabId => harness.send({
    type: 'saveContinuePreset', tabId, index: tabId - 1, text: `Work on task ${tabId} only.`,
  })));
  for (const tabId of [1, 2, 3, 4]) {
    const settings = (await harness.send({ type: 'getSettings', tabId })).settings;
    assert.equal(settings.continuePresetIndex, tabId - 1);
    assert.equal(settings.continuePrompt, `Work on task ${tabId} only.`);
    for (let index = 0; index < 4; index++) {
      assert.equal(settings.continuePresets[index], `Work on task ${index + 1} only.`);
    }
    const url = `https://chatgpt.com/c/${tabId}`;
    await harness.send({ type: 'setMonitoring', enabled: true, tabId, url });
    const action = await harness.send({ type: 'status', url, isGenerating: false,
      responseKey: `reply-${tabId}`, latestResponseText: 'More work remains.',
    }, { tab: { id: tabId, url } });
    assert.equal(action.action, 'sendContinue');
    assert.ok(action.prompt.includes(`\n\nWork on task ${tabId} only.\n\n`));
    await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url }, { tab: { id: tabId, url } });
  }
  assert.equal((await harness.send({ type: 'isTargetTab' }, { tab: { id: 5 } })).target, false,
    'monitoring selected tabs must not enroll other open tabs');
  // Only successful deliveries count, with independent cycles for each thread.
  const cycleUrl = 'https://chatgpt.com/c/2';
  const cycleSender = { tab: { id: 2, url: cycleUrl } };
  const continuation = key => harness.send({ type: 'status', url: cycleUrl, isGenerating: false,
    responseKey: key, latestResponseText: 'More work remains.' }, cycleSender);
  const generic1 = await continuation('cycle-generic-1');
  assert.ok(generic1.prompt.endsWith('\n\ncontinue'));
  assert.equal(generic1.prompt.includes('TASK_FINISHED'), false, 'generic turns omit the completion contract');
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: false, url: cycleUrl }, cycleSender);
  assert.equal(local.runtime.states[2].genericContinuesRemaining, 2, 'failed sends do not advance the cycle');
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  harness = worker();
  const generic2 = await continuation('cycle-generic-2');
  assert.ok(generic2.prompt.endsWith('\n\ncontinue'), 'the cycle survives worker restarts');
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  const customAgain = await continuation('cycle-custom-again');
  assert.ok(customAgain.prompt.includes('Work on task 2 only.'));
  assert.ok(customAgain.prompt.includes('TASK_FINISHED'));
  assert.equal(local.runtime.states[3].genericContinuesRemaining, 2, 'another tab has its own cycle');
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  await harness.send({ type: 'saveContinuePreset', tabId: 2, index: 1, text: 'Updated task two notes.' });
  const updatedCustom = await continuation('cycle-updated-custom');
  assert.ok(updatedCustom.prompt.includes('Updated task two notes.'), 'changed custom notes are sent before another generic turn');
  await harness.send({ type: 'saveContinuePreset', tabId: 2, index: 1, text: 'Work on task 2 only.' });
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  const beforeRecovery = local.runtime.states[2].genericContinuesRemaining;
  const checkIn = await harness.send({ type: 'extendedThinkingRecoveryReady', url: cycleUrl }, cycleSender);
  assert.equal(checkIn.prompt.includes('automated continuation'), false, 'recovery keeps its short status check');
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  assert.equal(local.runtime.states[2].genericContinuesRemaining, beforeRecovery, 'check-ins do not advance normal cadence');
  await harness.send({ type: 'saveContinuePreset', tabId: 2, index: 1, text:
    'this is a automated system message((user may include alot of prompting in this system message and it might be sent too often. so reason well in ur context to know when or when not to care for these extra notes/messages).\n\nWork on task 2 only.' });
  assert.equal((await harness.send({ type: 'getSettings', tabId: 2 })).settings.continuePrompt, 'Work on task 2 only.',
    'remove the duplicated automation preamble while preserving the custom task notes');
  await harness.send({ type: 'setMonitoring', enabled: false, tabId: 1 });
  assert.equal((await harness.send({ type: 'isTargetTab' }, { tab: { id: 1 } })).target, false);
  for (const tabId of [2, 3, 4]) {
    assert.equal((await harness.send({ type: 'isTargetTab' }, { tab: { id: tabId } })).target, true,
      'stopping one tab must leave the others monitored');
  }
  // Both the chosen slot and its text survive a worker restart and same-tab navigation.
  harness = worker();
  await harness.send({ type: 'setMonitoring', enabled: true, tabId: 2,
    url: 'https://chatgpt.com/c/new-handoff-chat' });
  const newConversation = await harness.send({ type: 'status', url: 'https://chatgpt.com/c/new-handoff-chat',
    isGenerating: false, responseKey: 'fresh-reply', latestResponseText: 'More work remains.' },
    { tab: { id: 2, url: 'https://chatgpt.com/c/new-handoff-chat' } });
  assert.ok(newConversation.prompt.includes('Work on task 2 only.'), 'a fresh conversation starts with custom notes');
  assert.equal((await harness.send({ type: 'getSettings', tabId: 2 })).settings.continuePrompt,
    'Work on task 2 only.');
  await harness.send({ type: 'saveContinuePreset', tabId: 1, index: 3, text: 'Changed tab one.' });
  assert.equal((await harness.send({ type: 'getSettings', tabId: 4 })).settings.continuePrompt,
    'Changed tab one.', 'edits sync to other tabs using the same slot');
  assert.equal((await harness.send({ type: 'getSettings', tabId: 2 })).settings.continuePresetIndex,
    1, 'editing another slot must not change this tab selection');
  await harness.remove(1);
  assert.equal(local.settings.tabContinuePresets[1], undefined, 'closed tabs must release their profiles');
  assert.equal((await harness.send({ type: 'getSettings', tabId: 5 })).settings.continuePrompt,
    'Work on task 1 only.', 'new tabs start with shared slot one');
  await harness.send({ type: 'saveContinuePreset', index: 3 });
  assert.equal((await harness.send({ type: 'getSettings', tabId: 6 })).settings.continuePresetIndex,
    0, 'a new tab must start on slot one even when the legacy global selection differs');
  console.log('tab_prompts_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
