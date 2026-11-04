const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
const helpers = source.slice(source.indexOf('function normalizedPluginLabel'), source.indexOf('function normalizedText'));

function scenario({ delayed = 0, current = true, disabled = false, draft = '', clickAccepts = true, enterAccepts = true, prefixResult = false, plugin = 'devspace' } = {}) {
  let selected = false, polls = 0, enters = 0, clicks = 0, typed = 0;
  let text = draft;
  const item = {
    tagName: 'BUTTON', innerText: `${plugin} ${plugin}`, disabled,
    getAttribute(name) {
      return ({ 'data-list-navigation-item': 'true', 'aria-current': String(current) })[name] ?? null;
    },
  };
  const chip = { getAttribute: () => plugin };
  const composer = {
    querySelectorAll() { return selected ? [chip] : []; },
    focus() {},
    dispatchEvent(event) {
      assert.equal(event.key, 'Enter');
      assert.ok(text && `@${plugin}`.startsWith(text));
      assert.equal(current, true);
      enters++;
      if (enterAccepts) { selected = true; text = ''; }
    },
  };
  const context = {
    document: { querySelectorAll(selector) {
      // Live ChatGPT result has no menu/listbox/radix parent.
      assert.ok(selector.includes('button[data-list-navigation-item]'));
      return (text === `@${plugin}` || (prefixResult && text && `@${plugin}`.startsWith(text))) && polls >= delayed ? [item] : [];
    } },
    findComposer: () => composer,
    composerScope: () => ({ querySelectorAll: () => [], matches: () => false }),
    visible: () => true,
    normalizedText: value => (value || '').trim(),
    composerText: () => text,
    setComposerText: async (_, value) => { text = value; typed++; return true; },
    clearComposer: async () => { text = ''; return true; },
    waitFor: async predicate => {
      for (let i = 0; i < 65; i++) { polls++; if (predicate()) return true; }
      return false;
    },
    KeyboardEvent: class { constructor(type, args) { Object.assign(this, { type }, args); } },
    HTMLElement: { prototype: { click() { clicks++; if (clickAccepts) { selected = true; text = ''; } } } },
  };
  vm.runInNewContext(helpers, context);
  return { context, stats: () => ({ selected, text, enters, clicks, typed }) };
}

(async () => {
  const renamed = scenario({ plugin: 'spacedev' });
  assert.equal(await renamed.context.selectConfiguredPlugin(), true, 'fall back to the alternate default plugin spelling');
  assert.equal(renamed.stats().typed, 2);
  assert.equal(renamed.stats().clicks, 1);
  assert.equal(await renamed.context.selectConfiguredPlugin(), true, 'recognize the alternate selected mention');
  assert.equal(renamed.stats().clicks, 1);
  const renamedPartial = scenario({ plugin: 'spacedev', draft: '@space', prefixResult: true, clickAccepts: false });
  assert.equal(await renamedPartial.context.selectConfiguredPlugin(), true, 'alternate partial lookup supports highlighted Enter fallback');
  assert.equal(renamedPartial.stats().typed, 0);
  const slow = scenario({ delayed: 40 });
  assert.equal(await slow.context.selectConfiguredPlugin(), true, 'wait for a late suggestion');
  assert.deepEqual(slow.stats(), { selected: true, text: '', enters: 0, clicks: 1, typed: 1 });
  assert.equal(await slow.context.selectConfiguredPlugin(), true, 'selected inline mention is idempotent');
  assert.equal(slow.stats().clicks, 1);
  assert.equal(slow.stats().typed, 1);

  const retry = scenario({ draft: '@devspace' });
  assert.equal(await retry.context.selectConfiguredPlugin(), true, 'resume an existing lookup');
  assert.equal(retry.stats().typed, 0);
  const visiblePartial = scenario({ draft: '@devspac', prefixResult: true });
  assert.equal(await visiblePartial.context.selectConfiguredPlugin(), true);
  assert.equal(visiblePartial.stats().typed, 0, 'select an existing suggestion without retyping');
  for (const draft of ['@', '@dev', '@devspac']) {
    const partial = scenario({ draft });
    assert.equal(await partial.context.selectConfiguredPlugin(), true, `repair ${draft}`);
    assert.equal(partial.stats().typed, 1);
  }

  for (const options of [{ current: false, clickAccepts: false }, { disabled: true }, { draft: 'My unsent work' }]) {
    const unsafe = scenario(options);
    assert.equal(await unsafe.context.selectConfiguredPlugin(), false);
    assert.equal(unsafe.stats().enters, 0, 'never press Enter without a verified highlighted result');
    if (options.draft) assert.equal(unsafe.stats().text, options.draft);
  }
  const keyboardFallback = scenario({ clickAccepts: false });
  assert.equal(await keyboardFallback.context.selectConfiguredPlugin(), true, 'use Enter only after a failed click on the highlighted result');
  assert.equal(keyboardFallback.stats().clicks, 1);
  assert.equal(keyboardFallback.stats().enters, 1);
  const rejected = scenario({ clickAccepts: false, enterAccepts: false });
  assert.equal(await rejected.context.selectConfiguredPlugin(), false, 'an event is not proof of selection');
  assert.equal(rejected.stats().enters, 1, 'no repeated Enter loop');
  assert.equal(rejected.stats().text, '');

  const prompt = 'Another agent worked on this task. Preserve the verified context.';
  let posted = `Devspace\n${prompt}`;
  const acknowledgement = { latestUserText: () => posted };
  vm.runInNewContext(source.slice(source.indexOf('function normalizedText'), source.indexOf('function validHandoffText')), acknowledgement);
  assert.equal(acknowledgement.latestUserMatchesPrompt(prompt), true, 'selected plugin prefix still acknowledges delivery');
  posted = `@spacedev\n${prompt}`;
  assert.equal(acknowledgement.latestUserMatchesPrompt(prompt), true, 'alternate plugin prefix acknowledges delivery');
  posted = 'A different user message';
  assert.equal(acknowledgement.latestUserMatchesPrompt(prompt), false, 'unrelated messages never acknowledge delivery');
  console.log('plugin_selection_ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
