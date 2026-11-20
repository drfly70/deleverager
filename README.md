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
`ONEINCH_API_KEY`, `STATE_FILE`, `HEARTBEAT_URL` (pinged after every completed check).

### Hosting: a small always-on server

The bot must keep running, so it runs on a small Linux server (any provider; 1 vCPU / 1 GB on
Ubuntu 24.04 is plenty), not on a laptop that sleeps.

1. Create the server and SSH in as root.
2. Copy the repo to `/opt/deleverager` (for example `git clone` with a read-only GitHub deploy key).
3. `cd /opt/deleverager && bash deploy/setup-vps.sh`. This installs Node, the dependencies, automatic
   security updates and the `deleverager` systemd service (restarts on crash and on reboot). It does
   not start the bot yet.
4. After deploying the contract, fill in `/etc/deleverager.env` (readable by root and the
   `keeper` service only), then `systemctl enable --now deleverager`.
   Logs: `journalctl -u deleverager -f`.

**Dead-man's switch:** create a check at healthchecks.io (free) with period 5 minutes and grace
5 minutes, and put its ping URL in `HEARTBEAT_URL`. If the server, the network or the bot dies, the
pings stop and healthchecks.io alerts you; `NOTIFY_URL` alone can't, because a dead bot sends nothing.

## Owner controls

From the owner wallet: `setPaused(true)` stops it; `setAuthorization(<address>, false)` on Morpho
removes its access completely; `setTriggerPrice`, `setKeeper`, `setRouter` change settings.
