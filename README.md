# Deleverager

Automatic deleveraging for one Morpho Blue position on Base: wallet
`0x8c62549c7abde21e8ccdb402f4ecf712c14b1c7f`, market cbBTC/USDC
`0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836` (LLTV 86%).

Nothing here is deployed, and nothing can touch the position until the owner wallet calls
`setAuthorization(<Deleverager address>, true)` on Morpho.

## What it does

- **Rule A:** Coinbase and Kraken both close a UTC day below $59,000, and the oracle price is still
  below $59,000 → sell cbBTC to bring the health factor back to 1.5. Acts once per daily close.
- **Rule B:** health factor at or below 1.05 → sell back to 1.5 immediately.
- Swaps go through KyberSwap or Velora (ParaSwap), whichever quote is best and passes a dry run.
  1inch is used only if `ONEINCH_API_KEY` is set.
- **Slippage:** first attempt fills at most 0.5% below the Morpho oracle price. Only after a 0.5%
  attempt has failed onchain does the contract allow 1.5%, for 10 minutes. 1.5% is the hard maximum.

## Pieces

| File | Role |
|---|---|
| `contracts/Deleverager.sol` | Holds no funds. Authorized on Morpho by the owner. Enforces triggers, the 1.5 target, slippage tiers, router allowlist, a minimum of 3M gas per attempt. |
| `bot/logic.js` | Bot decisions (unit tested with fakes). |
| `bot/quotes.js` | KyberSwap / Velora / 1inch quotes, built with the contract as sender and recipient. |
| `bot/run.js` | Wires the bot to Base, the price APIs and alerts. |
| `scripts/deploy.js` | Deploys the contract with routers allowlisted. Does not authorize it. |
| `scripts/e2e-local.js` | End-to-end check on a local fork only. |

## Tests

```
npm install
npx hardhat test                      # contract + bot unit tests on a Base fork
REAL_ROUTES=1 npx hardhat test        # also executes live KyberSwap/Velora routes on the fork
```

## Running the bot

The keeper wallet only needs a little ETH on Base for gas. It cannot borrow, withdraw to itself,
or sell outside the contract's rules.

```
DELEVERAGER_ADDRESS=0x... KEEPER_PRIVATE_KEY=0x... node bot/run.js --loop 30
```

Optional: `BASE_RPC`, `NOTIFY_URL` (alerts POSTed as plain text), `KYBER_CLIENT_ID`,
`ONEINCH_API_KEY`, `STATE_FILE`.

## Owner controls

From the owner wallet: `setPaused(true)` stops it; `setAuthorization(<address>, false)` on Morpho
removes its access completely; `setTriggerPrice`, `setKeeper`, `setRouter` change settings.
