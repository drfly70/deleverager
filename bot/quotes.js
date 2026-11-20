// Swap quotes for cbBTC -> USDC on Base from DEX aggregators.
// Every quote is built with the Deleverager contract as sender and recipient,
// and only the router addresses below are accepted.
const CHAIN_ID = 8453;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ROUTERS = {
  kyberswap: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
  velora: "0x6A000F20005980200259B80c5102003040001068",
  oneinch: "0x111111125421cA6dc452d289314280a0f8842A65",
};

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

async function kyberswap({ amountIn, taker, slippageBps, clientId }) {
  const headers = { "x-client-id": clientId, "content-type": "application/json" };
  const base = "https://aggregator-api.kyberswap.com/base/api/v1";
  const r = await getJson(`${base}/routes?tokenIn=${CBBTC}&tokenOut=${USDC}&amountIn=${amountIn}`, { headers });
  const b = await getJson(`${base}/route/build`, {
    method: "POST",
    headers,
    body: JSON.stringify({ routeSummary: r.data.routeSummary, sender: taker, recipient: taker, slippageTolerance: slippageBps }),
  });
  return { router: b.data.routerAddress, data: b.data.data, amountOut: BigInt(b.data.amountOut) };
}

async function velora({ amountIn, taker, slippageBps }) {
  const q = new URLSearchParams({
    srcToken: CBBTC, srcDecimals: "8", destToken: USDC, destDecimals: "6", amount: String(amountIn),
    side: "SELL", network: String(CHAIN_ID), version: "6.2", userAddress: taker,
  });
  const p = await getJson(`https://api.paraswap.io/prices?${q}`);
  const tx = await getJson(`https://api.paraswap.io/transactions/${CHAIN_ID}?ignoreChecks=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      srcToken: CBBTC, srcDecimals: 8, destToken: USDC, destDecimals: 6, srcAmount: String(amountIn),
      slippage: slippageBps, priceRoute: p.priceRoute, userAddress: taker, receiver: taker,
    }),
  });
  return { router: tx.to, data: tx.data, amountOut: BigInt(p.priceRoute.destAmount) };
}

// Needs a 1inch Business API key (ONEINCH_API_KEY). Not exercised in tests without one.
async function oneinch({ amountIn, taker, slippageBps, oneinchKey }) {
  if (!oneinchKey) throw new Error("no ONEINCH_API_KEY");
  const q = new URLSearchParams({
    src: CBBTC, dst: USDC, amount: String(amountIn), from: taker, origin: taker, receiver: taker,
    slippage: String(slippageBps / 100), disableEstimate: "true",
  });
  const s = await getJson(`https://api.1inch.com/swap/v6.1/${CHAIN_ID}/swap?${q}`, {
    headers: { Authorization: `Bearer ${oneinchKey}` },
  });
  return { router: s.tx.to, data: s.tx.data, amountOut: BigInt(s.dstAmount) };
}

const SOURCES = { kyberswap, velora, oneinch };

/**
 * @returns {Promise<Array<{source,router,data,amountOut}>>} successful quotes, best first.
 *          Failed sources are reported in `errors` on the returned array.
 */
async function getQuotes({ amountIn, taker, slippageBps, sources = ["kyberswap", "velora", "oneinch"],
  clientId = process.env.KYBER_CLIENT_ID || "deleverager", oneinchKey = process.env.ONEINCH_API_KEY }) {
  const quotes = [];
  const errors = {};
  for (const source of sources) {
    try {
      const q = await SOURCES[source]({ amountIn, taker, slippageBps, clientId, oneinchKey });
      if (!same(q.router, ROUTERS[source])) throw new Error(`unexpected router ${q.router}`);
      quotes.push({ source, router: ROUTERS[source], data: q.data, amountOut: q.amountOut });
    } catch (e) {
      errors[source] = e.message;
    }
  }
  quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  quotes.errors = errors;
  return quotes;
}

module.exports = { getQuotes, ROUTERS, CBBTC, USDC, CHAIN_ID };
