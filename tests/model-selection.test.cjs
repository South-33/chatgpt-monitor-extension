const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
const initialState = source.slice(source.indexOf('let stopped = false;'), source.indexOf('function normalizedControlText(value)'));
const flow = source.slice(source.indexOf('function modelPickerTrigger()'), source.indexOf('async function sendPrompt('));

function fixture(menuDelayQueries = 0, compact = false, initialModel = 'GPT-6') {
  let open = false, advanced = false, selected = initialModel, effort = compact ? 'high' : 'medium';
  let generating = false, blocked = false, paused = false;
  const clicks = [], reports = [];
  const preferences = { preferredModel: 'GPT-5.6 Sol', preferredReasoning: 'high' };
  const node = (text, attrs = {}) => ({
    textContent: text, innerText: text,
    getAttribute(name) { return attrs[name] ?? null; },
    hasAttribute(name) { return name in attrs; },
    closest() { return this.inert ? {} : null; },
    focus() {},
  });
  const badge = () => `${compact ? '' : 'Thinking effort\n'}${selected === 'GPT-5.6 Sol' ? '5.6 ' : ''}${effort[0].toUpperCase() + effort.slice(1)}`;
  const trigger = node(badge(),
    compact ? { 'aria-haspopup': 'menu' } : { 'aria-label': 'Select ChatGPT model' });
  trigger.id = 'picker';
  trigger.getAttribute = name => ({ 'aria-controls': open ? 'menu' : null,
    'aria-expanded': String(open), 'data-selected-reasoning-effort': effort,
    'aria-label': compact ? null : 'Select ChatGPT model',
    'aria-haspopup': compact ? 'menu' : null })[name] ?? null;
  if (compact) {
    trigger.getAttribute = ((original) => name => name === 'data-selected-reasoning-effort'
      ? null : original(name))(trigger.getAttribute);
    trigger.hasAttribute = name => name === 'aria-haspopup' || name === 'aria-expanded';
  }
  const toggle = node('Medium', { 'aria-label': 'Select model', role: 'menuitem' });
  const models = ['GPT-6', 'GPT-5.6 Sol', 'GPT-5.5\nLeaving on October 14'].map(label => {
    const item = node(label, { role: 'menuitemradio' });
    item.getAttribute = name => name === 'aria-checked' ? String(selected === label.split('\n')[0])
      : name === 'role' ? 'menuitemradio' : null;
    return item;
  });
  const power = node('', compact ? { role: 'slider' }
    : { 'aria-label': 'Power', 'data-reasoning-slider': 'true', role: 'menuitem' });
  if (compact) {
    power.getAttribute = name => name === 'aria-valuetext'
      ? effort[0].toUpperCase() + effort.slice(1)
      : name === 'role' ? 'slider' : null;
  }
  power.dispatchEvent = event => {
    if (event.type !== 'keydown') return;
    const levels = ['instant', 'medium', 'high'];
    effort = levels[Math.max(0, Math.min(2, levels.indexOf(effort) + (event.key === 'ArrowRight' ? 1 : -1)))];
  };
  const status = node('', { role: 'status' });
  const menu = node('', { 'aria-labelledby': 'picker' });
  menu.querySelectorAll = selector => {
    if (menuDelayQueries > 0) { menuDelayQueries--; return []; }
    models.forEach(item => { item.inert = !advanced; });
    power.inert = toggle.inert = advanced;
    status.textContent = effort;
    status.inert = advanced;
    if (selector === '[role="status"]') return [status];
    if (selector.includes('[aria-checked=')) return models.filter(item => item.getAttribute('aria-checked') === 'true');
    return [toggle, power, ...models];
  };
  menu.dispatchEvent = event => {
    if (event.key === 'Escape') {
      open = false;
      trigger.innerText = badge();
    }
  };
  const ctx = {
    location: { href: 'https://chatgpt.com/c/task' },
    sameConversation: url => url === ctx.location.href,
    document: {
      getElementById: id => id === 'menu' && open ? menu : null,
      querySelectorAll: selector => selector === 'button' ? [trigger] : open ? [menu] : [],
    },
    findComposer: () => ({ closest: selector => selector === 'form'
      ? { parentElement: { querySelectorAll: () => [trigger] } } : null }),
    normalizedControlText: text => (text || '').replace(/\s+/g, ' ').trim(),
    visible: element => Boolean(element), controlReady: element => Boolean(element && !element.disabled),
    controlMenuOpen: () => open, isGenerating: () => generating, hasBlockingUi: () => blocked,
    KeyboardEvent: class { constructor(type, properties) { this.type = type; Object.assign(this, properties); } },
    waitFor: async predicate => {
      for (let attempt = 0; attempt < 8; attempt++) {
        if (predicate()) return true;
        await Promise.resolve();
      }
      return false;
    },
    sendRuntime: async message => {
      if (message.type === 'isTargetTab') return { target: true, paused, ...preferences };
      reports.push(message);
    },
    clickControl: element => {
      clicks.push(element);
      if (element === trigger) { open = true; advanced = false; }
      else if (element === toggle) advanced = true;
      else if (models.includes(element)) {
        selected = element.textContent.split('\n')[0]; advanced = false;
      }
    },
  };
  // Evaluate the real top-level state. Supplying test-only model globals used
  // to hide a production ReferenceError even while this entire suite passed.
  vm.runInNewContext(`${initialState}\n${flow}`, ctx);
  return { ctx, preferences, clicks, reports, trigger, menu, models,
    setGenerating: value => { generating = value; }, setBlocked: value => { blocked = value; },
    setPaused: value => { paused = value; },
    selection: () => ({ selected, effort, open }),
  };
}

