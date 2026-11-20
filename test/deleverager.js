// Fork tests for Deleverager against the live Base position of
// 0x8c62549c7abde21e8ccdb402f4ecf712c14b1c7f in Morpho market 0x9103c3b4…434191836.
// Health factor is computed here in JS straight from Morpho storage + oracle,
// independently of the contract's own math.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const USER = "0x8c62549c7abde21e8ccdb402f4ecf712c14b1c7f";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";

const WAD = 10n ** 18n;
const px = (usd) => BigInt(Math.round(usd * 100)) * 10n ** 32n; // USD per BTC -> Morpho oracle scale (1e36 * 1e6 / 1e8)
const TRIGGER = px(59000);
const FLOOR = 105n * WAD / 100n;
const TARGET = 150n * WAD / 100n;

const morphoAbi = [
  "function position(bytes32,address) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function market(bytes32) view returns (uint128,uint128,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function idToMarketParams(bytes32) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
  "function setAuthorization(address,bool)",
  "function accrueInterest((address,address,address,address,uint256))",
];
const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];

async function expectRevert(p, name) {
  try { await p; } catch (e) {
    expect(e.message, e.message).to.include(name);
    return;
  }
  expect.fail(`expected revert ${name}`);
}

describe("Deleverager (Base fork)", function () {
  let morpho, params, oracle, user, keeper, stranger, d, router, usdc, cbbtc, snap;

  async function setPrice(usd) { await oracle.setPrice(px(usd)); }

  async function jsHealth() {
    await (await morpho.accrueInterest([params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv])).wait();
    const pos = await morpho.position(MARKET_ID, USER);
    const m = await morpho.market(MARKET_ID);
    const borrow = (BigInt(pos.borrowShares) * (BigInt(m.totalBorrowAssets) + 1n) + (BigInt(m.totalBorrowShares) + 10n ** 6n) - 1n)
      / (BigInt(m.totalBorrowShares) + 10n ** 6n);
    const price = await oracle.price();
    const collValue = BigInt(pos.collateral) * price / 10n ** 36n;
    return { hf: collValue * BigInt(params.lltv) / borrow, collateral: BigInt(pos.collateral), borrow, price };
  }

  function swapData(amountIn, priceUsd, slipBps) {
    const out = amountIn * px(priceUsd) / 10n ** 36n * BigInt(10000 - slipBps) / 10000n;
    return router.interface.encodeFunctionData("swap", [CBBTC, USDC, amountIn, out]);
  }

  async function run(signer, priceUsd, slipBps, tier, amountOverride) {
    const amount = amountOverride ?? await d.requiredSell();
    const data = swapData(amount, priceUsd, slipBps);
    const ok = await d.connect(signer).deleverage.staticCall(amount, await router.getAddress(), data, tier);
    await (await d.connect(signer).deleverage(amount, await router.getAddress(), data, tier)).wait();
    return { ok, amount };
  }

  before(async function () {
    await network.provider.send("hardhat_mine", ["0x1"]);
    [keeper, stranger] = await ethers.getSigners();
    morpho = await ethers.getContractAt(morphoAbi, MORPHO);
    params = await morpho.idToMarketParams(MARKET_ID);
    usdc = await ethers.getContractAt(erc20Abi, USDC);
    cbbtc = await ethers.getContractAt(erc20Abi, CBBTC);

    // Put a settable oracle at the market's oracle address.
    const mockOracle = await (await ethers.getContractFactory("MockOracle")).deploy();
    await network.provider.send("hardhat_setCode", [params.oracle, await ethers.provider.getCode(await mockOracle.getAddress())]);
    oracle = await ethers.getContractAt("MockOracle", params.oracle);

    await network.provider.send("hardhat_impersonateAccount", [USER]);
    await network.provider.send("hardhat_setBalance", [USER, "0x56BC75E2D63100000"]);
    user = await ethers.getSigner(USER);

    d = await (await ethers.getContractFactory("Deleverager")).deploy(
      MORPHO, [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
      USER, keeper.address, TRIGGER, FLOOR, TARGET, []);
    await (await morpho.connect(user).setAuthorization(await d.getAddress(), true)).wait();

    router = await (await ethers.getContractFactory("MockRouter")).deploy();
    await network.provider.send("hardhat_impersonateAccount", [MORPHO]);
    await network.provider.send("hardhat_setBalance", [MORPHO, "0x56BC75E2D63100000"]);
    await (await usdc.connect(await ethers.getSigner(MORPHO)).transfer(await router.getAddress(), 100_000n * 10n ** 6n)).wait();
    await (await d.connect(user).setRouter(await router.getAddress(), true)).wait();

    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async function () {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
  });

  it("rule A: daily-close trigger below $59k sells down to health 1.5", async function () {
    await setPrice(58900);
    const before = await jsHealth();
    const { ok, amount } = await run(keeper, 58900, 30, 1);
    const after = await jsHealth();
    expect(ok).to.equal(true);
    expect(after.collateral).to.equal(before.collateral - amount);
    expect((after.hf) >= (148n * WAD / 100n), String(after.hf) + " >= " + String(148n * WAD / 100n)).to.equal(true);
    expect((after.hf) <= (1501n * WAD / 1000n), String(after.hf) + " <= " + String(1501n * WAD / 1000n)).to.equal(true);
    expect(await usdc.balanceOf(await d.getAddress())).to.equal(0n);
    expect(await cbbtc.balanceOf(await d.getAddress())).to.equal(0n);
    console.log(`      sold ${Number(amount) / 1e8} cbBTC; HF ${Number(before.hf) / 1e18} -> ${Number(after.hf) / 1e18}; ` +
      `liq price $${Math.round(58900 / (Number(after.hf) / 1e18))}`);
  });

  it("does nothing while price is above the trigger and health is above the floor", async function () {
    await setPrice(61000);
    const amount = 1_000_000n;
    await expectRevert(d.connect(keeper).deleverage(amount, await router.getAddress(), swapData(amount, 61000, 0), 1), "NotTriggered");
  });

  it("rule B: health at or below 1.05 triggers even above the price trigger", async function () {
    await (await d.connect(user).setTriggerPrice(px(50000))).wait();
    await setPrice(55000);
    const before = await jsHealth();
    expect((before.hf) <= (FLOOR), String(before.hf) + " <= " + String(FLOOR)).to.equal(true);
    const { ok } = await run(keeper, 55000, 30, 1);
    const after = await jsHealth();
    expect(ok).to.equal(true);
    expect((after.hf) >= (148n * WAD / 100n), String(after.hf) + " >= " + String(148n * WAD / 100n)).to.equal(true);
  });

  it("refuses to sell more than needed to reach the target", async function () {
    await setPrice(58900);
    const amount = (await d.requiredSell()) * 101n / 100n;
    await expectRevert(d.connect(keeper).deleverage(amount, await router.getAddress(), swapData(amount, 58900, 0), 1), "Oversell");
  });

  it("tier 1 (0.5%): a worse fill is recorded as failed and leaves the position untouched", async function () {
    await setPrice(58900);
    const before = await jsHealth();
    const { ok } = await run(keeper, 58900, 100, 1);
    const after = await jsHealth();
    expect(ok).to.equal(false);
    expect(after.collateral).to.equal(before.collateral);
    expect((await d.lastTier1FailAt()) > (0n), String(await d.lastTier1FailAt()) + " > " + String(0n)).to.equal(true);
  });

  it("tier 2 (1.5%) is refused unless a tier-1 attempt failed first", async function () {
    await setPrice(58900);
    const amount = await d.requiredSell();
    await expectRevert(d.connect(keeper).deleverage(amount, await router.getAddress(), swapData(amount, 58900, 100), 2), "Tier2NotAllowed");
  });

  it("tier 2 accepts a 1% worse fill after a tier-1 failure", async function () {
    await setPrice(58900);
    expect((await run(keeper, 58900, 100, 1)).ok).to.equal(false);
    const before = await jsHealth();
    const { ok } = await run(keeper, 58900, 100, 2);
    const after = await jsHealth();
    expect(ok).to.equal(true);
    expect((after.hf) > (before.hf), String(after.hf) + " > " + String(before.hf)).to.equal(true);
  });

  it("tier 2 still rejects a 2% worse fill", async function () {
    await setPrice(58900);
    await run(keeper, 58900, 100, 1);
    const before = await jsHealth();
    const { ok } = await run(keeper, 58900, 200, 2);
    expect(ok).to.equal(false);
    expect((await jsHealth()).collateral).to.equal(before.collateral);
  });

  it("tier 2 permission expires 10 minutes after the tier-1 failure", async function () {
    await setPrice(58900);
    await run(keeper, 58900, 100, 1);
    await network.provider.send("evm_increaseTime", [11 * 60]);
    await network.provider.send("hardhat_mine", ["0x1"]);
    const amount = await d.requiredSell();
    await expectRevert(d.connect(keeper).deleverage(amount, await router.getAddress(), swapData(amount, 58900, 100), 2), "Tier2NotAllowed");
  });

  it("a tier-1 attempt starved of gas reverts instead of unlocking tier 2", async function () {
    await setPrice(58900);
    const amount = await d.requiredSell();
    // A route that uses ~1M gas, like the real aggregator routes measured on the fork.
    const out = amount * px(58900) / 10n ** 36n;
    const data = router.interface.encodeFunctionData("swapHeavy", [CBBTC, USDC, amount, out, 1_000_000n]);
    const full = await d.connect(keeper).deleverage.estimateGas(amount, await router.getAddress(), data, 1);
    let base = await network.provider.send("evm_snapshot");
    const unlockedAt = [];
    const succeededAt = [];
    for (let gas = full - 400_000n; gas < 3_400_000n; gas += 20_000n) {
      await network.provider.send("evm_revert", [base]);
      base = await network.provider.send("evm_snapshot");
      try {
        await (await d.connect(keeper).deleverage(amount, await router.getAddress(), data, 1, { gasLimit: gas })).wait();
      } catch (e) { continue; }
      if ((await d.lastTier1FailAt()) > 0n) unlockedAt.push(gas);
      else succeededAt.push(gas);
    }
    await network.provider.send("evm_revert", [base]);
    expect(unlockedAt.map(String), `tier 2 unlocked by low gas at: ${unlockedAt}`).to.deep.equal([]);
    expect(succeededAt.length > 0, "the heavy route never succeeded, even with ample gas").to.equal(true);
  });

  it("only the keeper or the owner can run it", async function () {
    await setPrice(58900);
    const amount = await d.requiredSell();
    await expectRevert(d.connect(stranger).deleverage(amount, await router.getAddress(), swapData(amount, 58900, 0), 1), "NotAuthorized");
  });

  it("only allowlisted routers can be used", async function () {
    await setPrice(58900);
    const other = await (await ethers.getContractFactory("MockRouter")).deploy();
    const amount = await d.requiredSell();
    await expectRevert(d.connect(keeper).deleverage(amount, await other.getAddress(), swapData(amount, 58900, 0), 1), "RouterNotAllowed");
  });

  it("the tokens and Morpho itself can never be allowlisted as a router", async function () {
    for (const a of [USDC, CBBTC, MORPHO]) await expectRevert(d.connect(user).setRouter(a, true), "BadRouter");
  });

  it("routers can be allowlisted at deployment, so the owner needs no extra transaction", async function () {
    const F = await ethers.getContractFactory("Deleverager");
    const mp = [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv];
    const other = await (await ethers.getContractFactory("MockRouter")).deploy();
    const d2 = await F.deploy(MORPHO, mp, USER, keeper.address, TRIGGER, FLOOR, TARGET, [await other.getAddress()]);
    expect(await d2.routerAllowed(await other.getAddress())).to.equal(true);
    await expectRevert(F.deploy(MORPHO, mp, USER, keeper.address, TRIGGER, FLOOR, TARGET, [USDC]), "BadRouter");
  });

  it("pausing blocks it", async function () {
    await setPrice(58900);
    await (await d.connect(user).setPaused(true)).wait();
    const amount = await d.requiredSell();
    await expectRevert(d.connect(keeper).deleverage(amount, await router.getAddress(), swapData(amount, 58900, 0), 1), "IsPaused");
  });

  it("only the owner can change settings", async function () {
    await expectRevert(d.connect(keeper).setRouter(stranger.address, true), "NotOwner");
    await expectRevert(d.connect(keeper).setKeeper(stranger.address), "NotOwner");
    await expectRevert(d.connect(keeper).setPaused(true), "NotOwner");
    await expectRevert(d.connect(keeper).setTriggerPrice(1n), "NotOwner");
  });

  it("revoking the Morpho authorization stops it from touching the position", async function () {
    await setPrice(58900);
    await (await morpho.connect(user).setAuthorization(await d.getAddress(), false)).wait();
    const before = await jsHealth();
    const { ok } = await run(keeper, 58900, 0, 1);
    expect(ok).to.equal(false);
    expect((await jsHealth()).collateral).to.equal(before.collateral);
  });

  it("nobody can call the repay callback directly", async function () {
    await expectRevert(d.connect(stranger).onMorphoRepay(1n, "0x"), "NotMorpho");
  });

  it("health factor view matches the independent calculation", async function () {
    await setPrice(60000);
    const js = await jsHealth();
    const onchain = await d.healthFactor();
    const diff = onchain > js.hf ? onchain - js.hf : js.hf - onchain;
    expect((diff) <= (10n ** 12n), String(diff) + " <= " + String(10n ** 12n)).to.equal(true);
  });
});
