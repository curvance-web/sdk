import { ChainRpcPrefix, getContractAddresses } from "./helpers";
import { Market } from "./classes/Market";
import { address, curvance_provider, curvance_read_provider, curvance_signer } from './types';
import { ProtocolReader } from "./classes/ProtocolReader";
import { OracleManager } from "./classes/OracleManager";
import { wrapProviderWithRetries } from "./retry-provider";
import { chain_config } from "./chains";
import { Api } from "./classes/Api";
import { validateApiUrl } from "./validation";
import { FeePolicy, defaultFeePolicyForChain } from "./feePolicy";

export interface SetupConfigSnapshot {
    chain: ChainRpcPrefix;
    contracts: ReturnType<typeof getContractAddresses>;
    readProvider: curvance_read_provider;
    signer: curvance_signer | null;
    account: address | null;
    /** @deprecated Prefer readProvider/signer/account. */
    provider: curvance_provider;
    api_url: string;
    feePolicy: FeePolicy;
}

export let setup_config: SetupConfigSnapshot;

export let all_markets: Market[] = [];
let latest_setup_invocation = 0;
let latest_published_setup_invocation = 0;
const pending_setup_invocations = new Set<number>();
const successful_setup_results = new Map<number, {
    setupConfig: SetupConfigSnapshot;
    markets: Market[];
}>();

export interface SetupChainOptions {
    /** Optional fee policy for SDK-initiated DEX swaps (zaps + leverage).
     *  Defaults to the chain's live Curvance fee policy when required. */
    feePolicy?: FeePolicy;
    /** Optional dedicated account for user-specific reads when no signer is available. */
    account?: address | null;
    /** Optional dedicated read provider override. */
    readProvider?: curvance_read_provider | null;
}

export interface SetupChainResult {
    markets: Market[];
    reader: ProtocolReader;
    dexAgg: any;
    global_milestone: any | null;
}

function createSetupConfig(
    chain: ChainRpcPrefix,
    readProvider: curvance_read_provider,
    signer: curvance_signer | null,
    account: address | null,
    api_url: string,
    options: SetupChainOptions,
): SetupConfigSnapshot {
    return {
        chain,
        readProvider,
        signer,
        account,
        provider: signer ?? readProvider,
        contracts: getContractAddresses(chain),
        api_url,
        feePolicy: options.feePolicy ?? defaultFeePolicyForChain(chain),
    };
}

function validateSetupConfig(config: SetupConfigSnapshot) {
    if(!("ProtocolReader" in config.contracts)) {
        throw new Error(`Chain configuration for ${config.chain} is missing ProtocolReader address.`);
    } else if (!("OracleManager" in config.contracts)) {
        throw new Error(`Chain configuration for ${config.chain} is missing OracleManager address.`);
    }
}

async function validateSignerProviderChain(chain: ChainRpcPrefix, signer: curvance_signer | null) {
    if (signer?.provider == null) {
        return;
    }

    const expectedChainId = BigInt(chain_config[chain].chainId);
    const network = await signer.provider.getNetwork();
    const actualChainId = BigInt(network.chainId);

    if (actualChainId !== expectedChainId) {
        throw new Error(
            `Signer provider is connected to chainId ${actualChainId} but setupChain('${chain}') expects ${expectedChainId}.`,
        );
    }
}

function getHighestPendingSetupInvocation() {
    let highest = 0;
    for (const invocation of pending_setup_invocations) {
        if (invocation > highest) {
            highest = invocation;
        }
    }
    return highest;
}

function publishLatestSuccessfulSetup() {
    const highestPending = getHighestPendingSetupInvocation();
    let candidateInvocation = 0;
    let candidate:
        | {
              setupConfig: SetupConfigSnapshot;
              markets: Market[];
          }
        | undefined;

    for (const [invocation, result] of successful_setup_results.entries()) {
        if (
            invocation > latest_published_setup_invocation &&
            invocation > highestPending &&
            invocation > candidateInvocation
        ) {
            candidateInvocation = invocation;
            candidate = result;
        }
    }

    if (candidate == undefined) {
        return;
    }

    latest_published_setup_invocation = candidateInvocation;
    setup_config = candidate.setupConfig;
    all_markets = candidate.markets;

    for (const invocation of [...successful_setup_results.keys()]) {
        if (invocation <= latest_published_setup_invocation) {
            successful_setup_results.delete(invocation);
        }
    }
}

export function setupChain(
    chain: ChainRpcPrefix,
    provider?: curvance_provider | null,
    api_url?: string,
    options?: SetupChainOptions,
): Promise<SetupChainResult>;
export async function setupChain(
    chain: ChainRpcPrefix,
    provider: curvance_provider | null = null,
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
            await validateSignerProviderChain(chain, signer);
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
    const signerAccount = (signer?.address as address | undefined) ?? null;
    const requestedAccount = options.account ?? null;
    if (
        signerAccount != null &&
        requestedAccount != null &&
        signerAccount.toLowerCase() !== requestedAccount.toLowerCase()
    ) {
        throw new Error(
            `setupChain('${chain}') cannot boot with signer ${signerAccount} and read account ${requestedAccount}. ` +
            `Pass a matching account or omit options.account when a signer is connected.`,
        );
    }
    const account = requestedAccount ?? signerAccount;

    const nextSetupConfig = createSetupConfig(
        chain,
        readProvider,
        signer,
        account,
        api_url,
        options,
    );
    validateSetupConfig(nextSetupConfig);

    const setupInvocation = ++latest_setup_invocation;
    pending_setup_invocations.add(setupInvocation);

    try {
        const { milestones, incentives } = await Api.getRewards(nextSetupConfig);
        const reader = new ProtocolReader(
            nextSetupConfig.contracts.ProtocolReader as address,
            nextSetupConfig.readProvider,
            nextSetupConfig.chain,
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

        pending_setup_invocations.delete(setupInvocation);
        successful_setup_results.set(setupInvocation, {
            setupConfig: nextSetupConfig,
            markets,
        });
        publishLatestSuccessfulSetup();

        return {
            markets,
            reader,
            dexAgg: chain_config[chain].dexAgg,
            global_milestone: milestones['global'] ?? null
        };
    } catch (error) {
        pending_setup_invocations.delete(setupInvocation);
        publishLatestSuccessfulSetup();
        throw error;
    }
}

export function getActiveUserMarkets(markets: Market[] = all_markets): Market[] {
    return Market.getActiveUserMarkets(markets);
}

export async function refreshActiveUserMarkets(
    account: address,
    markets: Market[] = all_markets,
): Promise<Market[]> {
    const refreshed = await Market.reloadUserMarkets(markets, account);
    return Market.getActiveUserMarkets(refreshed);
}

export async function refreshActiveUserMarketSummaries(
    account: address,
    markets: Market[] = all_markets,
): Promise<Market[]> {
    return Market.reloadUserMarketSummaries(markets, account);
}
