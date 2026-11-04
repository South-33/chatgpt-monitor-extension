# ChatGPT Agent Monitor

Chrome extension that continues a ChatGPT task and carries its checkpoint into a fresh chat.

1. Open `chrome://extensions`, turn on **Developer mode**, and use **Load unpacked** to select this directory.
2. Open a ChatGPT conversation and select **Monitor this tab**. Set the prompt, timers, and plugin in the popup. The four prompt presets are shared across tabs. Each tab remembers its selected preset.
3. Use the checkbox beside **Model** to apply your model and reasoning choices automatically. **Keep current** skips that setting.
4. After an update, reload the extension and refresh the monitored ChatGPT tabs.

**Pause** keeps the timer and lets you resume later. **Handoff** starts a fresh chat with a checkpoint. Review any approval shown by ChatGPT before resuming.

**Review workflow** cycles through your prompt → Continue → Improve workflow → Continue with housekeeping. With the box off, the cycle uses two Continue turns.

Open **Logs** to choose a folder for JSONL diagnostics or download a copy. The logs exclude chat text and page URLs.

Run the tests with `node --test tests/*.test.cjs`.
