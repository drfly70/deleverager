require("@nomicfoundation/hardhat-ethers");
module.exports = {
  solidity: { version: "0.8.19", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hardhat: {
      forking: { url: process.env.BASE_RPC || "https://mainnet.base.org" },
      hardfork: "cancun",
      chains: { 8453: { hardforkHistory: { cancun: 0, prague: 1 } } },
    },
    base: {
      url: process.env.BASE_RPC || "https://mainnet.base.org",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  mocha: { timeout: 300000 },
};
