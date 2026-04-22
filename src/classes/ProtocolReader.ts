import { Contract } from "ethers";
import { contractSetup, EMPTY_ADDRESS, toDecimal, UINT256_MAX, WAD } from "../helpers";
import abi from '../abis/ProtocolReader.json'
import { address, curvance_read_provider, TokenInput, TypeBPS } from "../types";
import Decimal from "decimal.js";
import { MarketToken } from "./Market";
import { BorrowableCToken } from "./BorrowableCToken";
import { CToken } from "./CToken";
import FormatConverter from "./FormatConverter";

export const AdaptorTypes = {
    CHAINLINK: 4146809896196834135992027840844413263297648946195754575888528621153937239424n,
    REDSTONE_CLASSIC: 112276167558285217273674630712820450209078260760085898814947528017380798039930n,
    REDSTONE_CORE: 2n,
    MOCK: 1337n
};

export interface StaticMarketAsset {
    address: address;
    name: string;
    symbol: string;
    decimals: bigint;
    totalSupply: bigint;
    balance?: bigint;
    image?: string;
    price?: Decimal;
}

export interface StaticMarketToken {
    address: address;
    asset: StaticMarketAsset;
    name: string;
    symbol: string;
    decimals: bigint;
    adapters: [bigint, bigint];
    isBorrowable: boolean;
    borrowPaused: boolean;
    collateralizationPaused: boolean;
    mintPaused: boolean;
    collateralCap: bigint;
    debtCap: bigint;
    isListed: boolean;
    collRatio: TypeBPS;
    maxLeverage: TypeBPS;
    collReqSoft: TypeBPS;
    collReqHard: TypeBPS;
    liqIncBase: TypeBPS;
    liqIncCurve: TypeBPS;
    liqIncMin: TypeBPS;
    liqIncMax: TypeBPS;
    closeFactorBase: TypeBPS;
    closeFactorCurve: TypeBPS;
    closeFactorMin: TypeBPS;
    closeFactorMax: TypeBPS;
    irmTargetRate: bigint;
    irmMaxRate: bigint;
    irmTargetUtilization: bigint;
    interestFee: TypeBPS;
}

export interface StaticMarketData {
    address: address;
    adapters: bigint[];
    cooldownLength: bigint;
    tokens: StaticMarketToken[];
}

export interface DynamicMarketToken {
    address: address;
    exchangeRate: bigint;
    totalSupply: bigint;
    totalAssets: bigint;
    collateral: bigint;
    debt: bigint;
    sharePrice: bigint;
    assetPrice: bigint;
    sharePriceLower: bigint;
    assetPriceLower: bigint;
    borrowRate: bigint;
    predictedBorrowRate: bigint;
    utilizationRate: bigint;
    supplyRate: bigint;
    liquidity: bigint;
}

export interface DynamicMarketData {
    address: address;
    tokens: DynamicMarketToken[];
}

export interface UserMarketToken {
    address: address;
    userAssetBalance: bigint;
    userShareBalance: bigint;
    userUnderlyingBalance: bigint;
    userCollateral: bigint;
    userDebt: bigint;
    liquidationPrice: bigint;
}

export interface UserMarketSummary {
    address: address;
    collateral: bigint;
    maxDebt: bigint;
    debt: bigint;
    positionHealth: bigint;
    cooldown: bigint;
    errorCodeHit: boolean;
    priceStale: boolean;
}

export interface UserMarket extends UserMarketSummary {
    tokens: UserMarketToken[]
}

export interface UserLock {
    lockIndex: bigint;
    amount: bigint;
    unlockTime: bigint;
}

export interface UserData {
    locks: UserLock[];
    markets: UserMarket[];
}

