import { Contract, TransactionResponse } from "ethers";
import { address, curvance_provider, Percentage, TokenInput, USD, USD_WAD } from "../types";
import { CToken, ICToken, ZapperInstructions } from "./CToken";
import { DynamicMarketToken, StaticMarketToken, UserMarketToken } from "./ProtocolReader";
import { Market } from "./Market";
import { ChangeRate, contractSetup, getRateSeconds, SECONDS_PER_YEAR, validateProviderAsSigner, WAD } from "../helpers";
import borrowable_ctoken_abi from '../abis/BorrowableCToken.json';
import irm_abi from '../abis/IDynamicIRM.json';
import Decimal from "decimal.js";
import FormatConverter from "./FormatConverter";

export interface IBorrowableCToken extends ICToken {
    borrow(amount: bigint, receiver: address): Promise<TransactionResponse>;
    repay(amount: bigint): Promise<TransactionResponse>;
    interestFee(): Promise<bigint>;
    marketOutstandingDebt(): Promise<bigint>;
    debtBalance(account: address): Promise<bigint>;
    IRM(): Promise<address>;
    // More functions available
}

export interface IDynamicIRM {
    ADJUSTMENT_RATE(): Promise<bigint>;
    linkedToken(): Promise<address>;
    borrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
    predictedBorrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
    supplyRate(assetsHeld: bigint, debt: bigint, interestFee: bigint): Promise<bigint>;
    adjustedBorrowRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
    utilizationRate(assetsHeld: bigint, debt: bigint): Promise<bigint>;
}

export class BorrowableCToken extends CToken {
    override contract: Contract & IBorrowableCToken;

    constructor(
        provider: curvance_provider,
        address: address,
        cache: StaticMarketToken & DynamicMarketToken & UserMarketToken,
        market: Market
    ) {
        super(provider, address, cache, market);
        this.contract = contractSetup<IBorrowableCToken>(provider, address, borrowable_ctoken_abi);
    }

    getLiquidity(inUSD: true): USD;
    getLiquidity(inUSD: false): USD_WAD;
    getLiquidity(inUSD: boolean): USD | USD_WAD {
        return inUSD ? this.convertTokensToUsd(this.cache.liquidity) : this.cache.liquidity;
    }

    getPredictedBorrowRate(inPercentage: true): Percentage;
    getPredictedBorrowRate(inPercentage: false): bigint;
    getPredictedBorrowRate(inPercentage: boolean) {
        return inPercentage ? Decimal(this.cache.predictedBorrowRate).div(WAD).mul(SECONDS_PER_YEAR) : this.cache.predictedBorrowRate;
    }

    getUtilizationRate(inPercentage: true): Percentage;
    getUtilizationRate(inPercentage: false): bigint;
    getUtilizationRate(inPercentage: boolean) {
        return inPercentage ? Decimal(this.cache.utilizationRate).div(WAD) : this.cache.utilizationRate;
    }

    borrowChange(amount: USD, rateType: ChangeRate) {
        const rate = this.getBorrowRate(false);
        const rate_seconds = getRateSeconds(rateType);
        const rate_percent = Decimal(rate * rate_seconds).div(WAD);

        return amount.mul(rate_percent);
    }


    async getMaxBorrowable(): Promise<TokenInput>;
    async getMaxBorrowable(inUSD: false): Promise<TokenInput>;
    async getMaxBorrowable(inUSD: true): Promise<USD>;
    async getMaxBorrowable(inUSD: boolean = false): Promise<USD | TokenInput> {
        const credit_usd = this.market.userRemainingCredit;
        return inUSD ? credit_usd : this.convertUsdToTokens(credit_usd, true);
    };

    override async depositAsCollateral(amount: TokenInput, zap: ZapperInstructions = 'none',  receiver: address | null = null) {
        if(this.cache.userDebt > 0) {
            throw new Error("Cannot deposit as collateral when there is outstanding debt");
        }
        return super.depositAsCollateral(amount, zap, receiver);
    }

    override async postCollateral(amount: TokenInput) {
        if(this.cache.userDebt > 0) {
            throw new Error("Cannot post collateral when there is outstanding debt");
        }
        return super.postCollateral(amount);
    }

