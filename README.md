# ChatGPT Agent Monitor

Chrome extension that continues a ChatGPT task and carries its checkpoint into a fresh chat.

1. Open `chrome://extensions`, turn on **Developer mode**, and use **Load unpacked** to select this directory.
2. Open a ChatGPT conversation and select **Monitor this tab**. Set the prompt, timers, and plugin in the popup. The four prompt presets are shared across tabs. Each tab remembers its selected preset.
3. Use the checkbox beside **Model** to apply your model and reasoning choices automatically. **Keep current** skips that setting.
4. After an update, reload the extension and refresh the monitored ChatGPT tabs.

**Pause** keeps the timer and lets you resume later. **Handoff** starts a fresh chat with a checkpoint. Review any approval shown by ChatGPT before resuming.

The cycle starts with your prompt and a Continue turn. **Improve** and **Housekeeping** each add their own turn followed by time to finish that step. With both off, the cycle uses two Continue turns.

Model, reasoning, and cycle controls apply to the current tab. Prompt text, plugin, and both timers are shared.
Hover over the cycle number to see the current stage name.

Open **Logs** to choose a folder for JSONL diagnostics or download a copy. New files are split by day and tab ID. The logs exclude chat text and page URLs.

Import your global `AGENTS.md` from **Logs**. Housekeeping includes its Git section. After about 28 minutes of tracked work, the next automated prompt refreshes the global instructions and asks the agent to reread the project's instructions. Fresh handoffs also include the global instructions.

Run the tests with `node --test tests/*.test.cjs`.
