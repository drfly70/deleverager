// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;
interface IERC20T {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}
/// Test-only stand-in for a DEX aggregator router: pulls `amountIn` of tokenIn
/// from the caller and pays `amountOut` of tokenOut from its own pre-funded balance.
contract MockRouter {
    /// Burns roughly `burnGas` before swapping, to mimic a real multi-hop route's gas use.
    function swapHeavy(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 burnGas) external {
        uint256 stop = gasleft() - burnGas;
        while (gasleft() > stop) {}
        swap(tokenIn, tokenOut, amountIn, amountOut);
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) public {
        require(IERC20T(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull");
        require(IERC20T(tokenOut).transfer(msg.sender, amountOut), "pay");
    }
}