export interface IProtocolReader {
    getAllDynamicState(account: address): Promise<any>;
    getMarketSummaries(markets: address[], account: address): Promise<any>;
    getMarketStates(markets: address[], account: address): Promise<any>;
    getUserData(account: address): Promise<UserData>;
    getDynamicMarketData(): Promise<DynamicMarketData[]>;
    getStaticMarketData(): Promise<StaticMarketData[]>;
    marketMultiCooldown(markets: address[], account: address): Promise<bigint[]>;
    previewAssetImpact(user: address, collateral_ctoken: address, debt_ctoken: address, new_collateral: bigint, new_debt: bigint): Promise<[bigint, bigint]>;
    hypotheticalLeverageOf(account: address, depositCToken: address, borrowCToken: address, assets: bigint, bufferTime: bigint): Promise<[ bigint, bigint, bigint, bigint, boolean, boolean ]>;
    getPositionHealth(market: address, account: address, ctoken: address, borrowableCToken: address, isDeposit: boolean, collateralAssets: bigint, isRepayment: boolean, debtAssets: bigint, bufferTime: bigint): Promise<[bigint, boolean]>;
    hypotheticalRedemptionOf(account: address, ctoken: address, redeemShares: bigint, bufferTime: bigint): Promise<[bigint, bigint, boolean, boolean]>;
    hypotheticalBorrowOf(account: address, borrowableCToken: address, borrowAssets: bigint, bufferTime: bigint): Promise<[bigint, bigint, boolean, boolean, boolean]>;
    maxRedemptionOf(account: address, ctoken: address, bufferTime: bigint): Promise<[bigint, bigint, boolean]>;
    debtBalanceAtTimestamp(account: address, borrowableCtoken: address, timestamp: bigint): Promise<bigint>;
    getBalancesOf(tokens: address[], account: address): Promise<bigint[]>;
    getLeverageSnapshot(account: address, cToken: address, borrowableCToken: address, bufferTime: bigint): Promise<[bigint, bigint, bigint, bigint, bigint, bigint, boolean]>;
}

const PROTOCOL_READER_EXTRA_ABI = [
    "function getMarketSummaries(address[] markets, address account) view returns ((address _address,uint256 collateral,uint256 maxDebt,uint256 debt,uint256 positionHealth,uint256 cooldown,bool errorCodeHit)[] userMarkets)",
    "function getMarketStates(address[] markets, address account) view returns ((address _address,(address _address,uint256 totalSupply,uint256 exchangeRate,uint256 totalAssets,uint256 collateral,uint256 debt,uint256 sharePrice,uint256 assetPrice,uint256 sharePriceLower,uint256 assetPriceLower,uint256 borrowRate,uint256 predictedBorrowRate,uint256 utilizationRate,uint256 supplyRate,uint256 liquidity)[] tokens)[] dynamicMarkets,(address _address,uint256 collateral,uint256 maxDebt,uint256 debt,uint256 positionHealth,uint256 cooldown,bool errorCodeHit,(address _address,uint256 userAssetBalance,uint256 userShareBalance,uint256 userUnderlyingBalance,uint256 userCollateral,uint256 userDebt,uint256 liquidationPrice)[] tokens)[] userMarkets)",
] as const;
const GET_MARKET_SUMMARIES_SELECTOR = "0x02230f46";
const GET_MARKET_STATES_SELECTOR = "0xaa78b4d4";
const STATIC_MARKET_CACHE_TTL_MS = 60_000;

type StaticMarketCacheEntry = {
    expiresAt: number;
    data: Promise<StaticMarketData[]>;
};

function normalizeDynamicMarketData(data: any[]): DynamicMarketData[] {
    return data.map((market: any) => ({
        address: market._address,
        tokens: market.tokens.map((token: any) => ({
            address: token._address,
            totalSupply: BigInt(token.totalSupply),
            totalAssets: BigInt(token.totalAssets),
            exchangeRate: BigInt(token.exchangeRate),
            collateral: BigInt(token.collateral),
            debt: BigInt(token.debt),
            sharePrice: BigInt(token.sharePrice),
            assetPrice: BigInt(token.assetPrice),
            sharePriceLower: BigInt(token.sharePriceLower),
            assetPriceLower: BigInt(token.assetPriceLower),
            borrowRate: BigInt(token.borrowRate),
            predictedBorrowRate: BigInt(token.predictedBorrowRate),
            utilizationRate: BigInt(token.utilizationRate),
            supplyRate: BigInt(token.supplyRate),
            liquidity: BigInt(token.liquidity),
        })),
    }));
}

