import { fetchWithTimeout } from "../validation";

const MERKL_API_BASE_URL = 'https://api.merkl.xyz/v4';
const PROTOCOL_ID = 'curvance';

export type MerklChainInfo = {
    id: number;
    name: string;
    icon?: string;
    explorer?: { url: string }[];
    liveCampaigns?: number;
    endOfDisputePeriod?: number;
};

export type MerklRewardToken = {
    id?: string;
    name?: string;
    symbol: string;
    address: string;
    chainId: number;
    decimals: number;
    icon?: string;
    price?: number;
    priceSource?: string;
};

export type MerklRewardBreakdown = {
    campaignId: string;
    amount: string;
    claimed: string;
    pending?: string;
    reason?: string;
};

export type MerklRewardRecordToken = Partial<MerklRewardToken>;

export type MerklRewardRecordBreakdown = {
    token: MerklRewardRecordToken;
    amount?: string;
    value?: number;
    distributionType?: string;
    onChainCampaignId?: string;
    id?: string;
    timestamp?: string;
    campaignId?: string;
    dailyRewardsRecordId?: string;
};

export type MerklReward = {
    distributionChainId: number;
    root: string;
    recipient: string;
    amount: string;
    claimed: string;
    pending?: string;
    token: MerklRewardToken;
    breakdowns?: MerklRewardBreakdown[];
};

export type MerklUserRewardsResponse = Array<{
    chain: MerklChainInfo;
    rewards: MerklReward[];
}>;

export type MerklCampaign = {
    id: string;
    campaignId: string;
    computeChainId: number;
    distributionChainId: number;
    chain: MerklChainInfo;
    distributionChain?: MerklChainInfo;
    rewardToken: MerklRewardToken;
};

type FetchOptions = {
    signal?: AbortSignal;
};

export type MerklOpportunity = {
    name: string;
    apr: number;
    action?: 'LEND' | 'BORROW' | string;
    identifier: string;
    type: string;
    tokens: { address: string; symbol: string }[];
    rewardsRecord?: {
        id?: string;
        total?: number;
        timestamp?: string;
        breakdowns?: MerklRewardRecordBreakdown[];
    };
};

type FetchRewardsParams = FetchOptions & {
    wallet: string;
    chainId: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value != null;
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0;
}

function normalizeChainInfo(value: unknown): MerklChainInfo | null {
    if (
        !isRecord(value) ||
        !isFiniteNumber(value.id) ||
        !isString(value.name)
    ) {
        return null;
    }

    const chain: MerklChainInfo = {
        id: value.id,
        name: value.name,
    };
    if (isString(value.icon)) {
        chain.icon = value.icon;
    }
    if (Array.isArray(value.explorer)) {
        const explorer = value.explorer
            .filter((entry): entry is { url: string } => isRecord(entry) && isString(entry.url))
            .map((entry) => ({ url: entry.url }));
        if (explorer.length > 0) {
            chain.explorer = explorer;
        }
    }
    if (isNonnegativeFiniteNumber(value.liveCampaigns)) {
        chain.liveCampaigns = value.liveCampaigns;
    }
    if (isNonnegativeFiniteNumber(value.endOfDisputePeriod)) {
        chain.endOfDisputePeriod = value.endOfDisputePeriod;
    }

    return chain;
}

function normalizeRewardToken(value: unknown): MerklRewardToken | null {
    if (
        !isRecord(value) ||
        !isString(value.symbol) ||
        !isString(value.address) ||
        !isFiniteNumber(value.chainId) ||
        !isNonnegativeFiniteNumber(value.decimals)
    ) {
        return null;
    }

    const token: MerklRewardToken = {
        symbol: value.symbol,
        address: value.address,
        chainId: value.chainId,
        decimals: value.decimals,
    };
    if (isString(value.id)) {
        token.id = value.id;
    }
    if (isString(value.name)) {
        token.name = value.name;
    }
    if (isString(value.icon)) {
        token.icon = value.icon;
    }
    if (isFiniteNumber(value.price)) {
        token.price = value.price;
    }
    if (isString(value.priceSource)) {
        token.priceSource = value.priceSource;
    }

    return token;
}

function normalizeRewardBreakdown(value: unknown): MerklRewardBreakdown | null {
    if (
        !isRecord(value) ||
        !isString(value.campaignId) ||
        !isString(value.amount) ||
        !isString(value.claimed)
    ) {
        return null;
    }

    const breakdown: MerklRewardBreakdown = {
        campaignId: value.campaignId,
        amount: value.amount,
        claimed: value.claimed,
    };
    if (isString(value.pending)) {
        breakdown.pending = value.pending;
    }
    if (isString(value.reason)) {
        breakdown.reason = value.reason;
    }

    return breakdown;
}

