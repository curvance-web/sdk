import { Contract, TransactionResponse } from "ethers";
import { address, bytes, curvance_provider, curvance_signer } from "../types";
import { requireSigner } from "../helpers";

export abstract class Calldata<T> {
    abstract address: address;
    abstract contract: Contract & T;
    /** @deprecated Legacy provider-as-signer compatibility for external subclasses. */
    provider?: curvance_provider | null;

    private getExecutionSigner(): curvance_signer {
        const self = this as typeof this & {
            signer?: curvance_signer | null;
            provider?: curvance_provider | null;
        };
        const explicitSigner = self.signer ?? null;
        if (explicitSigner != null) {
            return explicitSigner;
        }

        const legacyProvider = self.provider ?? null;
        const legacySigner =
            legacyProvider != null &&
            typeof legacyProvider === "object" &&
            "address" in legacyProvider
                ? legacyProvider as curvance_signer
                : null;

        return requireSigner(legacySigner);
    }
    
    getCallData(functionName: string, exec_params: any[]) {
        return this.contract.interface.encodeFunctionData(functionName, exec_params) as bytes;
    }

    async executeCallData(calldata: bytes, overrides: { [key: string]: any } = {}): Promise<TransactionResponse> {
        const signer = this.getExecutionSigner();
        return signer.sendTransaction({
            to: this.address,
            data: calldata,
            ...overrides
        });
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
