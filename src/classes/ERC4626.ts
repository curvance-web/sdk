import { contractSetup } from "../helpers";
import { address, TokenInput } from "../types";
import { ERC20 } from "./ERC20";
import FormatConverter from "./FormatConverter";

export interface IERC4626 {
    asset(): Promise<address>;
    convertToShares(assets: bigint): Promise<bigint>;
    convertToAssets(assets: bigint): Promise<bigint>;
    previewDeposit(assets: bigint): Promise<bigint>;
}

export class ERC4626 extends ERC20 {
    private get4626Contract() {
        return contractSetup<IERC4626>(this.provider, this.address, [
            "function asset() view returns (address)",
            "function convertToShares(uint256) view returns (uint256)",
            "function convertToAssets(uint256) view returns (uint256)",
            "function previewDeposit(uint256) view returns (uint256)"
        ]);
    }

    async fetchAsset(asErc20: true): Promise<ERC20>
    async fetchAsset(asErc20: false): Promise<address>
    async fetchAsset(asErc20: boolean) {
        const vault_asset_address = await this.get4626Contract().asset();
        return asErc20
            ? new ERC20(this.provider, vault_asset_address, undefined, this.oracleManagerAddress)
            : vault_asset_address as address;
    }

    async convertToShares(assets: bigint) {
        return this.get4626Contract().convertToShares(assets);
    }

    async convertToAssets(shares: bigint) {
        return this.get4626Contract().convertToAssets(shares);
    }

    async previewDeposit(assets: bigint ): Promise<bigint>
    async previewDeposit(assets: bigint, asTokenInput: false ): Promise<bigint>
    async previewDeposit(assets: bigint, asTokenInput: true ): Promise<TokenInput>
    async previewDeposit(assets: bigint, asTokenInput: boolean = false) {
        const shares = await this.get4626Contract().previewDeposit(assets);

        if(asTokenInput) {
            const token_decimals = this.decimals ?? await this.contract.decimals();
            return FormatConverter.bigIntToDecimal(shares, token_decimals);
        } else {
            return shares;
        }
    }
}
