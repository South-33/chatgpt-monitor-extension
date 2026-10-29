const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const start = source.indexOf("function workedSeconds(force = false)");
const end = source.indexOf("async function waitFor(", start);
assert.ok(start >= 0 && end > start);

let now = 100000;
let scans = 0;
let renderedSeconds = 60;
const sandbox = {
  Date: { now: () => now },
  location: { href: "https://chatgpt.com/c/first" },
  collectWorkedEntries: () => {
    scans++;
    return new Map([["turn", renderedSeconds]]);
  },
};
vm.runInNewContext(`
  let lastWorkedScanAt = 0;
  let cachedWorkedSeconds = 0;
  let workedScanUrl = location.href;
  ${source.slice(start, end)}
  this.workedSeconds = workedSeconds;
`, sandbox);

assert.equal(sandbox.workedSeconds(), 60);
renderedSeconds = 90;
now += 29000;
assert.equal(sandbox.workedSeconds(), 60);
assert.equal(scans, 1, "steady scans reuse the rendered worked time");
assert.equal(sandbox.workedSeconds(true), 90, "a generation ending reads fresh time immediately");
renderedSeconds = 120;
now += 30000;
assert.equal(sandbox.workedSeconds(), 120, "the cache refreshes during a long run");
sandbox.location.href = "https://chatgpt.com/c/second";
renderedSeconds = 15;
assert.equal(sandbox.workedSeconds(), 15, "a fresh chat does not inherit the old count");

console.log("worked_time_cache_ok");