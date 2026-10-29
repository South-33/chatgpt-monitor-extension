if (window.top === window.self) {
window.__chatgptAgentMonitorStop?.();

let stopped = false;
let scanRunning = false;
let manualActionRunning = false;
let blockingUiRunning = false;
let lastScanGenerating = null;
let lastGeneratingReportAt = 0;
let idleSince = 0;
let intervalId;
let observer;
let observerScanTimer;
let lastMutationAt = 0;
let observedUrl = location.href;
let loadRecovery = { url: location.href, attempts: 0, retryAt: 0 };
let extendedThinkingTurnIdentity = null;
let extendedThinkingSince = 0;
let extendedThinkingRecoveryRequested = false;
let extendedThinkingRetryAt = 0;
let extendedThinkingStopFailures = 0;
let publishedThinkingNoticeStartedAt;
let extendedThinkingLimitMs = 10 * 60 * 1000;
const FOLLOW_LATEST_INTERVAL_MS = 30 * 1000;
let lastFollowLatestAt = 0;
let lastWorkedScanAt = 0;
let cachedWorkedSeconds = 0;
let workedScanUrl = location.href;
let settledResponseKey = "";
let settledResponseUrl = location.href;
// Keep model verification and retry state within this content-script instance.
// These values must exist before the first scan; an undeclared optional-chain
// target throws a ReferenceError and prevents monitoring from advancing.
let verifiedModelSelection = null;
let modelPreferenceFailure = "";
let modelPreferenceRetryAt = 0;
const approvalDiagnostics = new WeakMap();

function normalizedControlText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function reportDiagnostic(event, reason, elapsedMs) {
  void sendRuntime({
    type: "diagnosticEvent",
    event,
    reason,
    elapsedMs,
  });
}

function isDevSpaceMaterializationText(value) {
  const text = normalizedControlText(value);
  return /allow file materialization\?/i.test(text)
    && /(?:dev\s*space|spacedev)/i.test(text)
    && /materialize\s+\d+\s+file attachments?/i.test(text);
}

function isConversationPermissionLabel(value) {
  const label = normalizedControlText(value).toLowerCase();
  return /\ballow\b/.test(label)
    && /\bconversation\b/.test(label)
    && (/\b(?:devspace|spacedev)\b/.test(label)
      || /\bfile\b/.test(label)
      || /^(?:always\s+)?allow\s+(?:for\s+)?this\s+conversation$/.test(label))
    && !/\b(?:deny|whole)\b/.test(label);
}

function hasDevSpaceApprovalControls(element) {
  const actions = element.querySelector('[data-testid="tool-action-buttons"]');
  if (!actions || !visible(actions)) return false;
  const labels = [...actions.querySelectorAll("button")]
    .filter(visible)
    .map((button) => normalizedControlText(
      `${button.getAttribute("aria-label") || ""} ${button.innerText || button.textContent || ""}`,
    ));
  return labels.some((label) => /^deny\b/i.test(label))
    && labels.some((label) => /^allow\b/i.test(label))
    && Boolean(materializationScopeMenuButton(element));
}

const hasToolApprovalControls = hasDevSpaceApprovalControls;

function devSpaceMaterializationDialog() {
  // Only file-materialization prompts are safe for this narrow approval flow.
  // Generic tool approval can authorize commands that change local files.
  const surface = [...document.querySelectorAll("[data-codex-approval-surface]")]
    .filter(visible)
    .filter((card) => isDevSpaceMaterializationText(card.innerText || card.textContent || ""))
    .filter(hasDevSpaceApprovalControls)
    .at(-1);
  if (surface) return surface;

  const toolCard = [...document.querySelectorAll('[data-testid="tool-approval-card"]')]
    .filter(visible)
    .filter((card) => isDevSpaceMaterializationText(card.innerText || card.textContent || ""))
    .filter(hasDevSpaceApprovalControls)
    .at(-1);
  if (toolCard) return toolCard;

  const explicitDialog = [...document.querySelectorAll(
    "[role='dialog'], [aria-modal='true'], [data-radix-dialog-content], [data-state='open']",
  )]
    .filter(visible)
    .filter((card) => isDevSpaceMaterializationText(card.innerText || card.textContent || ""))
    .filter(hasDevSpaceApprovalControls)
    .at(-1);
  if (explicitDialog) return explicitDialog;

  // ChatGPT's materialization card is not guaranteed to expose dialog roles.
  // Anchor on the visible heading text, then walk up to the smallest container
  // that contains the full DevSpace message plus the Deny/Allow controls.
  const marker = [...document.querySelectorAll(
    "h1, h2, h3, h4, h5, h6, [role='heading'], p, span, div",
  )]
    .filter(visible)
    .find((element) => /^allow file materialization\?$/i.test(
      normalizedControlText(element.innerText || element.textContent || ""),
    ));
  if (!marker) return null;

  let container = marker;
  for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
    if (!visible(container)) continue;
    const text = container.innerText || container.textContent || "";
    if (isDevSpaceMaterializationText(text) && hasDevSpaceApprovalControls(container)) return container;
  }
  return null;
}

function conversationPermissionOption(dialog) {
  const actions = dialog.querySelector('[data-testid="tool-action-buttons"]');
  const openMenus = [...document.querySelectorAll(
    "[role='menu'], [role='listbox'], [data-radix-menu-content], [data-radix-popper-content-wrapper]",
  )].filter(visible);
  const selectors = "button, [role='menuitem'], [role='option'], [role='radio'], [role='menuitemradio'], [data-radix-collection-item], [tabindex]";
  const inOpenMenus = openMenus.flatMap((menu) => [
    ...(menu.matches?.(selectors) ? [menu] : []),
    ...menu.querySelectorAll(selectors),
  ]);
  const menuCandidates = [...new Set([
    ...inOpenMenus,
    ...document.querySelectorAll(
      "[role='menuitem'], [role='option'], [role='radio'], [role='menuitemradio'], [data-radix-collection-item]",
    ),
  ])]
    .filter(visible)
    .filter((element) => controlReady(element) && !actions?.contains(element));

  const semanticMatch = menuCandidates.find((element) => isConversationPermissionLabel(
    element.getAttribute("aria-label") || element.innerText || element.textContent || "",
  ));
  if (semanticMatch) return semanticMatch;

  // Radix menu content can change its wrapper/role details across ChatGPT UI
  // revisions. Fall back to the exact visible label, then use the nearest
  // actionable ancestor. Exclude only the original approval action area so the
  // split-button trigger itself can never be mistaken for the menu option.
  const textMatch = [...document.querySelectorAll("body *")]
    .filter(visible)
    .filter((element) => controlReady(element) && !actions?.contains(element))
    .find((element) => isConversationPermissionLabel(
      element.getAttribute("aria-label") || element.innerText || element.textContent || "",
    ));
  if (!textMatch) return null;

  return textMatch.closest(selectors) || textMatch;
}

function materializationScopeMenuButton(dialog) {
  const actions = dialog.querySelector('[data-testid="tool-action-buttons"]') || dialog;
  const buttons = [...actions.querySelectorAll("button")].filter(visible);
  const exact = buttons.find((button) => /\bapproval\b.*\b(?:options|permissions)\b|^allow\s+(?:devspace|spacedev)\s+for\s+this\s+conversation$/i.test(
    button.getAttribute("aria-label") || "",
  ));
  if (exact) return exact;

  // ChatGPT renders Allow as a split control: the text button followed by a
  // separate chevron button. Prefer that structural sibling over guessed ARIA.
  const mainAllow = buttons.find((button) => /^allow\b/i.test(normalizedControlText(
    button.innerText || button.textContent || "",
  )));
  if (mainAllow?.parentElement) {
    const splitButtons = [...mainAllow.parentElement.querySelectorAll("button")]
      .filter(visible);
    const index = splitButtons.indexOf(mainAllow);
    if (index >= 0 && splitButtons[index + 1]) return splitButtons[index + 1];
    const alternate = splitButtons.find((button) => button !== mainAllow);
    if (alternate) return alternate;
  }

  const ariaMenu = buttons.find((button) =>
    button.getAttribute("aria-haspopup") === "menu"
      || button.hasAttribute("aria-expanded"));
  if (ariaMenu) return ariaMenu;

  // Final fallback for the current ChatGPT action layout: Deny, Allow, chevron.
  return buttons.length >= 3 ? buttons.at(-1) : null;
}

