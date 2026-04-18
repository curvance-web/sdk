import { ChainRpcPrefix, getContractAddresses } from "./helpers";
import { Market } from "./classes/Market";
import { address, curvance_provider, curvance_read_provider, curvance_signer } from './types';
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
    readProvider: curvance_read_provider;
    signer: curvance_signer | null;
    account: address | null;
    /** @deprecated Prefer readProvider/signer/account. */
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
    /** Optional dedicated account for user-specific reads when no signer is available. */
    account?: address | null;
    /** Optional dedicated read provider override. */
    readProvider?: curvance_read_provider | null;
}

function createSetupConfig(
    chain: ChainRpcPrefix,
    readProvider: curvance_read_provider,
    signer: curvance_signer | null,
    account: address | null,
    approval_protection: boolean,
    api_url: string,
    options: SetupChainOptions,
): SetupConfigSnapshot {
    return {
        chain,
        readProvider,
        signer,
        account,
        provider: signer ?? readProvider,
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

    const chainReadProvider = chain_config[chain].provider;
    const readFallbacks = chain_config[chain].fallbackProviders;
    let signer: curvance_signer | null = null;
    let readProviderOverride = options.readProvider ?? null;

    if(provider != null) {
        if("address" in provider) {
            signer = provider as curvance_signer;
            // Wallet-primary for reads: when a wallet is connected, its own
            // provider is the primary read source. chainReadProvider + chain
            // fallbacks become the fallback chain via wrapProviderWithRetries
            // below. This distributes read load across users' wallet RPCs
            // instead of funneling every Curvance session through one origin,
            // and matches the pre-`358d46b` architecture the original author
            // designed (explicitly citing Rabby as the unreliable-wallet case).
            // Explicit `options.readProvider` wins if set.
            if(!readProviderOverride && signer.provider) {
                readProviderOverride = signer.provider as curvance_read_provider;
            }
        } else {
            readProviderOverride = provider as curvance_read_provider;
        }
    }

    const readProvider = wrapProviderWithRetries(
        readProviderOverride ?? chainReadProvider,
        readProviderOverride ? [chainReadProvider, ...readFallbacks] : readFallbacks,
    );
    const account = options.account ?? (signer?.address as address | undefined) ?? null;

    const nextSetupConfig = createSetupConfig(
        chain,
        readProvider,
        signer,
        account,
        approval_protection,
        api_url,
        options,
    );
    validateSetupConfig(nextSetupConfig);

    const setupInvocation = ++latest_setup_invocation;
    const { milestones, incentives } = await Api.getRewards(nextSetupConfig);
    const reader = new ProtocolReader(
        nextSetupConfig.contracts.ProtocolReader as address,
        nextSetupConfig.readProvider,
    );
    const oracle_manager = new OracleManager(
        nextSetupConfig.contracts.OracleManager as address,
        nextSetupConfig.readProvider,
    );
    const markets = await Market.getAll(
        reader,
        oracle_manager,
        nextSetupConfig.readProvider,
        nextSetupConfig.signer,
        nextSetupConfig.account,
        milestones,
        incentives,
        nextSetupConfig,
    );

    if(setupInvocation === latest_setup_invocation) {
        setup_config = nextSetupConfig;
        all_markets = markets;
    } else {
        console.debug(
            `[setupChain] invocation ${setupInvocation} superseded by ${latest_setup_invocation}, not publishing to globals`
        );
    }

    return {
        markets,
        reader,
        dexAgg: chain_config[chain].dexAgg,
        global_milestone: milestones['global'] ?? null
    };
}

export function getActiveUserMarkets(markets: Market[] = all_markets): Market[] {
    return Market.getActiveUserMarkets(markets);
}

export async function refreshActiveUserMarkets(
    account: address,
    markets: Market[] = all_markets,
): Promise<Market[]> {
    return Market.reloadUserMarkets(getActiveUserMarkets(markets), account);
}
