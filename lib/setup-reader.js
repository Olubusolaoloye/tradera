"use strict";

/**
 * Setup reader: turns a pasted trade signal (or the text read from a
 * screenshot) into setups Tradera can watch.
 *
 *   "XAUUSD BUY LIMIT 2345.5  SL 2338  TP1 2352 TP2 2360"
 *   "Sell EUR/USD @ 1.0850, stop loss 30 pips, take profit 1.0790"
 *   "V75 (1s) buy zone 4120-4125 / sl 4100 / tp 4180"
 *
 * Chart screenshots (lines drawn on a chart, no written numbers) need an AI
 * that can see the picture. That is optional: set ANTHROPIC_API_KEY and
 * readImageWithAI() asks Claude to read the setup off the chart.
 */

const FX = ["EUR", "GBP", "USD", "JPY", "CHF", "AUD", "CAD", "NZD", "MXN", "PLN", "ZAR", "SEK", "NOK", "SGD", "HKD", "TRY"];

// Order matters: longer / more specific names first.
const NAMED = [
  [/\b(?:XAU\s*\/?\s*USD|GOLD|XAU)\b/, "XAUUSD"],
  [/\b(?:XAG\s*\/?\s*USD|SILVER|XAG)\b/, "XAGUSD"],
  [/\b(?:US\s*30|DJ\s*30|DJI|DOW(?:\s*JONES)?|WALL\s*ST(?:REET)?(?:\s*30)?)\b/, "US30"],
  [/\b(?:NAS\s*100|NAS|USTEC|US\s*TECH(?:\s*100)?|NASDAQ(?:\s*100)?|NDX|US\s*100)\b/, "NAS100"],
  [/\b(?:SPX\s*500|US\s*500|SPX|SP\s*500)\b|S&P\s*500/, "SPX500"],
  [/\b(?:GER\s*40|GER\s*30|DE\s*40|DE\s*30|DAX(?:\s*40)?)\b/, "GER40"],
  [/\b(?:UK\s*100|FTSE(?:\s*100)?)\b/, "UK100"],
  [/\b(?:JP\s*225|JPN\s*225|NIKKEI(?:\s*225)?)\b/, "JP225"],
  [/\b(?:BTC\s*\/?\s*USDT?|BITCOIN|BTC)\b/, "BTCUSD"],
  [/\b(?:ETH\s*\/?\s*USDT?|ETHEREUM|ETH)\b/, "ETHUSD"]
];

const NUM = "(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?)";

