# ChatGPT Agent Monitor

Chrome extension that continues a ChatGPT task and carries its checkpoint into a fresh chat.

1. Open `chrome://extensions`, turn on **Developer mode**, and use **Load unpacked** to select this directory.
2. Open a ChatGPT conversation and select **Monitor this tab**. Set the prompt, timers, and plugin in the popup. The four prompt presets are shared across tabs. Each tab remembers its selected preset.
3. Use the checkbox beside **Model** to apply your model and reasoning choices automatically. **Keep current** skips that setting.
4. After an update, reload the extension and refresh the monitored ChatGPT tabs.

**Pause** keeps the timer and lets you resume later. **Handoff** starts a fresh chat with a checkpoint. Review any approval shown by ChatGPT before resuming.
Drag the top slider to set how much time the current chat has already used toward handoff. You can set it before monitoring starts.

Each round runs your **Goal** prompt, two Goal continuations, **Improve**, then **Housekeeping**. The monitor skips disabled reviews and repeats each enabled review until it reports finished or blocked. A Goal finish or block starts **Reconsider**, which verifies whether to stop or return to Goal.
Either arrow stops the current reply and sends its prompt. Monitoring stays as it was.

Model, reasoning, and cycle controls apply to the current tab. Prompt text, plugin, and both timers are shared.
Hover over the cycle number to see the current stage name.

Open **Logs** to choose a folder for JSONL diagnostics or download a copy. New files are split by day and tab ID. The logs exclude chat text and page URLs.

Housekeeping includes the Git commit example, or the full Git section verbatim if you import your global `AGENTS.md` from **Logs**. After about 28 minutes of tracked work, the next automated prompt refreshes the global instructions and asks the agent to reread the project's instructions. Fresh handoffs also include the global instructions.

Run the tests with `node --test tests/*.test.cjs`.
