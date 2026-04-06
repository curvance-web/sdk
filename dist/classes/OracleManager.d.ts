import { address, curvance_provider } from "../types";
import { Contract } from "ethers";
export interface IOracleManager {
    getPrice(asset: address, inUSD: boolean, getLower: boolean): Promise<[bigint, bigint]>;
}
export declare class OracleManager {
    provider: curvance_provider;
    address: address;
    contract: Contract & IOracleManager;
    constructor(address: address, provider?: curvance_provider);
    getPrice(asset: address, inUSD: boolean, getLower: boolean): Promise<bigint>;
}
//# sourceMappingURL=OracleManager.d.ts.map