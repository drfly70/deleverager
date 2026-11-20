#!/usr/bin/env node
// Keeper bot. Usage:
//   node bot/run.js            one check, then exit (for cron)
//   node bot/run.js --loop 30  check every 30 seconds
//
// Environment:
//   DELEVERAGER_ADDRESS  deployed Deleverager contract (required)
//   KEEPER_PRIVATE_KEY   key of the keeper wallet; fund it with a little ETH for gas only (required)
//   BASE_RPC             Base RPC URL (default https://mainnet.base.org)
//   NOTIFY_URL           optional: every alert is POSTed here as plain text
//   KYBER_CLIENT_ID      optional client id sent to KyberSwap (default "deleverager")
//   ONEINCH_API_KEY      optional: enables 1inch quotes
//   STATE_FILE           optional: where the bot remembers which daily close it already acted on
//   HEARTBEAT_URL        optional: pinged (GET) after every completed check, for a dead-man's switch
//                        such as healthchecks.io; if the pings stop, that service alerts you
const fs = require("fs");
const { ethers } = require("ethers");
const { getQuotes } = require("./quotes");
const { lastClosedCoinbase, lastClosedKraken, dailyCloseSignal, runOnce } = require("./logic");

const ABI = [
  "function healthFactor() view returns (uint256)",
  "function requiredSell() view returns (uint256)",
  "function paused() view returns (bool)",
  "function triggerPrice() view returns (uint256)",
  "function FLOOR_HF() view returns (uint256)",
  "function keeper() view returns (address)",
  "function ORACLE() view returns (address)",
  "function deleverage(uint256,address,bytes,uint8) returns (bool)",
  "event Deleveraged(uint8 tier, uint256 collateralSold, uint256 hfBefore, uint256 hfAfter)",
  "event AttemptFailed(uint8 tier, bytes reason)",
];
// The contract refuses attempts with less than 3M gas left (MIN_ATTEMPT_GAS).
const GAS_LIMIT = 4_000_000n;
const SEND_TIMEOUT_MS = 120_000;
const ORACLE_TO_USD = 10n ** 34n; // Morpho oracle scale for cbBTC (8 dp) / USDC (6 dp)

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing ${name}`);
  return v;
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function makeDeps() {
  const provider = new ethers.JsonRpcProvider(env("BASE_RPC", "https://mainnet.base.org"));
  const wallet = new ethers.Wallet(env("KEEPER_PRIVATE_KEY"), provider);
  const d = new ethers.Contract(env("DELEVERAGER_ADDRESS"), ABI, wallet);
  const stateFile = env("STATE_FILE", "./deleverager-state.json");
  let triggerUsd = null;
  let lastFees = null;

  const chain = {
    address: env("DELEVERAGER_ADDRESS"),
    async read() {
      const [hf, required, paused, trigger, floor, oracleAddr, keeper, keeperBalance] = await Promise.all([
        d.healthFactor(), d.requiredSell(), d.paused(), d.triggerPrice(), d.FLOOR_HF(), d.ORACLE(), d.keeper(),
        provider.getBalance(wallet.address),
      ]);
      const oracle = await new ethers.Contract(oracleAddr, ["function price() view returns (uint256)"], provider).price();
      triggerUsd = Number(trigger / ORACLE_TO_USD);
      return { hf, required, paused, trigger, floor, oracle, keeperBalance, keeperOk: keeper.toLowerCase() === wallet.address.toLowerCase() };
    },
    async simulate(amount, router, data, tier) {
      try { return await d.deleverage.staticCall(amount, router, data, tier, { gasLimit: GAS_LIMIT }); } catch { return false; }
    },
    async send(amount, router, data, tier) {
      try {
        // Use the confirmed nonce so a send that got stuck earlier is replaced, not queued behind,
        // and pay at least 25% more than any earlier attempt (replacements need >= 10% more).
        const [nonce, fee] = await Promise.all([provider.getTransactionCount(wallet.address, "latest"), provider.getFeeData()]);
        const bump = (now, prev) => { const a = now * 2n, b = prev ? prev * 125n / 100n : 0n; return a > b ? a : b; };
        lastFees = {
          maxFeePerGas: bump(fee.maxFeePerGas ?? fee.gasPrice, lastFees?.maxFeePerGas),
          maxPriorityFeePerGas: bump(fee.maxPriorityFeePerGas ?? 1_000_000n, lastFees?.maxPriorityFeePerGas),
        };
        const tx = await d.deleverage(amount, router, data, tier, { gasLimit: GAS_LIMIT, nonce, ...lastFees });
        // Don't wait forever on a stuck transaction: give up after 2 minutes so the loop keeps running;
        // the next attempt reuses the nonce and replaces it.
        const rc = await tx.wait(1, SEND_TIMEOUT_MS);
        const names = rc.logs.map((l) => { try { return d.interface.parseLog(l)?.name; } catch { return null; } });
        return { success: names.includes("Deleveraged"), tx: rc.hash };
      } catch (e) {
        console.error(`send tier ${tier} failed: ${e.shortMessage || e.message}`);
        return { success: false };
      }
    },
  };

  return {
    chain,
    now: Math.floor(Date.now() / 1000),
    async signal() {
      const now = Math.floor(Date.now() / 1000);
      try {
        const [cb, kr] = await Promise.all([
          fetchJson("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400"),
          fetchJson("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440"),
        ]);
        const a = lastClosedCoinbase(cb, now);
        const b = lastClosedKraken(kr, now);
        const sig = dailyCloseSignal(a, b, triggerUsd);
        console.log(`daily close: coinbase ${a?.close} kraken ${b?.close} trigger ${triggerUsd} -> ${sig.triggered}`);
        return sig;
      } catch (e) {
        console.error(`daily close check failed (rule A skipped this run): ${e.message}`);
        return { triggered: false, day: null };
      }
    },
    getQuotes: async (args) => {
      const q = await getQuotes(args);
      for (const [k, v] of Object.entries(q.errors)) console.error(`quote ${k} failed: ${v}`);
      return q;
    },
    async notify(msg) {
      console.log(`ALERT: ${msg}`);
      if (process.env.NOTIFY_URL) {
        try { await fetch(process.env.NOTIFY_URL, { method: "POST", body: msg, signal: AbortSignal.timeout(10000) }); } catch (e) { console.error(`notify failed: ${e.message}`); }
      }
    },
    loadState: async () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } },
    // Write to a temp file and rename, so a crash mid-write can't leave a corrupt state file.
    saveState: async (s) => { fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(s)); fs.renameSync(`${stateFile}.tmp`, stateFile); },
  };
}

async function once() {
  const r = await runOnce(makeDeps());
  console.log(`${new Date().toISOString()} ${JSON.stringify(r)}`);
  await heartbeat();
  return r;
}

// Only reached when a check completed, so a crashed, stuck or offline bot stops pinging.
async function heartbeat() {
  if (!process.env.HEARTBEAT_URL) return;
  try { await fetch(process.env.HEARTBEAT_URL, { signal: AbortSignal.timeout(10000) }); } catch (e) { console.error(`heartbeat failed: ${e.message}`); }
}

async function main() {
  const i = process.argv.indexOf("--loop");
  if (i === -1) return once();
  const secs = Number(process.argv[i + 1] || 30);
  for (;;) {
    try { await once(); } catch (e) { console.error(`check failed: ${e.message}`); }
    await new Promise((r) => setTimeout(r, secs * 1000));
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { makeDeps };
