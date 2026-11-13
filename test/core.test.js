"use strict";

/**
 * Minimal test harness: core domain + serverless handler.
 * Run with: node test/core.test.js
 */

const assert = require("node:assert");
const core = require("../lib/desk-core");
const { createHandler, createMemoryStore, apiPath } = require("../lib/serverless");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok  " + name);
  } catch (err) {
    console.error("  FAIL " + name);
    console.error(err);
    process.exitCode = 1;
  }
}

(async function run() {
  console.log("\nTradera core");

  await test("pip sizes and units", () => {
    assert.equal(core.pipSize("EURUSD"), 0.0001);
    assert.equal(core.pipSize("USDJPY"), 0.01);
    assert.equal(core.pipSize("XAUUSD"), 0.1);
    assert.equal(core.pipSize("BTCUSD"), 1);
    assert.equal(core.unitName("BTCUSD"), "pts");
    assert.equal(core.unitName("EURUSD"), "pips");
  });

  await test("Yahoo symbol mapping", () => {
    assert.equal(core.tvSymbol("EURUSD"), "FX:EURUSD");
    assert.equal(core.tvSymbol("XAUUSD"), "OANDA:XAUUSD");
  });

  await test("OANDA, Binance and fill-side mapping", () => {
    assert.equal(core.toOandaInstrument("EURUSD"), "EUR_USD");
    assert.equal(core.toOandaInstrument("XAUUSD"), "XAU_USD");
    assert.equal(core.toOandaInstrument("NAS100"), "NAS100_USD");
    assert.equal(core.toOandaInstrument("BTCUSD"), null);
    assert.equal(core.toBinanceSymbol("BTCUSD"), "BTCUSDT");
    assert.equal(core.toBinanceSymbol("EURUSD"), null);
    assert.equal(core.toDerivSymbol("EURUSD"), "frxEURUSD");
    assert.equal(core.toDerivSymbol("XAUUSD"), "frxXAUUSD");
    assert.equal(core.toDerivSymbol("NAS100"), "OTC_NDX");
    assert.equal(core.toDerivSymbol("BTCUSD"), "cryBTCUSD");
    assert.equal(core.toDerivSymbol("DOGEUSD"), null);
    assert.equal(core.toDerivSymbol("R_75"), "R_75");
    assert.equal(core.toDerivSymbol("STPRNG3"), "stpRNG3");
    assert.equal(core.toDerivSymbol("CADJPY"), null, "pairs Deriv lacks fall back to Yahoo");
    assert.equal(core.symbolLabel("1HZ75V"), "V75 (1s)");
    assert.equal(core.pipSize("R_75"), 1);
    assert.equal(core.pipSize("STPRNG"), 0.1);
    assert.equal(core.unitName("STPRNG"), "pts");
    assert.equal(core.priceDecimals("R_50"), 4);
    const q = { price: 1.1, bid: 1.1, ask: 1.1002 };
    assert.equal(core.triggerPrice(q, "long"), 1.1002);
    assert.equal(core.triggerPrice(q, "short"), 1.1);
    assert.equal(core.triggerPrice({ price: 5 }, "long"), 5);
  });

  await test("entry alert fires after a getting-close alert, and calls only on entry", async () => {
    const realFetch = global.fetch;
    let btc = 105;
    const calls = [];
    global.fetch = async (url) => {
      url = String(url);
      if (url.includes("binance")) {
        return new Response(JSON.stringify([{ symbol: "BTCUSDT", lastPrice: String(btc), bidPrice: String(btc), askPrice: String(btc + 0.01), openPrice: "100" }]));
      }
      if (url.includes("callmebot")) { calls.push(url); return new Response("<p>Call queued</p>"); }
      throw new Error("offline");
    };
    try {
      const d = core.createDesk({ store: createMemoryStore(null), realtime: true });
      await d.load();
      await d.handle("POST", "/api/settings", { feed: "yahoo", binanceCrypto: true, callmebotUser: "tester" });
      await d.handle("POST", "/api/setups", { symbol: "BTCUSD", direction: "long", entry: 100, thresholdPips: 10 });
      await d.poll();
      let alerts = d.state().alerts;
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].kind, "approaching");
      assert.equal(calls.length, 0);
      btc = 99.5;
      await d.poll();
      alerts = d.state().alerts;
      assert.equal(alerts.length, 2);
      assert.equal(alerts[0].kind, "entry");
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes("user=%40tester"));
      await d.poll();
      assert.equal(d.state().alerts.length, 2, "entry alert fires only once");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("bulk add skips duplicates", async () => {
    const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
    await d.load();
    const res = await d.handle("POST", "/api/pairs/bulk", { symbols: ["EURUSD", "R_75", "stpRNG", "r_75"] });
    assert.equal(res.status, 200);
    assert.equal(res.body.added, 2);
    assert.ok(res.body.pairs.some(p => p.symbol === "STPRNG"));
  });

  await test("a dropped connection is retried before a call is given up", async () => {
    const realFetch = global.fetch;
    let attempts = 0;
    global.fetch = async () => {
      attempts++;
      if (attempts === 1) { const e = new TypeError("fetch failed"); e.cause = { code: "EAI_AGAIN" }; throw e; }
      return new Response("<p>Call queued</p>");
    };
    try {
      const d = core.createDesk({ store: createMemoryStore(null), realtime: true });
      await d.load();
      await d.handle("POST", "/api/settings", { callmebotUser: "tester" });
      const res = await d.handle("POST", "/api/test-call", {});
      assert.equal(res.body.results[0].ok, true);
      assert.equal(attempts, 2);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("a CallMeBot error inside its log is reported as a failure", async () => {
    const realFetch = global.fetch;
    global.fetch = async () => new Response("<p>Using bot: @CallMeBot_API16</p><p>Starting Telegram Audio Call.</p><p>Error: Someone reported CallMeBot as spammer. Please, add it into your contacts.</p><p>End.-</p>");
    try {
      const d = core.createDesk({ store: createMemoryStore(null), realtime: true });
      await d.load();
      await d.handle("POST", "/api/settings", { callmebotUser: "tester" });
      const r = (await d.handle("POST", "/api/test-call", {})).body.results[0];
      assert.equal(r.ok, false);
      assert.ok(/spammer/.test(r.error), r.error);
    } finally {
      global.fetch = realFetch;
    }
  });

  const store = createMemoryStore(null);
  const desk = core.createDesk({ store, realtime: false });
  await desk.load();

  await test("seeds five pairs", async () => {
    const state = desk.state();
    assert.equal(state.pairs.length, 5);
    assert.equal(state.trades.length, 0);
    assert.equal(state.setups.length, 0);
  });

  await test("adds a pair and rejects duplicates", async () => {
    let res = await desk.handle("POST", "/api/pairs", { symbol: "AUDUSD", priority: true });
    assert.equal(res.status, 200);
    assert.ok(res.body.pairs.some(p => p.symbol === "AUDUSD"));
    res = await desk.handle("POST", "/api/pairs", { symbol: "AUDUSD" });
    assert.equal(res.status, 409);
  });

  let setupId;
  await test("creates a setup and ranks it", async () => {
    const res = await desk.handle("POST", "/api/setups", {
      symbol: "EURUSD", direction: "long", entry: 1.0850,
      stop: 1.0820, target: 1.0910, priority: "high", thresholdPips: 20
    });
    assert.equal(res.status, 200);
    const setup = res.body.setups.find(s => s.symbol === "EURUSD");
    assert.ok(setup);
    setupId = setup.id;
    assert.equal(setup.rr, 2);
    assert.ok(res.body.priority.some(s => s.id === setupId));
  });

  await test("creates and closes a trade with auto P&L", async () => {
    let res = await desk.handle("POST", "/api/trades", {
      symbol: "EURUSD", direction: "long", status: "closed",
      entry: 1.08, stop: 1.075, exit: 1.09, riskAmount: 100, fees: 5,
      openedAt: "2026-01-02T10:00:00Z", closedAt: "2026-01-02T14:00:00Z"
    });
    assert.equal(res.status, 200);
    const trade = res.body.trades[0];
    assert.equal(trade.pnl, 200);
    assert.equal(trade.netPnl, 195);
    assert.equal(trade.r, 1.95);
    assert.equal(res.body.stats.wins, 1);
    assert.equal(res.body.stats.netPnl, 195);
  });

  await test("settings validation", async () => {
    const res = await desk.handle("POST", "/api/settings", {
      feed: "twelvedata", pollSeconds: 10, startingBalance: 5000
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.feed, "twelvedata");
    assert.ok(res.body.settings.pollSeconds >= 60);
    assert.equal(res.body.settings.startingBalance, 5000);
  });

  await test("import rejects junk", async () => {
    const res = await desk.handle("POST", "/api/import", { nope: true });
    assert.equal(res.status, 400);
  });

  await test("export returns database", async () => {
    const res = await desk.handle("GET", "/api/export");
    assert.equal(res.export, true);
    assert.ok(Array.isArray(res.body.trades));
  });

  console.log("\nServerless handler");

  await test("path normalisation", () => {
    assert.equal(apiPath("/api/state"), "/api/state");
    assert.equal(apiPath("/.netlify/functions/api/state"), "/api/state");
    assert.equal(apiPath("/.netlify/functions/api"), "/api");
  });

  await test("password: set, log in, lock out others, change, turn off", async () => {
    const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
    await d.load();
    assert.equal(d.authorize("/api/state", ""), true, "open until a password is set");
    let res = await d.handle("POST", "/api/auth/password", { password: "short" });
    assert.equal(res.status, 400);
    res = await d.handle("POST", "/api/auth/password", { password: "correct horse" });
    assert.equal(res.status, 200);
    assert.equal(res.body.passwordSet, true);
    const first = res.body.token;
    assert.equal(d.authorize("/api/state", ""), false);
    assert.equal(d.authorize("/api/state", "t1.bogus.sig"), false);
    assert.equal(d.authorize("/api/auth/login", ""), true);
    assert.equal(d.authorize("/api/state", first), true);
    res = await d.handle("POST", "/api/auth/login", { password: "wrong one" });
    assert.equal(res.status, 401);
    res = await d.handle("POST", "/api/auth/login", { password: "correct horse" });
    assert.equal(res.status, 200);
    const second = res.body.token;
    res = await d.handle("POST", "/api/auth/logout-all", {});
    assert.equal(d.authorize("/api/state", second), false, "other devices are signed out");
    assert.equal(d.authorize("/api/state", res.body.token), true);
    res = await d.handle("POST", "/api/auth/password", { current: "nope", password: "another pass" });
    assert.equal(res.status, 400);
    res = await d.handle("GET", "/api/export");
    assert.equal(res.body.auth, undefined, "backups never include the password");
    res = await d.handle("POST", "/api/auth/disable", { current: "correct horse" });
    assert.equal(res.body.passwordSet, false);
    assert.equal(d.authorize("/api/state", ""), true);
  });

  await test("five wrong passwords pause logins", async () => {
    const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
    await d.load();
    await d.handle("POST", "/api/auth/password", { password: "correct horse" });
    for (let i = 0; i < 5; i++) await d.handle("POST", "/api/auth/login", { password: "bad guess " + i });
    const res = await d.handle("POST", "/api/auth/login", { password: "correct horse" });
    assert.equal(res.status, 429);
  });

  await test("Netlify: app password replaces the passcode, passcode stays a master key", async () => {
    const h = createHandler({ store: createMemoryStore(null), passcode: "1234" });
    const call = (method, path, key, body) => h({ httpMethod: method, path, headers: key ? { "x-desk-key": key } : {}, body: body ? JSON.stringify(body) : undefined });
    let res = await call("POST", "/api/auth/password", "1234", { password: "correct horse" });
    assert.equal(res.statusCode, 200);
    res = await call("GET", "/api/state", "");
    assert.equal(JSON.parse(res.body).auth, "password");
    res = await call("POST", "/api/auth/login", "", { password: "correct horse" });
    const token = JSON.parse(res.body).token;
    assert.ok(token);
    assert.equal((await call("GET", "/api/state", token)).statusCode, 200);
    assert.equal((await call("GET", "/api/state", "1234")).statusCode, 200);
  });

  const mem = createMemoryStore(null);
  const handler = createHandler({ store: mem, passcode: "1234" });

  await test("rejects missing passcode", async () => {
    const res = await handler({ httpMethod: "GET", path: "/api/state", headers: {} });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).auth, "passcode");
  });

  await test("accepts passcode and returns state", async () => {
    const res = await handler({
      httpMethod: "GET", path: "/.netlify/functions/api/state",
      headers: { "x-desk-key": "1234" }
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.pairs.length, 5);
  });

  await test("mutations persist through the handler", async () => {
    const res = await handler({
      httpMethod: "POST", path: "/.netlify/functions/api/pairs",
      headers: { "x-desk-key": "1234", "content-type": "application/json" },
      body: JSON.stringify({ symbol: "NZDUSD", priority: false })
    });
    assert.equal(res.statusCode, 200);
    assert.ok(JSON.parse(res.body).pairs.some(p => p.symbol === "NZDUSD"));
    const stored = mem.read();
    assert.ok(stored.pairs.some(p => p.symbol === "NZDUSD"));
  });

  await test("invalid JSON returns an error", async () => {
    const res = await handler({
      httpMethod: "POST", path: "/api/pairs",
      headers: { "x-desk-key": "1234" }, body: "{nope"
    });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /Invalid JSON/);
  });

  console.log("\n" + passed + " checks passed.\n");
})();
