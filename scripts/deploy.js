// Deploys Deleverager for the cbBTC/USDC market on Base with the aggregator routers allowlisted.
// Any wallet can deploy it (for example the keeper wallet); OWNER_ADDRESS is the wallet that holds
// the Morpho position and is the only one that can change settings afterwards:
//   DEPLOYER_PRIVATE_KEY=... OWNER_ADDRESS=0x... KEEPER_ADDRESS=0x... npx hardhat run scripts/deploy.js --network base
// Afterwards the owner must call morpho.setAuthorization(<deployed address>, true) from their own
// wallet. This script does NOT do that step, so nothing can touch the position until you choose to.
const { ethers } = require("hardhat");
const { ROUTERS } = require("../bot/quotes");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const WAD = 10n ** 18n;

async function main() {
  const owner = process.env.OWNER_ADDRESS;
  const keeper = process.env.KEEPER_ADDRESS;
  if (!owner || !keeper) throw new Error("set OWNER_ADDRESS and KEEPER_ADDRESS");
  const triggerUsd = BigInt(process.env.TRIGGER_USD || "59000");
  const morpho = await ethers.getContractAt(
    ["function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)"], MORPHO);
  const p = await morpho.idToMarketParams(MARKET_ID);
  const routers = (process.env.ROUTERS || "kyberswap,velora").split(",");
  const d = await (await ethers.getContractFactory("Deleverager")).deploy(
    MORPHO, [...p], owner, keeper, triggerUsd * 10n ** 34n, 105n * WAD / 100n, 150n * WAD / 100n,
    routers.map((r) => ROUTERS[r]));
  await d.waitForDeployment();
  console.log(JSON.stringify({ deleverager: await d.getAddress(), owner, keeper, triggerUsd: String(triggerUsd), routers }));
}

main().catch((e) => { console.error(e); process.exit(1); });
