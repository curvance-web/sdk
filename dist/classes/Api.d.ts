import { address } from "../types";
export type IncentiveResponse = {
    market: address;
    type: string;
    rate: number;
    description: string;
    image: string;
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
};
export type Milestones = {
    [key: string]: MilestoneResponse;
};
export type Incentives = {
    [key: address]: Array<IncentiveResponse>;
};
export declare class Api {
    private url;
    constructor();
    static fetchNativeYields(): Promise<{
        symbol: string;
        apy: number;
    }[]>;
    static getRewards(): Promise<{
        milestones: Milestones;
        incentives: Incentives;
    }>;
}
//# sourceMappingURL=Api.d.ts.map