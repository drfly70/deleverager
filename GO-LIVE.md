# Go-live checklist

The code is finished and tested. These steps need your wallets or your accounts, so only you can do
them. Do them in order. Nothing can touch the position until step 6.

Before you start, re-read the position (health factor, BTC price, debt) in the Morpho app.

## 1. Server
Create a small Ubuntu 24.04 server (any provider, about $5/month). Then, as root:
```
git clone <repo, using a read-only GitHub deploy key> /opt/deleverager
cd /opt/deleverager && git checkout deleverager
bash deploy/setup-vps.sh
```
It installs everything and the service, but does not start the bot.

## 2. Keeper wallet (on the server, so the key never leaves it)
```
cd /opt/deleverager && node -e 'const w=require("ethers").Wallet.createRandom(); require("fs").appendFileSync("/etc/deleverager.env", "KEEPER_PRIVATE_KEY="+w.privateKey+"\n"); console.log("keeper address:", w.address)'
```
Then delete the empty `KEEPER_PRIVATE_KEY=` line from `/etc/deleverager.env`. Send about
**0.002 ETH on Base** to the printed keeper address. That is gas only. The keeper can't borrow,
withdraw or sell outside the contract's rules.

## 3. Alerts
- `NOTIFY_URL`: where alerts are POSTed as plain text, e.g. `https://ntfy.sh/<a long random topic>`
  (install the ntfy app and subscribe to that topic).
- `HEARTBEAT_URL`: a free healthchecks.io check, period 5 min, grace 5 min. It alerts you if the
  bot stops.

Put both in `/etc/deleverager.env`.

## 4. Deploy the contract
The keeper wallet can pay for the deploy, so your owner key is not needed here. On the server:
```
cd /opt/deleverager
set -a; . /etc/deleverager.env; set +a
DEPLOYER_PRIVATE_KEY=$KEEPER_PRIVATE_KEY OWNER_ADDRESS=0x8c62549c7abde21e8ccdb402f4ecf712c14b1c7f \
  KEEPER_ADDRESS=<keeper address> npx hardhat run scripts/deploy.js --network base
```
Put the printed `deleverager` address in `/etc/deleverager.env` as `DELEVERAGER_ADDRESS`.

## 5. Start the bot
```
systemctl enable --now deleverager && journalctl -u deleverager -f
```
Check that it logs `{"action":"none","reason":"no trigger"}` every 30 s and that healthchecks.io
shows pings. It can't act yet, because it isn't authorized.

## 6. Authorize (owner wallet, last step)
On Basescan, open Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` → Write Contract →
connect your owner wallet → `setAuthorization(<Deleverager address>, true)`.
This is the step that gives the bot access.

**Undo at any time:** `setAuthorization(<Deleverager address>, false)` from the same page, or
`setPaused(true)` on the Deleverager contract.

## Optional backstop
Also enable Morpho Auto Deleverage on the position in the Morpho app. It acts later (health factor
around 1.03), so it only matters if this bot fails.