function clickControl(element, { pointerFirst = false } = {}) {
  if (!element) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus?.();
  }
  if (pointerFirst && typeof PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }));
    element.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }));
  }
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  HTMLElement.prototype.click.call(element);
}

function materializationMenuOpen(button) {
  return button?.getAttribute("aria-expanded") === "true"
    || button?.getAttribute("data-state") === "open";
}

function controlReady(element) {
  if (!element || !visible(element)) return false;
  if (element.disabled) return false;
  return element.getAttribute("aria-disabled") !== "true";
}

function pendingToolApproval() {
  // Detect generic tool permission cards even when button text is in ARIA.
  // Never let a relay send a new message while an approval is unanswered.
  return [...document.querySelectorAll(
    '[data-codex-approval-surface], [data-testid="tool-approval-card"]',
  )].some(card => {
    if (!visible(card)) return false;
    const labels = [...card.querySelectorAll('button')]
      .filter(visible)
      .map(button => button.getAttribute('aria-label') || button.innerText || button.textContent || '');
    return labels.some(label => /^(?:deny|reject)\b/i.test(normalizedControlText(label)))
      && labels.some(label => /^(?:allow|approve)\b/i.test(normalizedControlText(label)));
  });
}

function hasBlockingUi() {
  return pendingToolApproval() || Boolean(devSpaceMaterializationDialog()) || blockingUiRunning;
}

function reportApproval(dialog, event, reason) {
  if (typeof approvalDiagnostics === "undefined") {
    if (typeof reportDiagnostic !== "undefined") reportDiagnostic(event, reason);
    return;
  }
  let reported = approvalDiagnostics.get(dialog);
  if (!reported) approvalDiagnostics.set(dialog, reported = new Set());
  const key = `${event}:${reason}`;
  if (reported.has(key)) return;
  reported.add(key);
  if (typeof reportDiagnostic !== "undefined") reportDiagnostic(event, reason);
}

async function resolveDevSpaceMaterialization() {
  const dialog = devSpaceMaterializationDialog();
  if (!dialog) return false;
  if (blockingUiRunning) return true;

  blockingUiRunning = true;
  try {
    console.debug("Agent Monitor materialization", "card-detected");
    reportApproval(dialog, "approval_detected", "permission-card");
    let conversationOption = conversationPermissionOption(dialog);
    if (!conversationOption) {
      const triggerReady = await waitFor(() => {
        const button = materializationScopeMenuButton(dialog);
        return Boolean(button && controlReady(button));
      }, 2500);
      if (!triggerReady) {
        console.warn("Agent Monitor materialization", "chevron-not-ready");
        reportApproval(dialog, "approval_pending", "chevron-not-ready");
        return true;
      }

      const scopeMenuButton = materializationScopeMenuButton(dialog);
      if (!scopeMenuButton || !controlReady(scopeMenuButton)) {
        console.warn("Agent Monitor materialization", "chevron-missing");
        reportApproval(dialog, "approval_pending", "chevron-missing");
        return true;
      }

      // The menu may already be open when monitoring attaches. Opening a
      // toggle in that state would close it and make the option disappear.
      if (!materializationMenuOpen(scopeMenuButton)) {
        clickControl(scopeMenuButton, { pointerFirst: true });
        let menuOpened = await waitFor(
          () => Boolean(conversationPermissionOption(dialog)),
          1500,
        );
        if (!menuOpened && !materializationMenuOpen(scopeMenuButton)) {
          clickControl(scopeMenuButton, { pointerFirst: true });
          menuOpened = await waitFor(
            () => Boolean(conversationPermissionOption(dialog)),
            1500,
          );
        }
        if (!menuOpened) {
          console.warn("Agent Monitor materialization", "conversation-option-not-found");
          reportApproval(dialog, "approval_pending", "conversation-option-not-found");
          return true;
        }
      }
      conversationOption = conversationPermissionOption(dialog);
    }
    if (!conversationOption) {
      console.warn("Agent Monitor materialization", "conversation-option-missing");
      reportApproval(dialog, "approval_pending", "conversation-option-not-found");
      return true;
    }

    console.debug("Agent Monitor materialization", "click-conversation-option");
    clickControl(conversationOption);
    const optionDismissed = await waitFor(
      () => !visible(conversationOption) || !conversationPermissionOption(dialog),
      1200,
    );
    if (!optionDismissed && conversationPermissionOption(dialog) === conversationOption) {
      conversationOption.focus?.();
      conversationOption.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
    const resolved = await waitFor(() => !devSpaceMaterializationDialog(), 4000);
    reportApproval(dialog, resolved ? "approval_resolved" : "approval_pending",
      resolved ? "conversation-scope" : "card-did-not-close");
    if (!resolved) console.warn("Agent Monitor materialization", "card-did-not-close");
    return true;
  } finally {
    blockingUiRunning = false;
  }
}


async function settleBlockingUiAfterGeneration(timeoutMs = 900) {
  if (hasBlockingUi()) return true;
  return waitFor(() => hasBlockingUi(), timeoutMs);
}

const toolApprovalCard = devSpaceMaterializationDialog;
const approvalMenuButton = materializationScopeMenuButton;
const approvalMenuOpen = materializationMenuOpen;
const resolveToolApproval = resolveDevSpaceMaterialization;

function stopMonitor() {
  stopped = true;
  if (intervalId) clearInterval(intervalId);
  if (observerScanTimer) clearTimeout(observerScanTimer);
  observer?.disconnect();
  document.removeEventListener("resume", handleResume);
  window.removeEventListener("pageshow", handlePageShow);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  try {
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  } catch {
    // The old extension context may already be gone during a reload.
  }
  if (window.__chatgptAgentMonitorStop === stopMonitor) {
    delete window.__chatgptAgentMonitorStop;
  }
}

window.__chatgptAgentMonitorStop = stopMonitor;

async function sendRuntime(message) {
  if (stopped) return null;
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (/extension context invalidated/i.test(error?.message || "")) stopMonitor();
    return null;
  }
}

function publishThinkingNoticeTimer(startedAt) {
  if (publishedThinkingNoticeStartedAt === startedAt) return;
  publishedThinkingNoticeStartedAt = startedAt;
  void sendRuntime({
    type: "thinkingNoticeTimer",
    url: location.href,
    startedAt,
  }).then((result) => {
    if (result?.ok !== true && publishedThinkingNoticeStartedAt === startedAt) {
      publishedThinkingNoticeStartedAt = undefined;
    }
  });
}

function isConversationPage() {
  try {
    const parsed = new URL(location.href);
    const chatHost = parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com";
    return chatHost &&
      (parsed.pathname.startsWith("/c/") || parsed.searchParams.get("temporary-chat") === "true");
  } catch {
    return false;
  }
}

function sameConversation(url) {
  try {
    const expected = new URL(url);
    const current = new URL(location.href);
    // Message-ID and other display query parameters do not change the chat.
    // A different conversation path or temporary-chat mode does.
    return expected.origin === current.origin
      && expected.pathname.replace(/\/+$/, '') === current.pathname.replace(/\/+$/, '')
      && ((expected.searchParams.get('temporary-chat') === 'true')
        === (current.searchParams.get('temporary-chat') === 'true'));
  } catch { return false; }
}

