const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
const flow = source.slice(source.indexOf('function modelPickerTrigger()'), source.indexOf('async function sendPrompt(text)'));

function fixture(menuDelayQueries = 0) {
  let open = false, advanced = false, selected = 'GPT-6', effort = 'medium';
  let generating = false, blocked = false, paused = false, clock = 1000;
  const clicks = [], reports = [];
  const preferences = { preferredModel: 'GPT-5.6 Sol', preferredReasoning: 'high' };
  const node = (text, attrs = {}) => ({
    textContent: text, innerText: text,
    getAttribute(name) { return attrs[name] ?? null; },
    hasAttribute(name) { return name in attrs; },
    closest() { return this.inert ? {} : null; },
    focus() {},
  });
  const trigger = node('Thinking effort', { 'aria-label': 'Select ChatGPT model' });
  trigger.id = 'picker';
  trigger.getAttribute = name => ({ 'aria-controls': open ? 'menu' : null,
    'aria-expanded': String(open), 'data-selected-reasoning-effort': effort,
    'aria-label': 'Select ChatGPT model' })[name] ?? null;
  const toggle = node('Medium', { 'aria-label': 'Select model', role: 'menuitem' });
  const models = ['GPT-6', 'GPT-5.6 Sol', 'GPT-5.5\nLeaving on October 14'].map(label => {
    const item = node(label, { role: 'menuitemradio' });
    item.getAttribute = name => name === 'aria-checked' ? String(selected === label.split('\n')[0])
      : name === 'role' ? 'menuitemradio' : null;
    return item;
  });
  const power = node('', { 'aria-label': 'Power', 'data-reasoning-slider': 'true', role: 'menuitem' });
  power.dispatchEvent = event => {
    if (event.type !== 'keydown') return;
    const levels = ['instant', 'medium', 'high'];
    effort = levels[Math.max(0, Math.min(2, levels.indexOf(effort) + (event.key === 'ArrowRight' ? 1 : -1)))];
    trigger.innerText = `${selected} ${effort}`;
  };
  const menu = node('', { 'aria-labelledby': 'picker' });
  menu.querySelectorAll = selector => {
    if (menuDelayQueries > 0) { menuDelayQueries--; return []; }
    models.forEach(item => { item.inert = !advanced; });
    power.inert = toggle.inert = advanced;
    if (selector.includes('[aria-checked=')) return models.filter(item => item.getAttribute('aria-checked') === 'true');
    return [toggle, power, ...models];
  };
  menu.dispatchEvent = event => { if (event.key === 'Escape') open = false; };
  const ctx = {
    stopped: false, verifiedModelSelection: null, modelPreferenceFailure: '', modelPreferenceRetryAt: 0,
    location: { href: 'https://chatgpt.com/c/task' },
    document: {
      getElementById: id => id === 'menu' && open ? menu : null,
      querySelectorAll: selector => selector === 'button' ? [trigger] : open ? [menu] : [],
    },
    normalizedControlText: text => (text || '').replace(/\s+/g, ' ').trim(),
    visible: element => Boolean(element), controlReady: element => Boolean(element && !element.disabled),
    approvalMenuOpen: () => open, isGenerating: () => generating, hasBlockingUi: () => blocked,
    Date: { now: () => clock },
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
        trigger.innerText = `${selected} ${effort}`;
      }
    },
  };
  vm.runInNewContext(flow, ctx);
  return { ctx, preferences, clicks, reports, trigger, menu, models,
    setGenerating: value => { generating = value; }, setBlocked: value => { blocked = value; },
    setPaused: value => { paused = value; }, advance: () => { clock += 30001; },
    selection: () => ({ selected, effort, open }),
  };
}

(async () => {
  const f = fixture();
  const loading = fixture(3);
  assert.equal(await loading.ctx.ensureModelPreferences(loading.preferences), true,
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
  assert.equal(await f.ctx.ensureModelPreferences(f.preferences), true);
  assert.deepEqual(f.selection(), { selected: 'GPT-5.6 Sol', effort: 'high', open: false });
  const count = f.clicks.length;
  assert.equal(await f.ctx.ensureModelPreferences(f.preferences), true);
  assert.equal(f.clicks.length, count, 'idle checks reuse unchanged verified state');
  assert.equal(await f.ctx.ensureModelPreferences(f.preferences, true), true);
  assert.equal(f.reports.at(-1).changed, false, 'pre-send verification must not select an already checked model');
  f.preferences.preferredReasoning = 'instant';
  assert.equal(await f.ctx.ensureModelPreferences(f.preferences), true);
  assert.equal(f.selection().effort, 'instant');

  for (const gate of ['setGenerating', 'setBlocked', 'setPaused']) {
    const guarded = fixture(); guarded[gate](true);
    assert.equal(await guarded.ctx.ensureModelPreferences(guarded.preferences), false);
    assert.equal(guarded.clicks.length, 0, `${gate} must prevent selection`);
    assert.equal(guarded.reports.length, 0, 'an ownership gate is not a preference error');
  }
  const missing = fixture();
  missing.preferences.preferredModel = 'GPT-5.6';
  assert.equal(await missing.ctx.ensureModelPreferences(missing.preferences), false, 'do not fuzzy match another model variant');
  assert.equal(missing.reports.at(-1).reason, 'model-unavailable');
  assert.equal(missing.selection().open, false);
  const failedClicks = missing.clicks.length;
  assert.equal(await missing.ctx.ensureModelPreferences(missing.preferences), false);
  assert.equal(missing.clicks.length, failedClicks, 'failed selections back off');
  missing.advance();
  assert.equal(await missing.ctx.ensureModelPreferences(missing.preferences), false);
  assert.equal(missing.reports.at(-1).repeated, true, 'repeated errors do not produce noisy logs');
  missing.preferences.preferredModel = 'GPT-5.6 Sol';
  assert.equal(await missing.ctx.ensureModelPreferences(missing.preferences), true, 'changing settings bypasses old failure backoff');

  const interrupted = fixture();
  const click = interrupted.ctx.clickControl;
  interrupted.ctx.clickControl = element => { click(element); interrupted.setPaused(true); };
  assert.equal(await interrupted.ctx.ensureModelPreferences(interrupted.preferences), false);
  assert.equal(interrupted.clicks.length, 1, 'pause during menu opening prevents selection');
  assert.equal(interrupted.selection().selected, 'GPT-6');
  assert.equal(interrupted.selection().open, false, 'close only the menu opened by this flow');
  const unchanged = fixture();
  unchanged.preferences.preferredModel = unchanged.preferences.preferredReasoning = '';
  assert.equal(await unchanged.ctx.ensureModelPreferences(unchanged.preferences), true);
  assert.equal(unchanged.clicks.length, 0);
  console.log('model_selection_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });