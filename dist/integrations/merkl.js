"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchMerklUserRewards = fetchMerklUserRewards;
exports.fetchMerklCampaignsBySymbol = fetchMerklCampaignsBySymbol;
exports.fetchMerklOpportunities = fetchMerklOpportunities;
const MERKL_API_BASE_URL = 'https://api.merkl.xyz/v4';
const PROTOCOL_ID = 'curvance';
async function fetchMerklUserRewards({ wallet, chainId, signal, }) {
    const url = new URL(`${MERKL_API_BASE_URL}/users/${wallet}/rewards?chainId=${chainId}`);
    const response = await fetch(url.toString(), { signal: signal ?? null, cache: 'no-store' });
    if (!response.ok) {
        throw new Error('Failed to fetch Merkl rewards');
    }
    return (await response.json());
}
async function fetchMerklCampaignsBySymbol({ tokenSymbol, signal, }) {
    const url = new URL(`${MERKL_API_BASE_URL}/campaigns`);
    url.searchParams.set('tokenSymbol', tokenSymbol);
    const response = await fetch(url.toString(), { signal: signal ?? null, cache: 'no-store' });
    if (!response.ok) {
        throw new Error('Failed to fetch Merkl campaigns');
    }
    return (await response.json());
}
async function fetchMerklOpportunities({ signal, action, }) {
    const url = new URL(`${MERKL_API_BASE_URL}/opportunities?items=100&tokenTypes=TOKEN`);
    url.searchParams.set('mainProtocolId', PROTOCOL_ID);
    if (action) {
        url.searchParams.set('action', action);
    }
    const response = await fetch(url.toString(), { signal: signal ?? null, cache: 'no-store' });
    if (!response.ok) {
        throw new Error('Failed to fetch Merkl opportunities');
    }
    return (await response.json());
}
//# sourceMappingURL=merkl.js.map