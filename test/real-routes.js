// Integration test: real KyberSwap and Velora calldata, real Chainlink oracle, Base fork.
// Hits the live aggregator APIs, so it only runs with REAL_ROUTES=1.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { getQuotes, ROUTERS } = require("../bot/quotes");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const USER = "0x8c62549c7abde21e8ccdb402f4ecf712c14b1c7f";
const WAD = 10n ** 18n;

const morphoAbi = [
  "function idToMarketParams(bytes32) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
  "function position(bytes32,address) view returns (uint256,uint128 borrowShares,uint128 collateral)",
  "function setAuthorization(address,bool)",
];

// Live quotes are priced on the newest chain state. To keep the fork in step with the quote,
// each test forks once to size the sale and fetch the quote, then re-forks at an even newer
// block and executes straight away. The contract lands at the same address both times
// because the deployer's nonce is the same on both forks.
(process.env.REAL_ROUTES ? describe : describe.skip)("Real aggregator routes (Base fork, live oracle)", function () {
  async function freshSetup() {
    const url = network.config.forking.url;
    await network.provider.send("hardhat_reset", [{ forking: { jsonRpcUrl: url } }]);
    await network.provider.send("hardhat_mine", ["0x1"]);
    const [keeper] = await ethers.getSigners();
    const morpho = await ethers.getContractAt(morphoAbi, MORPHO);
    const params = await morpho.idToMarketParams(MARKET_ID);
    await network.provider.send("hardhat_impersonateAccount", [USER]);
    await network.provider.send("hardhat_setBalance", [USER, "0x56BC75E2D63100000"]);
    const user = await ethers.getSigner(USER);
    // Trigger set above today's price so the live oracle counts as "below trigger".
    const d = await (await ethers.getContractFactory("Deleverager")).deploy(
      MORPHO, [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
      USER, keeper.address, 70000n * 10n ** 34n, 105n * WAD / 100n, 150n * WAD / 100n, []);
    await (await morpho.connect(user).setAuthorization(await d.getAddress(), true)).wait();
    for (const r of Object.values(ROUTERS)) await (await d.connect(user).setRouter(r, true)).wait();
    return { d, keeper, morpho };
  }

  for (const source of ["kyberswap", "velora"]) {
    // Asserts the safety property for a live route: it either fills within 0.5% of the oracle
    // and lands the health factor near 1.5, or it fails cleanly with the position untouched.
    // Which outcome happened is printed, because it depends on live liquidity at that moment.
    it(`${source}: real route either fills near health 1.5 or fails cleanly`, async function () {
      let { d } = await freshSetup();
      const taker = await d.getAddress();
      const amount = await d.requiredSell();
      const quotes = await getQuotes({ amountIn: amount, taker, slippageBps: 50, sources: [source] });
      expect(quotes.length, JSON.stringify(quotes.errors)).to.equal(1);
      const q = quotes[0];

      const fresh = await freshSetup();
      d = fresh.d;
      expect(await d.getAddress()).to.equal(taker);
      const before = await fresh.morpho.position(MARKET_ID, USER);
      const rc = await (await d.connect(fresh.keeper).deleverage(amount, q.router, q.data, 1)).wait();
      const events = rc.logs.map((l) => { try { return d.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      const failed = events.find((e) => e.name === "AttemptFailed");
      const after = await fresh.morpho.position(MARKET_ID, USER);
      const hf = await d.healthFactor();
      if (failed) {
        expect(after.collateral).to.equal(before.collateral);
        expect(after.borrowShares).to.equal(before.borrowShares);
        expect(await d.lastTier1FailAt() > 0n).to.equal(true);
        console.log(`      ${source}: FAILED CLEANLY (error ${failed.args.reason.slice(0, 10)}), position untouched, tier 2 unlocked`);
      } else {
        expect(hf >= 148n * WAD / 100n && hf <= 1501n * WAD / 1000n, String(hf)).to.equal(true);
        console.log(`      ${source}: FILLED, sold ${Number(amount) / 1e8} cbBTC, quoted ${Number(q.amountOut) / 1e6} USDC, ` +
          `HF now ${Number(hf) / 1e18}, collateral left ${Number(after.collateral) / 1e8}`);
      }
    });
  }

  it("getQuotes returns the best quote first", async function () {
    const { d } = await freshSetup();
    const amount = await d.requiredSell();
    const quotes = await getQuotes({ amountIn: amount, taker: await d.getAddress(), slippageBps: 50 });
    expect(quotes.length).to.be.greaterThan(0);
    for (let i = 1; i < quotes.length; i++) expect(quotes[i - 1].amountOut >= quotes[i].amountOut).to.equal(true);
  });
});