function normalizeUserMarketSummary(market: any): UserMarketSummary {
    return {
        address: market._address,
        collateral: BigInt(market.collateral),
        maxDebt: BigInt(market.maxDebt),
        debt: BigInt(market.debt),
        positionHealth: BigInt(market.positionHealth),
        cooldown: BigInt(market.cooldown),
        // ABI names this field `errorCodeHit`; keep `priceStale` as a
        // backward-compatible alias until downstream consumers migrate.
        errorCodeHit: Boolean(market.errorCodeHit ?? market.priceStale),
        priceStale: Boolean(market.errorCodeHit ?? market.priceStale),
    };
}

function normalizeUserMarketSummaries(data: any[]): UserMarketSummary[] {
    return data.map((market: any) => normalizeUserMarketSummary(market));
}

function normalizeUserMarkets(data: any[]): UserMarket[] {
    return data.map((market: any) => ({
        ...normalizeUserMarketSummary(market),
        tokens: market.tokens.map((token: any) => ({
            address: token._address,
            userAssetBalance: BigInt(token.userAssetBalance),
            userShareBalance: BigInt(token.userShareBalance),
            userUnderlyingBalance: BigInt(token.userUnderlyingBalance),
            userCollateral: BigInt(token.userCollateral),
            userDebt: BigInt(token.userDebt),
            liquidationPrice: BigInt(token.liquidationPrice),
        })),
    }));
}

function normalizeUserData(data: any): UserData {
    return {
        locks: (data?.locks ?? []).map((lock: any) => ({
            lockIndex: BigInt(lock.lockIndex),
            amount: BigInt(lock.amount),
            unlockTime: BigInt(lock.unlockTime),
        })),
        markets: normalizeUserMarkets(data?.markets ?? []),
    };
}

function createEmptyUserData(staticMarkets: StaticMarketData[]): UserData {
    return {
        locks: [],
        markets: staticMarkets.map((market) => ({
            address: market.address,
            collateral: 0n,
            maxDebt: 0n,
            debt: 0n,
            positionHealth: UINT256_MAX,
            cooldown: market.cooldownLength,
            errorCodeHit: false,
            priceStale: false,
            tokens: market.tokens.map((token) => ({
                address: token.address,
                userAssetBalance: 0n,
                userShareBalance: 0n,
                userUnderlyingBalance: 0n,
                userCollateral: 0n,
                userDebt: 0n,
                liquidationPrice: UINT256_MAX,
            })),
        })),
    };
}

