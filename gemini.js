// Gemini's Task harness uses the same monitor lifecycle, with different page controls.
(() => {
  if (location.hostname !== "gemini.google.com") return;
  const visible = element => Boolean(element && element.getBoundingClientRect().width
    && element.getBoundingClientRect().height && getComputedStyle(element).visibility !== "hidden");
  const ready = element => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true";
  const editor = () => [...document.querySelectorAll('[contenteditable="true"][role="textbox"][aria-label="Enter a prompt for Gemini"]')].filter(visible).at(-1) || null;
  const trigger = () => [...document.querySelectorAll('button[aria-label^="Open mode picker, currently "]')].find(ready);
  const model = () => trigger()?.getAttribute("aria-label")?.split("currently ")[1]?.trim() || "";
  const latestTurn = () => [...document.querySelectorAll('.conversation-container')].at(-1);
  const isQuotaNotice = (text, disabled = false) => {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value || value.length > 700 || !/\b(?:limit|quota)\b/i.test(value)) return false;
    const context = /\b(?:usage|quota|rate|message|task|request|daily|weekly|Neon|Hydrogen)\b/i.test(value);
    const exhausted = /(?:\breached\b|\bhit\b|\bexceeded\b|\bused (?:up|all)\b|\bout of\b|\bno (?:more|remaining)\b)/i.test(value);
    const reset = /\b(?:reset|resets|try again|come back|available again|upgrade|tomorrow)\b/i.test(value);
    return Boolean((exhausted && (context || reset)) || (disabled && context && reset));
  };
  const taskSelected = () => {
    if (document.querySelector('remy-plan-pill')) return true;
    return [...document.querySelectorAll('button[aria-pressed], [role="checkbox"], input[type="checkbox"]')].some(element =>
      (element.getAttribute("aria-label") || element.textContent || "").trim() === "Task"
      && (element.getAttribute("aria-pressed") === "true" || element.getAttribute("aria-checked") === "true" || element.checked));
  };

  globalThis.AgentMonitorGemini = {
    editor,
    isQuotaNotice,
    quotaEvidence() {
      const composer = document.querySelector('[aria-label="Enter a prompt for Gemini"]');
      const input = composer?.closest('input-container') || document.querySelector('input-container');
      const root = input?.parentElement?.parentElement || input;
      if (!root) return null;
      const disabled = !composer || composer.getAttribute('contenteditable') === 'false'
        || composer.getAttribute('aria-disabled') === 'true' || composer.disabled;
      const knownBanners = 'gemini-quota-banner, .inline-upgrade-banner-row';
      const candidates = [...root.querySelectorAll(`${knownBanners}, [role="alert"], [role="status"], div, p, span`)]
        .filter(node => visible(node) && !node.closest('.conversation-container, model-response, user-query, rich-textarea, pre, code')
          && !node.querySelector('.conversation-container, model-response, user-query, rich-textarea, pre, code')
          && !node.contains(input) && isQuotaNotice(node.innerText || node.textContent, disabled));
      const notice = candidates.find(node => node.matches(knownBanners))
        || candidates.find(node => !candidates.some(other => other !== node && node.contains(other)));
      if (!notice) return null;
      const title = notice.querySelector('[data-test-id="gem-banner-title-input"]');
      const description = notice.querySelector('[data-test-id="gem-banner-description-input"]');
      const inlineText = notice.querySelector('.inline-upgrade-banner-text');
      const text = title
        ? [title, description].filter(Boolean).map(node => node.innerText || node.textContent).join(' ')
        : (inlineText || notice).innerText || (inlineText || notice).textContent;
      const describe = node => {
        const classes = [...node.classList].filter(name => !name.startsWith('ng-')).slice(0, 8).join('.');
        return `${node.tagName.toLowerCase()}${classes ? '.' + classes : ''} role=${node.getAttribute('role') || 'none'}`;
      };
      return { text: text.replace(/\s+/g, ' ').trim(),
        structure: [notice.parentElement, notice].filter(Boolean).map(describe).join(' > '),
        composerDisabled: Boolean(disabled) };
    },
    scope: () => editor()?.closest('input-container') || document,
    taskSelected,
    async ensureTask({ waitFor, canAct }) {
      if (taskSelected()) return true;
      const toggle = [...document.querySelectorAll('button[aria-pressed], [role="checkbox"], input[type="checkbox"]')].find(element =>
        ready(element) && (element.getAttribute("aria-label") || element.textContent || "").trim() === "Task");
      if (!toggle || !await canAct()) return false;
      toggle.click();
      return waitFor(taskSelected, 2000);
    },
    turns: () => [...document.querySelectorAll('model-response')],
    latestResponse() {
      const turn = latestTurn()?.querySelector('model-response');
      return this.response(turn);
    },
    response(turn) {
      const text = [...(turn?.querySelectorAll('message-content .markdown') || [])]
        .map(node => (node.innerText || node.textContent || "").trim()).filter(Boolean).join("\n\n");
      return { text, substantive: Boolean(text), turn: turn || null };
    },
    latestUserText() {
      return [...(latestTurn()?.querySelectorAll('user-query .query-text-line') || [])]
        .map(node => node.textContent || "").join("\n").trim();
    },
    incompleteTurnKey() {
      const turn = latestTurn();
      return turn?.querySelector('user-query') && turn.querySelector('model-response')
        && !this.latestResponse().text ? `gemini:${turn.id}` : "";
    },
    connectorSelected(matches) {
      return [...(editor()?.querySelectorAll('[data-at-mention-chip="true"][data-mention-tool-name]') || [])]
        .some(node => matches(node.getAttribute('data-doc-chip-title') || node.textContent));
    },
    async selectConnector({ matches, composerText, setComposerText, waitFor, canAct }) {
      if (this.connectorSelected(matches)) return true;
      const composer = editor();
      if (!composer || composerText(composer) || !await canAct()) return false;
      composer.focus();
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: '@', code: 'Digit2', shiftKey: true, bubbles: true }));
      if (!await setComposerText(composer, '@')) return false;
      composer.dispatchEvent(new KeyboardEvent('keyup', { key: '@', code: 'Digit2', shiftKey: true, bubbles: true }));
      const item = () => [...document.querySelectorAll('[id^="at-mentions-v2-item-"][role="menuitem"]')]
        .find(node => ready(node) && matches(node.getAttribute('aria-label') || node.textContent));
      if (!await waitFor(item, 4000) || !await canAct() || composerText(composer) !== '@') return false;
      item().click();
      return waitFor(() => this.connectorSelected(matches), 2000);
    },
    async applyModel(preferences, { waitFor, canAct }) {
      if (preferences.enforceModelPreferences === false || !preferences.preferredModel) return true;
      const desired = preferences.preferredModel;
      if (model() === desired) return true;
      const picker = trigger();
      if (!picker || picker.getAttribute('aria-expanded') === 'true' || !await canAct()) return false;
      picker.click();
      const option = () => [...document.querySelectorAll('[data-test-id="gem-mode-menu"] [role="menuitemradio"]')]
        .find(node => ready(node) && !node.getAttribute('data-mode-id')?.startsWith('upsell_')
          && (node.querySelector('.sublabel')?.textContent || '').trim().replace(/^4\s+/, '') === desired);
      let success = false;
      try {
        if (!await waitFor(option, 2500) || !await canAct()) return false;
        option().click();
        success = await waitFor(() => model() === desired && picker.getAttribute('aria-expanded') !== 'true', 2500);
        return success && await canAct();
      } finally {
        if (picker.getAttribute('aria-expanded') === 'true') {
          picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        }
      }
    },
  };
})();
