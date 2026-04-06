"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testnet = void 0;
const ethers_1 = require("ethers");
const KyberSwap_1 = require("../classes/DexAggregators/KyberSwap");
exports.testnet = {
    chainId: 421614,
    dexAgg: new KyberSwap_1.KyberSwap(),
    provider: new ethers_1.JsonRpcProvider("https://arbitrum-sepolia-testnet.api.pocket.network"),
    native_symbol: 'ETH',
    native_name: 'Ether',
    wrapped_native: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    native_vaults: [],
    vaults: []
};
//# sourceMappingURL=arbitrum.js.map