"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptimizerReader = void 0;
const helpers_1 = require("../helpers");
const OptimizerReader_json_1 = __importDefault(require("../abis/OptimizerReader.json"));
const setup_1 = require("../setup");
class OptimizerReader {
    provider;
    address;
    contract;
    constructor(address, provider = setup_1.setup_config.provider) {
        this.provider = provider;
        this.address = address;
        this.contract = (0, helpers_1.contractSetup)(provider, address, OptimizerReader_json_1.default);
    }
    async getOptimizerMarketData(optimizers) {
        const data = await this.contract.getOptimizerMarketData(optimizers);
        return data.map((opt) => ({
            address: opt._address,
            asset: opt.asset,
            totalAssets: BigInt(opt.totalAssets),
            markets: opt.markets.map((m) => ({
                address: m._address,
                allocatedAssets: BigInt(m.allocatedAssets),
                liquidity: BigInt(m.liquidity)
            })),
            totalLiquidity: BigInt(opt.totalLiquidity),
            sharePrice: BigInt(opt.sharePrice),
            performanceFee: BigInt(opt.performanceFee)
        }));
    }
    async getOptimizerUserData(optimizers, account) {
        const data = await this.contract.getOptimizerUserData(optimizers, account);
        return data.map((opt) => ({
            address: opt._address,
            shareBalance: BigInt(opt.shareBalance),
            redeemable: BigInt(opt.redeemable)
        }));
    }
    async optimalDeposit(optimizer, assets) {
        return await this.contract.optimalDeposit(optimizer, assets);
    }
    async optimalWithdrawal(optimizer, assets) {
        return await this.contract.optimalWithdrawal(optimizer, assets);
    }
    async optimalRebalance(optimizer) {
        const data = await this.contract.optimalRebalance(optimizer);
        return data.map((action) => ({
            cToken: action.cToken,
            assets: BigInt(action.assets)
        }));
    }
}
exports.OptimizerReader = OptimizerReader;
//# sourceMappingURL=OptimizerReader.js.map