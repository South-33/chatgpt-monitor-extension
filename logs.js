const chooseFolder = document.querySelector("#chooseFolder");
const status = document.querySelector("#status");

async function showCurrentFolder() {
  const folder = await AgentMonitorLogFiles.directory();
  if (!folder) {
    status.textContent = "No folder selected yet.";
    return;
  }
  const permission = await folder.queryPermission({ mode: "readwrite" });
  status.textContent = permission === "granted"
    ? `Logging to ${folder.name}. You can close this tab.`
    : `${folder.name} needs write access. Choose folder to reconnect it.`;
}

chooseFolder.addEventListener("click", async () => {
  chooseFolder.disabled = true;
  try {
    let folder = await AgentMonitorLogFiles.directory();
    if (folder && await folder.queryPermission({ mode: "readwrite" }) !== "granted") {
      if (await folder.requestPermission({ mode: "readwrite" }) !== "granted") folder = null;
    }
    folder ||= await window.showDirectoryPicker({ mode: "readwrite", id: "agent-monitor-logs" });
    await AgentMonitorLogFiles.setDirectory(folder);
    await chrome.runtime.sendMessage({ type: "logFolderChanged" });
    await showCurrentFolder();
  } catch (error) {
    if (error?.name !== "AbortError") status.textContent = "Could not use that folder. Try again.";
  } finally {
    chooseFolder.disabled = false;
  }
});

void showCurrentFolder().catch(() => {
  status.textContent = "Could not read the saved log folder.";
});