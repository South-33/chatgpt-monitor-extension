const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "..", "content.js"), "utf8");
const normalize = value => (value || "").replace(/\s+/g, " ").trim();
const button = (label, attrs = {}) => ({
  innerText: "", textContent: "", hidden: false,
  getAttribute: name => name === "aria-label" ? label : attrs[name] || null,
});
const send = button("send message");
const stop = button("Stop generation", { type: "submit" });
const voice = button("Start voice", { type: "submit" });
const unrelated = button("Send feedback");
let controls = [send, stop, voice, unrelated];
const scope = { querySelectorAll: () => controls };
let form = null;
const composer = { closest: () => form };
const ctx = {
  findComposer: () => composer, composerScope: () => scope,
  normalizedControlText: normalize, buttonLabel: b => b.getAttribute("aria-label"),
  visible: element => !element.hidden,
};
vm.runInNewContext(source.slice(source.indexOf("function findSendButton"), source.indexOf("function sendButtonReady")), ctx);
assert.equal(ctx.findSendButton(), send, "Send must survive removed IDs and lowercase labels");
send.hidden = true;
assert.equal(ctx.findSendButton(), null, "never choose voice, stop, feedback, or hidden controls");
const submit = button("", { type: "submit" });
controls = [submit];
assert.equal(ctx.findSendButton(), null, "unlabelled submit is only safe inside the composer's form");
form = scope;
assert.equal(ctx.findSendButton(), submit);

const editor = { getAttribute: name => name === "aria-label" ? "Message ChatGPT" : null };
ctx.document = { querySelectorAll: selector => selector === "textarea, [contenteditable='true']" ? [editor] : [] };
vm.runInNewContext(source.slice(source.indexOf("function findComposer"), source.indexOf("function assistantTurns")), ctx);
assert.equal(ctx.findComposer(), editor, "named editor must survive removed ID and textbox role");
editor.hidden = true;
assert.equal(ctx.findComposer(), null);
console.log("control_fallbacks_ok");