function toNumber(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pipOf(symbol) {
  const s = String(symbol || "");
  if (/^STPRNG/.test(s)) return 0.1;
  if (/^(R_|1HZ)/.test(s)) return 1;
  if (/XAU/.test(s)) return 0.1;
  if (/XAG/.test(s)) return 0.01;
  if (/JPY/.test(s)) return 0.01;
  if (/BTC|ETH|US30|NAS100|SPX500|GER40|UK100|JP225/.test(s)) return 1;
  return 0.0001;
}

/** Every market named in the text, with where it was found. */
function findSymbols(upper, known) {
  const hits = [];
  const add = (index, length, symbol) => {
    if (!hits.some(h => index < h.index + h.length && h.index < index + length)) hits.push({ index, length, symbol });
  };

  // Deriv volatility indices: V75, VIX 75, Volatility 75 (1s) Index, 1HZ75V, R_75.
  const vol = /\b(?:VOLATILITY|VIX|VOL|V)\s*(10|15|25|30|50|75|90|100)\b(\s*(?:\(\s*1\s*S\s*\)|1\s*S\b))?(?:\s*INDEX)?(\s*\(\s*1\s*S\s*\))?/g;
  let m;
  while ((m = vol.exec(upper))) {
    const n = m[1];
    const oneSec = !!(m[2] || m[3]) || ["15", "30", "90"].includes(n);
    add(m.index, m[0].length, oneSec ? "1HZ" + n + "V" : "R_" + n);
  }
  const code = /\b(1HZ(?:10|15|25|30|50|75|90|100)V|R_(?:10|25|50|75|100))\b/g;
  while ((m = code.exec(upper))) add(m.index, m[0].length, m[1]);

  // Step indices: Step 200, Step Index 300, STPRNG2.
  const step = /\b(?:STEP\s*(?:INDEX)?\s*(100|200|300|400|500)?|STPRNG([2-5])?)\b/g;
  while ((m = step.exec(upper))) {
    const level = m[1] ? Number(m[1]) / 100 : m[2] ? Number(m[2]) : 1;
    add(m.index, m[0].length, level > 1 ? "STPRNG" + level : "STPRNG");
  }

  // Forex: EURUSD, EUR/USD, EUR-USD, EUR USD.
  const fx = new RegExp("\\b(" + FX.join("|") + ")\\s*[\\/\\-]?\\s*(" + FX.join("|") + ")\\b", "g");
  while ((m = fx.exec(upper))) {
    if (m[1] !== m[2]) add(m.index, m[0].length, m[1] + m[2]);
  }

  for (const [re, symbol] of NAMED) {
    const g = new RegExp(re.source, "g");
    while ((m = g.exec(upper))) add(m.index, m[0].length, symbol);
  }

  // Anything already on the user's own market list (custom symbols).
  (known || []).forEach(sym => {
    const s = String(sym || "").toUpperCase();
    if (!s || s.length < 3) return;
    const g = new RegExp("\\b" + s.replace(/[^A-Z0-9]/g, c => "\\" + c) + "\\b", "g");
    while ((m = g.exec(upper))) add(m.index, m[0].length, s);
  });

  return hits.sort((a, b) => a.index - b.index);
}

function directionOf(upper) {
  const buy = upper.search(/\b(BUY|LONG|BULLISH|BUYING|CALL)\b/);
  const sell = upper.search(/\b(SELL|SHORT|BEARISH|SELLING|PUT)\b/);
  if (buy < 0 && sell < 0) return null;
  if (buy < 0) return "short";
  if (sell < 0) return "long";
  return buy < sell ? "long" : "short";
}

/** Read one setup from one block of text (one market). */
function readChunk(chunk, symbol) {
  const upper = chunk.toUpperCase().replace(/[–—−]/g, "-").replace(/\s+/g, " ");
  const used = [];
  const take = (re, flags) => {
    const out = [];
    const g = new RegExp(re, flags || "g");
    let m;
    while ((m = g.exec(upper))) {
      out.push(m);
      used.push([m.index, m.index + m[0].length]);
    }
    return out;
  };

  const notes = [];
  let direction = directionOf(upper);

  // Stop loss (not "BUY STOP 1.08", which is an order type). May be in pips.
  let stop = null;
  let stopPips = null;
  const sl = take("(?<!BUY |SELL )\\b(?:SL|S\\/L|STOP\\s*LOSS|STOPLOSS|STOP|INVALIDATION)\\b\\s*(?:AT|@|[:=\\-])?\\s*" + NUM + "(\\s*(?:PIPS?|PTS|POINTS))?");
  if (sl.length) {
    if (sl[0][2]) stopPips = toNumber(sl[0][1]);
    else stop = toNumber(sl[0][1]);
  }

  // Take profits: first one is the target, the rest go in the note.
  const targets = [];
  take("\\b(?:TP|T\\/P|TAKE\\s*PROFIT|TARGET|TGT)\\s*(?:\\d(?:\\s+|\\s*[:=\\-@)]\\s*))?(?:AT|@|[:=\\-])?\\s*" + NUM + "(?!\\s*(?:PIPS?|PTS|POINTS))").forEach(m => {
    const v = toNumber(m[1]);
    if (v !== null && !targets.includes(v)) targets.push(v);
  });

  // Entry: "entry 1.0850", "@ 1.0850", "buy limit 1.0850", "sell zone 2345-2350".
  let entry = null;
  let zone = null;
  let orderType = null;
  const entryRe = "\\b(?:ENTRY(?:\\s*PRICE|\\s*ZONE)?|ENTER|OPEN(?:ED)?(?:\\s*PRICE)?|PRICE|BUY|SELL|LONG|SHORT)\\b" +
    "(?:\\s*(LIMIT|STOP|NOW|MARKET|ZONE|AREA|FROM|AT|@))*\\s*(?:[:=@\\-]\\s*)?" + NUM + "(?:\\s*(?:-|TO|\\/|~)\\s*" + NUM + ")?";
  const em = take(entryRe);
  const pickZone = (a, b) => {
    zone = [Math.min(a, b), Math.max(a, b)];
    // A buy zone is usually below price (touched first at its top); a sell zone above.
    return direction === "short" ? zone[0] : zone[1];
  };
  if (em.length) {
    const m = em[0];
    orderType = m[1] || null;
    const a = toNumber(m[2]);
    const b = toNumber(m[3]);
    entry = a !== null && b !== null && b !== a ? pickZone(a, b) : a;
  }
  if (entry === null) {
    const at = take("@\\s*" + NUM);
    if (at.length) entry = toNumber(at[0][1]);
  }
  if (entry === null) {
    // Fall back to the first number not already used as a stop or target.
    const g = new RegExp(NUM, "g");
    let m;
    while ((m = g.exec(upper))) {
      const inside = used.some(([s, e]) => m.index >= s && m.index < e);
      const before = upper.slice(Math.max(0, m.index - 6), m.index);
      if (inside || /(TP|SL|R:|RR)\s*$/.test(before) || /[A-Z_]$/.test(before)) continue;
      const v = toNumber(m[1]);
      if (v !== null && !(symbol && String(symbol).includes(String(m[1])))) { entry = v; break; }
    }
  }

  if (stopPips !== null && entry !== null && symbol) {
    const dir = direction || (targets[0] !== undefined ? (targets[0] > entry ? "long" : "short") : null);
    if (dir) stop = +(dir === "long" ? entry - stopPips * pipOf(symbol) : entry + stopPips * pipOf(symbol)).toFixed(6);
    notes.push("Stop: " + stopPips + " pips");
  }

  // Work out the direction from the levels when the text doesn't say.
  if (!direction && entry !== null) {
    if (stop !== null && stop !== entry) direction = stop < entry ? "long" : "short";
    else if (targets.length) direction = targets[0] > entry ? "long" : "short";
  }
  if (zone && direction) entry = direction === "short" ? zone[0] : zone[1];

  const warnings = [];
  if (direction && entry !== null) {
    if (stop !== null && (direction === "long" ? stop >= entry : stop <= entry)) warnings.push("The stop is on the wrong side of the entry for a " + (direction === "long" ? "buy" : "sell") + ".");
    if (targets.length && (direction === "long" ? targets[0] <= entry : targets[0] >= entry)) warnings.push("The target is on the wrong side of the entry for a " + (direction === "long" ? "buy" : "sell") + ".");
  }

  if (zone) notes.push("Entry zone " + zone[0] + " – " + zone[1]);
  if (orderType && !["AT", "@", "FROM", "ZONE", "AREA"].includes(orderType)) notes.push("Order: " + orderType.toLowerCase());
  if (targets.length > 1) notes.push("More targets: " + targets.slice(1).map((t, i) => "TP" + (i + 2) + " " + t).join(", "));

  const missing = [];
  if (!symbol) missing.push("pair");
  if (entry === null) missing.push("entry");
  if (!direction) missing.push("direction");

  return {
    symbol: symbol || "",
    direction: direction || "long",
    directionGuessed: !direction,
    entry,
    stop,
    target: targets.length ? targets[0] : null,
    note: notes.join(" · "),
    missing,
    warnings
  };
}

/**
 * Read every setup in a block of text. Each named market starts a new setup;
 * text before the first market belongs to the first one.
 */
function parseSetupText(text, options) {
  const opts = options || {};
  const raw = String(text || "").replace(/\r/g, "").slice(0, 20000);
  if (!raw.trim()) return [];
  const upper = raw.toUpperCase();
  const hits = findSymbols(upper, opts.known);

  const chunks = [];
  if (!hits.length) {
    chunks.push({ text: raw, symbol: "" });
  } else {
    // The same market named twice in a row (heading + body) is one setup.
    const starts = hits.filter((h, i) => i === 0 || h.symbol !== hits[i - 1].symbol || /\n\s*\n/.test(raw.slice(hits[i - 1].index, h.index)));
    starts.forEach((h, i) => {
      const from = i === 0 ? 0 : h.index;
      const to = i + 1 < starts.length ? starts[i + 1].index : raw.length;
      chunks.push({ text: raw.slice(from, to), symbol: h.symbol });
    });
  }

  return chunks
    .map(c => {
      const setup = readChunk(c.text, c.symbol);
      const firstLine = c.text.trim().split("\n").find(l => l.trim()) || "";
      setup.label = firstLine.trim().slice(0, 80);
      setup.source = c.text.trim().slice(0, 600);
      return setup;
    })
    // Drop chunks that are clearly not a setup (no price at all).
    .filter(s => s.entry !== null || s.stop !== null || s.target !== null)
    .slice(0, 20);
}

// ------------------------------------------------------------------ AI reader

let AnthropicSDK = null;
/** The Netlify function imports the SDK itself so the bundler ships it. */
function useAnthropic(sdk) { AnthropicSDK = sdk && (sdk.default || sdk); }
function loadSDK() {
  if (AnthropicSDK) return AnthropicSDK;
  try {
    const sdk = require("@anthropic-ai/sdk");
    AnthropicSDK = sdk.default || sdk;
  } catch (_) { AnthropicSDK = null; }
  return AnthropicSDK;
}
function aiAvailable() {
  return !!String(process.env.ANTHROPIC_API_KEY || "").trim() && !!loadSDK();
}

const AI_MODEL = () => String(process.env.TRADERA_AI_MODEL || "").trim() || "claude-opus-5-5";

const SETUP_SCHEMA = {
  type: "object",
  properties: {
    setups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          market: { type: "string", description: "Market as written or shown, e.g. EURUSD, XAUUSD, Volatility 75 (1s) Index, Step Index 200, US30" },
          direction: { type: "string", enum: ["buy", "sell", "unknown"] },
          entry: { type: ["number", "null"] },
          stop_loss: { type: ["number", "null"] },
          take_profits: { type: "array", items: { type: "number" } },
          timeframe: { type: ["string", "null"] },
          summary: { type: "string", description: "One short sentence: what the setup is (e.g. 'Buy the retest of the broken 1.0850 resistance')." }
        },
        required: ["market", "direction", "entry", "stop_loss", "take_profits", "timeframe", "summary"],
        additionalProperties: false
      }
    },
    problem: { type: ["string", "null"], description: "If no setup could be read, say why in one sentence; otherwise null." }
  },
  required: ["setups", "problem"],
  additionalProperties: false
};

