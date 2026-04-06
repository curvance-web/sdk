import { address, TokenInput } from "../types";
import { ERC20 } from "./ERC20";
export interface IERC4626 {
    asset(): Promise<address>;
    convertToShares(assets: bigint): Promise<bigint>;
    convertToAssets(assets: bigint): Promise<bigint>;
    previewDeposit(assets: bigint): Promise<bigint>;
}
export declare class ERC4626 extends ERC20 {
    private get4626Contract;
    fetchAsset(asErc20: true): Promise<ERC20>;
    fetchAsset(asErc20: false): Promise<address>;
    convertToShares(assets: bigint): Promise<bigint>;
    convertToAssets(shares: bigint): Promise<bigint>;
    previewDeposit(assets: bigint): Promise<bigint>;
    previewDeposit(assets: bigint, asTokenInput: false): Promise<bigint>;
    previewDeposit(assets: bigint, asTokenInput: true): Promise<TokenInput>;
}
//# sourceMappingURL=ERC4626.d.ts.map