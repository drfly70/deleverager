// Unit tests for the keeper bot's decision logic. No network: chain, prices and quotes are fakes.
const { expect } = require("chai");
const { lastClosedCoinbase, lastClosedKraken, dailyCloseSignal, runOnce } = require("../bot/logic");

const DAY = 86400;
const T0 = 1795132800; // a UTC midnight
const WAD = 10n ** 18n;
const px = (usd) => BigInt(usd) * 10n ** 34n;

// Coinbase: [time, low, high, open, close, volume], newest first, includes today's open candle.
const coinbase = (closes, now) => closes.map((c, i) => [T0 - i * DAY, 0, 0, 0, c, 1]).filter((r) => r[0] <= now);
// Kraken: { result: { XXBTZUSD: [[time, open, high, low, close, vwap, volume, count]], last } }, oldest first.
const kraken = (closes) => ({
  result: { XXBTZUSD: closes.map((c, i) => [T0 - (closes.length - 1 - i) * DAY, "0", "0", "0", String(c), "0", "1", 1]) },
});

function fakeChain(o = {}) {
  const calls = [];
  const s = {
    hf: o.hf ?? 117n * WAD / 100n,
    required: o.required ?? 6_000_000n,
    paused: o.paused ?? false,
    trigger: o.trigger ?? px(59000),
    floor: 105n * WAD / 100n,
    oracle: o.oracle ?? px(58000),
    simulate: o.simulate ?? (() => true),
    send: o.send ?? (() => ({ success: true })),
  };
  return {
    calls,
    address: "0x000000000000000000000000000000000000dEaD",
    read: async () => ({ hf: s.hf, required: s.required, paused: s.paused, trigger: s.trigger, floor: s.floor, oracle: s.oracle, keeperOk: o.keeperOk ?? true, keeperBalance: o.keeperBalance ?? 10n ** 16n }),
    simulate: async (a, r, d, t) => { calls.push(["simulate", a, r, d, t]); return s.simulate(a, r, d, t); },
    send: async (a, r, d, t) => { calls.push(["send", a, r, d, t]); return s.send(a, r, d, t); },
  };
}

function deps(o = {}) {
  const notes = [];
  const quoteCalls = [];
  const state = o.state ?? {};
  return {
    notes, quoteCalls, state,
    chain: o.chain ?? fakeChain(),
    now: o.now ?? T0 + 60,
    signal: o.signal ?? (async () => ({ triggered: false, day: T0 - DAY })),
    getQuotes: o.getQuotes ?? (async (args) => {
      quoteCalls.push(args);
      return [
        { source: "kyberswap", router: "0xK", data: `0xk${args.slippageBps}`, amountOut: 2n },
        { source: "velora", router: "0xV", data: `0xv${args.slippageBps}`, amountOut: 1n },
      ];
    }),
    notify: async (m) => notes.push(m),
    loadState: async () => state,
    saveState: async (s) => Object.assign(state, s),
  };
}

describe("bot: daily closes", function () {
  it("Coinbase: skips today's unfinished candle and returns yesterday's close", function () {
    const now = T0 + 3600;
    expect(lastClosedCoinbase(coinbase([61000, 58500, 60000], now), now)).to.deep.equal({ day: T0 - DAY, close: 58500 });
  });

  it("Kraken: skips the unfinished last candle and returns yesterday's close", function () {
    const now = T0 + 3600;
    expect(lastClosedKraken(kraken([60000, 58700, 61000]), now)).to.deep.equal({ day: T0 - DAY, close: 58700 });
  });

  it("signals only when both exchanges closed the same day below the trigger", function () {
    const day = T0 - DAY;
    expect(dailyCloseSignal({ day, close: 58000 }, { day, close: 58900 }, 59000)).to.deep.equal({ triggered: true, day });
    expect(dailyCloseSignal({ day, close: 58000 }, { day, close: 59100 }, 59000).triggered).to.equal(false);
    expect(dailyCloseSignal({ day, close: 58000 }, { day: day - DAY, close: 58000 }, 59000).triggered).to.equal(false);
    expect(dailyCloseSignal({ day, close: 58000 }, null, 59000).triggered).to.equal(false);
  });
});

