const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const values = new Map();
const files = new Map();
let permission = "granted";
const pending = new Map();
let nextId = 1;
let failWrite = false;
const folder = {
  name: "logs",
  async queryPermission() { return permission; },
  async getFileHandle(name) {
    return {
      async getFile() { return { size: (files.get(name) || "").length }; },
      async createWritable() {
        let position = 0;
        let content = files.get(name) || "";
        return {
          async seek(offset) { position = offset; },
          async write(text) {
            if (failWrite) throw new Error("disk unavailable");
            content = content.slice(0, position) + text;
          },
          async close() { files.set(name, content); },
          async abort() {},
        };
      },
    };
  },
};
const db = {
  objectStoreNames: { contains: () => true },
  createObjectStore() {},
  transaction(storeName) {
    const transaction = {
      objectStore() {
        return {
          add(value) {
            const id = nextId++;
            pending.set(id, { ...value, id });
            queueMicrotask(() => transaction.oncomplete());
          },
          getAll(_query, count) {
            const request = { result: [...pending.values()].slice(0, count) };
            queueMicrotask(() => request.onsuccess());
            return request;
          },
          delete(id) {
            pending.delete(id);
            queueMicrotask(() => transaction.oncomplete());
          },
          get(key) {
            const request = { result: values.get(key) };
            queueMicrotask(() => request.onsuccess());
            return request;
          },
          put(value, key) {
            values.set(key, value);
            queueMicrotask(() => transaction.oncomplete());
          },
        };
      },
    };
    return transaction;
  },
};
const indexedDB = {
  open() {
    const request = { result: db };
    queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); });
    return request;
  },
};
const source = fs.readFileSync(path.join(__dirname, "..", "log-files.js"), "utf8");
const context = { indexedDB, DOMException, queueMicrotask };
vm.runInNewContext(`${source}; this.logs = AgentMonitorLogFiles;`, context);

(async () => {
  assert.equal(await context.logs.append({ time: "2026-09-30T01:00:00Z", event: "before-setup" }), false);
  await context.logs.setDirectory(folder);
  assert.equal((await context.logs.directory()).name, "logs");
  await context.logs.append({ time: "2026-09-30T01:00:00Z", event: "first" });
  await context.logs.append({ time: "2026-09-30T01:00:01Z", event: "second" });
  assert.deepEqual(files.get("agent-monitor-2026-09-30.jsonl").trim().split("\n").map(JSON.parse).map((entry) => entry.event),
    ["before-setup", "first", "second"], "flush events buffered before setup and preserve previous events");
  permission = "prompt";
  await assert.rejects(context.logs.append({ time: "2026-09-30T01:00:02Z", event: "blocked" }),
    (error) => error.name === "NotAllowedError");
  assert.equal(pending.size, 1, "permission loss must retain the event durably");
  permission = "granted";
  await context.logs.append({ time: "2026-10-01T01:00:00Z", event: "reconnected" });
  assert.equal(pending.size, 0);
  assert.equal(JSON.parse(files.get("agent-monitor-2026-09-30.jsonl").trim().split("\n").at(-1)).event, "blocked",
    "buffered events must retain their original date when reconnected");
  assert.equal(JSON.parse(files.get("agent-monitor-2026-10-01.jsonl").trim()).event, "reconnected");
  failWrite = true;
  await assert.rejects(context.logs.append({ time: "2026-10-01T01:00:01Z", event: "disk-failed" }));
  assert.equal(pending.size, 1, "failed writes must not delete buffered events");
  failWrite = false;
  await context.logs.append({ time: "2026-10-01T01:00:02Z", event: "disk-recovered" });
  assert.equal(pending.size, 0);
  assert.deepEqual(files.get("agent-monitor-2026-10-01.jsonl").trim().split("\n").map(JSON.parse).map(e => e.event),
    ["reconnected", "disk-failed", "disk-recovered"]);
  console.log("log_files_ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
