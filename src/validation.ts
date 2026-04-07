import { getAddress } from "ethers";
import { address } from "./types";

/**
 * Parse a string from an untrusted source (API response) into BigInt.
 * Throws a descriptive error instead of raw SyntaxError on invalid input.
 *
 * @param value - Value to convert (string, number, bigint)
 * @param context - Human-readable label for error messages (e.g. "KyberSwap amountOut")
 */
export function safeBigInt(value: unknown, context: string): bigint {
    if (typeof value === 'bigint') return value;

    const str = String(value ?? '');

    // BigInt() accepts integer strings only — reject floats, hex, empty, etc. early
    // to give a useful error instead of generic SyntaxError
    if (!/^-?\d+$/.test(str)) {
        throw new Error(`Invalid numeric value from ${context}: "${str.slice(0, 50)}"`);
    }

    return BigInt(str);
}

/**
 * Validate and checksum an address from an untrusted source.
 * The SDK `address` type is compile-time only — this adds runtime enforcement.
 *
 * @param raw - Address string to validate
 * @param context - Human-readable label for error messages
 */
export function validateAddress(raw: string, context: string): address {
    if (!raw || typeof raw !== 'string') {
        throw new Error(`Missing address from ${context}`);
    }

    try {
        // ethers v6 getAddress: validates format, length, checksum.
        // Returns checksummed EIP-55 address.
        return getAddress(raw) as address;
    } catch {
        throw new Error(`Invalid address from ${context}: "${raw.slice(0, 50)}"`);
    }
}

/**
 * Validate that a router address from a DEX API matches the expected address.
 *
 * @param actual - Router address returned by the API
 * @param expected - Known router address from SDK config
 * @param aggregatorName - Name of the DEX aggregator for error messages
 */
export function validateRouterAddress(
    actual: string,
    expected: string,
    aggregatorName: string
): address {
    const validated = validateAddress(actual, `${aggregatorName} router`);
    if (validated.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(
            `${aggregatorName} returned unexpected router address: ${actual} (expected ${expected})`
        );
    }
    return validated;
}

// ── Fetch with timeout ──────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Wrapper around fetch() that adds a timeout via AbortController.
 * If the caller already provided a signal, the timeout races against it.
 *
 * @param url - Request URL
 * @param options - Standard RequestInit options
 * @param timeoutMs - Timeout in milliseconds (default 15s)
 */
export async function fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    // If the caller provided their own signal, listen for its abort too
    const externalSignal = options.signal;
    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
    }

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(id);
    }
}

// ── URL validation ──────────────────────────────────────────────────

/**
 * Validate that an API URL uses HTTPS and is well-formed.
 * Prevents SSRF when api_url is consumer-provided.
 */
export function validateApiUrl(url: string): string {
    if (!url || typeof url !== 'string') {
        throw new Error('api_url must be a non-empty string');
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid api_url: "${url.slice(0, 100)}"`);
    }

    if (parsed.protocol !== 'https:') {
        throw new Error(`api_url must use HTTPS, got ${parsed.protocol} in "${url.slice(0, 100)}"`);
    }

    return url;
}
