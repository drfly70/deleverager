// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;
/// Test-only: its runtime code is placed at the market's oracle address on the fork
/// so tests can set the BTC price. Storage slot 0 holds the price.
contract MockOracle {
    uint256 public price;
    function setPrice(uint256 p) external { price = p; }
}
