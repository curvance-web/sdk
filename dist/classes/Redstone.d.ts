import { address, bytes } from "../types";
import { TransactionResponse } from "ethers";
import { MulticallAction } from "./CToken";
import { MarketToken } from "./Market";
export interface IRedstoneCoreAdaptor {
    writePrice(asset: address, inUSD: boolean, redstoneTimestamp: bigint): Promise<TransactionResponse>;
}
export declare class Redstone {
    static getPayload(symbol: string, log?: boolean): Promise<{
        payload: bytes;
        timestamp: number;
    }>;
    static buildMultiCallAction(ctoken: MarketToken): Promise<MulticallAction>;
}
//# sourceMappingURL=Redstone.d.ts.map