function visible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function buttonLabel(button) {
  return normalizedControlText([
    button.getAttribute("aria-label"), button.getAttribute("title"),
    button.innerText || button.textContent,
  ].filter(Boolean).join(" "));
}

function findButton(pattern) {
  return [...document.querySelectorAll("button")]
    .filter(visible)
    .filter((button) => pattern.test(buttonLabel(button)))
    .at(-1) || null;
}

function isStopControl(label, testId = "") {
  const normalized = (label || "").replace(/\s+/g, " ").trim();
  if (/^stop(?:\s+(?:answering|responding|generating|streaming|response|answer)){0,2}$/i.test(normalized)) return true;
  return testId === "stop-button" && !normalized;
}

function findStopButton() {
  return [...document.querySelectorAll("button")]
    .filter(visible)
    .filter((button) => isStopControl(
      button.getAttribute("aria-label") || button.innerText || "",
      button.dataset?.testid || button.getAttribute("data-testid") || "",
    ))
    .at(-1) || null;
}

function isGenerating() {
  return Boolean(findStopButton());
}

function isExtendedThinkingNotice(value) {
  const text = normalizedControlText(value).toLowerCase();
  if (!text || text.length > 240) return false;

  // A recovering connection is another live delay notice. Use the same timer
  // and Stop → check-in flow, requiring both interruption and waiting cues.
  if (/\bconnection\b/.test(text)
      && /\b(?:interrupt(?:ed|ion)?|lost|dropped)\b/.test(text)
      && /\b(?:waiting|reconnecting|recovery|recovering)\b/.test(text)) return true;

  // Match the meaning rather than one brittle sentence. Keep all anchors in
  // the same short live status so unrelated ChatGPT status messages do not
  // start the recovery timer.
  return /\b(?:our\s+)?systems?\b|\bwe\b/.test(text)
    && /\bthink(?:ing)?\b/.test(text)
    && /\b(?:more|longer|extra|bit|little|moment)\b/.test(text)
    && /\b(?:respond(?:ing)?|response|reply(?:ing)?)\b/.test(text);
}

function extendedThinkingStatus() {
  // In current ChatGPT markup, one data-turn-key wraps both the user message
  // and the assistant response. The newest visible turn is the current one.
  const currentTurn = [...document.querySelectorAll("[data-turn-key]")].filter(visible).at(-1)
    || assistantTurns().filter(visible).at(-1);
  if (!currentTurn) return null;

  const statuses = new Set([
    ...document.querySelectorAll("[role='status']"),
    ...currentTurn.querySelectorAll?.('[aria-live="polite"], [aria-live="assertive"]') || [],
  ]);
  return [...statuses]
    .filter(visible)
    .map((status) => ({
      text: normalizedControlText(status.innerText || status.textContent || ""),
      turn: status.closest('[data-testid^="conversation-turn"][data-turn="assistant"]')
        || status.closest('[data-message-author-role="assistant"]')
        || status.closest("[data-turn-key]")
        || (currentTurn.contains(status) ? currentTurn : null),
    }))
    .filter(({ text, turn }) => isExtendedThinkingNotice(text) && turn && visible(turn))
    .filter(({ turn }) => turn === currentTurn
      || currentTurn.contains(turn) || turn.contains(currentTurn))
    .at(-1) || null;
}

function resetExtendedThinking() {
  if (extendedThinkingTurnIdentity) reportDiagnostic("watchdog-reset", "notice-or-generation-ended");
  publishThinkingNoticeTimer(null);
  extendedThinkingTurnIdentity = null;
  extendedThinkingSince = 0;
  extendedThinkingRecoveryRequested = false;
  extendedThinkingRetryAt = 0;
  extendedThinkingStopFailures = 0;
}

function extendedThinkingTimedOut() {
  const generating = isGenerating();
  const statusMatch = generating ? extendedThinkingStatus() : null;
  // Use only the live status element: matching ordinary response text could
  // mistake a quote or explanation for ChatGPT's transient system notice.
  const turn = statusMatch?.turn || null;
  const noticeVisible = Boolean(generating && statusMatch && turn);
  if (!noticeVisible) {
    resetExtendedThinking();
    return false;
  }

  // A URL and turn ID keep the timer stable across text changes, while a new
  // response starts a new timer.
  const stableTurn = turn.closest("[data-turn-key]") || turn;
  const turnId = stableTurn.getAttribute("data-turn-key")
    || turn.getAttribute("data-message-id")
    || turn.id
    || turn.getAttribute("data-testid");
  const turnIdentity = `${location.href}::${turnId || "live-status"}`;
  if (turnIdentity !== extendedThinkingTurnIdentity) {
    extendedThinkingTurnIdentity = turnIdentity;
    extendedThinkingSince = Date.now();
    extendedThinkingRecoveryRequested = false;
    extendedThinkingRetryAt = 0;
    extendedThinkingStopFailures = 0;
    reportDiagnostic("watchdog-detected", "timer-started");
  }
  publishThinkingNoticeTimer(extendedThinkingSince);
  const elapsedMs = Date.now() - extendedThinkingSince;
  if (!extendedThinkingRecoveryRequested && Date.now() >= extendedThinkingRetryAt
      && elapsedMs >= extendedThinkingLimitMs) {
    reportDiagnostic("watchdog-timeout", "configured-limit", elapsedMs);
    return true;
  }
  return false;
}



function latestRenderedAssistantTurn() {
  const latestTurn = [...document.querySelectorAll("[data-turn-key]")].filter(visible).at(-1);
  if (latestTurn) return latestTurn;
  const status = [...document.querySelectorAll("[role='status']")].filter(visible).at(-1);
  const statusTurn = status?.closest('[data-testid^="conversation-turn"][data-turn="assistant"]')
    || status?.closest('[data-message-author-role="assistant"]')
    || status?.closest("[data-turn-key]");
  return statusTurn || assistantTurns().filter(visible).at(-1) || null;
}

function scrollableAncestor(element) {
  for (let parent = element?.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (parent.scrollHeight <= parent.clientHeight + 1) continue;
    const overflowY = getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  const pageScroller = document.scrollingElement;
  return pageScroller && pageScroller.scrollHeight > pageScroller.clientHeight + 1
    ? pageScroller
    : null;
}

function followLatestConversation() {
  const now = Date.now();
  if (lastFollowLatestAt && now - lastFollowLatestAt < FOLLOW_LATEST_INTERVAL_MS) {
    return false;
  }
  const turn = latestRenderedAssistantTurn();
  if (!turn) return false;

  const scroller = scrollableAncestor(turn);
  const moved = !scroller || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 2;
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  else turn.scrollIntoView?.(false);
  lastFollowLatestAt = now;
  return moved;
}

async function recoverExtendedThinking() {
  if (!extendedThinkingTimedOut()) return false;
  const expectedUrl = location.href;
  extendedThinkingRecoveryRequested = true;
  const stopButton = findStopButton();
  if (!stopButton) {
    extendedThinkingRecoveryRequested = false;
    return false;
  }
  reportDiagnostic("watchdog-stop-requested", "stop-control-visible");
  console.info("ChatGPT Agent Monitor", "stopping response after prolonged thinking notice");
  HTMLButtonElement.prototype.click.call(stopButton);
  if (!await waitFor(() => !isGenerating(), 15000)) {
    extendedThinkingStopFailures += 1;
    await sendRuntime({ type: "extendedThinkingStopFailed", url: location.href,
      attempt: extendedThinkingStopFailures });
    extendedThinkingRecoveryRequested = extendedThinkingStopFailures >= 3;
    extendedThinkingRetryAt = Date.now() + 30000 * extendedThinkingStopFailures;
    return true;
  }
  reportDiagnostic("watchdog-stop-confirmed", "stop-control-disappeared");
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!sameConversation(expectedUrl)) return true;
  if (terminalMarker(captureResponse().text)) return false;
  const action = await sendRuntime({ type: "extendedThinkingRecoveryReady", url: location.href });
  if (action?.action && sameConversation(expectedUrl)) await handleAction(action);
  return true;
}

