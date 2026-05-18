import type { SetupConfigSnapshot } from "../setup";
import { chain_config } from "../chains";
import { address } from "../types";
import { fetchWithTimeout, validateApiUrl } from "../validation";

export type IncentiveResponse = {
    market: address,
    type: string,
    rate: number,
    description: string,
    image: string
};

export type MilestoneResponse = {
    market: address;
    tvl: number;
    multiplier: number;
    fail_multiplier: number;
    chain_network: string;
    start_date: string;
    end_date: string;
    duration_in_days: number;
}
export type Milestones = { [key: string]: MilestoneResponse };
export type Incentives = { [key: string]: Array<IncentiveResponse> };
type ApiRequestConfig = Pick<SetupConfigSnapshot, "chain" | "api_url"> & {
    services?: SetupConfigSnapshot["services"];
};

function isRewardsResponse(
    value: unknown,
): value is { milestones: Array<MilestoneResponse>; incentives: Array<IncentiveResponse> } {
    if (typeof value !== "object" || value == null) {
        return false;
    }

    const maybeRewards = value as {
        milestones?: unknown;
        incentives?: unknown;
    };

    return Array.isArray(maybeRewards.milestones) && Array.isArray(maybeRewards.incentives);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
    return isFiniteNumber(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isMilestoneResponse(value: unknown): value is MilestoneResponse {
    if (typeof value !== "object" || value == null) {
        return false;
    }

    const row = value as Partial<Record<keyof MilestoneResponse, unknown>>;
    return (
        isNonEmptyString(row.market) &&
        isNonNegativeFiniteNumber(row.tvl) &&
        isNonNegativeFiniteNumber(row.multiplier) &&
        isNonNegativeFiniteNumber(row.fail_multiplier) &&
        isNonEmptyString(row.chain_network) &&
        isNonEmptyString(row.start_date) &&
        isNonEmptyString(row.end_date) &&
        isPositiveFiniteNumber(row.duration_in_days)
    );
}

function isIncentiveResponse(value: unknown): value is IncentiveResponse {
    if (typeof value !== "object" || value == null) {
        return false;
    }

    const row = value as Partial<Record<keyof IncentiveResponse, unknown>>;
    return (
        isNonEmptyString(row.market) &&
        isNonEmptyString(row.type) &&
        isNonNegativeFiniteNumber(row.rate) &&
        isNonEmptyString(row.description) &&
        isNonEmptyString(row.image)
    );
}

function normalizeMarketKey(market: string): string {
    return market.toLowerCase();
}

function normalizeChainNetwork(chain: string): string {
    return chain.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function resolveCurvanceApiServices(config: ApiRequestConfig) {
    const services = config.services?.curvanceApi ?? chain_config[config.chain]?.services.curvanceApi;
    if (services == null) {
        throw new Error(`Chain configuration for ${config.chain} is missing Curvance API services.`);
    }
    return services;
}

function acceptedMilestoneChainNetworks(config: ApiRequestConfig): Set<string> {
    const { chain } = config;
    const normalized = normalizeChainNetwork(chain);
    const aliases = new Set([normalized]);
    const services = resolveCurvanceApiServices(config);

    for (const alias of services.rewardChainAliases) {
        aliases.add(normalizeChainNetwork(alias));
    }

    return aliases;
}

function isNativeYieldRow(value: unknown): value is { symbol: string; apy: number } {
    if (typeof value !== "object" || value == null) {
        return false;
    }

    const row = value as { symbol?: unknown; apy?: unknown };
    return typeof row.symbol === "string" && isNonNegativeFiniteNumber(row.apy);
}

function resolveDefaultSetupConfig(context: string): SetupConfigSnapshot {
    const config = (require("../setup") as typeof import("../setup")).setup_config;
    if (config == undefined) {
        throw new Error(
            `Setup config is not configured for ${context}. ` +
            `Pass config explicitly or initialize setupChain() first.`
        );
    }

    return config;
}

function resolveValidatedApiUrl(config: ApiRequestConfig, context: string): string {
    try {
        return validateApiUrl(config.api_url);
    } catch (error) {
        throw new Error(`${context}: ${(error as Error).message}`);
    }
}

export class Api {
    private url: string;
    
    public constructor(config?: SetupConfigSnapshot) {
        this.url = resolveValidatedApiUrl(config ?? resolveDefaultSetupConfig("Api"), "Api");
    }

    static async fetchNativeYields(config?: ApiRequestConfig): Promise<{ symbol: string, apy: number }[]> {
        const resolvedConfig = config ?? resolveDefaultSetupConfig("Api.fetchNativeYields");
        const { api_url } = resolvedConfig;
        const nativeYieldSlug = resolveCurvanceApiServices(resolvedConfig).nativeYieldSlug;

        if(nativeYieldSlug == null) {
            return [];
        }

        if(api_url == null) {
            console.error("You must have an API URL setup to fetch native yields.");
            return [];
        }

        const validatedApiUrl = resolveValidatedApiUrl(resolvedConfig, "Api.fetchNativeYields");
        try {
            const res = await fetchWithTimeout(`${validatedApiUrl}/v1/${nativeYieldSlug}/native_apy`);
            if (!res.ok) {
                throw new Error(`Native yields request failed: ${res.status} ${res.statusText}`);
            }

            const yields = await res.json() as {
                "native_apy": {
                    symbol: string,
                    apy: number
                }[]
            };

            // Add validation
            if (!yields || !yields.native_apy || !Array.isArray(yields.native_apy)) {
                console.error("Invalid API response structure for native yields");
                return [];
            }

            return yields.native_apy.filter(isNativeYieldRow);
        } catch (error) {
            console.error("Error fetching native yields:", error);
            return [];
        }
    }

    static async getRewards(config?: ApiRequestConfig) {
        const resolvedConfig = config ?? resolveDefaultSetupConfig("Api.getRewards");
        const rewardsSlug = resolveCurvanceApiServices(resolvedConfig).rewardsSlug;
        const apiUrl = resolveValidatedApiUrl(resolvedConfig, "Api.getRewards");

        let milestones: Milestones = {};
        let incentives: Incentives = {};

        let rewards;
        try {
            const response = await fetchWithTimeout(`${apiUrl}/v1/rewards/active/${rewardsSlug}`);
            if (!response.ok) {
                throw new Error(`Rewards request failed: ${response.status} ${response.statusText}`);
            }

            const payload = await response.json();
            if (!isRewardsResponse(payload)) {
                throw new Error("Invalid rewards response structure");
            }

            rewards = payload;
        } catch(e) {
            console.error("Failed to fetch rewards data from API:", e);
            rewards = {
                milestones: [],
                incentives: []
            };
        }

        const milestoneChainNetworks = acceptedMilestoneChainNetworks(resolvedConfig);
        for(const milestone of rewards.milestones.filter(isMilestoneResponse)) {
            if (!milestoneChainNetworks.has(normalizeChainNetwork(milestone.chain_network))) {
                continue;
            }

            milestones[normalizeMarketKey(milestone.market)] = milestone;
        }

        for(const incentive of rewards.incentives.filter(isIncentiveResponse)) {
            const market = normalizeMarketKey(incentive.market);
            if(!(market in incentives)) {
                incentives[market] = [];
            }

            incentives[market]!.push(incentive);
        }

        return { milestones, incentives };
    }
}
