const AgentMonitorLogFiles = (() => {
  const DATABASE = "agent-monitor-log-files";
  const STORE = "settings";
  const DIRECTORY_KEY = "directory";
  const PENDING = "pending-events";
  let databasePromise;

  function database() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 2);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
          if (!request.result.objectStoreNames.contains(PENDING)) {
            request.result.createObjectStore(PENDING, { keyPath: "id", autoIncrement: true });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        databasePromise = null;
        throw error;
      });
    }
    return databasePromise;
  }

  async function directory() {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(DIRECTORY_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function setDirectory(handle) {
    const db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(handle, DIRECTORY_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function pendingEntries() {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction(PENDING, "readonly").objectStore(PENDING).getAll();
      request.onsuccess = () => resolve(request.result.map(({ entry }) => entry));
      request.onerror = () => reject(request.error);
    });
  }

  async function append(entry) {
    // Persist before checking folder access. Browser permission can expire;
    // queued events are written on the next successful append/reconnection.
    const db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(PENDING, "readwrite");
      transaction.objectStore(PENDING).add({ entry });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const folder = await directory();
    if (!folder) return false;
    if (await folder.queryPermission({ mode: "readwrite" }) !== "granted") {
      throw new DOMException("Log folder access needs renewal", "NotAllowedError");
    }
    while (true) {
      const batch = await new Promise((resolve, reject) => {
        const request = db.transaction(PENDING, "readonly").objectStore(PENDING).getAll(null, 100);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!batch.length) break;
      const dates = new Map();
      for (const item of batch) {
        const date = item.entry.time.slice(0, 10);
        if (!dates.has(date)) dates.set(date, []);
        dates.get(date).push(item);
      }
      for (const [date, items] of dates) {
        const fileHandle = await folder.getFileHandle(`agent-monitor-${date}.jsonl`, { create: true });
        const file = await fileHandle.getFile();
        const writer = await fileHandle.createWritable({ keepExistingData: true });
        try {
          await writer.seek(file.size);
          await writer.write(items.map(({ entry }) => `${JSON.stringify(entry)}\n`).join(""));
          await writer.close();
        } catch (error) {
          await writer.abort();
          throw error;
        }
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(PENDING, "readwrite");
          const store = transaction.objectStore(PENDING);
          for (const { id } of items) store.delete(id);
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      }
    }
    return true;
  }

  return { directory, setDirectory, pendingEntries, append };
})();
