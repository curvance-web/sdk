import { ChainRpcPrefix, getContractAddresses } from "./helpers";
import { Market } from "./classes/Market";
import { curvance_provider } from './types';
import { ProtocolReader } from "./classes/ProtocolReader";
export declare let setup_config: {
    chain: ChainRpcPrefix;
    contracts: ReturnType<typeof getContractAddresses>;
    provider: curvance_provider;
    approval_protection: boolean;
    api_url: string;
};
export declare let all_markets: Market[];
export declare function setupChain(chain: ChainRpcPrefix, provider?: curvance_provider | null, approval_protection?: boolean, api_url?: string): Promise<{
    markets: Market[];
    reader: ProtocolReader;
    dexAgg: import("./classes/DexAggregators/IDexAgg").default;
    global_milestone: import("./classes/Api").MilestoneResponse | null;
}>;
//# sourceMappingURL=setup.d.ts.map