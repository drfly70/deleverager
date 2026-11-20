// End-to-end smoke test on a LOCAL Base fork (npx hardhat node). Never run against mainnet.
// Sets the market oracle to $55,000 so the position's health factor drops to about 1.04,
// deploys Deleverager the same way scripts/deploy.js does, and authorizes it as the owner.
// Then run the real bot against http://127.0.0.1:8545 and check it sells down to ~1.5.
const { ethers, network } = require("hardhat");
const { ROUTERS } = require("../bot/quotes");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const USER = "0x8c62549c7abde21e8ccdb402f4ecf712c14b1c7f";
const WAD = 10n ** 18n;

async function main() {
  if (network.name !== "localhost") throw new Error("local fork only");
  // A fresh `hardhat node` fork can't run calls at the fork block itself; mine one local block first.
  await network.provider.send("evm_mine", []);
  const [keeper] = await ethers.getSigners();
  const morpho = await ethers.getContractAt(
    ["function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)", "function setAuthorization(address,bool)"], MORPHO);
  const p = await morpho.idToMarketParams(MARKET_ID);

  const mock = await (await ethers.getContractFactory("MockOracle")).deploy();
  await network.provider.send("hardhat_setCode", [p[2], await ethers.provider.getCode(await mock.getAddress())]);
  await (await (await ethers.getContractAt("MockOracle", p[2])).setPrice(55000n * 10n ** 34n)).wait();

  const d = await (await ethers.getContractFactory("Deleverager")).deploy(
    MORPHO, [...p], USER, keeper.address, 59000n * 10n ** 34n, 105n * WAD / 100n, 150n * WAD / 100n,
    [ROUTERS.kyberswap, ROUTERS.velora]);
  await d.waitForDeployment();

  await network.provider.send("hardhat_impersonateAccount", [USER]);
  await network.provider.send("hardhat_setBalance", [USER, "0x56BC75E2D63100000"]);
  await (await morpho.connect(await ethers.getSigner(USER)).setAuthorization(await d.getAddress(), true)).wait();
  console.log(JSON.stringify({ deleverager: await d.getAddress(), hf: String(await d.healthFactor()), requiredSell: String(await d.requiredSell()) }));
}

main().catch((e) => { console.error(e); process.exit(1); });
