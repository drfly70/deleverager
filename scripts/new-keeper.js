// Creates the keeper wallet and stores its key in .env (gitignored). Never prints the key.
// Safe to run again: if .env already has a keeper key, it just shows the address and balance.
// Also adds an ntfy.sh alert topic if NOTIFY_URL isn't set. Usage: node scripts/new-keeper.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const ENV = process.env.DOTENV || path.join(__dirname, "..", ".env");

function readEnv() {
  if (!fs.existsSync(ENV)) return {};
  return Object.fromEntries(fs.readFileSync(ENV, "utf8").split(/\r?\n/)
    .filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

(async () => {
  const env = readEnv();
  const add = [];
  if (!env.KEEPER_PRIVATE_KEY) {
    const w = ethers.Wallet.createRandom();
    add.push(`KEEPER_PRIVATE_KEY=${w.privateKey}`);
    env.KEEPER_PRIVATE_KEY = w.privateKey;
    console.log("Created a new keeper wallet; its key is saved in .env (never shown).");
  }
  if (!env.NOTIFY_URL) {
    env.NOTIFY_URL = `https://ntfy.sh/deleverager-${crypto.randomBytes(12).toString("hex")}`;
    add.push(`NOTIFY_URL=${env.NOTIFY_URL}`);
  }
  if (add.length) fs.appendFileSync(ENV, (fs.existsSync(ENV) && !fs.readFileSync(ENV, "utf8").endsWith("\n") && fs.statSync(ENV).size ? "\n" : "") + add.join("\n") + "\n");

  const wallet = new ethers.Wallet(env.KEEPER_PRIVATE_KEY);
  const provider = new ethers.JsonRpcProvider(env.BASE_RPC || "https://mainnet.base.org");
  const bal = await provider.getBalance(wallet.address);
  console.log(`\nKeeper address (Base): ${wallet.address}`);
  console.log(`Keeper balance: ${ethers.formatEther(bal)} ETH  (send about 0.002 ETH on Base for gas)`);
  console.log(`\nAlerts go to: ${env.NOTIFY_URL}`);
  console.log("Install the ntfy app on your phone and subscribe to that topic name (the part after ntfy.sh/).");
})().catch((e) => { console.error(e.message); process.exit(1); });
