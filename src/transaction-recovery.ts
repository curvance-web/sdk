import { isHexString, type TransactionResponse } from "ethers";

export interface TransactionLookupProvider {
    getTransaction(hash: string): Promise<TransactionResponse | null>;
}

export function isTransactionLookupProvider(value: unknown): value is TransactionLookupProvider {
    return (
        typeof value === "object" &&
        value != null &&
        "getTransaction" in value &&
        typeof value.getTransaction === "function"
    );
}

function getBroadcastTransactionHash(error: unknown): string | null {
    if (typeof error !== "object" || error == null || !("info" in error)) {
        return null;
    }

    const info = error.info;
    if (typeof info !== "object" || info == null || !("sendTransactionHash" in info)) {
        return null;
    }

    const hash = info.sendTransactionHash;
    return typeof hash === "string" && isHexString(hash, 32) ? hash : null;
}

/**
 * Recovers the TransactionResponse when ethers rejects after the wallet has
 * already broadcast the transaction. The submission callback is never retried.
 */
export async function submitTransactionWithBroadcastRecovery(
    submit: () => Promise<TransactionResponse>,
    readProvider: TransactionLookupProvider | null | undefined,
): Promise<TransactionResponse> {
    try {
        return await submit();
    } catch (error) {
        const hash = getBroadcastTransactionHash(error);
        if (hash == null || readProvider == null) {
            throw error;
        }

        try {
            const transaction = await readProvider.getTransaction(hash);
            if (transaction != null && transaction.hash.toLowerCase() === hash.toLowerCase()) {
                return transaction;
            }
        } catch {
            // Preserve the wallet's original error if the recovery read fails.
        }

        throw error;
    }
}