function normalizeStaticMarketData(data: any[]): StaticMarketData[] {
    return data.map((market: any) => ({
        address: market._address,
        adapters: market.adapters,
        cooldownLength: market.cooldownLength,
        tokens: market.tokens.map((token: any) => ({
            address: token._address,
            name: token.name,
            symbol: token.symbol,
            decimals: BigInt(token.decimals),
            asset: {
                address: token.asset._address,
                name: token.asset.name,
                symbol: token.asset.symbol,
                decimals: BigInt(token.asset.decimals),
                totalSupply: BigInt(token.asset.totalSupply)
            },
            adapters: [BigInt(token.adapters[0]), BigInt(token.adapters[1])],
            isBorrowable: token.isBorrowable,
            borrowPaused: token.borrowPaused,
            collateralizationPaused: token.collateralizationPaused,
            mintPaused: token.mintPaused,
            collateralCap: BigInt(token.collateralCap),
            debtCap: BigInt(token.debtCap),
            isListed: token.isListed,
            collRatio: BigInt(token.collRatio),
            maxLeverage: BigInt(token.maxLeverage),
            collReqSoft: BigInt(token.collReqSoft),
            collReqHard: BigInt(token.collReqHard),
            liqIncBase: BigInt(token.liqIncBase),
            liqIncCurve: BigInt(token.liqIncCurve),
            liqIncMin: BigInt(token.liqIncMin),
            liqIncMax: BigInt(token.liqIncMax),
            closeFactorBase: BigInt(token.closeFactorBase),
            closeFactorCurve: BigInt(token.closeFactorCurve),
            closeFactorMin: BigInt(token.closeFactorMin),
            closeFactorMax: BigInt(token.closeFactorMax),
            irmTargetRate: BigInt(token.irmTargetRate),
            irmMaxRate: BigInt(token.irmMaxRate),
            irmTargetUtilization: BigInt(token.irmTargetUtilization),
            interestFee: BigInt(token.interestFee)
        }))
    }));
}

// Module-level cache: reader address → whether the new getMarketStates
// selector is deployed on that contract. Every setupChain() constructs a
// fresh ProtocolReader, so a per-instance flag would re-probe on every
// chain switch. After the retry-provider unknown-error cascade fix, one
// probe costs primary + every configured fallback RPC, making the re-probe
// observable cost rather than a silent waste.
const PROTOCOL_READER_SELECTOR_SUPPORT = new Map<string, boolean>();
const PROTOCOL_READER_FALLBACK_WARNED = new Set<string>();
const PROTOCOL_READER_SUMMARY_SELECTOR_SUPPORT = new Map<string, boolean>();
const PROTOCOL_READER_SUMMARY_FALLBACK_WARNED = new Set<string>();
const STATIC_MARKET_DATA_CACHE = new Map<string, StaticMarketCacheEntry>();

function resolveDefaultReadProvider(): curvance_read_provider | undefined {
    return (require("../setup") as typeof import("../setup")).setup_config?.readProvider;
}

/** Test-only: reset the module-level probe cache so tests can validate
 *  probe-path behavior in isolation. Not part of the public runtime API. */
export function __resetProtocolReaderCache(): void {
    PROTOCOL_READER_SELECTOR_SUPPORT.clear();
    PROTOCOL_READER_FALLBACK_WARNED.clear();
    PROTOCOL_READER_SUMMARY_SELECTOR_SUPPORT.clear();
    PROTOCOL_READER_SUMMARY_FALLBACK_WARNED.clear();
    STATIC_MARKET_DATA_CACHE.clear();
}

export class ProtocolReader {
    provider: curvance_read_provider;
    address: address;
    contract: Contract & IProtocolReader;
    readonly batchKey: string | null;
    private readonly staticMarketCacheKey: string | null;
    private readonly probeCacheKey: string;

    constructor(
        address: address,
        provider?: curvance_read_provider,
        cacheNamespace: string | null = null,
    ) {
        const resolvedProvider = provider ?? resolveDefaultReadProvider();
        if (resolvedProvider == undefined) {
            throw new Error(
                `Read provider is not configured for ProtocolReader ${address}. ` +
                `Pass a provider explicitly or initialize setupChain() first.`
            );
        }

        this.provider = resolvedProvider;
        this.address = address;
        this.contract = contractSetup<IProtocolReader>(resolvedProvider, address, [...abi, ...PROTOCOL_READER_EXTRA_ABI]);
        const normalizedAddress = address.toLowerCase();
        this.batchKey =
            cacheNamespace == null ? null : `${cacheNamespace}:${normalizedAddress}`;
        this.staticMarketCacheKey = this.batchKey;
        this.probeCacheKey =
            this.batchKey ?? normalizedAddress;
    }

