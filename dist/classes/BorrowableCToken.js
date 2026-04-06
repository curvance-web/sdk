"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BorrowableCToken = void 0;
const CToken_1 = require("./CToken");
const helpers_1 = require("../helpers");
const BorrowableCToken_json_1 = __importDefault(require("../abis/BorrowableCToken.json"));
const IDynamicIRM_json_1 = __importDefault(require("../abis/IDynamicIRM.json"));
const decimal_js_1 = __importDefault(require("decimal.js"));
const FormatConverter_1 = __importDefault(require("./FormatConverter"));
class BorrowableCToken extends CToken_1.CToken {
    contract;
    constructor(provider, address, cache, market) {
        super(provider, address, cache, market);
        this.contract = (0, helpers_1.contractSetup)(provider, address, BorrowableCToken_json_1.default);
    }
    getLiquidity(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.liquidity) : this.cache.liquidity;
    }
    getPredictedBorrowRate(inPercentage) {
        return inPercentage ? (0, decimal_js_1.default)(this.cache.predictedBorrowRate).div(helpers_1.WAD).mul(helpers_1.SECONDS_PER_YEAR) : this.cache.predictedBorrowRate;
    }
    getUtilizationRate(inPercentage) {
        return inPercentage ? (0, decimal_js_1.default)(this.cache.utilizationRate).div(helpers_1.WAD) : this.cache.utilizationRate;
    }
    borrowChange(amount, rateType) {
        const rate = this.getBorrowRate(false);
        const rate_seconds = (0, helpers_1.getRateSeconds)(rateType);
        const rate_percent = (0, decimal_js_1.default)(rate * rate_seconds).div(helpers_1.WAD);
        return amount.mul(rate_percent);
    }
    async getMaxBorrowable(inUSD = false) {
        const credit_usd = this.market.userRemainingCredit;
        return inUSD ? credit_usd : this.convertUsdToTokens(credit_usd, true);
    }
    ;
    async depositAsCollateral(amount, zap = 'none', receiver = null) {
        if (this.cache.userDebt > 0) {
            throw new Error("Cannot deposit as collateral when there is outstanding debt");
        }
        return super.depositAsCollateral(amount, zap, receiver);
    }
    async postCollateral(amount) {
        if (this.cache.userDebt > 0) {
            throw new Error("Cannot post collateral when there is outstanding debt");
        }
        return super.postCollateral(amount);
    }
    async hypotheticalBorrowOf(amount) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const assets = FormatConverter_1.default.decimalToBigInt(amount, this.asset.decimals);
        return this.market.reader.hypotheticalBorrowOf(signer.address, this, assets);
    }
    async fetchDebt(inUSD = true) {
        const totalDebt = await this.contract.marketOutstandingDebt();
        return inUSD ? this.fetchConvertTokensToUsd(totalDebt) : totalDebt;
    }
    async borrow(amount, receiver = null) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        receiver ??= signer.address;
        const assets = FormatConverter_1.default.decimalToBigInt(amount, this.asset.decimals);
        const calldata = this.getCallData("borrow", [assets, receiver]);
        return this.oracleRoute(calldata);
    }
    async dynamicIRM() {
        const irm_addr = await this.contract.IRM();
        return (0, helpers_1.contractSetup)(this.provider, irm_addr, IDynamicIRM_json_1.default);
    }
    async fetchUtilizationRateChange(assets, direction, inPercentage = true) {
        const assets_as_bn = FormatConverter_1.default.decimalToBigInt(assets, this.asset.decimals);
        const irm = await this.dynamicIRM();
        const assets_held = direction == 'add' ? this.cache.liquidity + assets_as_bn : this.cache.liquidity - assets_as_bn;
        const newRate = await irm.utilizationRate(assets_held, this.cache.debt);
        return inPercentage ? (0, decimal_js_1.default)(newRate).div(helpers_1.WAD) : newRate;
    }
    async fetchDebtBalanceAtTimestamp(timestamp = 0n, asUSD = true) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const debt = await this.market.reader.debtBalanceAtTimestamp(signer.address, this.address, timestamp);
        return asUSD ? this.fetchConvertTokensToUsd(debt) : debt;
    }
    async fetchBorrowRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = this.totalAssets;
        const debt = await this.contract.marketOutstandingDebt();
        const borrowRate = (await irm.borrowRate(assetsHeld, debt));
        this.cache.borrowRate = borrowRate;
        return borrowRate;
    }
    async fetchPredictedBorrowRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = this.totalAssets;
        const debt = await this.contract.marketOutstandingDebt();
        const predictedBorrowRate = (await irm.predictedBorrowRate(assetsHeld, debt));
        this.cache.predictedBorrowRate = predictedBorrowRate;
        return predictedBorrowRate;
    }
    async fetchUtilizationRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = this.totalAssets;
        const debt = await this.contract.marketOutstandingDebt();
        const utilizationRate = (await irm.utilizationRate(assetsHeld, debt));
        this.cache.utilizationRate = utilizationRate;
        return utilizationRate;
    }
    async fetchSupplyRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = this.totalAssets;
        const debt = await this.contract.marketOutstandingDebt();
        const fee = await this.fetchInterestFee();
        const supplyRate = (await irm.supplyRate(assetsHeld, debt, fee));
        this.cache.supplyRate = supplyRate;
        return supplyRate;
    }
    async fetchLiquidity() {
        const assetsHeld = this.totalAssets;
        const debt = await this.contract.marketOutstandingDebt();
        const liquidity = assetsHeld - debt;
        this.cache.liquidity = liquidity;
        return liquidity;
    }
    async repay(amount) {
        const assets = FormatConverter_1.default.decimalToBigInt(amount, this.asset.decimals);
        const calldata = this.getCallData("repay", [assets]);
        return this.oracleRoute(calldata);
    }
    async fetchInterestFee() {
        return this.contract.interestFee();
    }
    async marketOutstandingDebt() {
        return this.contract.marketOutstandingDebt();
    }
    async debtBalance(account) {
        return this.contract.debtBalance(account);
    }
}
exports.BorrowableCToken = BorrowableCToken;
//# sourceMappingURL=BorrowableCToken.js.map