    async hypotheticalBorrowOf(amount: TokenInput) {
        const signer = validateProviderAsSigner(this.provider);
        const assets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        return this.market.reader.hypotheticalBorrowOf(
            signer.address as address,
            this,
            assets
        )
    }

    async fetchDebt(inUSD: true): Promise<USD>;
    async fetchDebt(inUSD: false): Promise<bigint>;
    async fetchDebt(inUSD = true): Promise<USD | bigint> {
        const totalDebt = await this.contract.marketOutstandingDebt();
        return inUSD ? this.fetchConvertTokensToUsd(totalDebt) : totalDebt;
    }

    async borrow(amount: TokenInput, receiver: address | null = null) {
        const signer = validateProviderAsSigner(this.provider);
        receiver ??= signer.address as address;
        const assets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);

        const calldata = this.getCallData("borrow", [ assets, receiver ]);
        return this.oracleRoute(calldata);
    }

    async dynamicIRM() {
        const irm_addr = await this.contract.IRM();
        return contractSetup<IDynamicIRM>(this.provider, irm_addr, irm_abi);
    }

    async fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove'): Promise<Percentage>;
    async fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove', inPercentage: false ): Promise<bigint>;
    async fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove', inPercentage: true ): Promise<Percentage>;
    async fetchUtilizationRateChange(assets: TokenInput, direction: 'add' | 'remove', inPercentage = true ): Promise<Percentage | bigint> {
        const assets_as_bn = FormatConverter.decimalToBigInt(assets, this.asset.decimals);
        const irm = await this.dynamicIRM();
        const assets_held = direction == 'add' ? this.cache.liquidity + assets_as_bn : this.cache.liquidity - assets_as_bn;
        const newRate = await irm.utilizationRate(assets_held, this.cache.debt);

        return inPercentage ? Decimal(newRate).div(WAD) : newRate;
    }

    async fetchDebtBalanceAtTimestamp(): Promise<USD>;
    async fetchDebtBalanceAtTimestamp(timestamp: bigint): Promise<USD>;
    async fetchDebtBalanceAtTimestamp(timestamp: bigint, asUSD: true): Promise<USD>;
    async fetchDebtBalanceAtTimestamp(timestamp: bigint, asUSD: false): Promise<bigint>;
    async fetchDebtBalanceAtTimestamp(timestamp: bigint = 0n, asUSD: boolean = true): Promise<USD | bigint> {
        const signer = validateProviderAsSigner(this.provider);
        const debt = await this.market.reader.debtBalanceAtTimestamp(signer.address as address, this.address, timestamp);
        return asUSD ? this.fetchConvertTokensToUsd(debt) : debt;
    }

    async fetchBorrowRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = this.totalAssets
        const debt = await this.contract.marketOutstandingDebt();
        const borrowRate = (await irm.borrowRate(assetsHeld, debt));
        this.cache.borrowRate = borrowRate;
        return borrowRate;
    }

    async fetchPredictedBorrowRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = this.totalAssets
        const debt = await this.contract.marketOutstandingDebt();
        const predictedBorrowRate = (await irm.predictedBorrowRate(assetsHeld, debt));
        this.cache.predictedBorrowRate = predictedBorrowRate;
        return predictedBorrowRate;
    }

    async fetchUtilizationRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = this.totalAssets
        const debt = await this.contract.marketOutstandingDebt();
        const utilizationRate = (await irm.utilizationRate(assetsHeld, debt));
        this.cache.utilizationRate = utilizationRate;
        return utilizationRate;
    }

    async fetchSupplyRate() {
        const irm = await this.dynamicIRM();
        const assetsHeld = this.totalAssets
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

    async repay(amount: TokenInput) {
        const assets = FormatConverter.decimalToBigInt(amount, this.asset.decimals);
        const calldata = this.getCallData("repay", [ assets ]);
        return this.oracleRoute(calldata);
    }

    async fetchInterestFee() {
        return this.contract.interestFee();
    }

    async marketOutstandingDebt() {
        return this.contract.marketOutstandingDebt();
    }

    async debtBalance(account: address) {
        return this.contract.debtBalance(account);
    }
}