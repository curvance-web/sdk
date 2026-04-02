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

export async function fetchMerklUserRewards({
    wallet,
    chainId,
    signal,
}: FetchRewardsParams): Promise<MerklUserRewardsResponse> {
    const url = new URL(`${MERKL_API_BASE_URL}/users/${wallet}/rewards?chainId=${chainId}`);

    const response = await fetch(url.toString(), { signal: signal ?? null, cache: 'no-store' });

    if (!response.ok) {
        throw new Error('Failed to fetch Merkl rewards');
    }

    return (await response.json()) as MerklUserRewardsResponse;
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

    const response = await fetch(url.toString(), { signal: signal ?? null, cache: 'no-store' });

    if (!response.ok) {
        throw new Error('Failed to fetch Merkl campaigns');
    }

    return (await response.json()) as MerklCampaign[];
}

type FetchOpportunitiesParams = FetchOptions & {
    action?: 'LEND' | 'BORROW';
};

export async function fetchMerklOpportunities({
    signal,
    action,
}: FetchOpportunitiesParams): Promise<MerklOpportunity[]> {
    const url = new URL(`${MERKL_API_BASE_URL}/opportunities?items=100&tokenTypes=TOKEN`);
    url.searchParams.set('mainProtocolId', PROTOCOL_ID);
    if (action) {
        url.searchParams.set('action', action);
    }

    const response = await fetch(url.toString(), { signal: signal ?? null, cache: 'no-store' });

    if (!response.ok) {
        throw new Error('Failed to fetch Merkl opportunities');
    }

    return (await response.json()) as MerklOpportunity[];
}
