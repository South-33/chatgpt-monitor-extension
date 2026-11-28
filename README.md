# Agent Monitor for ChatGPT and Gemini

Chrome extension that continues ChatGPT and Gemini tasks. It detects the provider from the tab URL and shares the four Goal prompt presets between them.

1. Open `chrome://extensions`, turn on **Developer mode**, and use **Load unpacked** to select this directory.
2. Send your initial work in a ChatGPT conversation or a Gemini **Task**, then select **Monitor this tab**. Set the Goal prompt and model in the popup.
3. Reload the extension and refresh monitored tabs after an update. Version 1.6 adds access to `gemini.google.com`.

The default is GPT-6.2 with High reasoning. The model checkbox applies the configured model and reasoning after the draft is ready, immediately before each automated send. **Keep current** leaves that field to ChatGPT. Model, reasoning, and review checkboxes are per tab. The four prompt texts and plugin are shared. Each tab remembers its selected preset.

Gemini defaults to **Neon**, with **Hydrogen** and **Keep current** also available. It uses the same Goal, Improve, Housekeeping, and Reconsider contracts. Before every automated message, it types `@` and selects the DevSpace Laptop connector. A visible Task control is selected automatically; an existing regular Chat pauses with instructions to open a Task. Gemini handles compaction, so its popup has no reasoning, thinking watchdog, or fresh-chat handoff controls. Active replies are left running. Work time counts while **Stop response** is visible, starting when monitoring begins; it does not estimate earlier work from response text.

Gemini prompts explain how to request a wait: end the reply with `MONITOR_SLEEP_MINUTES=N` on its own final line, replacing `N` with a whole number from 5 to 1440. After the reply ends, the extension waits, then continues the current contract in the same Task. The popup shows a countdown. Waiting time is excluded from work time. A fresh Start ignores the sleep marker already on screen and continues when idle. If a reply is running when Start is pressed, its next wait is honored. Waits within an active run survive extension service-worker restarts and respect Pause and unsent drafts. Chrome must remain open; a wake can be delayed by sleep, loading, or browser throttling.

**Improve** defaults to off for each tab. Its saved per-tab choice is retained across popup reopenings and extension restarts; an old global value cannot turn it on in new tabs.

The Gemini quota guard pauses until you Resume. It recognizes the observed full quota banner and compact “Limit reached · Resets …” notice, with a text-based fallback near the composer. The last ten distinct observations are kept locally and included in **Logs** downloads, retaining the reset text and basic element structure while excluding chat text, page URLs, and email addresses.

ChatGPT rounds start with your custom **Goal** prompt, followed by two **Continue** prompts under the Goal contract. Gemini sends a full prompt, then four short continuations before refreshing the full prompt. A changed Goal or imported instructions, or a new stage, refreshes it immediately. Its quota, sleep, and imported instructions appear only in full prompts. Only accepted sends advance this count, which survives monitor restarts. A Goal turn counts once it receives a reply or the watchdog confirms it stopped. **Improve** and **Housekeeping** run in that order when enabled, after each three Goal turns, and repeat until they report finished or blocked. A Goal finish or block starts **Reconsider**, which keeps its full verification prompt.
Hover over the cycle number for the current stage. Either arrow stops the current reply and starts its review. On an off tab, monitoring lasts only for that review.

**Pause** keeps elapsed time. **Handoff** starts a fresh chat with a checkpoint. Handoff defaults to 150 minutes. Changes to **Thinking** and **Handoff** apply to the current tab until it closes or the browser session ends. Drag the top slider to adjust elapsed time toward the next handoff, even before monitoring starts.

The monitor pauses when ChatGPT shows the conversation length limit. Start a new chat to continue.

Open **Logs** to choose a folder for JSONL diagnostics or download a copy. New files are split by day and tab ID. The logs exclude chat text and page URLs.

Import your global `AGENTS.md` from **Logs** to include its Git section in Housekeeping. The bundled example is used when there is no imported Git section. ChatGPT fresh handoffs include the global instructions, and the next automated prompt refreshes them after about 28 minutes of tracked work. Gemini includes them in its full prompts.

Run the tests with `node --test tests/*.test.cjs`.
