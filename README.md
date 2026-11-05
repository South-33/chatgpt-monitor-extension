# ChatGPT Agent Monitor

Chrome extension that continues a ChatGPT task and carries its checkpoint into a fresh chat.

1. Open `chrome://extensions`, turn on **Developer mode**, and use **Load unpacked** to select this directory.
2. Open a ChatGPT conversation and select **Monitor this tab**. Set the goal prompt, timers, and plugin in the popup.
3. Reload the extension and refresh the monitored ChatGPT tabs after an update.

The model checkbox enables automatic model and reasoning selection. **Keep current** leaves that field to ChatGPT. Model, reasoning, and review checkboxes are per tab. The four prompt texts, plugin, and timers are shared. Each tab remembers its selected preset.

Each round runs your **Goal** prompt, two Goal continuations, **Improve**, then **Housekeeping**. The monitor skips disabled reviews and repeats each enabled review until it reports finished or blocked. A Goal finish or block starts **Reconsider**, which verifies whether to stop or return to Goal.
Hover over the cycle number for the current stage. Either arrow stops the current reply and starts its review. On an off tab, monitoring lasts only for that review.

**Pause** keeps elapsed time. **Handoff** starts a fresh chat with a checkpoint. Drag the top slider to adjust elapsed time toward the next handoff, even before monitoring starts.

Open **Logs** to choose a folder for JSONL diagnostics or download a copy. New files are split by day and tab ID. The logs exclude chat text and page URLs.

Import your global `AGENTS.md` from **Logs** to include its Git section in Housekeeping. The bundled example is used when there is no imported Git section. Fresh handoffs include the global instructions, and the next automated prompt refreshes them after about 28 minutes of tracked work.

Run the tests with `node --test tests/*.test.cjs`.
