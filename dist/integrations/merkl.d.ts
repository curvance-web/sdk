export type MerklChainInfo = {
    id: number;
    name: string;
    icon?: string;
    explorer?: {
        url: string;
    }[];
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
    tokens: {
        address: string;
        symbol: string;
    }[];
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
export declare function fetchMerklUserRewards({ wallet, chainId, signal, }: FetchRewardsParams): Promise<MerklUserRewardsResponse>;
type FetchCampaignsParams = FetchOptions & {
    tokenSymbol: string;
};
export declare function fetchMerklCampaignsBySymbol({ tokenSymbol, signal, }: FetchCampaignsParams): Promise<MerklCampaign[]>;
type FetchOpportunitiesParams = FetchOptions & {
    action?: 'LEND' | 'BORROW';
};
export declare function fetchMerklOpportunities({ signal, action, }: FetchOpportunitiesParams): Promise<MerklOpportunity[]>;
export {};
//# sourceMappingURL=merkl.d.ts.map