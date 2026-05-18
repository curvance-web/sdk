import { address } from "../types";
import { KyberSwap } from "../classes/DexAggregators/KyberSwap";
import { EMPTY_ADDRESS } from "../helpers";
import { ChainConfig } from ".";
import { createChainFallbackProviders, createChainPrimaryProvider, getChainRpcConfig } from "./rpc";
import { MONAD_KYBER_SWAP_SERVICE } from "./services";

const kyberSwap = MONAD_KYBER_SWAP_SERVICE;

export const mainnet: ChainConfig = {
    chainId: 143,
    environment: "production-mainnet",
    services: {
        curvanceApi: {
            rewardsSlug: "monad-mainnet",
            rewardChainAliases: ["monad"],
            nativeYieldSlug: "monad",
            suppressedNativeYieldSymbols: ["USDC"],
        },
        dexAggregators: {
            kyberSwap,
        },
    },
    dexAgg: new KyberSwap(EMPTY_ADDRESS, kyberSwap.router, kyberSwap.chainSlug, kyberSwap.apiBase),
    rpc: getChainRpcConfig("monad-mainnet"),
    provider: createChainPrimaryProvider("monad-mainnet"),
    fallbackProviders: createChainFallbackProviders("monad-mainnet"),
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