(async () => {
  const f = fixture();
  const loading = fixture(3);
  assert.equal(await loading.ctx.applyModelPreferences(loading.preferences), true,
    'a mounted menu with controls still loading must settle before selection');
  assert.equal(loading.reports.some(report => !report.ok), false, 'loading is not a picker failure');
  const perf = fixture();
  const query = perf.ctx.document.querySelectorAll;
  const unrelated = Array.from({ length: 200 }, () => ({
    getAttribute: () => 'Send feedback', hasAttribute: () => false,
  }));
  perf.ctx.document.querySelectorAll = selector => selector === 'button' ? [...unrelated, perf.trigger] : query(selector);
  let layoutChecks = 0;
  perf.ctx.controlReady = element => { layoutChecks++; return Boolean(element); };
  assert.equal(perf.ctx.modelPickerTrigger(), perf.trigger);
  assert.equal(layoutChecks, 1, 'only model candidates require a layout/visibility read');
  assert.equal(await f.ctx.applyModelPreferences(f.preferences), true);
  assert.deepEqual(f.selection(), { selected: 'GPT-5.6 Sol', effort: 'high', open: false });
  assert.equal(await f.ctx.applyModelPreferences(f.preferences), true);
  assert.equal(f.clicks.filter(element => element === f.models[1]).length, 2,
    'each send selects the configured model, even when its row was already checked');
  f.preferences.preferredReasoning = 'instant';
  assert.equal(await f.ctx.applyModelPreferences(f.preferences), true);
  assert.equal(f.selection().effort, 'instant');

  const gpt6 = fixture(0, true);
  gpt6.preferences.preferredModel = 'GPT-6';
  assert.equal(gpt6.trigger.innerText, 'High', 'GPT-6 only displays effort on its closed trigger');
  assert.equal(gpt6.ctx.modelPickerTrigger(), gpt6.trigger,
    'compact High trigger must be found beside the composer without a model label');
  assert.equal(await gpt6.ctx.applyModelPreferences(gpt6.preferences), true);
  assert.equal(gpt6.selection().selected, 'GPT-6');
  assert.equal(gpt6.trigger.innerText, 'High', 'selection does not require a visible GPT-6 name');
  assert.equal(gpt6.clicks.includes(gpt6.models[0]), true);

  const switchToGpt6 = fixture(0, true, 'GPT-5.6 Sol');
  switchToGpt6.preferences.preferredModel = 'GPT-6';
  switchToGpt6.preferences.preferredReasoning = 'medium';
  assert.equal(await switchToGpt6.ctx.applyModelPreferences(switchToGpt6.preferences), true,
    'GPT-6 model selection and nested slider changes work from a High-only trigger');
  assert.equal(switchToGpt6.selection().selected, 'GPT-6');
  assert.equal(switchToGpt6.selection().effort, 'medium');
  assert.equal(switchToGpt6.trigger.innerText, 'Medium',
    'collapsed GPT-6 control displays only the new effort level');

  const disabled = fixture();
  disabled.preferences.enforceModelPreferences = false;
  assert.equal(await disabled.ctx.applyModelPreferences(disabled.preferences), true);
  assert.equal(disabled.clicks.length, 0, 'unchecked box does not open picker or change reasoning');
  disabled.preferences.enforceModelPreferences = true;
  assert.equal(await disabled.ctx.applyModelPreferences(disabled.preferences), true,
    're-enabling automation rechecks the selected model');

  for (const gate of ['setGenerating', 'setBlocked', 'setPaused']) {
    const guarded = fixture(); guarded[gate](true);
    assert.equal(await guarded.ctx.applyModelPreferences(guarded.preferences), false);
    assert.equal(guarded.clicks.length, 0, `${gate} must prevent selection`);
    assert.equal(guarded.reports.length, 0, 'an ownership gate is not a preference error');
  }
  const missing = fixture();
  missing.preferences.preferredModel = 'GPT-5.6';
  assert.equal(await missing.ctx.applyModelPreferences(missing.preferences), false, 'do not fuzzy match another model variant');
  assert.equal(missing.reports.at(-1).reason, 'model-unavailable');
  assert.equal(missing.selection().open, false);
  missing.preferences.preferredModel = 'GPT-5.6 Sol';
  assert.equal(await missing.ctx.applyModelPreferences(missing.preferences), true);

  const interrupted = fixture();
  const click = interrupted.ctx.clickControl;
  interrupted.ctx.clickControl = element => { click(element); interrupted.setPaused(true); };
  assert.equal(await interrupted.ctx.applyModelPreferences(interrupted.preferences), false);
  assert.equal(interrupted.clicks.length, 1, 'pause during menu opening prevents selection');
  assert.equal(interrupted.selection().selected, 'GPT-6');
  assert.equal(interrupted.selection().open, false, 'close only the menu opened by this flow');
  const unchanged = fixture();
  unchanged.preferences.preferredModel = unchanged.preferences.preferredReasoning = '';
  assert.equal(await unchanged.ctx.applyModelPreferences(unchanged.preferences), true);
  assert.equal(unchanged.clicks.length, 0);
  console.log('model_selection_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
