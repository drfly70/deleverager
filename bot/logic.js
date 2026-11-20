// Keeper bot decision logic. Pure apart from the injected dependencies, so it is unit-tested
// with fakes (test/bot.js). bot/run.js wires it to the real chain, APIs and notifications.
const DAY = 86400;
const TIER1_BPS = 50; // 0.5%
const TIER2_BPS = 150; // 1.5%, the hard maximum enforced by the contract

/** Coinbase /products/BTC-USD/candles?granularity=86400 rows: [time, low, high, open, close, volume], newest first. */
function lastClosedCoinbase(rows, now) {
  const done = rows.filter((r) => Number(r[0]) + DAY <= now).sort((a, b) => b[0] - a[0]);
  return done.length ? { day: Number(done[0][0]), close: Number(done[0][4]) } : null;
}

/** Kraken /0/public/OHLC?pair=XBTUSD&interval=1440: rows [time, open, high, low, close, ...], oldest first. */
function lastClosedKraken(body, now) {
  const rows = Object.entries(body.result || {}).find(([k]) => k !== "last")?.[1] || [];
  const done = rows.filter((r) => Number(r[0]) + DAY <= now).sort((a, b) => b[0] - a[0]);
  return done.length ? { day: Number(done[0][0]), close: Number(done[0][4]) } : null;
}

/** Rule A fires only if both exchanges have a closed candle for the same UTC day below the trigger. */
function dailyCloseSignal(a, b, triggerUsd) {
  if (!a || !b || a.day !== b.day) return { triggered: false, day: null };
  return { triggered: a.close < triggerUsd && b.close < triggerUsd, day: a.day };
}

const fmt = (wad) => (Number(wad) / 1e18).toFixed(3);

async function tryTier(d, amount, tier, slippageBps) {
  const quotes = await d.getQuotes({ amountIn: amount, taker: d.chain.address, slippageBps });
  if (!quotes.length) return { status: "noquote", errors: quotes.errors };
  for (const q of quotes) {
    if (await d.chain.simulate(amount, q.router, q.data, tier)) {
      const res = await d.chain.send(amount, q.router, q.data, tier);
      if (res.success) return { status: "done", source: q.source, tx: res.tx };
    }
  }
  return { status: "failed", best: quotes[0] };
}

/**
 * One check. Returns { action: "none" | "deleveraged" | "failed", rule?, tier?, reason? }.
 * deps: chain {address, read, simulate, send}, signal(), getQuotes(), notify(), loadState(), saveState(), now
 */
async function runOnce(d) {
  const s = await d.chain.read();
  if (s.keeperOk === false) {
    await d.notify("Bot wallet is not the contract's keeper, so it cannot act. Fix KEEPER_PRIVATE_KEY or call setKeeper.");
    return { action: "failed", reason: "not keeper" };
  }
  if (s.paused) return { action: "none", reason: "paused" };
  if (s.required === 0n) return { action: "none", reason: "at or above target" };

  const state = await d.loadState();
  let rule = null;
  if (s.hf <= s.floor) {
    rule = "B";
  } else {
    const sig = await d.signal();
    if (sig.triggered && state.lastRuleADay !== sig.day) {
      // The contract only allows rule A while the oracle price is below the trigger.
      if (s.oracle < s.trigger) rule = "A";
      else return { action: "none", reason: "daily close below trigger but oracle price recovered" };
      state.pendingRuleADay = sig.day;
    }
  }
  if (!rule) return { action: "none", reason: "no trigger" };

  const header = `Rule ${rule} (HF ${fmt(s.hf)}):`;
  let r1 = await tryTier(d, s.required, 1, TIER1_BPS);
  if (r1.status === "noquote") {
    await d.notify(`${header} no swap quote available: ${JSON.stringify(r1.errors || {})}`);
    return { action: "failed", rule, reason: "no quote" };
  }
  if (r1.status === "done") return finish(d, state, rule, 1, r1, header);

  // No quote filled within 0.5%. Send the best tier-1 quote so the contract records the failure,
  // which is what unlocks tier 2 onchain.
  const recorded = await d.chain.send(s.required, r1.best.router, r1.best.data, 1);
  if (recorded.success) return finish(d, state, rule, 1, { source: r1.best.source, tx: recorded.tx }, header);

  const r2 = await tryTier(d, s.required, 2, TIER2_BPS);
  if (r2.status === "done") return finish(d, state, rule, 2, r2, header);
  await d.notify(`${header} sale FAILED at 0.5% and 1.5% slippage. Position unchanged. Check it manually.`);
  return { action: "failed", rule, reason: r2.status };
}

async function finish(d, state, rule, tier, r, header) {
  const next = { lastRuleADay: rule === "A" ? state.pendingRuleADay : state.lastRuleADay };
  await d.saveState(next);
  await d.notify(`${header} sold collateral via ${r.source} at tier ${tier} (${tier === 1 ? "0.5%" : "1.5%"} max).${r.tx ? ` tx ${r.tx}` : ""}`);
  return { action: "deleveraged", rule, tier };
}

module.exports = { lastClosedCoinbase, lastClosedKraken, dailyCloseSignal, runOnce, TIER1_BPS, TIER2_BPS };
