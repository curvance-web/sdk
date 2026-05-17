import monad_mainnet from "./monad-mainnet.json";
import arb_sepolia from "./arb-sepolia.json";
import { deepFreeze } from "../immutability";

export const chains = deepFreeze({
    "monad-mainnet": monad_mainnet,
    "arb-sepolia": arb_sepolia,
});
