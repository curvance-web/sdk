import Decimal from "decimal.js";
import { JsonRpcProvider, JsonRpcSigner, Wallet } from "ethers";
export type address = `0x${string}`;
export type bytes = `0x${string}`;
/**
 * Represents the percentage value in the system.
 * This shuold return 0.7 which represents 70% (0.7 * 100)
 */
export type Percentage = Decimal;
/**
 * USD in user representation which is value / 1e18
 * This can be used as an indicator that the value needs to be value * 1e18 in order to do math correctly
 */
export type USD = Decimal;
/**
 * USD in in WAD format, 1e18
 */
export type USD_WAD = bigint;
/**
 * This type represents the user view of what a token looks like IE 1.5 WBTC.
 * This then indicates that for WBTC with decimal 8, the function will need to convert to 1.5 * 1e8 to have the onchain value needed
 */
export type TokenInput = Decimal;
/**
 * Indicator that a value is in BPS which is 1e4
 */
export type TypeBPS = bigint;
export type curvance_provider = JsonRpcSigner | Wallet | JsonRpcProvider;
export type curvance_signer = JsonRpcSigner | Wallet;
export type MarketCategory = "stablecoin" | "staking" | "restaking" | "yield-stablecoin" | "blue-chip" | "native";
export type CollateralSource = "Renzo" | "Upshift" | "Yuzu" | "Native" | "Circle" | "Fastlane" | "Apriori" | "Mu Digital" | "Kintsu" | "Reservoir";
export declare const CATEGORY_META: Record<MarketCategory, {
    label: string;
    color: string;
}>;
export declare const PROTOCOL_META: Record<CollateralSource, {
    label: string;
    color: string;
}>;
//# sourceMappingURL=types.d.ts.map