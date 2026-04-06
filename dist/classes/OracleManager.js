"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OracleManager = void 0;
const helpers_1 = require("../helpers");
const setup_1 = require("../setup");
class OracleManager {
    provider;
    address;
    contract;
    constructor(address, provider = setup_1.setup_config.provider) {
        this.provider = provider;
        this.address = address;
        this.contract = (0, helpers_1.contractSetup)(provider, this.address, [
            "function getPrice(address, bool, bool) view returns (uint256, uint256)",
        ]);
    }
    async getPrice(asset, inUSD, getLower) {
        const [price, errorCode] = await this.contract.getPrice(asset, inUSD, getLower);
        if (errorCode != 0n) {
            let addon_msg = "unknown";
            switch (errorCode) {
                case 1n:
                    addon_msg = "indicates that price should be taken with caution.";
                    break;
                case 2n:
                    addon_msg = "indicates a complete failure in receiving a price.";
                    break;
            }
            throw new Error(`Error getting price for asset ${asset}: code ${errorCode} - ${addon_msg}`);
        }
        return price;
    }
}
exports.OracleManager = OracleManager;
//# sourceMappingURL=OracleManager.js.map