    private isMissingSelector(error: any, selector: string): boolean {
        const message = String(error?.message ?? "").toLowerCase();
        const shortMessage = String(error?.shortMessage ?? "").toLowerCase();
        const revertReason = String(error?.reason ?? "").toLowerCase();
        const txData = String(error?.transaction?.data ?? "").toLowerCase();

        const looksLikeSelectorMiss =
            txData.startsWith(selector) &&
            (
                shortMessage.includes("no data present") ||
                shortMessage.includes("missing revert data") ||
                message.includes("no data present") ||
                message.includes("missing revert data") ||
                revertReason === "require(false)"
            );

        return looksLikeSelectorMiss;
    }

    private isMissingGetMarketSummaries(error: any): boolean {
        return this.isMissingSelector(error, GET_MARKET_SUMMARIES_SELECTOR);
    }

    private isMissingGetMarketStates(error: any): boolean {
        return this.isMissingSelector(error, GET_MARKET_STATES_SELECTOR);
    }

    private async getMarketSummariesFallback(markets: address[], account: address) {
        if (!PROTOCOL_READER_SUMMARY_FALLBACK_WARNED.has(this.probeCacheKey)) {
            PROTOCOL_READER_SUMMARY_FALLBACK_WARNED.add(this.probeCacheKey);
            console.warn(
                "[ProtocolReader] getMarketSummaries is not available on this deployment yet. " +
                "Falling back to getMarketStates for summary refreshes."
            );
        }

        const { userMarkets } = await this.getMarketStates(markets, account);
        return userMarkets.map(({ tokens: _tokens, ...summary }) => summary);
    }

    private async getMarketStatesFallback(markets: address[], account: address) {
        // Compatibility fallback: keep this path until every environment that
        // runs the SDK (main deployment, staging, forks, local Anvil) has a
        // ProtocolReader with getMarketStates deployed. Removing it right after
        // a single deployment upgrade will break older forks and stale test envs.
        if (!PROTOCOL_READER_FALLBACK_WARNED.has(this.probeCacheKey)) {
            PROTOCOL_READER_FALLBACK_WARNED.add(this.probeCacheKey);
            console.warn(
                "[ProtocolReader] getMarketStates is not available on this deployment yet. " +
                "Falling back to getDynamicMarketData + getUserData for targeted refreshes."
            );
        }

        const [allDynamicMarkets, userData] = await Promise.all([
            this.getDynamicMarketData(),
            this.getUserData(account),
        ]);

        const dynamicByAddress = new Map(allDynamicMarkets.map((market) => [market.address, market] as const));
        const userByAddress = new Map(userData.markets.map((market) => [market.address, market] as const));

        const dynamicMarkets = markets.map((marketAddress) => {
            const dynamicMarket = dynamicByAddress.get(marketAddress);
            if (!dynamicMarket) {
                throw new Error(`Fallback could not find dynamic market state for ${marketAddress}.`);
            }
            return dynamicMarket;
        });

        const userMarkets = markets.map((marketAddress) => {
            const userMarket = userByAddress.get(marketAddress);
            if (!userMarket) {
                throw new Error(`Fallback could not find user market state for ${marketAddress}.`);
            }
            return userMarket;
        });

        return {
            dynamicMarkets,
            userMarkets,
        };
    }

    async getAllMarketData(account: address | null = null) {
        if(account == null || account === EMPTY_ADDRESS) {
            const [staticMarket, dynamicMarket] = await Promise.all([
                this.getStaticMarketData(),
                this.getDynamicMarketData(),
            ]);

            return {
                staticMarket,
                dynamicMarket,
                userData: createEmptyUserData(staticMarket),
            };
        }

        const [staticMarket, { dynamicMarket, userData }] = await Promise.all([
            this.getStaticMarketData(),
            this.getAllDynamicState(account),
        ]);

        return {
            staticMarket,
            dynamicMarket,
            userData,
        };
    }

