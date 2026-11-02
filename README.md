# ChatGPT Agent Monitor

A Manifest V3 extension for independently continuing and handing off ChatGPT tasks.

## Use

1. Enable Developer mode in `chrome://extensions`, choose **Load unpacked**, and select this directory.
2. Open a ChatGPT conversation and click **Monitor this tab**. Other tabs remain independent.
3. Choose one of four continue slots. Text is shared between tabs; selection belongs to each tab. Edits save automatically.
4. Set the long-thinking and handoff timers in the popup.
   Model and reasoning choices also save automatically and apply to monitored tabs and handoff chats. Use the model dropdown to choose GPT-6, GPT-5.6 Sol, or another listed option. Uncheck **Set model and reasoning automatically** to leave ChatGPT's current model and reasoning unchanged while monitoring continues. The checkbox preserves your selected preferences for when you enable it again. **Keep current** leaves each individual choice alone.
5. Reload the extension after updates and refresh monitored pages to load the new content script. The popup shows the loaded version.

## Flow

- Pause keeps monitoring and accumulated time. Resume restores the active flow. Stop removes monitoring.
- Each conversation sends the selected custom continuation first, then two brief `continue` turns, then repeats. Normal turns contain the selected prompt itself plus one compact terminal-marker note; they are not wrapped in a second automation preamble or a full completion contract. Changing the selected prompt sends its new text on the next normal continuation. Only acknowledged sends advance the cycle, and recovery check-ins and blocked reconsideration do not count.
- A standalone final `TASK_FINISHED` pauses immediately. A `TASK_BLOCKED` sends one focused reconsideration prompt for that blocked episode. If the reconsideration reply is still `TASK_BLOCKED`, monitoring pauses and asks for user action. If reconsideration finds a path forward, normal automation resumes and a later new `TASK_BLOCKED` can receive one fresh reconsideration. Manual messages and cancellations stay paused. Resume queues one selected continuation and waits for an idle, empty composer.
- Normal continuation prompts keep only a compact terminal signal: report `TASK_FINISHED` when the requested goal is verified, or `TASK_BLOCKED` when meaningful authorized progress truly requires user action. The longer completion contract remains reserved for handoff flows where the extra context is useful.
- Other tool approval cards block automated continuation and must be reviewed manually. The automatic permission handler only matches the specific DevSpace file-materialization request.
- Plugin selection accepts both DevSpace and spacedev. Fresh-chat lookup tries both names, recognizes either selected mention, and preserves unrelated drafts.
- Fresh-chat handoff ignores a selected non-editable DevSpace mention when checking for an unsent draft. It inserts text after the mention, retains the chosen plugin, and avoids reopening an already-verified model picker. On delivery failures the popup and JSONL diagnostics distinguish insertion, model, and send-confirmation problems without logging prompt contents.
- Model and reasoning settings are checked while idle and verified before every automated prompt. Generation and Pause prevent changes. Unavailable choices block submission and show a clear error; they retry at most every 30 seconds. Successful idle checks are reused until the page, picker, settings, or displayed selection changes.
- GPT-6 can show only its reasoning effort (for example, **High**) on the collapsed ChatGPT picker. Model verification opens the picker and inspects its checked model item; the compact control can also expose a nested reasoning slider. Automatic picker access is disabled entirely when the checkbox is unchecked.
- Stop is the generation signal; stale Thinking text does not count. After generation ends, readable final text is checked before continuing. Drafts are never overwritten.
- A prolonged current-turn system thinking notice only arms the watchdog while Stop remains visible. If the notice disappears before the timer, the watchdog clears and generation continues untouched. If the timer expires, the monitor clicks Stop, sends a brief honest status check-in, then returns to the selected continuation or due handoff after that reply.
- Handoff uses cumulative tracked work time. It requests a concise checkpoint, permits brief preparation, and validates a minimum of 200 characters and 30 words. A short response gets one retry. The fresh chat selects Devspace when needed and receives the saved checkpoint. Context remains saved until delivery is acknowledged.
- Manual Handoff is available without monitoring and leaves the fresh chat unmonitored. Terminal paused tasks must be resumed before handing off.
- Loading failures retry with increasing delays, capped at five minutes. Prompt failures get two delayed retries before requiring Retry. Submission acknowledgement prevents duplicate sends.
- Unacknowledged prompts cannot consume a prior assistant reply. Late sends and status updates from a different conversation are ignored; switching chats during an in-flight action cancels its submission instead of moving the prompt to another task.
- Runtime and settings writes are serialized so concurrent tab events, popup edits, and recovery checks do not save state in the wrong order.
- DOM changes are debounced, periodic scans reconcile missed updates, and monitored conversations scroll down at most every 30 seconds. A moved pane gets time to render before decisions. Pause disables these actions.
- Runtime state survives service-worker restarts. Worked-time labels supplement tracked generation time; unrendered past work cannot be reconstructed. Monitoring requests system keep-awake, allowing the display to turn off.

## Logs

Choose **Logs / folder**, then **Choose folder**, and select the included `logs` directory. If Chrome revokes access, use **Reconnect access**. The folder picker requires a direct user gesture. If Chrome blocks folder access, choose **Download logs instead** to export the last 500 saved events plus all pending events as JSONL. Manual exports do not clear buffered events.

Dated JSONL files contain timestamped actions, retries, approvals, pause changes, recovery events, and a five-minute heartbeat with tab IDs. Chat text and page URLs are excluded. Repeated approval detections are deduplicated. Events queue persistently in IndexedDB when file access fails and flush on reconnection, subject to browser storage limits. The last 500 events also remain in extension storage.

## Verification

Run `node --test tests/*.test.cjs`. Tests cover decisions, independent tabs, pause/resume, recovery, handoff, persistence, control fallbacks, and log buffering. They verify protocol and delivery behavior rather than freezing prose.
