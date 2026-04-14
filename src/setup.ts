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

export interface SetupConfigSnapshot {
    chain: ChainRpcPrefix;
    contracts: ReturnType<typeof getContractAddresses>;
    provider: curvance_provider;
    approval_protection: boolean;
    api_url: string;
    feePolicy: FeePolicy;
}

export let setup_config: SetupConfigSnapshot;

export let all_markets: Market[] = [];
let latest_setup_invocation = 0;

export interface SetupChainOptions {
    /** Optional fee policy for SDK-initiated DEX swaps (zaps + leverage).
     *  Defaults to NO_FEE_POLICY (zero fees) for backward compatibility. */
    feePolicy?: FeePolicy;
}

function createSetupConfig(
    chain: ChainRpcPrefix,
    provider: curvance_provider,
    approval_protection: boolean,
    api_url: string,
    options: SetupChainOptions,
): SetupConfigSnapshot {
    return {
        chain,
        provider,
        approval_protection,
        contracts: getContractAddresses(chain),
        api_url,
        feePolicy: options.feePolicy ?? NO_FEE_POLICY,
    };
}

function validateSetupConfig(config: SetupConfigSnapshot) {
    if(!("ProtocolReader" in config.contracts)) {
        throw new Error(`Chain configuration for ${config.chain} is missing ProtocolReader address.`);
    } else if (!("OracleManager" in config.contracts)) {
        throw new Error(`Chain configuration for ${config.chain} is missing OracleManager address.`);
    }
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
    const nextSetupConfig = createSetupConfig(chain, provider, approval_protection, api_url, options);
    validateSetupConfig(nextSetupConfig);

    const setupInvocation = ++latest_setup_invocation;
    const { milestones, incentives } = await Api.getRewards(nextSetupConfig);
    const reader = new ProtocolReader(
        nextSetupConfig.contracts.ProtocolReader as address,
        nextSetupConfig.provider,
    );
    const oracle_manager = new OracleManager(
        nextSetupConfig.contracts.OracleManager as address,
        nextSetupConfig.provider,
    );
    const markets = await Market.getAll(
        reader,
        oracle_manager,
        nextSetupConfig.provider,
        milestones,
        incentives,
        nextSetupConfig,
    );

    if(setupInvocation === latest_setup_invocation) {
        setup_config = nextSetupConfig;
        all_markets = markets;
    }

    return {
        markets,
        reader,
        dexAgg: chain_config[chain].dexAgg,
        global_milestone: milestones['global'] ?? null
    };
}
