"use strict";
const assert = require("node:assert");
const BASE = "http://127.0.0.1:4173";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = text; }
  assert.ok(res.ok, method + " " + path + " -> " + res.status + " " + text.slice(0, 200));
  return json;
}

(async () => {
  let state = await call("GET", "/api/state");
  assert.ok(state.pairs.length >= 5);

  state = await call("POST", "/api/pairs", { symbol: "AUDUSD", priority: true });
  assert.ok(state.pairs.some(p => p.symbol === "AUDUSD"));
  state = await call("PATCH", "/api/pairs/AUDUSD", { priority: false, monitor: false });
  assert.equal(state.pairs.find(p => p.symbol === "AUDUSD").priority, false);
  state = await call("PATCH", "/api/pairs/AUDUSD", { monitor: true });

  const quote = state.quotes.EURUSD;
  const entry = quote ? quote.price : 1.1;
  state = await call("POST", "/api/setups", {
    symbol: "EURUSD", direction: "long", entry,
    stop: entry - 0.003, target: entry + 0.006,
    priority: "high", thresholdPips: 500
  });
  const setup = state.setups.find(s => s.symbol === "EURUSD" && s.status === "watching");
  assert.ok(setup);
  assert.ok(state.priority.find(s => s.id === setup.id));

  // Force evaluation with the live quote (threshold is wide, so it should fire).
  let alert = null;
  for (let i = 0; i < 20 && !alert; i++) {
    await new Promise(r => setTimeout(r, 1000));
    state = await call("GET", "/api/state");
    alert = state.alerts.find(a => a.setupId === setup.id);
  }
  assert.ok(alert, "expected an alert for the setup");
  console.log("alert:", alert.kind, alert.message);

  state = await call("POST", "/api/trades", {
    symbol: "EURUSD", direction: "long", status: "closed",
    entry: entry, stop: entry - 0.003, exit: entry + 0.003,
    riskAmount: 100, fees: 2, setupId: setup.id,
    openedAt: new Date(Date.now() - 3600e3).toISOString(),
    closedAt: new Date().toISOString()
  });
  const trade = state.trades.find(t => t.setupId === setup.id);
  assert.ok(trade);
  assert.equal(trade.status, "closed");
  assert.equal(state.setups.find(s => s.id === setup.id).status, "done");
  assert.equal(state.stats.trades, 1);

  state = await call("POST", "/api/settings", { startingBalance: 12000, defaultThresholdPips: 25 });
  assert.equal(state.settings.startingBalance, 12000);
  assert.equal(state.settings.defaultThresholdPips, 25);

  const exported = await call("GET", "/api/export");
  assert.ok(Array.isArray(exported.trades) && exported.trades.length === 1);

  state = await call("POST", "/api/import", exported);
  assert.ok(state.trades.length === 1);

  state = await call("DELETE", "/api/setups/" + encodeURIComponent(setup.id));
  assert.ok(!state.setups.some(s => s.id === setup.id));

  state = await call("DELETE", "/api/trades/" + encodeURIComponent(trade.id));
  assert.ok(state.trades.length === 0);

  state = await call("DELETE", "/api/pairs/AUDUSD");
  assert.ok(!state.pairs.some(p => p.symbol === "AUDUSD"));

  // SSE endpoint must open and send a snapshot.
  const controller = new AbortController();
  const res = await fetch(BASE + "/api/events", { signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const chunk = await reader.read();
  const text = Buffer.from(chunk.value).toString("utf8");
  assert.match(text, /event: snapshot/);
  controller.abort();

  console.log("HTTP routes OK");
})().catch(err => { console.error(err); process.exitCode = 1; });