    async maxRedemptionOf(account: address, ctoken: CToken, bufferTime: bigint = 0n) {
        const data = await this.contract.maxRedemptionOf(account, ctoken.address, bufferTime);
        return {
            maxCollateralizedShares: BigInt(data[0]),
            maxUncollateralizedShares: BigInt(data[1]),
            errorCodeHit: data[2]
        };
    }

    async hypotheticalRedemptionOf(account: address, ctoken: CToken, shares: bigint, bufferTime: bigint = 0n) {
        const data = await this.contract.hypotheticalRedemptionOf(account, ctoken.address, shares, bufferTime);
        return {
            excess: BigInt(data[0]),
            deficit: BigInt(data[1]),
            isPossible: data[2],
            priceStale: data[3]
        }
    }

    async hypotheticalBorrowOf(account: address, ctoken: BorrowableCToken, assets: bigint, bufferTime: bigint = 0n) {
        const data = await this.contract.hypotheticalBorrowOf(account, ctoken.address, assets, bufferTime);
        const loanSizeError = Boolean(data[3]);
        const oracleError = Boolean(data[4]);
        return {
            excess: BigInt(data[0]),
            deficit: BigInt(data[1]),
            isPossible: Boolean(data[2]),
            loanSizeError,
            oracleError,
            priceStale: oracleError,
        }
    }

    async getPositionHealth(
        market: address,
        account: address,
        ctoken: address,
        borrowableCToken: address,
        isDeposit: boolean,
        collateralAssets: bigint,
        isRepayment: boolean,
        debtAssets: bigint,
        bufferTime: bigint
    ) {
        const data = await this.contract.getPositionHealth(market, account, ctoken, borrowableCToken, isDeposit, collateralAssets, isRepayment, debtAssets, bufferTime);
        return {
            positionHealth: BigInt(data[0]),
            errorCodeHit: data[1]
        }
    }

    async getDynamicMarketData() {
        const data = await this.contract.getDynamicMarketData();
        return normalizeDynamicMarketData(data);
    }

    async getUserData(account: address) {
        const data = await this.contract.getUserData(account);
        return normalizeUserData(data);
    }

    async getAllDynamicState(account: address) {
        const data = await this.contract.getAllDynamicState(account);
        return {
            dynamicMarket: normalizeDynamicMarketData(data.market ?? data[0] ?? []),
            userData: normalizeUserData(data.user ?? data[1] ?? { locks: [], markets: [] }),
        };
    }

    async getMarketSummaries(markets: address[], account: address) {
        if (PROTOCOL_READER_SUMMARY_SELECTOR_SUPPORT.get(this.probeCacheKey) === false) {
            return this.getMarketSummariesFallback(markets, account);
        }

        try {
            const data = await this.contract.getMarketSummaries(markets, account);
            PROTOCOL_READER_SUMMARY_SELECTOR_SUPPORT.set(this.probeCacheKey, true);
            return normalizeUserMarketSummaries(Array.isArray(data) ? data : data.userMarkets ?? data[0] ?? []);
        } catch (error: any) {
            if (!this.isMissingGetMarketSummaries(error)) {
                throw error;
            }

            PROTOCOL_READER_SUMMARY_SELECTOR_SUPPORT.set(this.probeCacheKey, false);
            return this.getMarketSummariesFallback(markets, account);
        }
    }

    async getMarketStates(markets: address[], account: address) {
        if (PROTOCOL_READER_SELECTOR_SUPPORT.get(this.probeCacheKey) === false) {
            return this.getMarketStatesFallback(markets, account);
        }

        try {
            const data = await this.contract.getMarketStates(markets, account);
            PROTOCOL_READER_SELECTOR_SUPPORT.set(this.probeCacheKey, true);
            return {
                dynamicMarkets: normalizeDynamicMarketData(data.dynamicMarkets ?? data[0] ?? []),
                userMarkets: normalizeUserMarkets(data.userMarkets ?? data[1] ?? []),
            };
        } catch (error: any) {
            if (!this.isMissingGetMarketStates(error)) {
                throw error;
            }

            PROTOCOL_READER_SELECTOR_SUPPORT.set(this.probeCacheKey, false);
            return this.getMarketStatesFallback(markets, account);
        }
    }

