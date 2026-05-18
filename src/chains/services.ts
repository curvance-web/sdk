import { address } from "../types";

export type KyberSwapServiceConfig = {
    chainSlug: string;
    apiBase: string;
    router: address;
};

export const MONAD_KYBER_SWAP_SERVICE: KyberSwapServiceConfig = {
    chainSlug: "monad",
    apiBase: "https://aggregator-api.kyberswap.com",
    router: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as address,
};
