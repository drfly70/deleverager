// Keeper bot decision logic. Pure apart from the injected dependencies, so it is unit-tested
// with fakes (test/bot.js). bot/run.js wires it to the real chain, APIs and notifications.
const DAY = 86400;
const TIER1_BPS = 50; // 0.5%
const TIER2_BPS = 150; // 1.5%, the hard maximum enforced by the contract
// After a sale fails at both tiers (or gets no quote), wait this long before trying again,
// so a persistent failure doesn't send a failing transaction every check.
const RETRY_AFTER_SEC = 120;
// The same alert is repeated at most this often while the problem persists.
const REALERT_SEC = 30 * 60;
// Warn when the keeper can't cover one attempt (4M gas) at a 1 gwei fee: crashes are when fees spike.
const MIN_KEEPER_WEI = 4n * 10n ** 15n; // 0.004 ETH
// Alert after this many consecutive failed chain reads / price-feed fetches.
const FAILS_BEFORE_ALERT = 3;
// A candle only counts as closed this long after its day ends, in case the local clock runs fast.
const CLOSE_BUFFER_SEC = 120;
// Don't sell dust: skip when health is already within 1.5% of the target (fills land just below it).
const NEAR_TARGET_PCT = 985n;

/** Sends msg unless the same key was alerted within everySec. Mutates state.alerts; caller saves. */
async function alert(d, state, key, msg, everySec = REALERT_SEC) {
  state.alerts = state.alerts || {};
  if (state.alerts[key] && d.now - state.alerts[key] < everySec) return;
  state.alerts[key] = d.now;
  await d.notify(msg);
}

const closedRows = (rows, now) => rows.filter((r) => Number(r[0]) + DAY + CLOSE_BUFFER_SEC <= now).sort((a, b) => b[0] - a[0]);

/** Coinbase /products/BTC-USD/candles?granularity=86400 rows: [time, low, high, open, close, volume], newest first. */
function lastClosedCoinbase(rows, now) {
  const done = closedRows(rows, now);
  return done.length ? { day: Number(done[0][0]), close: Number(done[0][4]) } : null;
}

/** Kraken /0/public/OHLC?pair=XBTUSD&interval=1440: rows [time, open, high, low, close, ...], oldest first. */
function lastClosedKraken(body, now) {
  if (body.error && body.error.length) throw new Error(`kraken: ${body.error.join(", ")}`);
  const rows = Object.entries(body.result || {}).find(([k]) => k !== "last")?.[1] || [];
  const done = closedRows(rows, now);
  return done.length ? { day: Number(done[0][0]), close: Number(done[0][4]) } : null;
}

/** Rule A fires only if both exchanges have a closed candle for the same UTC day below the trigger. */
function dailyCloseSignal(a, b, triggerUsd) {
  if (!a || !b || a.day !== b.day) return { triggered: false, day: null };
  return { triggered: a.close < triggerUsd && b.close < triggerUsd, day: a.day };
}

const fmt = (wad) => (Number(wad) / 1e18).toFixed(3);

/**
 * chain.simulate returns true (would sell), false (the contract would record a failed attempt,
 * which is what unlocks tier 2), or null (the call reverts: not a price problem, records nothing).
 */
async function tryTier(d, amount, tier, slippageBps) {
  const quotes = await d.getQuotes({ amountIn: amount, taker: d.chain.address, slippageBps });
  if (!quotes.length) return { status: "noquote", errors: quotes.errors };
  const recordable = [];
  for (const q of quotes) {
    const sim = await d.chain.simulate(amount, q.router, q.data, tier);
    if (sim === true) {
      const res = await d.chain.send(amount, q.router, q.data, tier);
      if (res.success) return { status: "done", source: q.source, tx: res.tx };
      if (res.reason === "funds") return { status: "funds" };
    } else if (sim === false) {
      recordable.push(q);
    }
  }
  return recordable.length ? { status: "failed", best: recordable[0] } : { status: "reverted" };
}

/**
 * One check. Returns { action: "none" | "deleveraged" | "failed", rule?, tier?, reason? }.
 * Throws (after saving state) if the chain can't be read, so the caller's heartbeat isn't sent.
 * deps: chain {address, read, simulate, send}, signal(), getQuotes(), notify(), loadState(), saveState(), now
 */
async function runOnce(d) {
  const state = await d.loadState();
  let s;
  try {
    s = await d.chain.read();
    state.readFails = 0;
  } catch (e) {
    state.readFails = (state.readFails || 0) + 1;
    if (state.readFails >= FAILS_BEFORE_ALERT) {
      await alert(d, state, "read", `Bot can't read Base (${state.readFails} checks in a row): ${e.message}. It can't protect the position until this clears.`);
    }
    await d.saveState(state);
    throw e;
  }
  const r = await decide(d, s, state);
  await d.saveState(state);
  return r;
}