    async previewAssetImpact(user: address, collateral_ctoken: address, debt_ctoken: address, deposit_amount: bigint, borrow_amount: bigint) {
        const data = await this.contract.previewAssetImpact(user, collateral_ctoken, debt_ctoken, deposit_amount, borrow_amount );
        return {
            supply: BigInt(data[0]),
            borrow: BigInt(data[1])
        };
    }

    async hypotheticalLeverageOf(account: address, depositCToken: MarketToken, borrowableCToken: MarketToken, deposit_amount: TokenInput) {
        const assets = FormatConverter.decimalToBigInt(deposit_amount, depositCToken.asset.decimals);
        const [
            currentLeverage,
            adjustMaxLeverage,
            maxLeverage,
            maxDebtBorrowable,
            loanSizeError,
            oracleError,
        ] = await this.contract.hypotheticalLeverageOf(account, depositCToken.address, borrowableCToken.address, assets, 0n);

        return {
            currentLeverage: FormatConverter.bigIntToDecimal(currentLeverage, 18),
            adjustMaxLeverage: FormatConverter.bigIntToDecimal(adjustMaxLeverage, 18),
            maxLeverage: FormatConverter.bigIntToDecimal(maxLeverage, 18),
            maxDebtBorrowable: FormatConverter.bigIntToDecimal(maxDebtBorrowable, borrowableCToken.decimals),
            loanSizeError: Boolean(loanSizeError),
            oracleError: Boolean(oracleError),
        };
    }

    async marketMultiCooldown(markets: address[], account: address) {
        return await this.contract.marketMultiCooldown(markets, account);
    }

    async debtBalanceAtTimestamp(account: address, borrowableCtoken: address, timestamp: bigint) {
        return await this.contract.debtBalanceAtTimestamp(account, borrowableCtoken, timestamp);
    }

    async getBalancesOf(tokens: address[], account: address) {
        return await this.contract.getBalancesOf(tokens, account);
    }

    async getLeverageSnapshot(account: address, cToken: address, borrowableCToken: address, bufferTime: bigint = 120n) {
        const [collateralUsd, debtUsd, collateralAssetPrice, sharePrice, debtAssetPrice, debtTokenBalance, oracleError] =
            await this.contract.getLeverageSnapshot(account, cToken, borrowableCToken, bufferTime) as [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
        return { collateralUsd, debtUsd, collateralAssetPrice, sharePrice, debtAssetPrice, debtTokenBalance, oracleError };
    }

    async getStaticMarketData(options: { forceRefresh?: boolean } = {}) {
        const cacheKey = this.staticMarketCacheKey;
        const now = Date.now();

        if (!options.forceRefresh && cacheKey != null) {
            const cached = STATIC_MARKET_DATA_CACHE.get(cacheKey);
            if (cached != undefined && cached.expiresAt > now) {
                return cached.data;
            }
        }

        const dataPromise = this.contract
            .getStaticMarketData()
            .then((data) => normalizeStaticMarketData(data));

        if (cacheKey == null) {
            return dataPromise;
        }

        // Cache only within a short window because this payload includes slow-
        // moving config like caps and pause flags, not immutable metadata only.
        STATIC_MARKET_DATA_CACHE.set(cacheKey, {
            expiresAt: now + STATIC_MARKET_CACHE_TTL_MS,
            data: dataPromise,
        });

        try {
            return await dataPromise;
        } catch (error) {
            const cached = STATIC_MARKET_DATA_CACHE.get(cacheKey);
            if (cached?.data === dataPromise) {
                STATIC_MARKET_DATA_CACHE.delete(cacheKey);
            }
            throw error;
        }
    }
}
