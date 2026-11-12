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
  const deliveries = [];
  const attachments = [];
  const sendErrors = new Map();
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(),
      onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      async get(key) { return { [key]: structuredClone(local[key]) }; },
      async set(value) { Object.assign(local, structuredClone(value)); },
    }, session: { async get() { return {}; } }, onChanged: event() },
    scripting: { async executeScript({ target }) { attachments.push(target.tabId); } },
    tabs: { async get(id) { return { id, url: `https://chatgpt.com/c/${id}` }; },
      async sendMessage(id, message, options) {
        deliveries.push({ id, ...message, options });
        const error = sendErrors.get(id);
        if (error) {
          sendErrors.delete(id);
          throw new Error(error);
        }
        return { ok: true };
      },
      onRemoved: { addListener(fn) { removed = fn; } } },
    alarms: { create() {}, onAlarm: event() },
  };
  vm.runInNewContext(source, { chrome, console, URL, Date });
  return {
    deliveries,
    attachments,
    sendErrors,
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
    if (tabId === 4) await harness.send({ type: 'saveSettings', tabId, settings: {
      reviewWorkflow: true, preferredModel: 'GPT-6', preferredReasoning: 'medium',
      enforceModelPreferences: false,
    } });
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
    assert.ok(action.prompt.startsWith('This is an automated continuation. Use your judgment.'));
    assert.ok(action.prompt.includes(`\n\nWork on task ${tabId} only.\n\n`));
    assert.equal(action.prompt.match(/automated continuation/gi)?.length, 1,
      'normal prompts have one concise automation preamble');
    assert.equal(action.prompt.includes('Completion contract:'), false,
      'custom prompts use only the compact terminal note');
    await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url }, { tab: { id: tabId, url } });
  }
  assert.equal((await harness.send({ type: 'isTargetTab' }, { tab: { id: 5 } })).target, false,
    'monitoring selected tabs must not enroll other open tabs');
  const reviewUrl = 'https://chatgpt.com/c/4';
  const reviewSender = { tab: { id: 4, url: reviewUrl } };
  assert.equal((await harness.send({ type: 'sendCyclePrompt', tabId: 5,
    url: 'https://chatgpt.com/c/5', kind: 'housekeeping' })).ok, true);
  assert.match(harness.deliveries.at(-1).prompt,
    /\*\*BAD\*\*\n> refactor\(stash\)[\s\S]*\*\*GOOD\*\*\n> fix\(web\): stashed prompts now survive switching providers/);
  await harness.send({ type: 'status', url: 'https://chatgpt.com/c/5', responseKey: 'initial-cleanup',
    latestResponseText: 'The work is organized.\nHOUSEKEEPING_FINISHED',
  }, { tab: { id: 5, url: 'https://chatgpt.com/c/5' } });
  const globalInstructions = '# Working Styles\nKeep scope focused.\n\n# Git\nCommit one coherent decision.\n\n### Example\nExplain what changed and why.\n\n# Project AGENTS.md\nRead project rules.';
  const importResult = await harness.send({ type: 'saveAgentInstructions', text: globalInstructions });
  assert.equal(importResult.hasGit, true);
  harness = worker();
  const readStage = async () => (await harness.send({ type: 'getMonitorStatus', tabId: 4, url: reviewUrl })).cycleStage;
  assert.deepEqual({ ...await readStage() }, { step: 1, total: 2, label: 'Goal' });
  await harness.send({ type: 'saveSettings', tabId: 4, settings: { housekeeping: true } });
  assert.deepEqual({ ...await readStage() }, { step: 1, total: 3, label: 'Goal' });
  const ownership = await harness.send({ type: 'isTargetTab' }, reviewSender);
  assert.equal(ownership.preferredModel, 'GPT-6');
  assert.equal(ownership.preferredReasoning, 'medium');
  assert.equal(ownership.enforceModelPreferences, false);
  const other = (await harness.send({ type: 'getSettings', tabId: 2 })).settings;
  assert.equal(other.reviewWorkflow, false);
  assert.equal(other.housekeeping, false);
  assert.equal(other.preferredModel, 'GPT-5.6 Sol');
  for (const [index, step, label, reply, expected] of [
    [1, 1, 'Goal', 'Goal in progress.', /Continue\.\n\nGoal contract/],
    [2, 1, 'Goal', 'Goal in progress.', /Continue\.\n\nGoal contract/],
    [3, 2, 'Improve', 'Goal in progress.', /Improve how you carry out the remaining work on this task/],
    [4, 2, 'Improve', 'IMPROVE_FINISHED was mentioned.\nStill testing.', /IMPROVE_FINISHED/],
    [5, 2, 'Improve', 'TASK_BLOCKED', /IMPROVE_BLOCKED/],
    [6, 3, 'Housekeeping', 'Verified the new harness.\nIMPROVE_FINISHED', /HOUSEKEEPING_FINISHED/],
    [7, 3, 'Housekeeping', 'HOUSEKEEPING_FINISHED\nStill consolidating.', /HOUSEKEEPING_BLOCKED/],
    [8, 1, 'Goal', 'Need access to the archive.\nHOUSEKEEPING_BLOCKED', /Work on task 4 only\./],
    [9, 1, 'Goal', 'Goal in progress.', /Continue\.\n\nGoal contract/],
    [10, 1, 'Goal', 'Goal in progress.', /Continue\.\n\nGoal contract/],
    [11, 2, 'Improve', 'Goal in progress.', /Improve contract/],
  ]) {
    let latestUserText;
    if (index === 1) {
      const check = await harness.send({ type: 'extendedThinkingRecoveryReady', url: reviewUrl }, reviewSender);
      await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: reviewUrl }, reviewSender);
      latestUserText = check.prompt;
    }
    if (index === 2) harness = worker();
    if (index === 5) {
      const check = await harness.send({ type: 'extendedThinkingRecoveryReady', url: reviewUrl }, reviewSender);
      await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: reviewUrl }, reviewSender);
      const resumed = await harness.send({ type: 'status', url: reviewUrl, responseKey: 'check-in',
        latestUserText: check.prompt, latestResponseText: 'Interrupted while running the benchmark.',
      }, reviewSender);
      assert.match(resumed.prompt, /IMPROVE_FINISHED/);
      await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: reviewUrl }, reviewSender);
    }
    const action = await harness.send({ type: 'status', url: reviewUrl, isGenerating: false,
      responseKey: `workflow-${index}`, latestResponseText: reply, latestUserText,
    }, reviewSender);
    assert.match(action.prompt, expected);
    if (step === 3) {
      assert.match(action.prompt, /Commit one coherent decision\.[\s\S]*Explain what changed and why\./);
      assert.doesNotMatch(action.prompt, /Keep scope focused|Read project rules/);
    }
    await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: reviewUrl }, reviewSender);
    const { cycleStage } = await harness.send({ type: 'getMonitorStatus', tabId: 4, url: reviewUrl });
    assert.deepEqual({ ...cycleStage }, { step, total: 3, label });
  }
  const sendNow = { type: 'sendCyclePrompt', tabId: 4, url: reviewUrl, kind: 'housekeeping' };
  assert.equal((await harness.send(sendNow)).ok, true);
  assert.match(harness.deliveries.at(-1).prompt, /HOUSEKEEPING_FINISHED[\s\S]*Commit one coherent decision/);
  assert.equal((await readStage()).label, 'Housekeeping');
  await harness.send({ type: 'setPaused', tabId: 4, paused: true });
  assert.equal((await harness.send({ ...sendNow, kind: 'improve' })).ok, true);
  assert.equal((await harness.send({ type: 'getMonitorStatus', tabId: 4, url: reviewUrl })).paused, true);
  harness.sendErrors.set(5, 'Could not establish connection. Receiving end does not exist.');
  const off = { ...sendNow, tabId: 5, url: 'https://chatgpt.com/c/5' };
  assert.equal((await harness.send(off)).ok, true, 'attach to an off tab after a confirmed missing listener');
  assert.deepEqual(harness.attachments.filter(id => id === 5), [5]);
  assert.equal(harness.deliveries.at(-1).options.frameId, 0);
  assert.equal(harness.deliveries.filter(entry => entry.id === 5).length, 2);
  const temporarySender = { tab: { id: 5, url: off.url } };
  const temporaryReply = (responseKey, latestResponseText) => harness.send({
    type: 'status', url: off.url, responseKey, latestResponseText, workedSeconds: 18000, composerEmpty: true,
  }, temporarySender);
  assert.equal((await harness.send({ type: 'isTargetTab' }, temporarySender)).target, true);
  assert.deepEqual({ ...(await harness.send({ type: 'getMonitorStatus', tabId: 5, url: off.url })).cycleStage },
    { step: 1, total: 1, label: 'Housekeeping' });
  const followUp = await temporaryReply('partial-cleanup', 'The docs still need consolidation.');
  assert.equal(followUp.action, 'sendContinue');
  assert.match(followUp.prompt, /HOUSEKEEPING_FINISHED/);
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: off.url }, temporarySender);
  harness.sendErrors.set(5, 'The message port closed before a response was received.');
  assert.equal((await harness.send(off)).ok, false);
  assert.equal(harness.deliveries.filter(entry => entry.id === 5).length, 3, 'an ambiguous send must not be repeated');
  const { events: diagnostics } = await harness.send({ type: 'getDiagnostics' });
  assert.ok(diagnostics.some(entry => entry.tabId === 5 && entry.source === 'manual-contract'
    && entry.contract === 'housekeeping' && entry.reason === 'command-unconfirmed'));
  harness = worker();
  assert.equal((await temporaryReply('cleanup-finished', 'The docs are consolidated.\nHOUSEKEEPING_FINISHED')).action, undefined);
  assert.equal((await harness.send({ type: 'getMonitorStatus', tabId: 5, url: off.url })).status, 'off');
  assert.equal((await harness.send({ type: 'isTargetTab' }, reviewSender)).target, true);
  assert.equal((await harness.send({ ...off, kind: 'improve' })).ok, true);
  assert.equal((await temporaryReply('improve-blocked', 'The benchmark needs access.\nIMPROVE_BLOCKED')).action, undefined);
  assert.equal((await harness.send({ type: 'isTargetTab' }, temporarySender)).target, false);
  assert.equal((await harness.send(off)).ok, true);
  const otherChat = { tab: { id: 5, url: 'https://chatgpt.com/c/different-chat' } };
  await harness.send({ type: 'historyScanComplete', url: otherChat.tab.url, workedSeconds: 30 }, otherChat);
  assert.equal((await harness.send({ type: 'isTargetTab' }, otherChat)).target, false,
    'a temporary contract cannot become regular monitoring in a different chat');
  assert.equal((await harness.send({ ...sendNow, url: 'https://chatgpt.com/c/other' })).ok, false);
  await harness.send({ type: 'setPaused', tabId: 4, paused: false });
  const checkpoint = 'The original goal is recorded here. Improve is still testing its new harness. '
    + 'Use the verified benchmark evidence and finish checking the remaining results before returning to the main task. '
    + 'The benchmark results are in the workspace next to the current implementation.';
  assert.equal((await harness.send({ type: 'handoffCaptured', text: checkpoint, url: reviewUrl }, reviewSender)).ok, true);
  const fresh = { tab: { id: 4, url: 'https://chatgpt.com/' } };
  assert.match((await harness.send({ type: 'getPendingHandoff' }, fresh)).prompt, /Resume the current step first\.[\s\S]*IMPROVE_FINISHED/);
  await harness.send({ type: 'handoffDelivered', url: fresh.tab.url }, fresh);
  assert.equal((await readStage()).label, 'Improve', 'handoff carries an unfinished step into the fresh chat');
  // Only successful deliveries count, with independent cycles for each thread.
  const cycleUrl = 'https://chatgpt.com/c/2';
  const cycleSender = { tab: { id: 2, url: cycleUrl } };
  const continuation = key => harness.send({ type: 'status', url: cycleUrl, isGenerating: false,
    responseKey: key, latestResponseText: 'More work remains.' }, cycleSender);
  const generic1 = await continuation('cycle-goal-1');
  assert.match(generic1.prompt, /Continue\.\n\nGoal contract[\s\S]*TASK_FINISHED/);
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: false, url: cycleUrl }, cycleSender);
  assert.equal(local.runtime.states[2].cycleTask, 'goal', 'failed sends keep the current step');
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  harness = worker();
  const generic2 = await continuation('cycle-goal-2');
  assert.equal(generic2.prompt, generic1.prompt, 'the second short continuation survives a restart');
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  const customAgain = await continuation('cycle-custom-again');
  assert.ok(customAgain.prompt.includes('Work on task 2 only.'));
  assert.ok(customAgain.prompt.includes('TASK_FINISHED'));
  assert.equal(local.runtime.states[3].cycleTask, 'goal', 'another tab has its own cycle');
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  await harness.send({ type: 'saveContinuePreset', tabId: 2, index: 1, text: 'Updated task two notes.' });
  assert.equal((await continuation('cycle-updated-custom')).prompt, generic1.prompt);
  await harness.send({ type: 'saveContinuePreset', tabId: 2, index: 1, text: 'Work on task 2 only.' });
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  const beforeRecovery = local.runtime.states[2].cycleTask;
  const checkIn = await harness.send({ type: 'extendedThinkingRecoveryReady', url: cycleUrl }, cycleSender);
  assert.equal(checkIn.prompt.includes('automated continuation'), false, 'recovery keeps its short status check');
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: cycleUrl }, cycleSender);
  assert.equal(local.runtime.states[2].cycleTask, beforeRecovery, 'check-ins do not advance the cycle');
  await harness.send({ type: 'saveContinuePreset', tabId: 2, index: 1, text: customAgain.prompt });
  assert.equal((await harness.send({ type: 'getSettings', tabId: 2 })).settings.continuePrompt, 'Work on task 2 only.',
    'current generated wrappers are stripped when pasted back into a preset');
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
  const spacedPrompt = '  Work on task 2 only.  \n\n';
  await harness.send({ type: 'saveContinuePreset', tabId: 2, index: 1, text: spacedPrompt });
  harness = worker();
  assert.equal((await harness.send({ type: 'getSettings', tabId: 2 })).settings.continuePrompt,
    spacedPrompt, 'preserve the editor text through autosave and worker restart');
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
    0, 'a new tab must start on slot one even when the global selection differs');

  const refreshUrl = 'https://chatgpt.com/c/refresh-instructions';
  const refreshSender = { tab: { id: 6, url: refreshUrl } };
  await harness.send({ type: 'setMonitoring', enabled: true, tabId: 6, url: refreshUrl });
  const refreshStatus = (responseKey, workedSeconds) => harness.send({
    type: 'status', url: refreshUrl, responseKey, workedSeconds,
    latestResponseText: 'More work remains.', composerEmpty: true,
  }, refreshSender);
  const beforeRefresh = await refreshStatus('below-threshold', 1650);
  assert.doesNotMatch(beforeRefresh.prompt, /Global AGENTS\.md/);
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: refreshUrl }, refreshSender);
  const refresh = await refreshStatus('past-threshold', 1700);
  assert.ok(refresh.prompt.startsWith('This is an automated continuation.'));
  assert.ok(refresh.prompt.endsWith(globalInstructions));
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: false, url: refreshUrl }, refreshSender);
  harness = worker();
  await harness.send({ type: 'retryNow', tabId: 6 });
  assert.equal((await refreshStatus('past-threshold', 1700)).prompt, refresh.prompt);
  await harness.send({ type: 'commandResult', action: 'sendContinue', ok: true, url: refreshUrl }, refreshSender);
  assert.doesNotMatch((await refreshStatus('after-refresh', 1800)).prompt, /Global AGENTS\.md/);
  console.log('tab_prompts_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