async function decide(d, s, state) {
  if (s.keeperOk === false) {
    await alert(d, state, "keeper", "Bot wallet is not the contract's keeper, so it cannot act. Fix KEEPER_PRIVATE_KEY or call setKeeper.");
    return { action: "failed", reason: "not keeper" };
  }
  if (s.authorized === false) {
    await alert(d, state, "auth", "The Deleverager is not authorized on Morpho, so it cannot protect the position. Call setAuthorization(<contract>, true) from the owner wallet if that wasn't intended.", 12 * 3600);
    return { action: "none", reason: "not authorized on Morpho" };
  }
  if (s.keeperBalance !== undefined && s.keeperBalance < MIN_KEEPER_WEI) {
    await alert(d, state, "gas", `Keeper wallet is low on ETH for gas (${(Number(s.keeperBalance) / 1e18).toFixed(6)} ETH). If fees spike in a crash it can't pay for a sale. Top it up to 0.01 ETH on Base.`, 12 * 3600);
  }
  if (s.paused) return { action: "none", reason: "paused" };
  if (s.required === 0n) { delete state.failedAt; return { action: "none", reason: "at or above target" }; }
  if (s.target !== undefined && s.hf * 1000n >= s.target * NEAR_TARGET_PCT) {
    delete state.failedAt;
    return { action: "none", reason: "within 1.5% of target" };
  }
  // Rule B (health at or below the floor) is an emergency: retry every check; only rule A waits.
  if (state.failedAt && s.hf > s.floor && d.now - state.failedAt < RETRY_AFTER_SEC) {
    return { action: "none", reason: "waiting to retry after a failed sale" };
  }

  let rule = null;
  if (s.hf <= s.floor) {
    rule = "B";
  } else {
    const sig = await d.signal();
    if (sig.error) {
      state.signalFails = (state.signalFails || 0) + 1;
      if (state.signalFails >= FAILS_BEFORE_ALERT) {
        await alert(d, state, "signal", `Can't get daily closes from Coinbase/Kraken (${state.signalFails} checks in a row): ${sig.error}. Rule A is blind until this clears; rule B still works.`, 2 * 3600);
      }
    } else {
      state.signalFails = 0;
    }
    if (sig.triggered && state.lastRuleADay !== sig.day) {
      // The contract only allows rule A while the oracle price is below its trigger. The day stays
      // pending, so the bot sells if the oracle drops back below it before the next close.
      if (s.oracle >= s.trigger) {
        await alert(d, state, `ruleA-blocked-${sig.day}`, `Rule A fired (daily close below the threshold on Coinbase and Kraken), but the onchain oracle price is back above the contract's trigger, so it can't sell yet. It will sell if the oracle drops below the trigger before the next close.`, 2 * DAY);
        return { action: "none", reason: "daily close below trigger but oracle price recovered" };
      }
      rule = "A";
      state.pendingRuleADay = sig.day;
    }
  }
  if (!rule) return { action: "none", reason: "no trigger" };

  const header = `Rule ${rule} (HF ${fmt(s.hf)}):`;
  const r1 = await tryTier(d, s.required, 1, TIER1_BPS);
  if (r1.status === "done") return finish(d, state, rule, 1, r1, header);
  if (r1.status !== "failed") return fail(d, state, header, r1);

  // No quote filled within 0.5%. Send a tier-1 quote whose dry run returned "failed" (not a revert),
  // so the contract records the failure, which is what unlocks tier 2 onchain.
  const recorded = await d.chain.send(s.required, r1.best.router, r1.best.data, 1);
  if (recorded.success) return finish(d, state, rule, 1, { source: r1.best.source, tx: recorded.tx }, header);
  if (recorded.reason === "funds") return fail(d, state, header, { status: "funds" });

  const r2 = await tryTier(d, s.required, 2, TIER2_BPS);
  if (r2.status === "done") return finish(d, state, rule, 2, r2, header);
  return fail(d, state, header, r2.status === "failed" ? { status: "bothtiers" } : r2);
}

const FAIL_TEXT = {
  noquote: (r) => `no swap quote available: ${JSON.stringify(r.errors || {})}`,
  funds: () => "the keeper wallet can't afford gas at current fees. Top it up on Base NOW",
  reverted: () => "every quote's dry run reverted (not a price problem; tier 2 was not unlocked). Check the bot log",
  bothtiers: () => "sale FAILED at 0.5% and 1.5% slippage",
};

async function fail(d, state, header, r) {
  state.failedAt = d.now;
  const text = (FAIL_TEXT[r.status] || FAIL_TEXT.bothtiers)(r);
  await alert(d, state, `fail-${r.status}`, `${header} ${text}. Position unchanged; retrying. Check it manually.`);
  return { action: "failed", reason: r.status };
}

async function finish(d, state, rule, tier, r, header) {
  if (rule === "A") state.lastRuleADay = state.pendingRuleADay;
  delete state.pendingRuleADay;
  delete state.failedAt;
  if (state.alerts) for (const k of Object.keys(state.alerts)) if (k.startsWith("fail-")) delete state.alerts[k];
  await d.notify(`${header} sold collateral via ${r.source} at tier ${tier} (${tier === 1 ? "0.5%" : "1.5%"} max).${r.tx ? ` tx ${r.tx}` : ""}`);
  return { action: "deleveraged", rule, tier };
}

module.exports = { lastClosedCoinbase, lastClosedKraken, dailyCloseSignal, runOnce, TIER1_BPS, TIER2_BPS, RETRY_AFTER_SEC, MIN_KEEPER_WEI };
