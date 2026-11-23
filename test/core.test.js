"use strict";

/**
 * Minimal test harness: core domain + serverless handler.
 * Run with: node test/core.test.js
 */

const assert = require("node:assert");
const core = require("../lib/desk-core");
const { createHandler, createMemoryStore, createMemoryBlobs, docStore, pollAll, apiPath } = require("../lib/serverless");

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

  await test("editing a setup keeps it on watch; editing a linked trade does not re-trigger it", async () => {
    const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
    await d.load();
    let res = await d.handle("POST", "/api/setups", { symbol: "EURUSD", direction: "long", entry: 1.05 });
    const id = res.body.setups.find(s => s.symbol === "EURUSD" && s.entry === 1.05).id;
    res = await d.handle("POST", "/api/setups", { id, symbol: "EURUSD", direction: "long", entry: 1.06, status: "watching" });
    assert.equal(res.body.setups.find(s => s.id === id).status, "watching");
    assert.equal(res.body.trades.filter(t => t.setupId === id).length, 0);
    res = await d.handle("POST", "/api/trades", { symbol: "EURUSD", direction: "long", entry: 1.06, setupId: id, status: "open" });
    assert.equal(res.body.setups.find(s => s.id === id).status, "triggered");
    const tradeId = res.body.trades.find(t => t.setupId === id).id;
    await d.handle("POST", "/api/setups/" + id + "/status", { status: "watching" });
    res = await d.handle("POST", "/api/trades", { id: tradeId, symbol: "EURUSD", direction: "long", entry: 1.061, setupId: id, status: "open" });
    assert.equal(res.body.setups.find(s => s.id === id).status, "watching");
  });

  await test("trade screenshots and review: save, keep on quick edits, clean up", async () => {
    const images = core.createMemoryImages();
    const d = core.createDesk({ store: createMemoryStore(null), realtime: false, images });
    await d.load();
    const png = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");
    const a = (await d.handle("POST", "/api/images", { data: png })).body.id;
    const b = (await d.handle("POST", "/api/images", { data: png })).body.id;
    assert.equal(images.size(), 2);
    assert.equal((await d.handle("POST", "/api/images", { data: "data:text/html;base64,PGI+" })).status, 400);

    let res = await d.handle("POST", "/api/trades", {
      symbol: "EURUSD", direction: "long", entry: 1.1, status: "open",
      images: JSON.stringify([{ id: a, caption: "Entry" }, { id: b }]),
      verdict: "worked", followedPlan: "yes", why: "Waited for the retest", lesson: "Be patient"
    });
    const t = res.body.trades.find(x => x.why === "Waited for the retest");
    assert.equal(t.images.length, 2);
    assert.equal(t.images[0].caption, "Entry");
    assert.equal(t.verdict, "worked");
    assert.equal(t.followedPlan, "yes");

    const file = await d.handle("GET", "/api/images/" + a);
    assert.equal(file.file.contentType, "image/png");
    assert.equal(file.file.data.toString(), "fake-png-bytes");

    // A save that does not send screenshots or the review keeps them.
    res = await d.handle("POST", "/api/trades", { id: t.id, symbol: "EURUSD", direction: "long", entry: 1.1, status: "open", notes: "edited" });
    let kept = res.body.trades.find(x => x.id === t.id);
    assert.equal(kept.images.length, 2);
    assert.equal(kept.verdict, "worked");

    // Closing with one screenshot removed deletes that file.
    res = await d.handle("POST", "/api/trades/" + t.id + "/close", { exit: 1.12, images: [{ id: a }], verdict: "mixed" });
    kept = res.body.trades.find(x => x.id === t.id);
    assert.equal(kept.images.length, 1);
    assert.equal(kept.verdict, "mixed");
    assert.equal(images.size(), 1);

    await d.handle("DELETE", "/api/trades/" + t.id);
    assert.equal(images.size(), 0);
  });

  await test("chart reminders fire once per slot, only on chosen days", async () => {
    const sent = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => { sent.push({ url: String(url), init }); return new Response("ok"); };
    try {
      const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
      await d.load();
      await d.handle("POST", "/api/settings", { ntfyTopic: "tradera-test" });
      let res = await d.handle("POST", "/api/reminders", { enabled: true, everyMinutes: 120, from: "08:00", to: "20:00", days: [1, 2, 3, 4, 5], tz: "Africa/Lagos" });
      assert.equal(res.status, 200);
      assert.ok(res.body.nextReminderAt);
      // Tuesday 17 Nov 2026, 14:05 in Lagos (13:05 UTC): the 14:00 check is due.
      assert.equal(await d.checkReminders(new Date("2026-11-17T13:05:00Z")), true);
      assert.equal(await d.checkReminders(new Date("2026-11-17T13:07:00Z")), false);
      // 14:50 is between checks; too late for 14:00, before 16:00.
      assert.equal(await d.checkReminders(new Date("2026-11-17T13:50:00Z")), false);
      // Saturday is not a chosen day.
      assert.equal(await d.checkReminders(new Date("2026-11-21T13:05:00Z")), false);
      const pushes = sent.filter(x => x.url.includes("tradera-test"));
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0].init.headers.Title, "Time to check your charts");
      assert.equal(d.state().alerts[0].kind, "reminder");
      res = await d.handle("POST", "/api/reminders", { from: "20:00", to: "08:00" });
      assert.equal(res.status, 400);
    } finally { global.fetch = realFetch; }
  });

  await test("iPhone feeds: calendar and Shortcut JSON need the feed key", async () => {
    const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
    await d.load();
    await d.handle("POST", "/api/reminders", { enabled: true, everyMinutes: 240, from: "08:00", to: "20:00", days: [1, 3, 5], tz: "Europe/London" });
    assert.equal(d.reminderFeed("ics", "anything").status, 404);
    const key = (await d.handle("POST", "/api/reminders/feed-key", {})).body.settings.feedKey;
    assert.match(key, /^[0-9a-f]{48}$/);
    const ics = d.reminderFeed("ics", key, "https://tradera.example");
    assert.equal(ics.contentType, "text/calendar; charset=utf-8");
    assert.equal((ics.text.match(/BEGIN:VEVENT/g) || []).length, 4);
    assert.ok(ics.text.includes("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"));
    assert.ok(ics.text.includes("DTSTART;TZID=Europe/London:20260105T080000"));
    assert.ok(ics.text.includes("BEGIN:VALARM"));
    const today = d.reminderFeed("json", key);
    assert.equal(today.body.list, "Tradera");
    assert.ok(Array.isArray(today.body.items));
    const rotated = (await d.handle("POST", "/api/reminders/feed-key", { rotate: true })).body.settings.feedKey;
    assert.notEqual(rotated, key);
    assert.equal(d.reminderFeed("ics", key).status, 404);
  });

  await test("setup reader: common signal formats", async () => {
    const { parseSetupText } = require("../lib/setup-reader");
    const one = t => { const r = parseSetupText(t); assert.equal(r.length, 1, t); const x = r[0]; return [x.symbol, x.direction, x.entry, x.stop, x.target]; };
    assert.deepEqual(one("XAUUSD BUY LIMIT 2345.5\nSL 2338\nTP1 2352\nTP2 2360"), ["XAUUSD", "long", 2345.5, 2338, 2352]);
    assert.deepEqual(one("Sell EUR/USD @ 1.0850, stop loss 30 pips, take profit 1.0790"), ["EURUSD", "short", 1.085, 1.088, 1.079]);
    assert.deepEqual(one("V75 (1s) buy zone 4120-4125 / sl 4100 / tp 4180"), ["1HZ75V", "long", 4125, 4100, 4180]);
    assert.deepEqual(one("GBPJPY SELL NOW 191.200\nSL: 191.800\nTP: 190.500"), ["GBPJPY", "short", 191.2, 191.8, 190.5]);
    assert.deepEqual(one("Gold sell 2,410.50 sl 2,418 tp 2,395"), ["XAUUSD", "short", 2410.5, 2418, 2395]);
    assert.deepEqual(one("US30\nEntry: 39250\nStop: 39100\nTarget: 39600"), ["US30", "long", 39250, 39100, 39600]);
    assert.deepEqual(one("Step Index 200 long from 7850.3 SL 7840 TP 7880"), ["STPRNG2", "long", 7850.3, 7840, 7880]);
    assert.deepEqual(one("Volatility 100 Index sell 1250.55 tp 1230 sl 1262"), ["R_100", "short", 1250.55, 1262, 1230]);
    const two = parseSetupText("EURUSD buy 1.0800 sl 1.0770 tp 1.0860\n\nGBPUSD sell 1.2700 sl 1.2740 tp 1.2620");
    assert.deepEqual(two.map(x => x.symbol), ["EURUSD", "GBPUSD"]);
    const bad = parseSetupText("EURUSD buy 1.0800 sl 1.0850")[0];
    assert.ok(bad.warnings.length, "a buy with the stop above entry is flagged");
    assert.equal(parseSetupText("hello there").length, 0);
  });

  await test("setup reader routes: read never saves; batch adds to the watchlist", async () => {
    const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
    await d.load();
    let res = await d.handle("POST", "/api/setups/read", { text: "NAS100 entry 18250 SL 18100 TP 18600" });
    assert.equal(res.status, 200);
    assert.equal(res.body.setups.length, 1);
    assert.equal(d.state().setups.length, 0);
    res = await d.handle("POST", "/api/setups/read", { text: "nothing useful" });
    assert.equal(res.body.setups.length, 0);
    assert.ok(res.body.problem);
    res = await d.handle("POST", "/api/setups/read", { image: "data:image/png;base64,iVBORw0KGgo=" });
    assert.equal(res.status, 400);
    assert.equal(res.body.needsText, true);
    res = await d.handle("POST", "/api/setups/batch", { setups: [
      { symbol: "NAS100", direction: "long", entry: 18250, stop: 18100, target: 18600, status: "triggered" },
      { symbol: "R_75", direction: "short", entry: 4100 }
    ] });
    assert.equal(res.status, 200);
    assert.equal(res.body.added, 2);
    assert.ok(res.body.setups.every(x => x.status === "watching"));
    assert.ok(res.body.pairs.some(x => x.symbol === "R_75"));
    res = await d.handle("POST", "/api/setups/batch", { setups: [{ symbol: "EURUSD" }] });
    assert.equal(res.status, 400);
    assert.equal(d.state().setups.length, 2);
  });

  await test("setups that hit stop or target are finished and ask to be logged", async () => {
    const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
    await d.load();
    await d.handle("POST", "/api/settings", { feed: "demo" });
    await d.handle("POST", "/api/setups", { symbol: "EURUSD", direction: "long", entry: 1.08, stop: 1.077, target: 1.086 });
    await d.handle("POST", "/api/setups", { symbol: "GBPUSD", direction: "short", entry: 1.27, stop: 1.274, target: 1.262 });
    const [a, b] = d.state().setups;
    const tick = async (sym, price) => { d._setQuote(sym, price); await d._evaluate(); };
    await tick("EURUSD", 1.0799);          // entry fills
    assert.ok(d.state().setups.find(x => x.id === a.id).entryHitAt);
    await tick("EURUSD", 1.0862);          // target
    let sa = d.state().setups.find(x => x.id === a.id);
    assert.equal(sa.outcome.result, "tp");
    assert.equal(sa.outcome.r, 2);
    assert.equal(sa.status, "done");
    assert.equal(sa.logPrompt, true);
    assert.equal(d.state().alerts[0].kind, "outcome");
    await tick("GBPUSD", 1.261);           // target hit before the sell entry filled
    const sb = d.state().setups.find(x => x.id === b.id);
    assert.equal(sb.outcome.result, "missed");
    assert.equal(sb.status, "invalidated");
    assert.ok(!sb.logPrompt);
    // Logging a trade from the setup answers the prompt.
    await d.handle("POST", "/api/trades", { symbol: "EURUSD", direction: "long", entry: 1.08, stop: 1.077, exit: 1.086, status: "closed", setupId: a.id });
    sa = d.state().setups.find(x => x.id === a.id);
    assert.equal(sa.logPrompt, false);
    assert.ok(sa.loggedTradeId);
    // "Not taken" also clears it; back to watching resets the result.
    await d.handle("POST", "/api/setups", { symbol: "XAUUSD", direction: "short", entry: 2400, stop: 2410, target: 2380 });
    const c = d.state().setups.find(x => x.symbol === "XAUUSD");
    await tick("XAUUSD", 2401); await tick("XAUUSD", 2411);
    assert.equal(d.state().setups.find(x => x.id === c.id).outcome.result, "sl");
    await d.handle("POST", "/api/setups/" + c.id + "/skip-log", {});
    assert.equal(d.state().setups.find(x => x.id === c.id).logPrompt, false);
    await d.handle("POST", "/api/setups/" + c.id + "/status", { status: "watching" });
    const back = d.state().setups.find(x => x.id === c.id);
    assert.equal(back.outcome, undefined);
    assert.equal(back.status, "watching");
  });

  await test("Pushover: emergency alarm for entries, key is checked", async () => {
    const sent = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => { sent.push({ url: String(url), body: String(init && init.body || "") }); return new Response(JSON.stringify({ status: 1 }), { status: 200 }); };
    try {
      const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
      await d.load();
      let res = await d.handle("POST", "/api/settings", { pushoverUser: "short" });
      assert.equal(res.status, 400);
      res = await d.handle("POST", "/api/settings", { pushoverUser: "u".repeat(30), pushoverToken: "a".repeat(30) });
      assert.equal(res.status, 200);
      res = await d.handle("POST", "/api/test-alert", {});
      assert.equal(res.status, 200);
      const push = sent.filter(x => x.url.includes("pushover"));
      assert.equal(push.length, 1);
      const form = new URLSearchParams(push[0].body);
      assert.equal(form.get("priority"), "2");
      assert.equal(form.get("retry"), "30");
      assert.equal(form.get("user"), "u".repeat(30));
    } finally { global.fetch = realFetch; }
  });

  await test("Tradera notifications: devices are saved, alerted, and dropped when gone", async () => {
    const pushLib = require("../lib/webpush");
    const sent = [];
    let answer = 201;
    pushLib.useWebPush({
      generateVAPIDKeys: () => ({ publicKey: "B" + "x".repeat(86), privateKey: "y".repeat(43) }),
      sendNotification: async (sub, body, opts) => {
        sent.push({ sub, body: JSON.parse(body), opts });
        if (answer !== 201) { const e = new Error("gone"); e.statusCode = answer; throw e; }
        return { statusCode: 201 };
      }
    });
    pushLib.setPushKeys(pushLib.newPushKeys());
    const d = core.createDesk({ store: createMemoryStore(null), realtime: false });
    await d.load();
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc123def456", keys: { p256dh: "B" + "p".repeat(86), auth: "a".repeat(22) } };
    let res = await d.handle("POST", "/api/push/subscribe", { subscription: { endpoint: "http://evil" } });
    assert.equal(res.status, 400);
    res = await d.handle("POST", "/api/push/subscribe", { subscription: sub, label: "iPhone (app)" });
    assert.equal(res.status, 200);
    assert.equal(res.body.push.devices.length, 1);
    assert.equal(res.body.push.devices[0].label, "iPhone (app)");
    assert.ok(!JSON.stringify(res.body.push).includes("abc123def456"), "the private address is never sent back");
    res = await d.handle("POST", "/api/push/test", {});
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.title, "Tradera test alert");
    assert.equal(sent[0].body.urgent, true);
    assert.equal(sent[0].opts.urgency, "high");
    // The phone turned notifications off: the next alert removes it.
    answer = 410;
    res = await d.handle("POST", "/api/test-alert", {});
    assert.equal(d.state().push.devices.length, 0);
    pushLib.setPushKeys(null);
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
    const h = createHandler({ accounts: false, store: createMemoryStore(null), passcode: "1234" });
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
  const handler = createHandler({ accounts: false, store: mem, passcode: "1234" });

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

  // ---------------------------------------------------------------- accounts
  const blobs = createMemoryBlobs();
  const acc = createHandler({ accounts: true, blobs });
  const call = async (method, path, data, token) => {
    const res = await acc({
      httpMethod: method, path,
      headers: token ? { "x-desk-key": token } : {},
      body: data ? JSON.stringify(data) : undefined
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  // A pre-accounts journal protected by its old app password.
  {
    const old = core.createDesk({ store: docStore(blobs, "db.json"), realtime: false });
    await old.load();
    await old.handle("POST", "/api/setups", { symbol: "GBPUSD", direction: "short", entry: 1.3, label: "old journal setup" });
    await old.handle("POST", "/api/auth/password", { password: "old-password-1" });
    await old.save(true);
  }

  await test("accounts: state needs a login", async () => {
    const res = await call("GET", "/api/state");
    assert.equal(res.status, 401);
    assert.equal(res.body.auth, "account");
    const st = await call("GET", "/api/auth/status");
    assert.equal(st.body.legacy, true);
    assert.equal(st.body.legacyNeedsPassword, true);
  });

  let ownerToken;
  await test("accounts: sign up brings the old journal only with its password", async () => {
    let res = await call("POST", "/api/auth/signup", { email: "Owner@Example.com", password: "new-password-1", legacyPassword: "wrong" });
    assert.equal(res.status, 400);
    res = await call("POST", "/api/auth/signup", { email: "Owner@Example.com", password: "new-password-1", legacyPassword: "old-password-1" });
    assert.equal(res.status, 200);
    assert.equal(res.body.broughtJournal, true);
    ownerToken = res.body.token;
    const st = await call("GET", "/api/state", null, ownerToken);
    assert.equal(st.status, 200);
    assert.equal(st.body.account.email, "owner@example.com");
    assert.ok(st.body.setups.some(s => s.label === "old journal setup"));
    assert.ok(!blobs.keys().includes("db.json"));
    assert.equal((await call("GET", "/api/auth/status")).body.legacy, false);
  });

  await test("accounts: duplicate email, bad login, good login", async () => {
    assert.equal((await call("POST", "/api/auth/signup", { email: "owner@example.com", password: "another-pass" })).status, 409);
    assert.equal((await call("POST", "/api/auth/login", { email: "owner@example.com", password: "nope-nope" })).status, 401);
    const res = await call("POST", "/api/auth/login", { email: " OWNER@example.com ", password: "new-password-1" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  await test("accounts: each account sees only its own journal", async () => {
    const res = await call("POST", "/api/auth/signup", { email: "friend@example.com", password: "maple-river-41" });
    assert.equal(res.status, 200);
    const friend = res.body.token;
    await call("POST", "/api/setups", { symbol: "USDJPY", direction: "long", entry: 150, label: "friend setup" }, friend);
    const mine = await call("GET", "/api/state", null, ownerToken);
    assert.ok(!mine.body.setups.some(s => s.label === "friend setup"));
    const theirs = await call("GET", "/api/state", null, friend);
    assert.ok(!theirs.body.setups.some(s => s.label === "old journal setup"));
    assert.ok(theirs.body.setups.some(s => s.label === "friend setup"));
  });

  await test("accounts: password change signs out other devices", async () => {
    const res = await call("POST", "/api/auth/password", { current: "new-password-1", password: "newer-password-2" }, ownerToken);
    assert.equal(res.status, 200);
    assert.equal((await call("GET", "/api/state", null, ownerToken)).status, 401);
    ownerToken = res.body.token;
    assert.equal((await call("GET", "/api/state", null, ownerToken)).status, 200);
  });

  await test("accounts: an edit made during a price check is not overwritten", async () => {
    const token = (await call("POST", "/api/auth/login", { email: "friend@example.com", password: "maple-river-41" })).body.token;
    let friendKey = null;
    for (const k of blobs.keys().filter(k => k.startsWith("accounts/db/"))) {
      const d = await blobs.get(k);
      if (d.setups.some(s => s.label === "friend setup")) friendKey = k;
    }
    // The poller loads, the user saves a setup, then the poller tries to save.
    const poller = core.createDesk({ store: docStore(blobs, friendKey), realtime: false });
    await poller.load();
    await call("POST", "/api/setups", { symbol: "EURUSD", direction: "long", entry: 1.2, label: "added mid-poll" }, token);
    let conflict = false;
    try { await poller.save(true); } catch (err) { conflict = !!err.conflict; }
    assert.equal(conflict, true);
    const snap = poller.pollSnapshot();
    await poller.load();
    poller.mergePoll(snap);
    await poller.save(true);
    const st = await call("GET", "/api/state", null, token);
    assert.ok(st.body.setups.some(s => s.label === "added mid-poll"));
    assert.ok(st.body.setups.some(s => s.label === "friend setup"));
  });

  await test("accounts: scheduled check visits every journal", async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error("offline in tests"); };
    try {
      const result = await pollAll(null, { blobs, budgetMs: 5000 });
      assert.equal(result.journals, 2);
    } finally { global.fetch = realFetch; }
  });

  await test("accounts: screenshots are private to each account", async () => {
    const tok = (await call("POST", "/api/auth/login", { email: "owner@example.com", password: "newer-password-2" })).body.token;
    const png = "data:image/png;base64," + Buffer.from("owner-shot").toString("base64");
    const up = await call("POST", "/api/images", { data: png }, tok);
    assert.equal(up.status, 200);
    const raw = await acc({ httpMethod: "GET", path: "/api/images/" + up.body.id, headers: {}, queryStringParameters: { key: tok } });
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.isBase64Encoded, true);
    assert.equal(Buffer.from(raw.body, "base64").toString(), "owner-shot");
    const signup = await call("POST", "/api/auth/signup", { email: "other@example.com", password: "quiet-harbor-7" });
    const other = await acc({ httpMethod: "GET", path: "/api/images/" + up.body.id, headers: { "x-desk-key": signup.body.token } });
    assert.equal(other.statusCode, 404);
    const anon = await acc({ httpMethod: "GET", path: "/api/images/" + up.body.id, headers: {} });
    assert.equal(anon.statusCode, 401);
  });

  await test("accounts: reminder links work without a login, only with the right key", async () => {
    const tok = (await call("POST", "/api/auth/login", { email: "owner@example.com", password: "newer-password-2" })).body.token;
    await call("POST", "/api/reminders", { enabled: true, everyMinutes: 60, from: "09:00", to: "11:00", days: [0, 1, 2, 3, 4, 5, 6], tz: "UTC" }, tok);
    const st = await call("POST", "/api/reminders/feed-key", {}, tok);
    const { id } = st.body.account;
    const key = st.body.settings.feedKey;
    const ics = await acc({ httpMethod: "GET", path: "/api/reminders/calendar.ics", rawUrl: "https://t.example/api/reminders/calendar.ics", headers: {}, queryStringParameters: { u: id, k: key } });
    assert.equal(ics.statusCode, 200);
    assert.equal((ics.body.match(/BEGIN:VEVENT/g) || []).length, 3);
    const bad = await acc({ httpMethod: "GET", path: "/api/reminders/today.json", headers: {}, queryStringParameters: { u: id, k: "0".repeat(48) } });
    assert.equal(bad.statusCode, 404);
    const json = await acc({ httpMethod: "GET", path: "/api/reminders/today.json", headers: {}, queryStringParameters: { u: id, k: key } });
    assert.equal(json.statusCode, 200);
    assert.equal(JSON.parse(json.body).list, "Tradera");
  });

  await test("accounts: every request opens its own Blobs connection (no expired tokens)", async () => {
    const mem = createMemoryBlobs();
    let opened = 0;
    const h = createHandler({ accounts: true, getStore: () => { opened++; return mem; } });
    const ev = { httpMethod: "GET", path: "/api/auth/status", headers: {} };
    assert.equal((await h(ev)).statusCode, 200);
    assert.equal((await h(ev)).statusCode, 200);
    assert.equal(opened, 2);
  });

  await test("accounts: reading chart pictures with AI is Pro only", async () => {
    const tok = (await call("POST", "/api/auth/login", { email: "owner@example.com", password: "newer-password-2" })).body.token;
    const img = "data:image/png;base64,iVBORw0KGgo=";
    let res = await call("POST", "/api/setups/read", { image: img }, tok);
    assert.equal(res.status, 402);
    assert.equal(res.body.pro, true);
    res = await call("POST", "/api/setups/read", { text: "EURUSD buy 1.08 sl 1.07 tp 1.1" }, tok);
    assert.equal(res.status, 200);
    process.env.TRADERA_PRO_EMAILS = "someone@else.com, OWNER@example.com";
    try {
      res = await call("POST", "/api/setups/read", { image: img }, tok);
      assert.notEqual(res.status, 402);
      const st = await call("GET", "/api/state", null, tok);
      assert.equal(st.body.plan, "pro");
    } finally { delete process.env.TRADERA_PRO_EMAILS; }
  });

  await test("accounts: closed sign-ups and account deletion", async () => {
    const closed = createHandler({ accounts: true, blobs, signups: false });
    const res = await closed({ httpMethod: "POST", path: "/api/auth/signup", headers: {}, body: JSON.stringify({ email: "x@example.com", password: "xxxxxxxx1" }) });
    assert.equal(res.statusCode, 403);
    const login = await call("POST", "/api/auth/login", { email: "friend@example.com", password: "maple-river-41" });
    assert.equal((await call("POST", "/api/auth/delete", { current: "wrong" }, login.body.token)).status, 400);
    assert.equal((await call("POST", "/api/auth/delete", { current: "maple-river-41" }, login.body.token)).status, 200);
    assert.equal((await call("POST", "/api/auth/login", { email: "friend@example.com", password: "maple-river-41" })).status, 401);
  });

  // ------------------------------------------------------------ admin
  console.log("\nAdmin and security");
  const secu = require("../lib/security");
  const ab = createMemoryBlobs();
  const ah = createHandler({ accounts: true, blobs: ab });
  let ipN = 0;
  const areq = async (method, path, data, opts) => {
    const o = opts || {};
    const headers = { "x-nf-client-connection-ip": o.ip || "10.0.0.1" };
    if (o.token) headers["x-desk-key"] = o.token;
    if (o.admin) headers["x-admin-token"] = o.admin;
    const res = await ah({ httpMethod: method, path, headers, body: data ? JSON.stringify(data) : undefined });
    return { status: res.statusCode, body: JSON.parse(res.body || "{}"), headers: res.headers };
  };
  const ADMIN = "boss@example.com";
  const APW = "granite-ladder-river-9";
  let totpSecret = null;
  // Each code may be used once, so move a fake clock 30 seconds on for every new code.
  const realNow = Date.now;
  let clockShift = 0;
  Date.now = () => realNow() + clockShift;
  const freshCode = () => { clockShift += 30000; return secu.totpAt(totpSecret, Math.floor(Date.now() / 30000)); };
  let adminToken = null;
  let recovery = null;

  await test("security: weak and personal passwords are refused at sign-up", async () => {
    assert.equal((await areq("POST", "/api/auth/signup", { email: "a1@example.com", password: "password123" }, { ip: "1.1.1.1" })).status, 400);
    assert.equal((await areq("POST", "/api/auth/signup", { email: "carolina@example.com", password: "carolina-2026!" }, { ip: "1.1.1.1" })).status, 400);
    assert.equal((await areq("POST", "/api/auth/signup", { email: "a1@example.com", password: "short1" }, { ip: "1.1.1.1" })).status, 400);
  });

  await test("security: 5 sign-ups per IP per hour", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await areq("POST", "/api/auth/signup", { email: "spam" + i + "@example.com", password: "tidal-orchard-55" }, { ip: "6.6.6.6" });
      assert.equal(r.status, 200, "signup " + i);
    }
    assert.equal((await areq("POST", "/api/auth/signup", { email: "spam9@example.com", password: "tidal-orchard-55" }, { ip: "6.6.6.6" })).status, 429);
  });

  await test("security: wrong passwords lock the email, same answer for unknown emails", async () => {
    const a = await areq("POST", "/api/auth/login", { email: "spam0@example.com", password: "nope-nope-1" }, { ip: "7.7.7.1" });
    const b = await areq("POST", "/api/auth/login", { email: "nobody-here@example.com", password: "nope-nope-1" }, { ip: "7.7.7.1" });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.body.error, b.body.error);
    for (let i = 0; i < 4; i++) await areq("POST", "/api/auth/login", { email: "spam0@example.com", password: "nope-" + i }, { ip: "7.7.7." + (i + 2) });
    // Locked even with the right password, from a fresh IP.
    assert.equal((await areq("POST", "/api/auth/login", { email: "spam0@example.com", password: "tidal-orchard-55" }, { ip: "8.8.8.8" })).status, 429);
  });

  await test("security: password change limits wrong current-password guesses", async () => {
    const tok = (await areq("POST", "/api/auth/login", { email: "spam1@example.com", password: "tidal-orchard-55" }, { ip: "9.9.9.9" })).body.token;
    for (let i = 0; i < 4; i++) assert.equal((await areq("POST", "/api/auth/password", { current: "guess-" + i, password: "brand-new-pass-1" }, { token: tok })).status, 400);
    assert.equal((await areq("POST", "/api/auth/password", { current: "guess-x", password: "brand-new-pass-1" }, { token: tok })).status, 429);
    assert.equal((await areq("POST", "/api/auth/password", { current: "tidal-orchard-55", password: "brand-new-pass-1" }, { token: tok })).status, 429);
  });

  await test("admin: switched off until TRADERA_ADMIN_EMAILS is set", async () => {
    delete process.env.TRADERA_ADMIN_EMAILS;
    assert.equal((await areq("POST", "/api/admin/login", { email: ADMIN, password: APW })).status, 404);
  });

  await test("admin: two-step setup works without a setup code, and checks it when one is set", async () => {
    process.env.TRADERA_ADMIN_EMAILS = ADMIN;
    assert.equal((await areq("POST", "/api/auth/signup", { email: ADMIN, password: APW }, { ip: "2.2.2.2" })).status, 200);
    let r = await areq("POST", "/api/admin/login", { email: ADMIN, password: APW }, { ip: "3.3.3.1" });
    assert.equal(r.body.needsSetup, true);
    assert.equal(r.body.needsSetupCode, false);
    r = await areq("POST", "/api/admin/setup", { step: "start", email: ADMIN, password: APW }, { ip: "3.3.3.1" });
    assert.equal(r.status, 200, "no code needed when none is set");
    assert.equal((await areq("POST", "/api/admin/setup", { step: "start", email: ADMIN, password: "wrong-password-1" }, { ip: "3.3.3.1" })).status, 401);
    process.env.TRADERA_ADMIN_SETUP_CODE = "owner-only-setup-code-77";
    assert.equal((await areq("POST", "/api/admin/login", { email: ADMIN, password: APW }, { ip: "3.3.3.4" })).body.needsSetupCode, true);
    r = await areq("POST", "/api/admin/setup", { step: "start", email: ADMIN, password: APW, setupCode: "wrong-code" }, { ip: "3.3.3.2" });
    assert.equal(r.status, 401);
    r = await areq("POST", "/api/admin/setup", { step: "start", email: ADMIN, password: APW, setupCode: "owner-only-setup-code-77" }, { ip: "3.3.3.3" });
    assert.equal(r.status, 200);
    assert.match(r.body.secret, /^[A-Z2-7]{32}$/);
    assert.ok(r.body.uri.startsWith("otpauth://totp/"));
    totpSecret = r.body.secret;
    r = await areq("POST", "/api/admin/setup", { step: "confirm", email: ADMIN, password: APW, setupCode: "owner-only-setup-code-77", code: freshCode() }, { ip: "3.3.3.3" });
    assert.equal(r.status, 200);
    assert.equal(r.body.recoveryCodes.length, 8);
    recovery = r.body.recoveryCodes;
    // The secret is never stored in plain text.
    const raw = JSON.stringify(await ab.get("accounts/users/" + require("crypto").createHash("sha256").update(ADMIN).digest("hex").slice(0, 40) + ".json", { type: "json" }));
    assert.ok(!raw.includes(totpSecret));
    assert.ok(!raw.includes(recovery[0]));
  });

  await test("admin: sign-in needs password AND a fresh code; codes can't be replayed", async () => {
    let r = await areq("POST", "/api/admin/login", { email: ADMIN, password: APW, code: "" }, { ip: "4.4.4.1" });
    assert.equal(r.status, 401);
    const code = freshCode();
    r = await areq("POST", "/api/admin/login", { email: ADMIN, password: APW, code }, { ip: "4.4.4.2" });
    assert.equal(r.status, 200);
    adminToken = r.body.token;
    r = await areq("POST", "/api/admin/login", { email: ADMIN, password: APW, code }, { ip: "4.4.4.3" });
    assert.equal(r.status, 401, "same code twice");
    // A normal app login token is not an admin token, and vice versa.
    const appTok = (await areq("POST", "/api/auth/login", { email: ADMIN, password: APW }, { ip: "4.4.4.4" })).body.token;
    assert.equal((await areq("GET", "/api/admin/overview", null, { admin: appTok })).status, 401);
    assert.equal((await areq("GET", "/api/state", null, { token: adminToken })).status, 401);
    assert.equal((await areq("GET", "/api/admin/overview", null, { admin: adminToken })).status, 200);
  });

  await test("admin: non-admins get the same answer and are locked after 3 tries", async () => {
    const r1 = await areq("POST", "/api/admin/login", { email: "spam2@example.com", password: "tidal-orchard-55", code: "123456" }, { ip: "5.5.5.1" });
    assert.equal(r1.status, 401);
    assert.equal(r1.body.error, "Email, password or code is not correct.");
    await areq("POST", "/api/admin/login", { email: "spam2@example.com", password: "x" }, { ip: "5.5.5.2" });
    const r3 = await areq("POST", "/api/admin/login", { email: "spam2@example.com", password: "y" }, { ip: "5.5.5.3" });
    assert.equal(r3.status, 429);
  });

  await test("admin: one recovery code works exactly once", async () => {
    let r = await areq("POST", "/api/admin/login", { email: ADMIN, password: APW, code: recovery[0] }, { ip: "4.4.5.1" });
    assert.equal(r.status, 200);
    assert.equal(r.body.recoveryLeft, 7);
    r = await areq("POST", "/api/admin/login", { email: ADMIN, password: APW, code: recovery[0] }, { ip: "4.4.5.2" });
    assert.equal(r.status, 401);
    adminToken = (await areq("POST", "/api/admin/login", { email: ADMIN, password: APW, code: freshCode() }, { ip: "4.4.5.3" })).body.token;
  });

  await test("admin: feature switches and maintenance reach users", async () => {
    const uTok = (await areq("POST", "/api/auth/login", { email: "spam3@example.com", password: "tidal-orchard-55" }, { ip: "11.0.0.1" })).body.token;
    let r = await areq("POST", "/api/admin/config", { features: { pasteImport: false, signups: false }, announcement: "Hello traders" }, { admin: adminToken });
    assert.equal(r.status, 200);
    assert.equal((await areq("POST", "/api/setups/read", { text: "EURUSD buy 1.08" }, { token: uTok })).status, 403);
    const st = await areq("GET", "/api/state", null, { token: uTok });
    assert.equal(st.body.features.pasteImport, false);
    assert.equal(st.body.announcement, "Hello traders");
    assert.equal((await areq("GET", "/api/auth/status")).body.signups, false);
    assert.equal((await areq("POST", "/api/auth/signup", { email: "late@example.com", password: "tidal-orchard-55" }, { ip: "12.0.0.1" })).status, 403);
    r = await areq("POST", "/api/admin/config", { maintenance: { enabled: true, message: "Back at 2pm" } }, { admin: adminToken });
    const down = await areq("GET", "/api/state", null, { token: uTok });
    assert.equal(down.status, 503);
    assert.equal(down.body.error, "Back at 2pm");
    assert.equal((await areq("GET", "/api/auth/status")).body.maintenance.message, "Back at 2pm");
    assert.equal((await areq("GET", "/api/admin/overview", null, { admin: adminToken })).status, 200, "admin still works");
    await areq("POST", "/api/admin/config", { features: { pasteImport: true, signups: true }, maintenance: { enabled: false, message: "" }, announcement: "" }, { admin: adminToken });
    assert.equal((await areq("GET", "/api/state", null, { token: uTok })).status, 200);
  });

  await test("admin: users can be made Pro, disabled and deleted (delete needs email + code)", async () => {
    const list = (await areq("GET", "/api/admin/users", null, { admin: adminToken })).body.users;
    const u = list.find(x => x.email === "spam4@example.com");
    assert.ok(u && !("hash" in u) && !("salt" in u));
    let r = await areq("POST", "/api/admin/users/action", { ek: u.ek, action: "plan", plan: "pro" }, { admin: adminToken });
    assert.equal(r.body.user.plan, "pro");
    const uTok = (await areq("POST", "/api/auth/login", { email: u.email, password: "tidal-orchard-55" }, { ip: "13.0.0.1" })).body.token;
    assert.equal((await areq("GET", "/api/state", null, { token: uTok })).body.plan, "pro");
    await areq("POST", "/api/admin/users/action", { ek: u.ek, action: "disable" }, { admin: adminToken });
    assert.equal((await areq("GET", "/api/state", null, { token: uTok })).status, 401, "signed out");
    assert.equal((await areq("POST", "/api/auth/login", { email: u.email, password: "tidal-orchard-55" }, { ip: "13.0.0.2" })).status, 403);
    await areq("POST", "/api/admin/users/action", { ek: u.ek, action: "enable" }, { admin: adminToken });
    assert.equal((await areq("POST", "/api/auth/login", { email: u.email, password: "tidal-orchard-55" }, { ip: "13.0.0.3" })).status, 200);
    r = await areq("POST", "/api/admin/users/action", { ek: u.ek, action: "delete", confirmEmail: "wrong@example.com", code: freshCode() }, { admin: adminToken });
    assert.equal(r.status, 400);
    r = await areq("POST", "/api/admin/users/action", { ek: u.ek, action: "delete", confirmEmail: u.email, code: "000000" }, { admin: adminToken });
    assert.equal(r.status, 401);
    r = await areq("POST", "/api/admin/users/action", { ek: u.ek, action: "delete", confirmEmail: u.email, code: freshCode() }, { admin: adminToken });
    assert.equal(r.status, 200);
    assert.equal((await areq("POST", "/api/auth/login", { email: u.email, password: "tidal-orchard-55" }, { ip: "13.0.0.4" })).status, 401);
    const me = list.find(x => x.email === ADMIN);
    assert.equal((await areq("POST", "/api/admin/users/action", { ek: me.ek, action: "disable" }, { admin: adminToken })).status, 400);
    const log = (await areq("GET", "/api/admin/audit", null, { admin: adminToken })).body.audit;
    assert.ok(log.some(a => a.action === "delete-user" && a.target === u.email));
    assert.ok(log.some(a => a.action === "login-failed"));
  });

  await test("admin: password change needs current password + code and ends old sessions", async () => {
    const appTok = (await areq("POST", "/api/auth/login", { email: ADMIN, password: APW }, { ip: "14.0.0.1" })).body.token;
    assert.equal((await areq("POST", "/api/auth/password", { current: APW, password: "another-long-pass-9" }, { token: appTok })).status, 403, "not from the app");
    let r = await areq("POST", "/api/admin/password", { current: APW, password: "another-long-pass-9", code: "000000" }, { admin: adminToken });
    assert.equal(r.status, 401);
    r = await areq("POST", "/api/admin/password", { current: APW, password: "short-pass", code: freshCode() }, { admin: adminToken });
    assert.equal(r.status, 400);
    r = await areq("POST", "/api/admin/password", { current: APW, password: "another-long-pass-9", code: freshCode() }, { admin: adminToken });
    assert.equal(r.status, 200);
    const newAdmin = r.body.token;
    assert.equal((await areq("GET", "/api/admin/overview", null, { admin: adminToken })).status, 401, "old admin session ended");
    assert.equal((await areq("GET", "/api/state", null, { token: appTok })).status, 401, "app signed out");
    assert.equal((await areq("GET", "/api/admin/overview", null, { admin: newAdmin })).status, 200);
    assert.equal((await areq("POST", "/api/admin/logout", {}, { admin: newAdmin })).status, 200);
    assert.equal((await areq("GET", "/api/admin/overview", null, { admin: newAdmin })).status, 401, "logged out");
    // Removing the email from the admin list cuts access straight away.
    const t2 = (await areq("POST", "/api/admin/login", { email: ADMIN, password: "another-long-pass-9", code: freshCode() }, { ip: "14.0.0.2" })).body.token;
    process.env.TRADERA_ADMIN_EMAILS = "someone-else@example.com";
    assert.equal((await areq("GET", "/api/admin/overview", null, { admin: t2 })).status, 401);
    delete process.env.TRADERA_ADMIN_EMAILS;
    delete process.env.TRADERA_ADMIN_SETUP_CODE;
  });
  Date.now = realNow;

  console.log("\n" + passed + " checks passed.\n");
})();
