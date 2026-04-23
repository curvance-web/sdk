import type { SetupConfigSnapshot } from "../setup";
import { address } from "../types";
import { fetchWithTimeout } from "../validation";

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
        isFiniteNumber(row.tvl) &&
        isFiniteNumber(row.multiplier) &&
        isFiniteNumber(row.fail_multiplier) &&
        isNonEmptyString(row.chain_network) &&
        isNonEmptyString(row.start_date) &&
        isNonEmptyString(row.end_date) &&
        isFiniteNumber(row.duration_in_days)
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
        isFiniteNumber(row.rate) &&
        isNonEmptyString(row.description) &&
        isNonEmptyString(row.image)
    );
}

function normalizeMarketKey(market: string): string {
    return market.toLowerCase();
}

function isNativeYieldRow(value: unknown): value is { symbol: string; apy: number } {
    if (typeof value !== "object" || value == null) {
        return false;
    }

    const row = value as { symbol?: unknown; apy?: unknown };
    return typeof row.symbol === "string" && typeof row.apy === "number" && Number.isFinite(row.apy);
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

export class Api {
    private url: string;
    
    public constructor(config?: SetupConfigSnapshot) {
        this.url = (config ?? resolveDefaultSetupConfig("Api")).api_url!;
    }

    static async fetchNativeYields(config?: SetupConfigSnapshot): Promise<{ symbol: string, apy: number }[]> {
        const resolvedConfig = config ?? resolveDefaultSetupConfig("Api.fetchNativeYields");
        const { api_url } = resolvedConfig;
        let chain: string = resolvedConfig.chain;

        if(api_url == null) {
            console.error("You must have an API URL setup to fetch native yields.");
            return [];
        }

        if(chain == 'monad-mainnet') {
            chain = 'monad';
        }

        if(['monad'].includes(chain)) {
            try {
                const res = await fetchWithTimeout(`${api_url}/v1/${chain}/native_apy`);
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
        } else {
            return [];
        }
    }

    static async getRewards(config?: SetupConfigSnapshot) {
        const { chain, api_url } = config ?? resolveDefaultSetupConfig("Api.getRewards");

        let milestones: Milestones = {};
        let incentives: Incentives = {};

        let rewards;
        try {
            const response = await fetchWithTimeout(`${api_url}/v1/rewards/active/${chain}`);
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

        for(const milestone of rewards.milestones.filter(isMilestoneResponse)) {
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
