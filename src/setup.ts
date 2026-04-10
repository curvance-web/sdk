import { ChainRpcPrefix, getContractAddresses } from "./helpers";
import { Market } from "./classes/Market";
import { address, curvance_provider } from './types';
import { ProtocolReader } from "./classes/ProtocolReader";
import { OracleManager } from "./classes/OracleManager";
import { wrapProviderWithRetries } from "./retry-provider";
import { chain_config } from "./chains";
import { Api } from "./classes/Api";
import { validateApiUrl } from "./validation";
import { FeePolicy, NO_FEE_POLICY } from "./feePolicy";

export let setup_config: {
    chain: ChainRpcPrefix;
    contracts: ReturnType<typeof getContractAddresses>;
    provider: curvance_provider;
    approval_protection: boolean;
    api_url: string;
    feePolicy: FeePolicy;
};

export let all_markets: Market[] = [];

export interface SetupChainOptions {
    /** Optional fee policy for SDK-initiated DEX swaps (zaps + leverage).
     *  Defaults to NO_FEE_POLICY (zero fees) for backward compatibility. */
    feePolicy?: FeePolicy;
}

export async function setupChain(
    chain: ChainRpcPrefix,
    provider: curvance_provider | null = null,
    approval_protection: boolean = false,
    api_url: string = "https://api.curvance.com",
    options: SetupChainOptions = {},
) {
    if(!(chain in chain_config)) {
        throw new Error("Chain does not have a corresponding config");
    }

    // Validate api_url scheme before any network calls
    validateApiUrl(api_url);

    if(provider == null) {
        provider = chain_config[chain].provider!;
    }

    provider = wrapProviderWithRetries(provider);

    setup_config = {
        chain,
        provider,
        approval_protection,
        contracts: getContractAddresses(chain),
        api_url,
        feePolicy: options.feePolicy ?? NO_FEE_POLICY,
    }

    if(!("ProtocolReader" in setup_config.contracts)) {
        throw new Error(`Chain configuration for ${chain} is missing ProtocolReader address.`);
    } else if (!("OracleManager" in setup_config.contracts)) {
        throw new Error(`Chain configuration for ${chain} is missing OracleManager address.`);
    }

    const { milestones, incentives } = await Api.getRewards();
    const reader = new ProtocolReader(setup_config.contracts.ProtocolReader as address)
    const oracle_manager = new OracleManager(setup_config.contracts.OracleManager as address);

    all_markets = await Market.getAll(reader, oracle_manager, setup_config.provider, milestones, incentives);

    return {
        markets: all_markets,
        reader,
        dexAgg: chain_config[chain].dexAgg,
        global_milestone: milestones['global'] ?? null
    };
}