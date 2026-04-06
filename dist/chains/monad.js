"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mainnet = void 0;
const ethers_1 = require("ethers");
const KyberSwap_1 = require("../classes/DexAggregators/KyberSwap");
exports.mainnet = {
    chainId: 143,
    dexAgg: new KyberSwap_1.KyberSwap(),
    provider: new ethers_1.JsonRpcProvider("https://rpc1.monad.xyz"),
    native_symbol: 'MON',
    native_name: 'Monad',
    wrapped_native: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    native_vaults: [
        { name: "aprMON", contract: "0x0c65A0BC65a5D819235B71F554D210D3F80E0852" },
        { name: "shMON", contract: "0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c" },
    ],
    vaults: [
        { name: "sAUSD", contract: "0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E", underlying: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" }
    ]
};
//# sourceMappingURL=monad.js.map