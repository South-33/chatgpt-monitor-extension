const chooseFolder = document.querySelector('#chooseFolder');
const reconnectFolder = document.querySelector('#reconnectFolder');
const downloadLogs = document.querySelector('#downloadLogs');
const status = document.querySelector('#status');
const agentInstructions = document.querySelector('#agentInstructions');
const clearAgentInstructions = document.querySelector('#clearAgentInstructions');
const agentInstructionsStatus = document.querySelector('#agentInstructionsStatus');

let savedFolder = null;

function explain(error) {
  const name = error?.name || 'Error';
  if (name === 'SecurityError') return 'Chrome blocked the folder picker. Try this full browser tab, or download logs instead.';
  if (name === 'NotAllowedError') return 'Write permission was not granted. Reconnect access or choose another folder.';
  if (name === 'NotSupportedError' || name === 'TypeError') return 'This browser does not support folder access here. Use Download logs instead.';
  return `${name}: ${error?.message || 'Could not access the folder.'}`;
}

async function showCurrentFolder() {
  savedFolder = await AgentMonitorLogFiles.directory();
  const pending = (await AgentMonitorLogFiles.pendingEntries()).length;
  const suffix = `${pending} event${pending === 1 ? '' : 's'} waiting to be written.`;
  if (!savedFolder) {
    reconnectFolder.hidden = true;
    status.textContent = `No log folder connected. ${suffix}`;
    return;
  }
  const permission = await savedFolder.queryPermission({ mode: 'readwrite' });
  reconnectFolder.hidden = permission === 'granted';
  status.textContent = permission === 'granted'
    ? `Folder: ${savedFolder.name}. ${suffix}`
    : `Folder: ${savedFolder.name}. Write permission is ${permission}. Reconnect access. ${suffix}`;
}

async function confirmFolder(folder) {
  await AgentMonitorLogFiles.setDirectory(folder);
  const result = await chrome.runtime.sendMessage({ type: 'logFolderChanged' });
  await showCurrentFolder();
  if (!result?.ok) status.textContent = result?.logFileError || 'Folder saved, but the test log could not be written.';
  else status.textContent = `Logging to ${folder.name}. A test event was saved. You can close this tab.`;
}

chooseFolder.addEventListener('click', async () => {
  // The picker must start in the click event, before any IndexedDB or runtime
  // await: the browser requires transient user activation.
  let selection;
  try {
    if (typeof window.showDirectoryPicker !== 'function') throw new DOMException('Picker unavailable', 'NotSupportedError');
    selection = window.showDirectoryPicker({ mode: 'readwrite', id: 'agent-monitor-logs' });
  } catch (error) {
    status.textContent = explain(error);
    return;
  }
  chooseFolder.disabled = true;
  try {
    const folder = await selection;
    await confirmFolder(folder);
  } catch (error) {
    if (error?.name !== 'AbortError') status.textContent = explain(error);
  } finally {
    chooseFolder.disabled = false;
  }
});

reconnectFolder.addEventListener('click', async () => {
  // Use the previously loaded handle. Asking permission in this click handler
  // avoids losing activation while reading IndexedDB.
  if (!savedFolder) return;
  reconnectFolder.disabled = true;
  try {
    const request = savedFolder.requestPermission({ mode: 'readwrite' });
    if (await request !== 'granted') throw new DOMException('Access not granted', 'NotAllowedError');
    await confirmFolder(savedFolder);
  } catch (error) {
    status.textContent = explain(error);
  } finally {
    reconnectFolder.disabled = false;
  }
});

downloadLogs.addEventListener('click', async () => {
  downloadLogs.disabled = true;
  try {
    // An ordinary user-initiated download works even when directory picking
    // is unsupported. Combine the recent history with unwritten queued events.
    const [history, buffered] = await Promise.allSettled([
      chrome.runtime.sendMessage({ type: 'getDiagnostics' }),
      AgentMonitorLogFiles.pendingEntries(),
    ]);
    const response = history.status === 'fulfilled' ? history.value : null;
    const pending = buffered.status === 'fulfilled' ? buffered.value : [];
    const seen = new Set();
    const events = [...(response?.events || []), ...pending].filter((entry) => {
      const key = JSON.stringify(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!events.length) {
      status.textContent = 'No diagnostic events to download yet.';
      return;
    }
    const file = new Blob([events.map((entry) => JSON.stringify(entry)).join('\n') + '\n'],
      { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `agent-monitor-export-${new Date().toISOString().slice(0, 10)}.jsonl`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    status.textContent = `Downloaded ${events.length} event${events.length === 1 ? '' : 's'}. Buffered events remain in the extension.`;
  } catch (error) {
    status.textContent = `Could not export logs: ${explain(error)}`;
  } finally {
    downloadLogs.disabled = false;
  }
});

void showCurrentFolder().catch((error) => {
  status.textContent = `Could not read log storage: ${explain(error)}`;
});

async function updateAgentInstructions(message) {
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'Could not access global instructions.');
    clearAgentInstructions.hidden = !result.configured;
    agentInstructionsStatus.textContent = result.configured
      ? result.hasGit ? 'Imported. Git section found.' : 'Imported. Using default Git guidance.'
      : 'No file imported.';
  } catch (error) {
    agentInstructionsStatus.textContent = error.message;
  }
}

agentInstructions.addEventListener('change', async () => {
  const file = agentInstructions.files[0];
  if (!file) return;
  try {
    if (file.size > 128000) throw new Error('Choose an AGENTS.md file under 32,000 characters.');
    await updateAgentInstructions({ type: 'saveAgentInstructions', text: await file.text() });
  } catch (error) {
    agentInstructionsStatus.textContent = error.message;
  } finally {
    agentInstructions.value = '';
  }
});
clearAgentInstructions.addEventListener('click', () =>
  void updateAgentInstructions({ type: 'saveAgentInstructions', text: '' }));
void updateAgentInstructions({ type: 'getAgentInstructions' });
