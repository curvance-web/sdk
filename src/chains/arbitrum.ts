import { JsonRpcProvider } from "ethers";
import { address } from "../types";
import { KyberSwap } from "../classes/DexAggregators/KyberSwap";
import { ChainConfig } from ".";

export const testnet: ChainConfig = {
    chainId: 421614,
    dexAgg: new KyberSwap(),
    provider: new JsonRpcProvider("https://arbitrum-sepolia-testnet.api.pocket.network"),
    native_symbol: 'ETH',
    native_name: 'Ether',
    wrapped_native: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as address,
    native_vaults: [],
    vaults: []
}