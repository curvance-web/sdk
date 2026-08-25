import type { address } from "./types";

export interface ZapPolicyAssets {
    readonly excluded_zap_symbols?: readonly string[];
    readonly excluded_zap_addresses?: readonly address[];
}

export interface ZapPolicyToken {
    readonly address?: string | null | undefined;
    readonly symbol?: string | null | undefined;
}

export function isZapSymbolExcluded(
    assets: ZapPolicyAssets | undefined,
    symbol: string | undefined | null,
): boolean {
    if (symbol == null) {
        return false;
    }

    return (assets?.excluded_zap_symbols ?? []).some(
        (excluded) => excluded.toLowerCase() === symbol.toLowerCase(),
    );
}

export function isZapAddressExcluded(
    assets: ZapPolicyAssets | undefined,
    token: string | undefined | null,
): boolean {
    if (token == null) {
        return false;
    }

    return (assets?.excluded_zap_addresses ?? []).some(
        (excluded) => excluded.toLowerCase() === token.toLowerCase(),
    );
}

export function isZapTokenExcluded(
    assets: ZapPolicyAssets | undefined,
    token: ZapPolicyToken,
): boolean {
    return isZapAddressExcluded(assets, token.address)
        || isZapSymbolExcluded(assets, token.symbol);
}

/** Rejects real and no-op zap entry points that use a policy-excluded input. */
export function assertZapSwapAllowed(
    assets: ZapPolicyAssets | undefined,
    inputToken: address,
    outputToken: address,
    context: string,
) {
    if (isZapAddressExcluded(assets, inputToken)) {
        throw new Error(`${context} does not support excluded zap input token ${inputToken}.`);
    }
    if (
        inputToken.toLowerCase() !== outputToken.toLowerCase()
        && isZapAddressExcluded(assets, outputToken)
    ) {
        throw new Error(`${context} does not support excluded zap output token ${outputToken}.`);
    }
}