function findComposer() {
  const known = [...document.querySelectorAll(
    "#prompt-textarea, textarea[placeholder*='Message'], textarea[placeholder*='Ask'], [contenteditable='true'][role='textbox']",
  )].filter(visible).at(-1) || null;
  if (known) return known;
  return [...document.querySelectorAll("textarea, [contenteditable='true']")]
    .filter(visible)
    .find((element) => /\b(?:ask\s+chatgpt|message(?:\s+chatgpt)?|prompt)\b/i.test([
      element.getAttribute("aria-label"), element.getAttribute("data-placeholder"),
      element.getAttribute("placeholder"),
    ].filter(Boolean).join(" "))) || null;
}

function assistantTurns() {
  const modern = [...document.querySelectorAll(
    '[data-testid^="conversation-turn"][data-turn="assistant"]',
  )];
  if (modern.length) return modern;
  const legacy = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  if (legacy.length) return legacy;
  return [...document.querySelectorAll('[data-turn-key]')].filter((turn) =>
    [...turn.querySelectorAll('h4')].some((heading) => heading.textContent?.trim() === 'ChatGPT said:'),
  );
}

function responseFromTurn(turn) {
  if (!turn) return { text: "", substantive: false, turn: null };

  if (turn.hasAttribute('data-turn-key')) {
    const rendered = [...turn.querySelectorAll('[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]')]
      .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)))
      .map((node) => (node.innerText || node.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n");
    return { text: rendered, substantive: Boolean(rendered), turn };
  }

  const candidates = [...turn.querySelectorAll(
    '.markdown, [class*="markdown"], [data-message-author-role="assistant"]',
  )].filter((node, index, all) => !all.some((other, otherIndex) => (
    otherIndex !== index && other.contains(node)
  )));
  const rendered = candidates
    .map((node) => (node.innerText || node.textContent || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (rendered) return { text: rendered, substantive: true, turn };

  const clone = turn.cloneNode(true);
  clone.querySelectorAll(
    'button, svg, [data-testid*="turn-action"], [aria-label="Open tool call list"]',
  ).forEach((node) => node.remove());
  const fallback = (clone.innerText || clone.textContent || "")
    .replace(/^\s*(?:Stopped thinking|Thinking)\s*$/gim, "")
    .replace(/^\s*(?:Called tool|Open tool call list)\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: fallback, substantive: false, turn };
}

function terminalMarker(text) {
  const finalLine = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || "";
  const match = finalLine.match(/^(?:TASK|GOAL)[\s_:-]*(FINISHED|BLOCKED)[.!]?$/i);
  return match ? match[1].toLowerCase() : null;
}

function latestAssistantResponse() {
  const currentTurn = [...document.querySelectorAll('[data-turn-key]')].at(-1);
  if (currentTurn) {
    // Final-answer containers identify the speaker. Localized/changed headings
    // must not turn a readable answer into an endless incomplete-turn recovery.
    return responseFromTurn(currentTurn);
  }
  return responseFromTurn(assistantTurns().at(-1));
}

function latestUserText() {
  const modern = [...document.querySelectorAll(
    '[data-testid^="conversation-turn"][data-turn="user"] [data-message-author-role="user"]',
  )];
  const candidates = modern.length
    ? modern
    : [...document.querySelectorAll('[data-message-author-role="user"]')];
  const node = candidates.at(-1);
  if (node) return normalizedText(node.innerText || node.textContent || "");
  const bubble = [...document.querySelectorAll('[data-turn-key] [data-user-message-bubble="true"]')].at(-1);
  return normalizedText(bubble?.innerText || bubble?.textContent || "");
}

function streamRecoveryFailure() {
  const turn = [...document.querySelectorAll('[data-turn-key], [data-testid^="conversation-turn"]')].at(-1)
    || document.querySelector('main');
  if (!turn || isGenerating()) return "";
  const alert = [...turn.querySelectorAll('[role="alert"]')].find((node) =>
    /stream recovery|resume stream unavailable|something went wrong|network error|error.*(?:generating|stream)|unable to (?:load|resume)/i.test(node.innerText || node.textContent || ""),
  );
  return alert ? turn.getAttribute('data-turn-key') || turn.getAttribute('data-testid')
    || `interrupted:${fingerprint(latestUserText() || turn.innerText || turn.textContent || "")}` : "";
}

function incompleteTurnKey() {
  const turn = [...document.querySelectorAll('[data-turn-key], [data-testid^="conversation-turn"]')].at(-1)
    || assistantTurns().at(-1) || document.querySelector('main');
  if (!turn || !visible(findComposer()) || isGenerating()) {
    return "";
  }
  if (latestAssistantResponse().text) return "";
  const identity = turn.getAttribute('data-turn-key') || turn.getAttribute('data-testid');
  if (identity) return identity;
  const text = normalizedText(turn.innerText || turn.textContent || "");
  if (!turn.querySelector?.('[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]')
      && !/(?:^|\n)\s*(?:Thinking|Stopped thinking|Worked for[^\n]*)\s*(?:\n|$)/i.test(text)) return "";
  return text ? `idle:${fingerprint(latestUserText() || text)}` : "";
}

function consecutiveBlockedResponses() {
  let count = 0;
  for (const turn of [...assistantTurns()].reverse()) {
    if (terminalMarker(responseFromTurn(turn).text) !== "blocked") break;
    count += 1;
  }
  return count;
}

function latestAssistantText() {
  return latestAssistantResponse().text;
}

function fingerprint(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
}

function workedDurations(text) {
  const pattern = /Worked for\s+(?:(\d+)\s*(?:h|hr|hrs|hour|hours)\s*)?(?:(\d+)\s*(?:m|min|mins|minute|minutes)\s*)?(?:(\d+)\s*(?:s|sec|secs|second|seconds))?/gi;
  const durations = [];
  for (const match of (text || "").matchAll(pattern)) {
    const seconds = Number(match[1] || 0) * 3600
      + Number(match[2] || 0) * 60
      + Number(match[3] || 0);
    if (seconds > 0) durations.push(seconds);
  }
  return durations;
}

function collectWorkedEntries(entries = new Map()) {
  const blocks = document.querySelector('[data-turn-key]')
    ? [...document.querySelectorAll('[data-turn-key]')]
    : assistantTurns();

  blocks.forEach((block) => {
    const owner = block.closest("[data-testid^='conversation-turn']")
      || block.closest("article")
      || block.closest("[data-message-id]")
      || block;
    const text = owner.innerText || owner.textContent || "";
    const identity = block.getAttribute("data-turn-key") || owner.getAttribute("data-message-id")
      || owner.getAttribute("data-testid")
      || fingerprint(text);
    workedDurations(text).forEach((seconds, occurrence) => {
      entries.set(`${identity}:${occurrence}`, seconds);
    });
  });
  return entries;
}

function workedSeconds(force = false) {
  const now = Date.now();
  if (workedScanUrl !== location.href) {
    workedScanUrl = location.href;
    lastWorkedScanAt = 0;
    cachedWorkedSeconds = 0;
  }
  if (!force && lastWorkedScanAt && now - lastWorkedScanAt < 30000) return cachedWorkedSeconds;
  cachedWorkedSeconds = [...collectWorkedEntries().values()].reduce((sum, seconds) => sum + seconds, 0);
  lastWorkedScanAt = now;
  return cachedWorkedSeconds;
}

async function scanExistingHistory() {
  // Only inspect mounted history. Scrolling loads pages from ChatGPT and can
  // amplify an existing reconnect/rate-limit loop.
  return workedSeconds(true);
}

async function waitFor(predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (!stopped && Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function composerScope(composer = findComposer()) {
  return composer?.closest("form") || composer?.parentElement?.parentElement || document;
}

function normalizedPluginLabel(value) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isDevSpaceLabel(value) {
  const label = normalizedPluginLabel(value);
  return label.includes("devspace") || label.includes("spacedev");
}

function isPluginLookupPrefix(text) {
  return Boolean(text && ["@devspace", "@spacedev"].some(lookup => lookup.startsWith(text)));
}

function pluginControlLabel(element) {
  return [
    buttonLabel(element),
    element.getAttribute("title"),
    element.getAttribute("data-composer-plugin-impression-id"),
    element.getAttribute("data-testid"),
    element.getAttribute("href"),
    element.textContent,
  ].filter(Boolean).join(" ");
}

function devSpaceSelected() {
  const composer = findComposer();
  if (!composer) return false;
  if ([...composer.querySelectorAll("[app-mention-name][contenteditable='false']")]
    .some((element) => visible(element)
      && ["devspace", "spacedev"].includes(normalizedPluginLabel(element.getAttribute("app-mention-name"))))) return true;

  const selector = "a, button, [role='button'], [data-composer-plugin-impression-id]";
  let scope = composerScope(composer);
  for (let depth = 0; scope && depth < 2; depth += 1, scope = scope.parentElement) {
    const candidates = [
      ...(scope.matches?.(selector) ? [scope] : []),
      ...scope.querySelectorAll(selector),
    ];
    if (candidates.some((element) => visible(element)
        && !element.closest?.("[role='menu'], [role='listbox'], [role='dialog']")
        && isDevSpaceLabel(pluginControlLabel(element)))) {
      return true;
    }
  }
  return false;
}

function devSpaceMenuItem() {
  // The mention picker uses portaled list-navigation buttons, not an ARIA menu.
  const candidates = [...document.querySelectorAll(
    "button[data-list-navigation-item], [role='menu'] [role='menuitem'], [role='listbox'] [role='option'], [data-radix-menu-content] [data-radix-collection-item], [data-radix-popper-content-wrapper] button",
  )]
    .filter(visible)
    .filter((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true")
    .filter((element) => isDevSpaceLabel(element.innerText || element.textContent || ""));

  return candidates.sort((a, b) => {
    const aPreferred = /^(BUTTON|A)$/.test(a.tagName) || /menuitem|option|button/.test(a.getAttribute("role") || "");
    const bPreferred = /^(BUTTON|A)$/.test(b.tagName) || /menuitem|option|button/.test(b.getAttribute("role") || "");
    return Number(b.getAttribute("aria-current") === "true") - Number(a.getAttribute("aria-current") === "true")
      || Number(bPreferred) - Number(aPreferred);
  })[0] || null;
}

async function selectDevSpaceResult() {
  if (devSpaceSelected()) return true;
  const item = devSpaceMenuItem();
  if (item) {
    HTMLElement.prototype.click.call(item);
    if (await waitFor(devSpaceSelected, 2000)) return true;
  }
  const composer = findComposer();
  if (!composer) return false;
  const lookup = normalizedText(composerText(composer)).toLowerCase();
  if (item
      && item.getAttribute("aria-current") === "true"
      && isPluginLookupPrefix(lookup)) {
    composer.focus();
    composer.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
    return waitFor(devSpaceSelected, 8000);
  }
  return false;
}

async function enableDevSpace() {
  if (devSpaceSelected()) return true;
  const composer = findComposer();
  if (!composer) return false;
  const existing = normalizedText(composerText(composer)).toLowerCase();
  // Repair only an exact prefix of our lookup, never an unrelated user draft.
  if (existing && !isPluginLookupPrefix(existing)) return false;
  if (existing && devSpaceMenuItem() && await selectDevSpaceResult()) return true;
  const lookups = existing.startsWith("@space") ? ["@spacedev", "@devspace"] : ["@devspace", "@spacedev"];
  for (const lookup of lookups) {
    const current = findComposer();
    if (!current) return false;
    const draft = normalizedText(composerText(current)).toLowerCase();
    if (draft && !isPluginLookupPrefix(draft)) return false;
    if (draft !== lookup) {
      if (draft && !await clearComposer(current)) return false;
      if (!await setComposerText(findComposer(), lookup)) return false;
    }
    if (await waitFor(() => devSpaceSelected() || Boolean(devSpaceMenuItem()), 15000)) {
      if (await selectDevSpaceResult()) return true;
    }
    // Only remove our exact failed lookup, never a draft typed while waiting.
    if (normalizedText(composerText(findComposer())).toLowerCase() !== lookup) return false;
    if (!await clearComposer(findComposer())) return false;
  }
  return false;
}

function normalizedText(text) {
  return (text || "").replace(/\r\n/g, "\n").replace(/\uFEFF/g, "").trim();
}

function comparableText(text) {
  return normalizedText(text).replace(/\s+/g, " ");
}

function latestUserMatchesPrompt(expectedPrompt) {
  const actual = comparableText(latestUserText());
  const expected = comparableText(expectedPrompt);
  return Boolean(expected && (actual === expected
    || actual.replace(/^@?(?:devspace|spacedev)\s+/i, "") === expected));
}

function validHandoffText(text) {
  const normalized = normalizedText(text);
  return normalized.length >= 200 && normalized.split(/\s+/).length >= 30;
}

function composerText(composer) {
  if (!composer) return "";
  if ("value" in composer) return normalizedText(composer.value);
  const pluginSelector = "[data-composer-plugin-impression-id], a[href*='/plugins/']";
  if (!composer.querySelector(pluginSelector)) {
    return normalizedText(composer.innerText ?? composer.textContent ?? "");
  }
  const read = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(pluginSelector)) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(read).join("");
    return /^(?:P|DIV)$/.test(node.tagName) && node !== composer ? `${text}\n` : text;
  };
  return normalizedText(read(composer));
}

async function setComposerText(composer, text) {
  const requested = normalizedText(text);
  composer.focus();
  if ("value" in composer) {
    const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(composer, text);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return waitFor(() => comparableText(composerText(composer)) === comparableText(requested), 1500);
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);

  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (!inserted && comparableText(composerText(composer)) !== comparableText(requested)) return false;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  return waitFor(() => comparableText(composerText(composer)) === comparableText(requested), 1500);
}

async function clearComposer(composer) {
  if (!composer) return false;
  composer.focus();
  if ("value" in composer) {
    const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(composer, "");
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
    try {
      document.execCommand("delete", false);
    } catch {
      // The DOM fallback below handles editors that reject execCommand.
    }
    if (composerText(composer)) return false;
  }
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  return waitFor(() => !composerText(composer), 1500);
}

function findSendButton(composer = findComposer()) {
  if (!composer) return null;
  const form = composer.closest("form");
  const scope = form || composerScope(composer);
  if (!scope) return null;
  const candidates = [...scope.querySelectorAll("button")]
    .filter(visible)
    .filter((button) => !/stop|voice/i.test(buttonLabel(button)))
    .filter((button) => /^(?:send|submit)(?:\s+(?:message|prompt|request))?$/i.test(
      normalizedControlText(button.getAttribute("aria-label") || button.innerText || button.textContent),
    ) || button.getAttribute("data-testid") === "send-button"
      || button.id === "composer-submit-button"
      || (form && button.getAttribute("type") === "submit"));
  return candidates.at(-1) || null;
}

function sendButtonReady(button) {
  return Boolean(button && visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true");
}

async function submitComposer(composer, expectedUrl = location.href) {
  const requested = comparableText(composerText(composer));
  const submitted = () => isGenerating() || (
    !composerText(findComposer()) && latestUserMatchesPrompt(requested)
  );

  // ChatGPT creates the Send button only after text enters an empty composer.
  await waitFor(() => sendButtonReady(findSendButton(composer)), 8000);
  if (!sameConversation(expectedUrl) || findComposer() !== composer) return false;
  const button = findSendButton(composer);
  const ownership = await sendRuntime({ type: "isTargetTab" });
  if (stopped || !ownership?.target || ownership.paused || isGenerating() || hasBlockingUi()
      || !sameConversation(expectedUrl) || findComposer() !== composer) return false;
  if (sendButtonReady(button)) {
    HTMLButtonElement.prototype.click.call(button);
    if (await waitFor(submitted, 10000)) return true;
  }
  return false;
}

function modelPickerTrigger() {
  return [...document.querySelectorAll('button')].find(button =>
    (/select.*(?:chatgpt )?model|thinking effort/i.test(button.getAttribute('aria-label') || '')
      || button.hasAttribute('data-codex-intelligence-trigger')) && controlReady(button)) || null;
}

function pickerMenu(trigger) {
  const controlled = document.getElementById(trigger.getAttribute('aria-controls'));
  if (controlled && visible(controlled)) return controlled;
  return [...document.querySelectorAll('[role="menu"]')].find(menu => visible(menu)
    && menu.getAttribute('aria-labelledby') === trigger.id) || null;
}

function pickerItems(menu, selector = '[role="menuitemradio"], [role="option"], [role="menuitem"]') {
  // Both views remain mounted. Ignore the inert model list behind the power slider.
  return [...(menu?.querySelectorAll(selector) || [])].filter(item => controlReady(item)
    && !item.closest('[inert], [aria-hidden="true"]'));
}

function modelLabel(item) {
  // Use the first line, excluding descriptions such as retirement dates.
  return normalizedControlText(item?.getAttribute?.('aria-label') || (item?.innerText || item?.textContent || '').split('\n')[0])
    .toLowerCase().replace(/[\s\u2010-\u2015-]+/g, '');
}

function selectedModel(menu, name) {
  return pickerItems(menu).some(item => modelLabel(item) === modelLabel({ textContent: name })
    && (item.getAttribute('aria-checked') === 'true' || item.getAttribute('data-model-selected') === 'true'));
}

function selectedReasoning(trigger, menu) {
  const explicit = trigger.getAttribute('data-selected-reasoning-effort');
  if (explicit) return explicit.toLowerCase();
  const status = pickerItems(menu, '[role="status"]').map(item => item.textContent).join(' ');
  return (status.match(/\b(instant|medium|high)\b/i) || [])[1]?.toLowerCase() || '';
}

async function ensureModelPreferences(preferences, force = false) {
  const model = preferences.preferredModel || '';
  const reasoning = preferences.preferredReasoning || '';
  if (!model && !reasoning) return true;
  const trigger = modelPickerTrigger();
  const signature = trigger ? `${trigger.innerText}|${trigger.getAttribute('data-selected-reasoning-effort')}` : '';
  const key = `${location.href}|${model}|${reasoning}`;
  if (!force && verifiedModelSelection?.trigger === trigger && verifiedModelSelection.key === key
      && verifiedModelSelection.signature === signature && !approvalMenuOpen(trigger)) return true;
  if (modelPreferenceRetryAt > Date.now() && modelPreferenceFailure === key) return false;

  // Check ownership again before every click. A pause, approval, or new response
  // can appear while a menu is opening; none should be interrupted by this flow.
  const canAct = async () => {
    const current = await sendRuntime({ type: 'isTargetTab' });
    return !stopped && current?.target && !current.paused && !isGenerating() && !hasBlockingUi()
      && (current.preferredModel || '') === model && (current.preferredReasoning || '') === reasoning;
  };
  if (!await canAct()) return false;
  if (trigger && !approvalMenuOpen(trigger)
      && [...document.querySelectorAll('[role="menu"], [role="dialog"]')].some(visible)) return false;
  let opened = false;
  let success = false;
  let changed = false;
  let reason = 'picker-unavailable';
  try {
    if (!trigger) return false;
    if (!approvalMenuOpen(trigger)) {
      clickControl(trigger, { pointerFirst: true });
      opened = true;
    }
    if (!await waitFor(() => Boolean(pickerMenu(trigger)), 3000)) return false;
    // The portal can mount before the active view's controls. Let the actual
    // choices become ready before treating a loading menu as a failed picker.
    if (!await waitFor(() => pickerItems(pickerMenu(trigger)).length > 0, 3000)) return false;
    let menu = pickerMenu(trigger);
    if (model) {
      let options = pickerItems(menu);
      let desired = options.find(item => modelLabel(item) === modelLabel({ textContent: model }));
      if (!desired) {
        const toggle = options.find(item => /^(?:select|choose) model$/i.test(item.getAttribute('aria-label') || ''));
        if (!toggle || !await canAct()) return false;
        clickControl(toggle);
        await waitFor(() => pickerItems(pickerMenu(trigger)).some(item => item.getAttribute('role') === 'menuitemradio'), 2000);
        menu = pickerMenu(trigger);
        desired = pickerItems(menu).find(item => modelLabel(item) === modelLabel({ textContent: model }));
      }
      reason = 'model-unavailable';
      if (!desired || !await canAct()) return false;
      if (!selectedModel(menu, model)) {
        clickControl(desired);
        changed = true;
        // Current ChatGPT returns to the power view, retaining the checked list
        // in an inert panel. Read that authoritative state to verify selection.
        if (!await waitFor(() => [...(pickerMenu(trigger)?.querySelectorAll('[aria-checked="true"], [data-model-selected="true"]') || [])]
          .some(item => modelLabel(item) === modelLabel({ textContent: model })), 3000)) return false;
      }
    }
    if (reasoning && selectedReasoning(trigger, pickerMenu(trigger)) !== reasoning) {
      menu = pickerMenu(trigger);
      // A checked model in the advanced view returns to the simple power view.
      let power = pickerItems(menu).find(item => /^(?:power|reasoning|thinking effort)$/i.test(item.getAttribute('aria-label') || ''));
      if (!power) {
        const selected = pickerItems(menu).find(item => item.getAttribute('aria-checked') === 'true');
        if (selected && await canAct()) {
          clickControl(selected);
          await waitFor(() => pickerItems(pickerMenu(trigger)).some(item => item.hasAttribute('data-reasoning-slider')), 2000);
          power = pickerItems(pickerMenu(trigger)).find(item => item.hasAttribute('data-reasoning-slider'));
        }
      }
      reason = 'reasoning-unavailable';
      if (!power) return false;
      // Use the menu's documented keyboard control, then verify its actual
      // effort after each step. Never map guessed slider coordinates to levels.
      const levels = ['instant', 'medium', 'high'];
      for (let step = 0; step < 4 && selectedReasoning(trigger, pickerMenu(trigger)) !== reasoning; step++) {
        const current = levels.indexOf(selectedReasoning(trigger, pickerMenu(trigger)));
        const target = levels.indexOf(reasoning);
        if (current < 0 || target < 0 || !await canAct()) return false;
        const before = selectedReasoning(trigger, pickerMenu(trigger));
        const key = current < target ? 'ArrowRight' : 'ArrowLeft';
        power.focus({ preventScroll: true });
        power.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
        power.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
        changed = true;
        if (!await waitFor(() => selectedReasoning(trigger, pickerMenu(trigger)) !== before, 1500)) return false;
      }
      if (selectedReasoning(trigger, pickerMenu(trigger)) !== reasoning) return false;
    }
    success = await canAct();
  } finally {
    if (opened && approvalMenuOpen(trigger)) {
      const menu = pickerMenu(trigger);
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      if (!await waitFor(() => !approvalMenuOpen(trigger), 1000)) success = false;
    }
    if (success) {
      verifiedModelSelection = { trigger, key, signature: `${trigger.innerText}|${trigger.getAttribute('data-selected-reasoning-effort')}` };
      modelPreferenceFailure = '';
      modelPreferenceRetryAt = 0;
      await sendRuntime({ type: 'modelPreferenceResult', ok: true, changed });
    } else if (await canAct()) {
      modelPreferenceRetryAt = Date.now() + 30000;
      const repeated = modelPreferenceFailure === key;
      modelPreferenceFailure = key;
      await sendRuntime({ type: 'modelPreferenceResult', ok: false, reason, repeated });
    }
  }
  return success;
}

async function sendPrompt(text) {
  const expectedUrl = location.href;
  const ownership = await sendRuntime({ type: "isTargetTab" });
  if (stopped || !ownership?.target || ownership.paused || !sameConversation(expectedUrl)) return false;
  const requested = normalizedText(text);
  if (!requested || isGenerating() || hasBlockingUi()) return false;
  if (!await waitFor(() => visible(findComposer()), 10000)) return false;
  if (hasBlockingUi() || !sameConversation(expectedUrl)) return false;
  if (!await ensureModelPreferences(ownership, true)) return false;

  if (!sameConversation(expectedUrl)) return false;

  const composer = findComposer();
  const existing = composerText(composer);
  if (existing && comparableText(existing) !== comparableText(requested)) return false;
  if (!existing && !await setComposerText(composer, text)) return false;
  if (comparableText(composerText(composer)) !== comparableText(requested)) return false;
  return submitComposer(composer, expectedUrl);
}

async function sendPromptWithRetry(text) {
  // The background owns delayed retries. One attempt must produce one click.
  return sendPrompt(text);
}

async function manualSwap(prompt, expectedUrl = location.href) {
  if (manualActionRunning || !prompt || hasBlockingUi() || !sameConversation(expectedUrl)) return false;
  manualActionRunning = true;
  let ok = false;
  try {
    if (!await waitFor(() => !scanRunning, 10000)) return false;
    if (!sameConversation(expectedUrl)) return false;
    const stopButton = findStopButton();
    if (stopButton) {
      HTMLButtonElement.prototype.click.call(stopButton);
      if (!await waitFor(() => !isGenerating(), 15000)) return false;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    if (!sameConversation(expectedUrl)) return false;
    ok = await sendPromptWithRetry(prompt);
    return ok;
  } finally {
    await sendRuntime({
      type: "commandResult",
      action: "sendHandoff",
      ok,
      url: location.href,
    });
    manualActionRunning = false;
  }
}

async function manualContinue(prompt, expectedUrl = location.href) {
  if (manualActionRunning || !prompt || isGenerating() || hasBlockingUi()
      || !sameConversation(expectedUrl)) return false;
  manualActionRunning = true;
  let ok = false;
  try {
    if (!await waitFor(() => !scanRunning, 10000)) return false;
    if (!sameConversation(expectedUrl)) return false;
    ok = await sendPromptWithRetry(prompt);
    return ok;
  } finally {
    await sendRuntime({
      type: "commandResult",
      action: "sendContinue",
      ok,
      url: location.href,
    });
    manualActionRunning = false;
  }
}

async function waitForSettledAssistantResponse(timeoutMs = 8000, stableMs = 2000) {
  const initial = latestAssistantResponse();
  const initialTurn = initial.turn?.getAttribute("data-testid")
    || initial.turn?.getAttribute("data-turn-key") || "";
  const initialKey = initial.text ? `${initialTurn}:${fingerprint(initial.text)}` : "";
  if (initialKey && initialKey === settledResponseKey && settledResponseUrl === location.href) {
    return initial;
  }
  const startedAt = Date.now();
  let latest = initial;
  let lastKey = initialKey;
  let stableSince = initialKey ? startedAt : 0;

  while (!stopped && !isGenerating() && Date.now() - startedAt < timeoutMs) {
    const response = latestAssistantResponse();
    const turnId = response.turn?.getAttribute("data-testid")
      || response.turn?.getAttribute("data-turn-key") || "";
    const key = response.text ? `${turnId}:${fingerprint(response.text)}` : "";
    if (!key || key !== lastKey) {
      latest = response;
      lastKey = key;
      stableSince = key ? Date.now() : 0;
    } else if (Date.now() - stableSince >= stableMs) {
      settledResponseKey = key;
      settledResponseUrl = location.href;
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function captureResponse(response = latestAssistantResponse()) {
  const turnId = response.turn?.getAttribute("data-testid")
    || response.turn?.getAttribute("data-turn-key") || "";
  const responseKey = response.text
    ? `${turnId}:${fingerprint(response.text)}`
    : turnId
      ? `turn:${turnId}`
      : "";
  return { ...response, responseKey };
}

async function openNewChat() {
  const before = location.href;
  const control = [...document.querySelectorAll("a, button")]
    .filter(visible)
    .find((candidate) => /^new\s+chat$/i.test(
      normalizedControlText(candidate.getAttribute("aria-label") || candidate.innerText || ""),
    ));

  if (control) {
    HTMLElement.prototype.click.call(control);
    if (await waitFor(() => location.href !== before && !isConversationPage(), 8000)) return true;
  }
  location.assign("https://chatgpt.com/");
  return true;
}

async function handleAction(result) {
  if (hasBlockingUi()) return;
  if (["sendHandoff", "sendContinue", "sendBlockedReview"].includes(result.action)) {
    const ok = await sendPromptWithRetry(result.prompt);
    await sendRuntime({ type: "commandResult", action: result.action, ok, url: location.href });
    return;
  }

  if (result.action === "rotateWithHandoff") {
    let handoff = captureResponse();
    if (!validHandoffText(handoff.text)) {
      const settled = await waitForSettledAssistantResponse(12000, 2500);
      if (settled) handoff = captureResponse(settled);
    }
    if (!handoff.substantive || !validHandoffText(handoff.text)) {
      await sendRuntime({ type: "commandResult", action: result.action, ok: false, url: location.href });
      return;
    }
    const captured = await sendRuntime({ type: "handoffCaptured", text: handoff.text, url: location.href });
    if (!captured?.ok) return;
    await openNewChat();
  }
}

async function deliverPendingHandoff() {
  if (hasBlockingUi()) return;
  const expectedUrl = location.href;
  const result = await sendRuntime({ type: "getPendingHandoff" });
  if (!sameConversation(expectedUrl)) return;
  if (!result?.prompt) return;
  if (isConversationPage()) {
    // Navigation may complete before the delivery acknowledgement reaches the
    // worker. Reconcile the posted message without sending it a second time.
    if (latestUserMatchesPrompt(result.prompt)) {
      await sendRuntime({ type: "handoffDelivered", url: location.href });
    }
    return;
  }
  if (!await enableDevSpace()) {
    await sendRuntime({ type: "commandResult", action: "enableDevSpace", ok: false, url: location.href });
    return;
  }
  if (!sameConversation(expectedUrl)) return;

  const ok = await sendPromptWithRetry(result.prompt);
  if (ok) {
    await sendRuntime({ type: "handoffDelivered", url: location.href });
    return;
  }
  await sendRuntime({ type: "commandResult", action: "deliverHandoff", ok: false, url: location.href });
}

function conversationLoadRetryButton() {
  if (!isConversationPage() || isGenerating()) return null;
  for (const button of document.querySelectorAll("button, [role='button']")) {
    if (!visible(button) || !/^try again$/i.test(buttonLabel(button).trim())) continue;
    // Scope the error to the retry card, never a quoted message in chat history.
    let card = button.parentElement;
    for (let depth = 0; card && depth < 3; depth++, card = card.parentElement) {
      if (card.closest?.("[data-message-author-role], [data-turn-key], [data-testid^='conversation-turn']")) break;
      if (/could not load this chatgpt conversation/i.test(card.innerText || "")) return button;
    }
  }
  return null;
}

async function recoverConversationLoad() {
  if (loadRecovery.url !== location.href) loadRecovery = { url: location.href, attempts: 0, retryAt: 0 };
  const button = conversationLoadRetryButton();
  if (!button) {
    // Disappearing error text can mean loading. Only resume after a real composer returns.
    if (loadRecovery.attempts && !visible(findComposer())) return true;
    if (loadRecovery.attempts) {
      await sendRuntime({ type: "conversationLoadRecovered", url: location.href });
      loadRecovery = { url: location.href, attempts: 0, retryAt: 0 };
    }
    return false;
  }
  if (Date.now() >= loadRecovery.retryAt && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
    loadRecovery.attempts++;
    const delay = Math.min(300000, 30000 * 2 ** Math.min(loadRecovery.attempts - 1, 4));
    loadRecovery.retryAt = Date.now() + delay;
    const allowed = await sendRuntime({ type: "conversationLoadRetry", url: location.href });
    if (!stopped && allowed?.ok) HTMLElement.prototype.click.call(button);
  }
  return true;
}

async function scan() {
  if (stopped || scanRunning || manualActionRunning || blockingUiRunning) return;
  const scannedUrl = location.href;
  scanRunning = true;
  try {
    const tabRole = await sendRuntime({ type: "isTargetTab" });
    // A transient service-worker wakeup failure is not proof that this tab lost ownership.
    if (!tabRole) return;
    extendedThinkingLimitMs = Math.min(60, Math.max(1, Number(tabRole.thinkingMinutes) || 10)) * 60 * 1000;
    if (!tabRole.target) {
      stopMonitor();
      return;
    }

    if (tabRole.paused) { resetExtendedThinking(); return; }
    if (await recoverConversationLoad()) { resetExtendedThinking(); return; }
    if (isConversationPage() && followLatestConversation()) {
      // Allow virtualized content to render before detecting approvals or
      // deciding the turn finished. This runs only when the pane moved.
      scheduleScan();
      return;
    }
    if (await resolveDevSpaceMaterialization()) { resetExtendedThinking(); return; }

    if (!isConversationPage() || tabRole.pendingDelivery) {
      resetExtendedThinking();
      if (!isGenerating() && !await ensureModelPreferences(tabRole)) return;
      await deliverPendingHandoff();
      return;
    }

    const generating = isGenerating();
    let recoveryKey = generating ? "" : streamRecoveryFailure();
    const generationEnded = lastScanGenerating === true && !generating;
    const generationStarted = lastScanGenerating !== true && generating;
    lastScanGenerating = generating;
    if (generationStarted) settledResponseKey = "";
    if (generating) idleSince = 0;
    else if (!idleSince) idleSince = Date.now();
    if (await recoverExtendedThinking()) return;
    if (generationEnded && await settleBlockingUiAfterGeneration()) return;
    if (!generating && tabRole.scanHistory) {
      const historySeconds = await scanExistingHistory();
      if (!sameConversation(scannedUrl)) return;
      if (historySeconds !== null) {
        await sendRuntime({
          type: "historyScanComplete",
          url: location.href,
          workedSeconds: historySeconds,
        });
      }
    }

    // While a response streams, the background only needs an occasional
    // heartbeat after the initial state transition. Idle reconciliation also
    // runs without DOM mutations so delayed retries cannot get stuck.
    if (generating) {
      const now = Date.now();
      if (!generationStarted && now - lastGeneratingReportAt < 10000) return;
      lastGeneratingReportAt = now;
    } else if (!generationEnded && Date.now() - idleSince < 5000) {
      return;
    }
    let latestResponseText = "";
    let responseKey = "";
    let latestResponseIsSubstantive = false;

    if (!generating) {
      const completed = captureResponse();
      // A stale error banner must not hide a readable final reply. Let the
      // normal settling check validate it before deciding recovery is needed.
      if (completed.substantive && completed.text) recoveryKey = "";
      if (terminalMarker(completed.text)) {
        latestResponseText = completed.text;
        latestResponseIsSubstantive = completed.substantive;
        responseKey = completed.responseKey;
        recoveryKey = "";
      }
      // Read the latest rendered assistant turn directly. Clipboard focus and
      // ChatGPT's Copy response control are deliberately outside this flow.
      if (!recoveryKey && !responseKey) {
        const settled = await waitForSettledAssistantResponse(3500, 1500);
        if (isGenerating()) {
          scheduleScan(0);
          return;
        }
        if (settled) {
          const latest = captureResponse(settled);
          latestResponseText = latest.text;
          latestResponseIsSubstantive = latest.substantive;
          responseKey = latest.responseKey;
        } else {
          recoveryKey = incompleteTurnKey();
        }
      }
    }

    // A permission dialog can appear while this scan is already in flight.
    // It outranks status/continuation decisions, so abort before notifying the
    // background or submitting any prompt.
    if (await resolveDevSpaceMaterialization()) return;

    // Let completed/blocked replies reach the background and pause the task
    // before reconciling model choices. Active generation is never interrupted.
    if (!generating && !terminalMarker(latestResponseText) && !await ensureModelPreferences(tabRole)) return;

    // DOM reads and model-menu waits can span a navigation. A completed reply
    // from the old chat must never become an action in the new conversation.
    if (!sameConversation(scannedUrl)) return;

    const result = await sendRuntime({
      type: "status",
      url: location.href,
      isGenerating: generating,
      generationEnded,
      workedSeconds: workedSeconds(generationEnded),
      responseKey,
      recoveryKey,
      latestResponseText,
      latestResponseIsSubstantive,
      latestUserText: generating ? "" : latestUserText(),
      composerEmpty: generating ? false : !composerText(findComposer()),
      terminalStatus: terminalMarker(latestResponseText),
      consecutiveBlockedResponses: generating ? 0 : consecutiveBlockedResponses(),
    });
    if (await resolveDevSpaceMaterialization()) return;
    if (result?.action && !manualActionRunning && !hasBlockingUi()
        && sameConversation(scannedUrl)) await handleAction(result);
  } catch (error) {
    if (/extension context invalidated/i.test(error?.message || "")) {
      stopMonitor();
    } else {
      console.error("ChatGPT Agent Monitor", error);
    }
  } finally {
    scanRunning = false;
  }
}

function scheduleScan(delayMs = 700) {
  if (stopped) return;
  if (delayMs === 0) {
    if (observerScanTimer) clearTimeout(observerScanTimer);
    observerScanTimer = setTimeout(() => {
      observerScanTimer = null;
      void scan();
    }, 0);
    return;
  }

  lastMutationAt = Date.now();
  if (observerScanTimer) return;
  const afterQuietPeriod = () => {
    const remaining = 700 - (Date.now() - lastMutationAt);
    if (remaining > 0) {
      observerScanTimer = setTimeout(afterQuietPeriod, remaining);
      return;
    }
    observerScanTimer = null;
    void scan();
  };
  observerScanTimer = setTimeout(afterQuietPeriod, 700);
}

function handleResume() {
  scheduleScan(0);
}

function handlePageShow() {
  scheduleScan(0);
}

function handleVisibilityChange() {
  if (!document.hidden) scheduleScan(0);
}

function handleRuntimeMessage(message, _sender, sendResponse) {
  if (message.type !== "manualSwap" && message.type !== "manualContinue") return false;
  const operation = message.type === "manualSwap" ? manualSwap : manualContinue;
  operation(message.prompt, message.expectedUrl)
    .then((ok) => sendResponse({ ok }))
    .catch(() => sendResponse({ ok: false }));
  return true;
}

intervalId = setInterval(() => void scan(), 5000);
observer = new MutationObserver(() => {
  const urlChanged = observedUrl !== location.href;
  observedUrl = location.href;
  scheduleScan(urlChanged ? 0 : 700);
});
observer.observe(document.body, { childList: true, characterData: true, subtree: true });
document.addEventListener("resume", handleResume);
window.addEventListener("pageshow", handlePageShow);
document.addEventListener("visibilitychange", handleVisibilityChange);
chrome.runtime.onMessage.addListener(handleRuntimeMessage);
void scan();
}