function normalizeReward(value: unknown): MerklReward | null {
    if (
        !isRecord(value) ||
        !isFiniteNumber(value.distributionChainId) ||
        !isString(value.root) ||
        !isString(value.recipient) ||
        !isString(value.amount) ||
        !isString(value.claimed)
    ) {
        return null;
    }

    const token = normalizeRewardToken(value.token);
    if (token == null) {
        return null;
    }

    const breakdowns = Array.isArray(value.breakdowns)
        ? value.breakdowns
            .map(normalizeRewardBreakdown)
            .filter((breakdown): breakdown is MerklRewardBreakdown => breakdown != null)
        : undefined;

    const reward: MerklReward = {
        distributionChainId: value.distributionChainId,
        root: value.root,
        recipient: value.recipient,
        amount: value.amount,
        claimed: value.claimed,
        token,
    };
    if (isString(value.pending)) {
        reward.pending = value.pending;
    }
    if (breakdowns != undefined) {
        reward.breakdowns = breakdowns;
    }

    return reward;
}

function normalizeMerklUserRewardsResponse(value: unknown): MerklUserRewardsResponse {
    if (!Array.isArray(value)) {
        return [];
    }

    const rows: MerklUserRewardsResponse = [];
    for (const row of value) {
        if (!isRecord(row) || !Array.isArray(row.rewards)) {
            continue;
        }

        const chain = normalizeChainInfo(row.chain);
        if (chain == null) {
            continue;
        }

        rows.push({
            chain,
            rewards: row.rewards
                .map(normalizeReward)
                .filter((reward): reward is MerklReward => reward != null),
        });
    }

    return rows;
}

function normalizeCampaign(value: unknown): MerklCampaign | null {
    if (
        !isRecord(value) ||
        !isString(value.id) ||
        !isString(value.campaignId) ||
        !isFiniteNumber(value.computeChainId) ||
        !isFiniteNumber(value.distributionChainId)
    ) {
        return null;
    }

    const chain = normalizeChainInfo(value.chain);
    const rewardToken = normalizeRewardToken(value.rewardToken);
    if (chain == null || rewardToken == null) {
        return null;
    }

    const distributionChain = value.distributionChain != undefined
        ? normalizeChainInfo(value.distributionChain)
        : undefined;
    if (value.distributionChain != undefined && distributionChain == null) {
        return null;
    }

    const campaign: MerklCampaign = {
        id: value.id,
        campaignId: value.campaignId,
        computeChainId: value.computeChainId,
        distributionChainId: value.distributionChainId,
        chain,
        rewardToken,
    };
    if (distributionChain != undefined) {
        campaign.distributionChain = distributionChain;
    }

    return campaign;
}

function normalizeMerklCampaigns(value: unknown): MerklCampaign[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(normalizeCampaign)
        .filter((campaign): campaign is MerklCampaign => campaign != null);
}

export async function fetchMerklUserRewards({
    wallet,
    chainId,
    signal,
}: FetchRewardsParams): Promise<MerklUserRewardsResponse> {
    const url = new URL(`${MERKL_API_BASE_URL}/users/${wallet}/rewards?chainId=${chainId}`);

    const response = await fetchWithTimeout(url.toString(), { signal: signal ?? null, cache: 'no-store' });

    if (!response.ok) {
        throw new Error('Failed to fetch Merkl rewards');
    }

    return normalizeMerklUserRewardsResponse(await response.json());
}

type FetchCampaignsParams = FetchOptions & {
    tokenSymbol: string;
};

export async function fetchMerklCampaignsBySymbol({
    tokenSymbol,
    signal,
}: FetchCampaignsParams): Promise<MerklCampaign[]> {
    const url = new URL(`${MERKL_API_BASE_URL}/campaigns`);
    url.searchParams.set('tokenSymbol', tokenSymbol);

    const response = await fetchWithTimeout(url.toString(), { signal: signal ?? null, cache: 'no-store' });

    if (!response.ok) {
        throw new Error('Failed to fetch Merkl campaigns');
    }

    return normalizeMerklCampaigns(await response.json());
}

type FetchOpportunitiesParams = FetchOptions & {
    action?: 'LEND' | 'BORROW';
    chainId?: number;
};

export async function fetchMerklOpportunities({
    signal,
    action,
    chainId,
}: FetchOpportunitiesParams): Promise<MerklOpportunity[]> {
    const url = new URL(`${MERKL_API_BASE_URL}/opportunities?items=100&tokenTypes=TOKEN`);
    url.searchParams.set('mainProtocolId', PROTOCOL_ID);
    if (action) {
        url.searchParams.set('action', action);
    }
    if (chainId != undefined) {
        url.searchParams.set('chainId', String(chainId));
    }

    const response = await fetchWithTimeout(url.toString(), { signal: signal ?? null, cache: 'no-store' });

    if (!response.ok) {
        throw new Error('Failed to fetch Merkl opportunities');
    }

    const body = await response.json();
    if (!Array.isArray(body)) {
        return [];
    }

    return body as MerklOpportunity[];
}
