# Handoff: Morpho auto-deleverage (Kyle)

Status as of 2026-11-20 03:56 PT. Code is complete and tested on a Base fork. **Nothing is deployed
and nothing has access to the position.**

## 1. The position (read 2026-11-19 ~22:45 PT)

| Item | Value | Source |
|---|---|---|
| Chain | Base (8453) | Morpho API |
| Wallet (owner) | `0x8c62549c7abde21e8ccdb402f4ecf712c14b1c7f` | user |
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | Morpho API |
| Market ID | `0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836` | Morpho API |
| Collateral / loan | cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` / USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Morpho API |
| LLTV | 86% | Morpho API |
| Oracle | `0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9` (Chainlink type) | Morpho API |
| Collateral | 0.13454053 cbBTC | Morpho API, matched onchain on fork |
| Debt | 6,108.88 USDC | Morpho API |
| Health factor | 1.169 (BTC ~$61,780) | Morpho API |
| Liquidation price | ~$52,870 | Morpho API (14.4% below price at that time) |
| Morpho Auto Deleverage | Available on this market (pre-liquidation contract `0xa7272afc21f9c321024ed93892a1abfeb621c374`, fires near HF ~1.033 / BTC ~$54.5k). **Not enabled** for this wallet: `isAuthorized` = false, checked onchain. | Morpho API + onchain |

Numbers change with price and interest; re-read before acting.

## 2. Decisions Kyle made

- **Target:** sell back to health factor **1.5**, however much that takes.
- **Rule A:** daily close below **$59,000** on **Coinbase and Kraken** (both, same UTC day).
  Robinhood was dropped: its crypto API needs his personal trading key and showed no daily candles.
- **Rule B:** health factor **≤ 1.05** → act immediately.
- **Slippage:** 0.5% first; **1.5% is the hard max**, allowed only after a 0.5% attempt fails.
- **Swap venues:** KyberSwap, Velora (ParaSwap); 1inch only with an API key (its API returned
  HTTP 402 without one).
- **Trigger runner:** his own small keeper bot, not Chainlink. Reasons: Chainlink Automation is
  deprecated (v2.1 as of 2026-07-31); its replacement CRE needs Early Access approval to deploy and
  runs on many nodes that must agree, which aggregator quotes (different each request) break.

## 3. What is built (`deleverager/`)

| File | What it does |
|---|---|
| `contracts/Deleverager.sol` | Owner authorizes it on Morpho. Sells collateral to repay debt in one transaction via Morpho's repay callback. Enforces: trigger (oracle < triggerPrice, or HF ≤ floor), never sells more than needed for HF 1.5, slippage tiers vs the oracle price, router allowlist (set at deploy), only keeper/owner can call, pause, 3M minimum gas per attempt. No borrow, no withdraw-to-anyone. |
| `bot/logic.js` | Decisions: rule A once per daily close, rule B anytime, best quote that passes a dry run, tier 1 → recorded failure → tier 2, alerts, keeper-mismatch alert. |
| `bot/quotes.js` | KyberSwap / Velora / 1inch quotes with the contract as sender and recipient; rejects unexpected router addresses. |
| `bot/run.js` | Wires it to Base RPC, Coinbase + Kraken candles, alerts (`NOTIFY_URL`). `node bot/run.js --loop 30`. |
| `scripts/deploy.js` | Deploys with routers allowlisted. Any wallet can deploy. Does **not** authorize. |
| `scripts/e2e-local.js` | End-to-end check on a local fork only. |
| `README.md` | Usage. |

Router addresses: KyberSwap `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`,
Velora `0x6A000F20005980200259B80c5102003040001068`, 1inch `0x111111125421cA6dc452d289314280a0f8842A65` (1inch untested).

## 4. Verified

- `npx hardhat test` → contract 19 + bot 14 passing; with `REAL_ROUTES=1` → 36 passing (adds live routes).
- Live routes on a Base fork: KyberSwap filled in every run (HF → ~1.498); Velora filled in some
  runs and in others failed its own min-out check, each time leaving the position untouched.
- End-to-end on a local fork (oracle forced to $55k, HF 1.042): bot sold 0.0795 cbBTC via KyberSwap
  at tier 1; a second run did nothing. HF overshot to 2.19 only because the forced oracle price was
  below the real swap price.
- Each of four safety checks was removed one at a time; a test failed every time.

## 5. Bugs found and fixed

1. **Gas:** an under-gassed call (including normal gas estimation) let the swap run out of gas,
   which was recorded as a 0.5% failure and unlocked 1.5%. Fix: contract requires ≥ 3M gas per
   attempt; bot sends 4M. Test covers 0.9M–3.4M.
2. Deploying needed the owner's private key to allowlist routers. Fix: routers set in constructor.
3. Bot with the wrong key reported a misleading "sale failed". Fix: explicit keeper check + alert.

## 6. Known limits

- Rule A sells only if the oracle price is still below $59k when the bot acts.
- A malicious keeper can force the 1.5% tier (bounded: only when triggered, only to HF 1.5).
- If both tiers keep failing, the bot retries every check (repeat alerts, small gas each time).
- No independent security review yet.

## 7. Open items (in order)

1. **GitHub:** create an empty **private** repo `drfly70/deleverager` (no README). The GitHub
   connector returned 403 on repo creation and the `gh` token in the workspace is invalid. Then push
   branches `main` and `deleverager` and open a PR.
2. **Ultrareview:** Kyle runs `/code-review ultra` himself in Claude Code (v2.1.86+) from the repo
   on branch `deleverager`. Claude cannot start it.
3. **Host:** an always-on machine with Node 18+. Not settled. The cloud workspace cannot host it
   (background programs stop minutes after a reply); a phone cannot run it. Option discussed: link
   his computer via the Claude desktop app (+ menu → add folder) and set it up there.
4. **Keeper wallet:** new wallet, small ETH on Base for gas only.
5. **Deploy:** `DEPLOYER_PRIVATE_KEY=... OWNER_ADDRESS=0x8c62549c7abde21e8ccdb402f4ecf712c14b1c7f KEEPER_ADDRESS=0x... npx hardhat run scripts/deploy.js --network base`
6. **Authorize (owner wallet, last):** `setAuthorization(<Deleverager>, true)` on Morpho. This is
   the only step that grants access. Undo: `setAuthorization(<Deleverager>, false)`.
7. Optional backstop: enable Morpho Auto Deleverage in the Morpho app.

## 8. Commands

```
cd deleverager && npm install
npx hardhat test                    # forks Base via https://mainnet.base.org (override with BASE_RPC)
REAL_ROUTES=1 npx hardhat test      # + live aggregator routes
DELEVERAGER_ADDRESS=0x... KEEPER_PRIVATE_KEY=0x... NOTIFY_URL=... node bot/run.js --loop 30
```
