import { JsonRpcProvider } from "ethers";
import { address } from "../types";
import { KyberSwap } from "../classes/DexAggregators/KyberSwap";
import { ChainConfig } from ".";

export const mainnet: ChainConfig = {
    chainId: 143,
    dexAgg: new KyberSwap(),
    provider: new JsonRpcProvider("https://rpc1.monad.xyz"),
    native_symbol: 'MON',
    native_name: 'Monad',
    wrapped_native: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as address,
    native_vaults: [
        { name: "aprMON", contract: "0x0c65A0BC65a5D819235B71F554D210D3F80E0852" as address },
        { name: "shMON", contract: "0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c" as address },
    ],
    vaults: [
        { name: "sAUSD", contract: "0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E" as address, underlying: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as address }
    ]
};