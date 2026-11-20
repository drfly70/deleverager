// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IMorpho, MarketParams, Id} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import {IMorphoRepayCallback} from "@morpho-org/morpho-blue/src/interfaces/IMorphoCallbacks.sol";
import {IOracle} from "@morpho-org/morpho-blue/src/interfaces/IOracle.sol";
import {MarketParamsLib} from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import {MorphoLib} from "@morpho-org/morpho-blue/src/libraries/periphery/MorphoLib.sol";
import {MorphoBalancesLib} from "@morpho-org/morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// @title Deleverager
/// @notice Sells part of ONE owner's collateral in ONE Morpho Blue market to repay debt,
///         bringing the health factor back to a target. It can only act when the oracle
///         price is below `triggerPrice` or the health factor is at or below `FLOOR_HF`.
/// @dev The owner must call `morpho.setAuthorization(this, true)`. Morpho authorization is
///      all-or-nothing, so this contract deliberately has no borrow, no withdraw-to-anyone,
///      and no arbitrary-call path except an allowlisted swap router that only receives an
///      allowance for the exact collateral being sold.
contract Deleverager is IMorphoRepayCallback {
    using MarketParamsLib for MarketParams;
    using MorphoLib for IMorpho;
    using MorphoBalancesLib for IMorpho;

    uint256 private constant WAD = 1e18;
    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    uint256 private constant BPS = 10_000;

    /// @notice First attempt may fill at most 0.5% below the oracle price.
    uint256 public constant TIER1_SLIPPAGE_BPS = 50;
    /// @notice Second attempt may fill at most 1.5% below, only after a tier-1 attempt failed.
    uint256 public constant TIER2_SLIPPAGE_BPS = 150;
    /// @notice How long a tier-1 failure unlocks tier 2.
    uint256 public constant TIER2_WINDOW = 10 minutes;
    /// @notice Minimum gas left when an attempt starts. Live KyberSwap/Velora routes on the
    ///         Base fork used about 1.1M-1.3M gas for this sale.
    uint256 public constant MIN_ATTEMPT_GAS = 3_000_000;

    IMorpho public immutable MORPHO;
    address public immutable OWNER;
    address public immutable LOAN_TOKEN;
    address public immutable COLLATERAL_TOKEN;
    address public immutable ORACLE;
    address public immutable IRM;
    uint256 public immutable LLTV;
    Id public immutable MARKET_ID;
    uint256 public immutable FLOOR_HF;
    uint256 public immutable TARGET_HF;

    address public keeper;
    uint256 public triggerPrice; // in Morpho oracle scale
    bool public paused;
    uint256 public lastTier1FailAt;
    mapping(address => bool) public routerAllowed;

    bool private executing;

    error NotAuthorized();
    error NotOwner();
    error IsPaused();
    error RouterNotAllowed();
    error BadRouter();
    error NotTriggered();
    error Oversell();
    error BadTier();
    error Tier2NotAllowed();
    error NotMorpho();
    error NotSelf();
    error Slippage();
    error BadConfig();
    error ApproveFailed();
    error InsufficientGas();

    event Deleveraged(uint8 tier, uint256 collateralSold, uint256 hfBefore, uint256 hfAfter);
    event AttemptFailed(uint8 tier, bytes reason);
    event RouterSet(address router, bool allowed);
    event KeeperSet(address keeper);
    event PausedSet(bool paused);
    event TriggerPriceSet(uint256 price);

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner();
        _;
    }

    constructor(
        IMorpho morpho,
        MarketParams memory params,
        address owner,
        address keeper_,
        uint256 triggerPrice_,
        uint256 floorHf,
        uint256 targetHf,
        address[] memory routers
    ) {
        if (owner == address(0) || floorHf < WAD || targetHf <= floorHf || targetHf <= params.lltv) revert BadConfig();
        MORPHO = morpho;
        OWNER = owner;
        LOAN_TOKEN = params.loanToken;
        COLLATERAL_TOKEN = params.collateralToken;
        ORACLE = params.oracle;
        IRM = params.irm;
        LLTV = params.lltv;
        MARKET_ID = params.id();
        FLOOR_HF = floorHf;
        TARGET_HF = targetHf;
        keeper = keeper_;
        triggerPrice = triggerPrice_;
        for (uint256 i; i < routers.length; ++i) _setRouter(routers[i], true);
    }

    // ---------------------------------------------------------------- views

    function marketParams() public view returns (MarketParams memory) {
        return MarketParams(LOAN_TOKEN, COLLATERAL_TOKEN, ORACLE, IRM, LLTV);
    }

    /// @notice Owner's health factor (WAD), including interest accrued since the last update.
    function healthFactor() public view returns (uint256) {
        uint256 borrow = MORPHO.expectedBorrowAssets(marketParams(), OWNER);
        if (borrow == 0) return type(uint256).max;
        return _collateralValue() * LLTV / borrow;
    }

    /// @notice Collateral to sell (collateral-token units) so the health factor lands on TARGET_HF,
    ///         assuming a fill at the oracle price. 0 if already at or above target.
    function requiredSell() public view returns (uint256) {
        uint256 debt = MORPHO.expectedBorrowAssets(marketParams(), OWNER);
        uint256 value = _collateralValue();
        if (debt == 0 || value * LLTV >= TARGET_HF * debt) return 0;
        // Solve (value - x) * LLTV / (debt - x) = TARGET_HF for x (loan-token units).
        uint256 x = (TARGET_HF * debt - value * LLTV) / (TARGET_HF - LLTV);
        return x * ORACLE_PRICE_SCALE / IOracle(ORACLE).price();
    }

    function _collateralValue() internal view returns (uint256) {
        return MORPHO.collateral(MARKET_ID, OWNER) * IOracle(ORACLE).price() / ORACLE_PRICE_SCALE;
    }

    // ---------------------------------------------------------------- action

    /// @notice Sell `amount` collateral through `router` using `swapData` and repay the debt.
    /// @return success false if the swap or repay failed (position untouched); tier-1 failures
    ///         unlock tier 2 for TIER2_WINDOW.
    function deleverage(uint256 amount, address router, bytes calldata swapData, uint8 tier)
        external
        returns (bool success)
    {
        if (msg.sender != keeper && msg.sender != OWNER) revert NotAuthorized();
        if (paused) revert IsPaused();
        if (!routerAllowed[router]) revert RouterNotAllowed();

        uint256 price = IOracle(ORACLE).price();
        uint256 hfBefore = healthFactor();
        if (price >= triggerPrice && hfBefore > FLOOR_HF) revert NotTriggered();
        if (amount == 0 || amount > requiredSell()) revert Oversell();

        uint256 slippageBps;
        if (tier == 1) {
            slippageBps = TIER1_SLIPPAGE_BPS;
        } else if (tier == 2) {
            if (lastTier1FailAt == 0 || block.timestamp > lastTier1FailAt + TIER2_WINDOW) revert Tier2NotAllowed();
            slippageBps = TIER2_SLIPPAGE_BPS;
        } else {
            revert BadTier();
        }
        uint256 minOut = amount * price / ORACLE_PRICE_SCALE * (BPS - slippageBps) / BPS;

        // Every attempt must carry plenty of gas. Otherwise an under-gassed transaction (or a gas
        // estimator, which searches for the least gas that doesn't revert) could make the swap run
        // out of gas deep inside the route, which the catch below would record as a tier-1
        // failure and so unlock the 1.5% tier without any real price problem.
        if (gasleft() < MIN_ATTEMPT_GAS) revert InsufficientGas();
        try this.executeSelf(amount, router, swapData, minOut) {
            lastTier1FailAt = 0;
            emit Deleveraged(tier, amount, hfBefore, healthFactor());
            return true;
        } catch (bytes memory reason) {
            if (tier == 1) lastTier1FailAt = block.timestamp;
            emit AttemptFailed(tier, reason);
            return false;
        }
    }

    /// @dev External only so `deleverage` can try/catch it; callable by this contract alone.
    function executeSelf(uint256 amount, address router, bytes calldata swapData, uint256 minOut) external {
        if (msg.sender != address(this)) revert NotSelf();
        MarketParams memory params = marketParams();

        executing = true;
        MORPHO.repay(params, minOut, 0, OWNER, abi.encode(amount, router, swapData));
        executing = false;

        // Any fill above the minimum also goes to the debt; anything past full repayment goes to the owner.
        uint256 extra = IERC20Min(LOAN_TOKEN).balanceOf(address(this));
        if (extra > 0) {
            _approve(LOAN_TOKEN, address(MORPHO), extra);
            if (extra >= MORPHO.expectedBorrowAssets(params, OWNER)) {
                MORPHO.repay(params, 0, MORPHO.borrowShares(MARKET_ID, OWNER), OWNER, "");
            } else {
                MORPHO.repay(params, extra, 0, OWNER, "");
            }
            _approve(LOAN_TOKEN, address(MORPHO), 0);
            uint256 rest = IERC20Min(LOAN_TOKEN).balanceOf(address(this));
            if (rest > 0 && !IERC20Min(LOAN_TOKEN).transfer(OWNER, rest)) revert ApproveFailed();
        }

        // Collateral the router did not use goes back into the owner's position.
        uint256 unused = IERC20Min(COLLATERAL_TOKEN).balanceOf(address(this));
        if (unused > 0) {
            _approve(COLLATERAL_TOKEN, address(MORPHO), unused);
            MORPHO.supplyCollateral(params, unused, OWNER, "");
        }
    }

    /// @inheritdoc IMorphoRepayCallback
    function onMorphoRepay(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(MORPHO) || !executing) revert NotMorpho();
        (uint256 amount, address router, bytes memory swapData) = abi.decode(data, (uint256, address, bytes));

        MORPHO.withdrawCollateral(marketParams(), amount, OWNER, address(this));

        _approve(COLLATERAL_TOKEN, router, amount);
        (bool ok, bytes memory ret) = router.call(swapData);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        _approve(COLLATERAL_TOKEN, router, 0);

        if (IERC20Min(LOAN_TOKEN).balanceOf(address(this)) < assets) revert Slippage();
        _approve(LOAN_TOKEN, address(MORPHO), assets);
    }

    // ---------------------------------------------------------------- owner settings

    function setRouter(address router, bool allowed) external onlyOwner {
        _setRouter(router, allowed);
    }

    function _setRouter(address router, bool allowed) internal {
        if (
            router == LOAN_TOKEN || router == COLLATERAL_TOKEN || router == address(MORPHO) || router == ORACLE
                || router == address(this) || router == address(0)
        ) revert BadRouter();
        routerAllowed[router] = allowed;
        emit RouterSet(router, allowed);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setTriggerPrice(uint256 price) external onlyOwner {
        triggerPrice = price;
        emit TriggerPriceSet(price);
    }

    function _approve(address token, address spender, uint256 amount) internal {
        if (!IERC20Min(token).approve(spender, amount)) revert ApproveFailed();
    }
}