const AI_PROMPT =
  "This is a screenshot a trader saved of a trade setup: a chart (often TradingView or MetaTrader, maybe with a " +
  "long/short position tool, horizontal lines or labels) or a written trade signal. Read the setup(s) it shows.\n" +
  "- entry, stop_loss and take_profits must be prices read from the image: price-axis labels, line labels, position-tool " +
  "boxes or written text. Never invent a price you cannot read; use null instead.\n" +
  "- With a long/short position tool, the boundary between the two boxes is the entry, the red box's far edge is the stop " +
  "and the green box's far edge is the target.\n" +
  "- direction is buy when the target is above the entry, sell when it is below.\n" +
  "- market: the symbol in the chart title or the signal text.\n" +
  "If the image does not show a trade setup, return an empty setups list and explain in problem.";

/**
 * Ask Claude to read a setup from an image. Returns parseSetupText-shaped
 * setups. Throws a plain-English Error when it can't.
 */
async function readImageWithAI(base64, mediaType, options) {
  const opts = options || {};
  const SDK = loadSDK();
  if (!SDK || !String(process.env.ANTHROPIC_API_KEY || "").trim()) {
    throw new Error("Chart reading is not switched on (no ANTHROPIC_API_KEY).");
  }
  const client = new SDK({ timeout: opts.timeoutMs || 25000, maxRetries: 0 });
  let response;
  try {
    response = await client.beta.messages.create({
      model: AI_MODEL(),
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SETUP_SCHEMA }
      },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: AI_PROMPT }
        ]
      }]
    });
  } catch (err) {
    if (SDK.AuthenticationError && err instanceof SDK.AuthenticationError) throw new Error("The AI key (ANTHROPIC_API_KEY) was refused. Check it in your Netlify settings.");
    if (SDK.RateLimitError && err instanceof SDK.RateLimitError) throw new Error("The chart reader is busy. Try again in a minute.");
    if (SDK.APIConnectionTimeoutError && err instanceof SDK.APIConnectionTimeoutError) throw new Error("Reading the chart took too long. Try a smaller, cropped screenshot.");
    if (SDK.APIError && err instanceof SDK.APIError) throw new Error("The chart reader failed (" + (err.status || "error") + "). Try again.");
    throw new Error("Could not reach the chart reader: " + (err && err.message ? err.message : "network error"));
  }
  if (response.stop_reason === "refusal") throw new Error("The chart reader declined this image.");
  const text = (response.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error("The chart reader gave an answer Tradera couldn't understand. Try again."); }

  const setups = (data.setups || []).map(s => {
    const found = findSymbols(String(s.market || "").toUpperCase(), opts.known);
    const symbol = found.length ? found[0].symbol : String(s.market || "").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 24);
    const tps = (s.take_profits || []).filter(n => Number.isFinite(n) && n > 0);
    const entry = Number.isFinite(s.entry) && s.entry > 0 ? s.entry : null;
    const stop = Number.isFinite(s.stop_loss) && s.stop_loss > 0 ? s.stop_loss : null;
    let direction = s.direction === "buy" ? "long" : s.direction === "sell" ? "short" : null;
    if (!direction && entry !== null && stop !== null) direction = stop < entry ? "long" : "short";
    const notes = [];
    if (s.timeframe) notes.push("Timeframe: " + s.timeframe);
    if (tps.length > 1) notes.push("More targets: " + tps.slice(1).map((t, i) => "TP" + (i + 2) + " " + t).join(", "));
    const missing = [];
    if (!symbol) missing.push("pair");
    if (entry === null) missing.push("entry");
    if (!direction) missing.push("direction");
    const warnings = [];
    if (direction && entry !== null && stop !== null && (direction === "long" ? stop >= entry : stop <= entry)) warnings.push("The stop is on the wrong side of the entry.");
    return {
      symbol,
      direction: direction || "long",
      directionGuessed: !direction,
      entry,
      stop,
      target: tps.length ? tps[0] : null,
      label: String(s.summary || "").slice(0, 80),
      note: notes.join(" · "),
      source: "",
      missing,
      warnings
    };
  });
  return { setups, problem: data.problem || null };
}

module.exports = { parseSetupText, readImageWithAI, aiAvailable, useAnthropic, findSymbols, toNumber };
