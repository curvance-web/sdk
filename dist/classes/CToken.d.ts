import { Contract, TransactionResponse } from "ethers";
import { ChangeRate } from "../helpers";
import { DynamicMarketToken, StaticMarketToken, UserMarketToken } from "./ProtocolReader";
import { ERC20 } from "./ERC20";
import { Market, PluginTypes } from "./Market";
import { Calldata } from "./Calldata";
import Decimal from "decimal.js";
import { address, bytes, curvance_provider, Percentage, TokenInput, USD, USD_WAD } from "../types";
import { Zapper, ZapperTypes } from "./Zapper";
import { PositionManager, PositionManagerTypes } from "./PositionManager";
import { BorrowableCToken } from "./BorrowableCToken";
import { NativeToken } from "./NativeToken";
import { ERC4626 } from "./ERC4626";
export interface AccountSnapshot {
    asset: address;
    decimals: bigint;
    isCollateral: boolean;
    collateralPosted: bigint;
    debtBalance: bigint;
}
export interface MulticallAction {
    target: address;
    isPriceUpdate: boolean;
    data: bytes;
}
export interface ZapToken {
    interface: NativeToken | ERC20;
    type: ZapperTypes;
    quote?: (tokenIn: string, tokenOut: string, amount: TokenInput, slippage: Percentage) => Promise<{
        minOut_raw: bigint;
        output_raw: bigint;
        minOut: Decimal;
        output: Decimal;
        extra?: any;
    }>;
}
export type ZapperInstructions = 'none' | 'native-vault' | 'vault' | 'native-simple' | {
    type: ZapperTypes;
    inputToken: address;
    slippage: Percentage;
};
export interface ICToken {
    decimals(): Promise<bigint>;
    isBorrowable(): Promise<boolean>;
    balanceOf(account: address): Promise<bigint>;
    asset(): Promise<address>;
    totalSupply(): Promise<bigint>;
    totalAssets(): Promise<bigint>;
    marketManager(): Promise<address>;
    convertToAssets(shares: bigint): Promise<bigint>;
    convertToShares(assets: bigint): Promise<bigint>;
    exchangeRate(): Promise<bigint>;
    getSnapshot(account: address): Promise<AccountSnapshot>;
    multicall(calls: MulticallAction[]): Promise<TransactionResponse>;
    deposit(assets: bigint, receiver: address): Promise<TransactionResponse>;
    depositAsCollateral(assets: bigint, receiver: address): Promise<TransactionResponse>;
    redeem(shares: bigint, receiver: address, owner: address): Promise<TransactionResponse>;
    marketCollateralPosted(): Promise<bigint>;
    collateralPosted(account: address): Promise<bigint>;
    redeemCollateral(shares: bigint, receiver: address, owner: address): Promise<TransactionResponse>;
    postCollateral(shares: bigint): Promise<TransactionResponse>;
    removeCollateral(shares: bigint): Promise<TransactionResponse>;
    symbol(): Promise<string>;
    name(): Promise<string>;
    maxDeposit(receiver: address): Promise<bigint>;
    transfer(receiver: address, amount: bigint): Promise<TransactionResponse>;
    approve(spender: address, amount: bigint): Promise<TransactionResponse>;
    allowance(owner: address, spender: address): Promise<bigint>;
    isDelegate(user: address, delegate: address): Promise<boolean>;
    setDelegateApproval(delegate: address, approved: boolean): Promise<TransactionResponse>;
}
export declare class CToken extends Calldata<ICToken> {
    provider: curvance_provider;
    address: address;
    contract: Contract & ICToken;
    abi: any;
    cache: StaticMarketToken & DynamicMarketToken & UserMarketToken;
    market: Market;
    zapTypes: ZapperTypes[];
    leverageTypes: string[];
    isVault: boolean;
    isNativeVault: boolean;
    isWrappedNative: boolean;
    nativeApy: Decimal;
    incentiveSupplyApy: Decimal;
    incentiveBorrowApy: Decimal;
    constructor(provider: curvance_provider, address: address, cache: StaticMarketToken & DynamicMarketToken & UserMarketToken, market: Market);
    get adapters(): [bigint, bigint];
    get borrowPaused(): boolean;
    get collateralizationPaused(): boolean;
    get mintPaused(): boolean;
    get marketManager(): Market;
    get decimals(): bigint;
    get symbol(): string;
    get name(): string;
    get asset(): import("./ProtocolReader").StaticMarketAsset;
    get isBorrowable(): boolean;
    get exchangeRate(): bigint;
    get canZap(): boolean;
    get maxLeverage(): Decimal;
    get canLeverage(): boolean;
    get totalAssets(): bigint;
    get totalSupply(): bigint;
    get liquidationPrice(): USD | null;
    get irmTargetRate(): Decimal;
    get irmMaxRate(): Decimal;
    get irmTargetUtilization(): Decimal;
    get interestFee(): Decimal;
    virtualConvertToAssets(shares: bigint): bigint;
    virtualConvertToShares(assets: bigint): bigint;
    getLeverage(): Decimal | null;
    /** @returns Remaining Collateral cap */
    getRemainingCollateral(formatted: true): USD;
    getRemainingCollateral(formatted: false): bigint;
    /** @returns Remaining Debt cap */
    getRemainingDebt(formatted: true): USD;
    getRemainingDebt(formatted: false): bigint;
    /** @returns Collateral Ratio in BPS or bigint */
    getCollRatio(inBPS: true): Percentage;
    getCollRatio(inBPS: false): bigint;
    /** @returns Soft Collateral Requirement in BPS or bigint */
    getCollReqSoft(inBPS: true): Percentage;
    getCollReqSoft(inBPS: false): bigint;
    /** @returns Hard Collateral Requirement in BPS or bigint */
    getCollReqHard(inBPS: true): Percentage;
    getCollReqHard(inBPS: false): bigint;
    /** @returns Liquidation Incentive Base in BPS or bigint */
    getLiqIncBase(inBPS: true): Percentage;
    getLiqIncBase(inBPS: false): bigint;
    /** @returns Liquidation Incentive Curve in BPS or bigint */
    getLiqIncCurve(inBPS: true): Percentage;
    getLiqIncCurve(inBPS: false): bigint;
    /** @returns Liquidation Incentive Min in BPS or bigint */
    getLiqIncMin(inBPS: true): Percentage;
    getLiqIncMin(inBPS: false): bigint;
    /** @returns Liquidation Incentive Max in BPS or bigint */
    getLiqIncMax(inBPS: true): Percentage;
    getLiqIncMax(inBPS: false): bigint;
    /** @returns Close Factor Base in BPS or bigint */
    getCloseFactorBase(inBPS: true): Percentage;
    getCloseFactorBase(inBPS: false): bigint;
    /** @returns Close Factor Curve in BPS or bigint */
    getCloseFactorCurve(inBPS: true): Percentage;
    getCloseFactorCurve(inBPS: false): bigint;
    /** @returns Close Factor Min in BPS or bigint */
    getCloseFactorMin(inBPS: true): Percentage;
    getCloseFactorMin(inBPS: false): bigint;
    /** @returns Close Factor Max in Percentage or bigint */
    getCloseFactorMax(inBPS: true): Percentage;
    getCloseFactorMax(inBPS: false): bigint;
    /** @returns User shares in USD (native balance amount) or token */
    getUserShareBalance(inUSD: true): USD;
    getUserShareBalance(inUSD: false): TokenInput;
    /** @returns User assets in USD (this is the raw balance that the token exchanges too) or token */
    getUserAssetBalance(inUSD: true): USD;
    getUserAssetBalance(inUSD: false): TokenInput;
    /** @returns User underlying assets in USD or token */
    getUserUnderlyingBalance(inUSD: true): USD;
    getUserUnderlyingBalance(inUSD: false): TokenInput;
    /** @returns Token Collateral Cap in USD or USD WAD */
    getCollateralCap(inUSD: true): USD;
    getCollateralCap(inUSD: false): USD_WAD;
    /** @returns Token Debt Cap in USD or USD WAD */
    getDebtCap(inUSD: true): USD;
    getDebtCap(inUSD: false): bigint;
    /** @returns Token Collateral in USD or USD WAD*/
    getCollateral(inUSD: true): USD;
    getCollateral(inUSD: false): USD_WAD;
    /** @returns Token Debt in USD or USD WAD */
    getDebt(inUSD: true): USD;
    getDebt(inUSD: false): USD_WAD;
    /** @returns User Collateral in USD or share token amount */
    getUserCollateral(inUSD: true): USD;
    getUserCollateral(inUSD: false): TokenInput;
    fetchUserCollateral(): Promise<bigint>;
    fetchUserCollateral(formatted: true): Promise<TokenInput>;
    fetchUserCollateral(formatted: false): Promise<bigint>;
    /** @returns User Debt in USD or Tokens owed (assets) */
    getUserDebt(inUSD: true): USD;
    getUserDebt(inUSD: false): TokenInput;
    earnChange(amount: USD, rateType: ChangeRate): Decimal;
    /**
     * Grabs the collateralization ratio and converts it to a Percentage.
     * @returns Percentage representation of the LTV (e.g. 0.75 for 75% LTV)
     */
    ltv(): Percentage;
    getUnderlyingVault(): ERC4626;
    getVaultAsset(asErc20: true): Promise<ERC20>;
    getVaultAsset(asErc20: false): Promise<address>;
    getAsset(asErc20: true): ERC20;
    getAsset(asErc20: false): address;
    getPrice(): USD;
    getPrice(asset: boolean): USD;
    getPrice(asset: boolean, lower: boolean): USD;
    getPrice(asset: boolean, lower: boolean, formatted: true): USD;
    getPrice(asset: boolean, lower: boolean, formatted: false): USD_WAD;
    getApy(): Percentage;
    getApy(asPercentage: false): bigint;
    getApy(asPercentage: true): Percentage;
    getTotalBorrowRate(): Decimal;
    getTotalSupplyRate(): Decimal;
    getBorrowRate(): Percentage;
    getBorrowRate(inPercentage: true): Percentage;
    getBorrowRate(inPercentage: false): bigint;
    getSupplyRate(): Percentage;
    getSupplyRate(asPercentage: false): bigint;
    getSupplyRate(asPercentage: true): Percentage;
    getTvl(inUSD: true): USD;
    getTvl(inUSD: false): bigint;
    fetchTvl(inUSD: true): Promise<USD>;
    fetchTvl(inUSD: false): Promise<bigint>;
    getTotalCollateral(inUSD: true): USD;
    getTotalCollateral(inUSD: false): bigint;
    fetchTotalCollateral(inUSD: true): Promise<USD>;
    fetchTotalCollateral(inUSD: false): Promise<bigint>;
    getPositionManager(type: PositionManagerTypes): PositionManager;
    getZapper(type: ZapperTypes): Zapper | null;
    isZapAssetApproved(instructions: ZapperInstructions, amount: bigint): Promise<boolean>;
    approveZapAsset(instructions: ZapperInstructions, amount: TokenInput | null): Promise<TransactionResponse | undefined>;
    isPluginApproved(plugin: ZapperTypes | PositionManagerTypes, type: PluginTypes): Promise<boolean>;
    approvePlugin(plugin: ZapperTypes | PositionManagerTypes, type: PluginTypes): Promise<TransactionResponse>;
    getPluginAddress(plugin: ZapperTypes | PositionManagerTypes, type: PluginTypes): address | null;
    getAllowance(check_contract: address, underlying?: boolean): Promise<bigint>;
    /**
     * Approves the underlying asset to be used with the ctoken contract.
     * @param amount - if null it will approve the max uint256, otherwise the amount specified
     * @returns tx
     */
    approveUnderlying(amount?: TokenInput | null, target?: address | null): Promise<TransactionResponse>;
    approve(amount: (TokenInput | null) | undefined, spender: address): Promise<TransactionResponse>;
    fetchDecimals(): Promise<bigint>;
    fetchIsBorrowable(): Promise<boolean>;
    fetchAsset(): Promise<`0x${string}`>;
    fetchMarketManagerAddr(): Promise<`0x${string}`>;
    fetchSymbol(): Promise<string>;
    fetchName(): Promise<string>;
    fetchPrice(asset?: boolean, getLower?: boolean, inUSD?: boolean): Promise<bigint>;
    fetchTotalSupply(): Promise<bigint>;
    fetchTotalAssets(): Promise<bigint>;
    getExchangeRate(): Promise<bigint>;
    marketCollateralPosted(): Promise<bigint>;
    balanceOf(account: address): Promise<bigint>;
    maxDeposit(receiver: address): Promise<bigint>;
    transfer(receiver: address, amount: TokenInput): Promise<TransactionResponse>;
    redeemCollateral(amount: Decimal, receiver?: address | null, owner?: address | null): Promise<TransactionResponse>;
    postCollateral(amount: TokenInput): Promise<TransactionResponse>;
    getZapBalance(zap: ZapperInstructions): Promise<bigint>;
    ensureUnderlyingAmount(amount: TokenInput, zap: ZapperInstructions): Promise<TokenInput>;
    removeCollateral(amount: TokenInput, removeAll?: boolean): Promise<TransactionResponse>;
    convertTokenInputToShares(amount: TokenInput): bigint;
    convertTokenToToken(fromToken: CToken, toToken: CToken, amount: TokenInput, formatted: true): TokenInput;
    convertTokenToToken(fromToken: CToken, toToken: CToken, amount: TokenInput, formatted: true, shares: boolean): TokenInput;
    convertTokenToToken(fromToken: CToken, toToken: CToken, amount: TokenInput, formatted: false, shares: boolean): bigint;
    convertTokenToToken(fromToken: CToken, toToken: CToken, amount: TokenInput, formatted: false): bigint;
    convertToAssets(shares: bigint): Promise<bigint>;
    convertToShares(assets: bigint, bufferBps?: bigint): Promise<bigint>;
    maxRedemption(): Promise<TokenInput>;
    maxRedemption(in_shares: true): Promise<bigint>;
    maxRedemption(in_shares: false): Promise<TokenInput>;
    maxRedemption(in_shares: true, bufferTime: bigint): Promise<bigint>;
    maxRedemption(in_shares: false, bufferTime: bigint): Promise<TokenInput>;
    maxRedemption(in_shares: true, bufferTime: bigint, breakdown: true): Promise<{
        max_collateral: bigint;
        max_uncollateralized: bigint;
    }>;
    maxRedemption(in_shares: false, bufferTime: bigint, breakdown: true): Promise<{
        max_collateral: TokenInput;
        max_uncollateralized: TokenInput;
    }>;
    /** @returns A list of tokens mapped to their respective zap options */
    getDepositTokens(search?: string | null): Promise<ZapToken[]>;
    hypotheticalRedemptionOf(amount: TokenInput): Promise<{
        excess: bigint;
        deficit: bigint;
        isPossible: boolean;
        priceStale: boolean;
    }>;
    /**
     * Compute slippage BPS for the contract's checkSlippage modifier when leveraging up.
     * Share rounding (vault + cToken) causes equity loss ≈ 20bps × (leverage - 1).
     * The user's swap slippage is preserved for DEX protection; this adds a buffer
     * so the on-chain sanity check doesn't reject legitimate leverage operations.
     */
    private _leverageUpSlippage;
    previewLeverageUp(newLeverage: Decimal, borrow: BorrowableCToken, depositAmount?: bigint): {
        borrowAmount: Decimal;
        rawBorrowAmount: Decimal;
        newDebt: Decimal;
        newDebtInAssets: Decimal;
        newCollateral: Decimal;
        newCollateralInAssets: Decimal;
    };
    previewLeverageDown(newLeverage: Decimal, currentLeverage: Decimal, borrow?: BorrowableCToken): {
        collateralAssetReduction: bigint;
        collateralAssetReductionUsd: Decimal;
        leverageDiff: Decimal;
        newDebt: Decimal;
        newDebtInAssets: Decimal | undefined;
        newCollateral: Decimal;
        newCollateralInAssets: Decimal;
    };
    leverageUp(borrow: BorrowableCToken, newLeverage: Decimal, type: PositionManagerTypes, slippage_?: Percentage, simulate?: boolean): Promise<any>;
    leverageDown(borrowToken: BorrowableCToken, currentLeverage: Decimal, newLeverage: Decimal, type: PositionManagerTypes, slippage_?: Percentage, simulate?: boolean): Promise<any>;
    depositAndLeverage(depositAmount: TokenInput, borrow: BorrowableCToken, multiplier: Decimal, type: PositionManagerTypes, slippage_?: Percentage, simulate?: boolean): Promise<any>;
    simulateDeposit(amount: TokenInput, zap?: ZapperInstructions, receiver?: address | null): Promise<{
        success: boolean;
        error?: string;
    }>;
    simulateDepositAsCollateral(amount: TokenInput, zap?: ZapperInstructions, receiver?: address | null): Promise<{
        success: boolean;
        error?: string;
    }>;
    zap(assets: bigint, zap: ZapperInstructions, collateralize: boolean | undefined, default_calldata: bytes): Promise<{
        calldata: `0x${string}`;
        calldata_overrides: {};
        zapper: null;
    } | {
        calldata: `0x${string}`;
        calldata_overrides: {};
        zapper: Zapper;
    }>;
    deposit(amount: TokenInput, zap?: ZapperInstructions, receiver?: address | null): Promise<TransactionResponse>;
    depositAsCollateral(amount: Decimal, zap?: ZapperInstructions, receiver?: address | null): Promise<TransactionResponse>;
    redeem(amount: TokenInput): Promise<TransactionResponse>;
    redeemShares(amount: bigint): Promise<TransactionResponse>;
    collateralPosted(account?: address | null): Promise<bigint>;
    multicall(calls: MulticallAction[]): Promise<TransactionResponse>;
    getSnapshot(account: address): Promise<{
        asset: `0x${string}`;
        decimals: bigint;
        isCollateral: boolean;
        collateralPosted: bigint;
        debtBalance: bigint;
    }>;
    convertTokensToUsd(tokenAmount: bigint, asset?: boolean): USD;
    fetchConvertTokensToUsd(tokenAmount: bigint, asset?: boolean): Promise<Decimal>;
    convertUsdToTokens(usdAmount: USD, asset?: boolean, lower?: boolean): Decimal;
    convertAssetsToUsd(tokenAmount: bigint): USD;
    convertSharesToUsd(tokenAmount: bigint): Promise<USD>;
    buildMultiCallAction(calldata: bytes): MulticallAction;
    private _checkPositionManagerApproval;
    private _checkZapperApproval;
    private _checkErc20Approval;
    private _checkAssetApproval;
    private _checkDepositApprovals;
    oracleRoute(calldata: bytes, override?: {
        [key: string]: any;
    }): Promise<TransactionResponse>;
    simulateOracleRoute(calldata: bytes, override?: {
        [key: string]: any;
    }): Promise<{
        success: boolean;
        error?: string;
    }>;
    getPriceUpdates(): Promise<MulticallAction[]>;
}
//# sourceMappingURL=CToken.d.ts.map