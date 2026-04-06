"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERC4626 = void 0;
const helpers_1 = require("../helpers");
const ERC20_1 = require("./ERC20");
const FormatConverter_1 = __importDefault(require("./FormatConverter"));
class ERC4626 extends ERC20_1.ERC20 {
    get4626Contract() {
        return (0, helpers_1.contractSetup)(this.provider, this.address, [
            "function asset() view returns (address)",
            "function convertToShares(uint256) view returns (uint256)",
            "function convertToAssets(uint256) view returns (uint256)",
            "function previewDeposit(uint256) view returns (uint256)"
        ]);
    }
    async fetchAsset(asErc20) {
        const vault_asset_address = await this.get4626Contract().asset();
        return asErc20 ? new ERC20_1.ERC20(this.provider, vault_asset_address) : vault_asset_address;
    }
    async convertToShares(assets) {
        return this.get4626Contract().convertToShares(assets);
    }
    async convertToAssets(shares) {
        return this.get4626Contract().convertToAssets(shares);
    }
    async previewDeposit(assets, asTokenInput = false) {
        const shares = await this.get4626Contract().previewDeposit(assets);
        if (asTokenInput) {
            const token_decimals = this.decimals ?? await this.contract.decimals();
            return FormatConverter_1.default.bigIntToDecimal(shares, token_decimals);
        }
        else {
            return shares;
        }
    }
}
exports.ERC4626 = ERC4626;
//# sourceMappingURL=ERC4626.js.map