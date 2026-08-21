import { Contract, TransactionResponse } from "ethers";
import { address, bytes, curvance_signer } from "../types";
import { requireSigner } from "../helpers";
import {
    isTransactionLookupProvider,
    submitTransactionWithBroadcastRecovery,
    type TransactionLookupProvider,
} from "../transaction-recovery";

export abstract class Calldata<T> {
    abstract address: address;
    abstract contract: Contract & T;

    private getExecutionSigner(): curvance_signer {
        const self = this as typeof this & {
            signer?: curvance_signer | null;
        };
        return requireSigner(self.signer);
    }

    private getTransactionLookupProvider(signer: curvance_signer): TransactionLookupProvider | null {
        const self = this as typeof this & {
            provider?: unknown;
            setup?: { readProvider?: unknown };
        };
        const candidates: unknown[] = [
            self.provider,
            self.setup?.readProvider,
            signer.provider,
        ];

        return candidates.find(isTransactionLookupProvider) ?? null;
    }
    
    getCallData(functionName: string, exec_params: any[]) {
        return this.contract.interface.encodeFunctionData(functionName, exec_params) as bytes;
    }

    async executeCallData(calldata: bytes, overrides: { [key: string]: any } = {}): Promise<TransactionResponse> {
        const signer = this.getExecutionSigner();
        return submitTransactionWithBroadcastRecovery(
            () => signer.sendTransaction({
                to: this.address,
                data: calldata,
                ...overrides
            }),
            this.getTransactionLookupProvider(signer),
        );
    }

    async simulateCallData(calldata: bytes, overrides: { [key: string]: any } = {}): Promise<{ success: boolean; error?: string }> {
        const signer = this.getExecutionSigner();
        try {
            await signer.call({
                to: this.address,
                data: calldata,
                from: signer.address,
                ...overrides
            });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error?.reason || error?.message || String(error) };
        }
    }
}