describe("bot: runOnce", function () {
  it("does nothing when health is above the floor and there is no daily-close signal", async function () {
    const d = deps();
    const r = await runOnce(d);
    expect(r.action).to.equal("none");
    expect(d.chain.calls).to.deep.equal([]);
  });

  it("rule A: sells with the best quote that simulates, then not again the same day", async function () {
    const d = deps({ signal: async () => ({ triggered: true, day: T0 - DAY }) });
    const r = await runOnce(d);
    expect(r.action).to.equal("deleveraged");
    expect(d.chain.calls.find((c) => c[0] === "send")).to.deep.equal(["send", 6_000_000n, "0xK", "0xk50", 1]);
    expect(d.state.lastRuleADay).to.equal(T0 - DAY);
    expect(d.notes.length).to.equal(1);
    const again = await runOnce({ ...d, chain: fakeChain() });
    expect(again.action).to.equal("none");
  });

  it("rule A waits while the oracle price is still at or above the trigger", async function () {
    const d = deps({ chain: fakeChain({ oracle: px(59500) }), signal: async () => ({ triggered: true, day: T0 - DAY }) });
    const r = await runOnce(d);
    expect(r.action).to.equal("none");
    expect(d.state.lastRuleADay).to.equal(undefined);
  });

  it("rule B: acts at health 1.05 or lower even without a daily-close signal", async function () {
    const d = deps({ chain: fakeChain({ hf: 104n * WAD / 100n, oracle: px(60000) }) });
    const r = await runOnce(d);
    expect(r.action).to.equal("deleveraged");
    expect(r.rule).to.equal("B");
  });

  it("skips a quote that fails simulation and uses the next one", async function () {
    const chain = fakeChain({ simulate: (a, router) => router === "0xV" });
    const d = deps({ chain, signal: async () => ({ triggered: true, day: T0 - DAY }) });
    await runOnce(d);
    expect(chain.calls.filter((c) => c[0] === "send").map((c) => c[2])).to.deep.equal(["0xV"]);
  });

  it("escalates to tier 2 (1.5%) only after sending a tier-1 attempt that failed", async function () {
    const chain = fakeChain({
      simulate: (a, r, data, tier) => tier === 2,
      send: (a, r, data, tier) => ({ success: tier === 2 }),
    });
    const d = deps({ chain, signal: async () => ({ triggered: true, day: T0 - DAY }) });
    const r = await runOnce(d);
    const sends = chain.calls.filter((c) => c[0] === "send").map((c) => [c[2], c[4]]);
    expect(sends).to.deep.equal([["0xK", 1], ["0xK", 2]]);
    expect(d.quoteCalls.map((q) => q.slippageBps)).to.deep.equal([50, 150]);
    expect(r.action).to.equal("deleveraged");
    expect(r.tier).to.equal(2);
  });

  it("stops and reports when no tier-2 quote works either (no wasted tier-2 send)", async function () {
    const chain = fakeChain({ simulate: () => false, send: () => ({ success: false }) });
    const d = deps({ chain, signal: async () => ({ triggered: true, day: T0 - DAY }) });
    const r = await runOnce(d);
    expect(r.action).to.equal("failed");
    expect(chain.calls.filter((c) => c[0] === "send").map((c) => c[4])).to.deep.equal([1]);
    expect(d.notes.join(" ")).to.match(/fail/i);
  });

  it("alerts and stops if the bot wallet is not the contract's keeper", async function () {
    const d = deps({ chain: fakeChain({ keeperOk: false, hf: WAD }) });
    const r = await runOnce(d);
    expect(r.action).to.equal("failed");
    expect(d.chain.calls).to.deep.equal([]);
    expect(d.notes.join(" ")).to.match(/keeper/i);
  });

  it("does nothing while paused", async function () {
    const d = deps({ chain: fakeChain({ paused: true, hf: WAD }) });
    expect((await runOnce(d)).action).to.equal("none");
  });

  it("does nothing when no sale is needed", async function () {
    const d = deps({ chain: fakeChain({ required: 0n, hf: WAD }) });
    expect((await runOnce(d)).action).to.equal("none");
  });

  it("rule B retries every check after a failure (no wait), without repeating the alert", async function () {
    const chain = fakeChain({ hf: WAD, simulate: () => false, send: () => ({ success: false }) });
    const d = deps({ chain });
    await runOnce(d);
    const sends = chain.calls.filter((c) => c[0] === "send").length;
    d.now += 30;
    expect((await runOnce(d)).action).to.equal("failed");
    expect(chain.calls.filter((c) => c[0] === "send").length).to.be.greaterThan(sends);
    expect(d.notes.length).to.equal(1);
  });

  it("after a failed rule-A sale, waits before retrying and does not repeat the alert", async function () {
    const chain = fakeChain({ simulate: () => false, send: () => ({ success: false }) });
    const d = deps({ chain, signal: async () => ({ triggered: true, day: T0 - DAY }) });
    expect((await runOnce(d)).action).to.equal("failed");
    const sendsAfterFirst = chain.calls.filter((c) => c[0] === "send").length;
    expect(d.notes.length).to.equal(1);

    d.now += 30; // next check, inside the retry window: no transaction, no alert
    expect((await runOnce(d)).reason).to.match(/waiting to retry/);
    expect(chain.calls.filter((c) => c[0] === "send").length).to.equal(sendsAfterFirst);

    d.now += 120; // retry window over: tries again, but the alert is not repeated within 30 min
    expect((await runOnce(d)).action).to.equal("failed");
    expect(chain.calls.filter((c) => c[0] === "send").length).to.be.greaterThan(sendsAfterFirst);
    expect(d.notes.length).to.equal(1);

    d.now += 31 * 60; // still failing 30+ min later: alerted again
    await runOnce(d);
    expect(d.notes.length).to.equal(2);
  });

  it("a successful sale after failures clears the retry wait", async function () {
    let ok = false;
    const chain = fakeChain({ hf: WAD, simulate: () => ok, send: () => ({ success: ok }) });
    const d = deps({ chain });
    await runOnce(d);
    expect(d.state.failedAt).to.be.a("number");
    ok = true;
    d.now += 121;
    expect((await runOnce(d)).action).to.equal("deleveraged");
    expect(d.state.failedAt).to.equal(undefined);
  });

  it("warns (at most every 12h) when the keeper wallet is low on gas, and still acts", async function () {
    const d = deps({ chain: fakeChain({ hf: WAD, keeperBalance: 10n ** 13n }) });
    expect((await runOnce(d)).action).to.equal("deleveraged");
    expect(d.notes.filter((n) => /low on ETH/.test(n)).length).to.equal(1);
    d.now += 3600;
    await runOnce(d);
    expect(d.notes.filter((n) => /low on ETH/.test(n)).length).to.equal(1);
  });

  it("the not-keeper alert is not repeated every check", async function () {
    const d = deps({ chain: fakeChain({ keeperOk: false }) });
    await runOnce(d); d.now += 30; await runOnce(d);
    expect(d.notes.length).to.equal(1);
  });

  it("never sends when every dry run reverts (no fake tier-1 'failure', no tier 2)", async function () {
    const chain = fakeChain({ hf: WAD, simulate: () => null });
    const d = deps({ chain });
    const r = await runOnce(d);
    expect(r).to.deep.include({ action: "failed", reason: "reverted" });
    expect(chain.calls.filter((c) => c[0] === "send")).to.deep.equal([]);
    expect(d.notes.join(" ")).to.match(/reverted/);
  });

  it("records the tier-1 failure with a quote whose dry run failed, not one that reverts", async function () {
    const chain = fakeChain({
      hf: WAD,
      simulate: (a, router, data, tier) => (tier === 1 ? (router === "0xK" ? null : false) : router === "0xV"),
      send: (a, r, data, tier) => ({ success: tier === 2 }),
    });
    const d = deps({ chain });
    const r = await runOnce(d);
    expect(chain.calls.filter((c) => c[0] === "send").map((c) => [c[2], c[4]])).to.deep.equal([["0xV", 1], ["0xV", 2]]);
    expect(r.tier).to.equal(2);
  });

  it("reports when the keeper can't afford gas, instead of 'sale failed'", async function () {
    const chain = fakeChain({ hf: WAD, send: () => ({ success: false, reason: "funds" }) });
    const d = deps({ chain });
    const r = await runOnce(d);
    expect(r.reason).to.equal("funds");
    expect(chain.calls.filter((c) => c[0] === "send").length).to.equal(1);
    expect(d.notes.join(" ")).to.match(/afford gas/);
  });

  it("alerts after 3 failed chain reads in a row, and throws so no heartbeat is sent", async function () {
    const chain = fakeChain();
    chain.read = async () => { throw new Error("rpc down"); };
    const d = deps({ chain });
    for (let i = 0; i < 3; i++) {
      let threw = false;
      try { await runOnce(d); } catch { threw = true; }
      expect(threw).to.equal(true);
      d.now += 30;
    }
    expect(d.notes.length).to.equal(1);
    expect(d.notes[0]).to.match(/can't read Base/);
  });

  it("alerts after 3 failed daily-close fetches in a row (rule A blind)", async function () {
    const d = deps({ signal: async () => ({ triggered: false, day: null, error: "kraken: EService:Unavailable" }) });
    await runOnce(d); await runOnce(d);
    expect(d.notes.length).to.equal(0);
    await runOnce(d);
    expect(d.notes.join(" ")).to.match(/Rule A is blind/);
  });

  it("alerts once when rule A fires but the oracle is back above the onchain trigger", async function () {
    const d = deps({ chain: fakeChain({ oracle: px(59500) }), signal: async () => ({ triggered: true, day: T0 - DAY }) });
    await runOnce(d); d.now += 30; await runOnce(d);
    expect(d.notes.length).to.equal(1);
    expect(d.notes[0]).to.match(/Rule A fired/);
  });

  it("does nothing and alerts if the contract is not authorized on Morpho", async function () {
    const chain = fakeChain({ hf: WAD });
    const read = chain.read;
    chain.read = async () => ({ ...(await read()), authorized: false });
    const d = deps({ chain });
    expect((await runOnce(d)).reason).to.match(/not authorized/);
    expect(chain.calls).to.deep.equal([]);
    expect(d.notes.join(" ")).to.match(/not authorized/);
  });

  it("doesn't sell dust when health is already within 1.5% of the target", async function () {
    const chain = fakeChain({ hf: 149n * WAD / 100n, required: 1000n });
    const read = chain.read;
    chain.read = async () => ({ ...(await read()), target: 150n * WAD / 100n });
    const d = deps({ chain, signal: async () => ({ triggered: true, day: T0 - DAY }) });
    expect((await runOnce(d)).reason).to.match(/within 1.5%/);
    expect(chain.calls).to.deep.equal([]);
  });

  it("reports when no aggregator returns a quote", async function () {
    const d = deps({ chain: fakeChain({ hf: WAD }), getQuotes: async () => Object.assign([], { errors: { kyberswap: "down" } }) });
    const r = await runOnce(d);
    expect(r.action).to.equal("failed");
    expect(d.notes.join(" ")).to.match(/quote/i);
  });
});
