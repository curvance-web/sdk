import { Contract, TransactionResponse } from "ethers";
import { address, bytes, curvance_provider } from "../types";
export declare abstract class Calldata<T> {
    abstract address: address;
    abstract contract: Contract & T;
    abstract provider: curvance_provider;
    getCallData(functionName: string, exec_params: any[]): bytes;
    executeCallData(calldata: bytes, overrides?: {
        [key: string]: any;
    }): Promise<TransactionResponse>;
    simulateCallData(calldata: bytes, overrides?: {
        [key: string]: any;
    }): Promise<{
        success: boolean;
        error?: string;
    }>;
}
//# sourceMappingURL=Calldata.d.ts.map