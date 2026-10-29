const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

const local = {};
const session = {};
const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function boot() {
  const runtime = { onInstalled: event(), onStartup: event(), onMessage: event() };
  const chrome = {
    runtime,
    storage: {
      local: {
        async get(key) { return { [key]: local[key] }; },
        async set(value) { Object.assign(local, value); },
      },
      session: {
        async get(key) { return { [key]: session[key] }; },
        async set(value) { Object.assign(session, value); },
      },
      onChanged: event(),
    },
    scripting: { async executeScript() {} },
    tabs: {
      async get(id) { return { id, url: "https://chatgpt.com/c/restart" }; },
      async sendMessage() { return { ok: true }; },
      onRemoved: event(),
    },
    alarms: { create() {}, onAlarm: event() },
    power: { requestKeepAwake() {}, releaseKeepAwake() {} },
  };
  vm.runInNewContext(source, { chrome, console, URL, Date, setTimeout, clearTimeout });

  return function send(message, sender = {}) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`message timed out: ${message.type}`)), 1000);
      runtime.onMessage.listeners[0](message, sender, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  };
}

(async () => {
  const url = "https://chatgpt.com/c/restart";
  const sender = { tab: { id: 41, url } };
  let send = boot();
  await send({ type: "setMonitoring", enabled: true, tabId: 41, url });

  await send({ type: "historyScanComplete", url, workedSeconds: 7800 }, sender);
  let action = await send({
    type: "status",
    url,
    isGenerating: false,
    workedSeconds: 7800,
    responseKey: "pre-handoff",
    latestResponseText: "Meaningful work remains.",
  }, sender);
  assert.equal(action.action, "sendHandoff");
  await send({ type: "commandResult", action: "sendHandoff", ok: true, url }, sender);

  // A completely new service-worker context must resume the handoff phase.
  send = boot();
  let status = await send({ type: "getMonitorStatus", tabId: 41, url });
  assert.equal(status.phase, "waiting-for-handoff");


  const handoff = "The goal is to complete the original task while preserving its verified constraints and decisions. The current implementation is coherent, the important evidence has been recorded, and meaningful validation remains. The next agent should inspect the current state, use its own judgment, and continue without repeating the completed investigation.";
  action = await send({
    type: "status",
    url: `${url}?messageId=finalAgentTurnStart`,
    isGenerating: false,
    workedSeconds: 7800,
    responseKey: "handoff-response",
    latestResponseText: handoff,
    latestResponseIsSubstantive: true,
  }, sender);
  assert.equal(action.action, "rotateWithHandoff");
  await send({ type: "handoffCaptured", text: handoff, url }, sender);

  // Pending handoff text must also survive another worker restart.
  send = boot();
  const freshSender = { tab: { id: 41, url: "https://chatgpt.com/" } };
  const pending = await send({ type: "getPendingHandoff" }, freshSender);
  assert.match(pending.prompt, /The goal is to complete the original task/);

  await send({
    type: "commandResult",
    action: "enableDevSpace",
    ok: false,
    url: freshSender.tab.url,
  }, freshSender);

  // Failed delivery stays paused across a service-worker restart until Retry.
  send = boot();
  assert.equal((await send({ type: "getPendingHandoff" }, freshSender)).prompt, null);
  await send({ type: "retryNow", tabId: 41 }, freshSender);
  assert.match((await send({ type: "getPendingHandoff" }, freshSender)).prompt, /The goal is to complete the original task/);
  await send({ type: "handoffDelivered", url: freshSender.tab.url }, freshSender);
  status = await send({ type: "getMonitorStatus", tabId: 41, url: freshSender.tab.url });
  assert.equal(status.phase, "watching");


  console.log("restart_recovery_ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
