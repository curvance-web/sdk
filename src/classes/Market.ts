import { BPS, ChangeRate, contractSetup, EMPTY_ADDRESS, getRateSeconds, requireAccount, toBigInt, toDecimal, UINT256_MAX, WAD, WAD_DECIMAL } from "../helpers";
import { Contract } from "ethers";
import { DynamicMarketData, ProtocolReader, StaticMarketData, UserMarket, UserMarketSummary } from "./ProtocolReader";
import { AccountSnapshot, CToken } from "./CToken";
import abi from '../abis/MarketManagerIsolated.json';
import { Decimal } from "decimal.js";
import { address, curvance_read_provider, curvance_signer, Percentage, TokenInput, USD } from "../types";
import { OracleManager } from "./OracleManager";
import type { SetupConfigSnapshot } from "../setup";
import { fetchMerklOpportunities, MerklOpportunity } from "../integrations/merkl";
import { BorrowableCToken } from "./BorrowableCToken";
import FormatConverter from "./FormatConverter";
import { Api, IncentiveResponse, Incentives, MilestoneResponse, Milestones } from "./Api";

export type MarketToken = CToken | BorrowableCToken;
export type PluginTypes = 'zapper' | 'positionManager';

export interface Plugins {
    simplePositionManager?: address;
    vaultPositionManager?: address;
    nativeVaultPositionManager?: address;
}

export interface Zappers {
    simpleZapper?: address;
    vaultZapper?: address;
    nativeVaultZapper?: address;
}

export interface StatusOf {
    collateral: bigint;
    maxDebt: bigint;
    debt: bigint;
}

export interface DeployData {
    name: string,
    plugins: { [key: string]: address }
}

export interface HypotheticalLiquidityOf {
    collateral: bigint;
    maxDebt: bigint;
    debt: bigint;
    collateralSurplus: bigint;
    liquidityDeficit: bigint;
    loanSizeError: boolean;
    oracleError: boolean;
}

export type UserDataScope = "full" | "summary";

export interface IMarket {
    accountAssets(account: address): Promise<bigint>;
    MIN_HOLD_PERIOD(): Promise<bigint>;
    hypotheticalLiquidityOf(account: address, cTokenModified: address, redemptionShares: bigint, borrowAssets: bigint): Promise<HypotheticalLiquidityOf>;
    statusOf(account: address): Promise<StatusOf>;
}

type NativeYield = Awaited<ReturnType<typeof Api.fetchNativeYields>>[number];

function resolveDefaultSetupConfig(context: string): SetupConfigSnapshot {
    const config = (require("../setup") as typeof import("../setup")).setup_config;
    if (config == undefined) {
        throw new Error(
            `Setup config is not configured for ${context}. ` +
            `Pass setup/provider context explicitly or initialize setupChain() first.`
        );
    }

    return config;
}

export class Market {
    provider: curvance_read_provider;
    signer: curvance_signer | null;
    account: address | null;
    address: address;
    contract: Contract & IMarket;
    tokens: (CToken | BorrowableCToken)[] = [];
    oracle_manager: OracleManager;
    reader: ProtocolReader;
    setup: SetupConfigSnapshot;
    cache: { static: StaticMarketData, dynamic: DynamicMarketData, user: UserMarket, deploy: DeployData };
    milestone: MilestoneResponse | null = null;
    incentives: Array<IncentiveResponse> = [];
    private _userDataScope?: UserDataScope;

    constructor(
        provider: curvance_read_provider,
        signer: curvance_signer | null,
        account: address | null,
        static_data: StaticMarketData,
        dynamic_data: DynamicMarketData,
        user_data: UserMarket,
        deploy_data: DeployData,
        oracle_manager: OracleManager,
        reader: ProtocolReader,
        setup: SetupConfigSnapshot
    ) {
        this.provider = provider;
        this.signer = signer;
        this.account = account;
        this.address = static_data.address;
        this.oracle_manager = oracle_manager;
        this.reader = reader;
        this.setup = setup;
        this.contract = contractSetup<IMarket>(provider, this.address, abi);
        this.cache = { static: static_data, dynamic: dynamic_data, user: user_data, deploy: deploy_data };
        this._userDataScope = "full";

        for(let i = 0; i < static_data.tokens.length; i++) {
            // @NOTE: Merged fields from the 3 types, so you wanna make sure there is no collisions
            // Otherwise we will have some dataloss
            const tokenData = {
                ...static_data.tokens[i]!,
                ...dynamic_data.tokens[i]!,
                ...user_data.tokens[i]!
            };

            if(tokenData.isBorrowable) {
                const ctoken = new BorrowableCToken(provider, tokenData.address, tokenData, this);
                this.tokens.push(ctoken);
            } else {
                const ctoken = new CToken(provider, tokenData.address, tokenData, this);
                this.tokens.push(ctoken);
            }
        }
    }

    private getAccountOrThrow(): address {
        return requireAccount(this.account, this.signer);
    }

    private requireFullUserTokenData(accessLabel: string) {
        if (this.userDataScope !== "summary") {
            return;
        }

        throw new Error(
            `Market-level token-derived user data is stale for ${this.address} after a summary-only refresh. ` +
            `Call market.reloadUserData(account) or Market.reloadUserMarkets(...) before ${accessLabel}.`
        );
    }

    /** @returns {string} - The name of the market at deployment. */
    get name() { return this.cache.deploy.name; }
    /** @returns {Plugins} - The address of the market's plugins by deploy name. */
    get plugins():Plugins { return this.cache.deploy.plugins ?? {}; }
    /** @returns {bigint} - The length of the cooldown period in seconds. */
    get cooldownLength() { return this.cache.static.cooldownLength; }
    /** @returns {bigint[]} - A list of oracle identifiers which can be mapped to AdaptorTypes enum */
    get adapters() { return this.cache.static.adapters; }
    /** @returns {Date | null} - Market cooldown, activated by Collateralization or Borrowing. Lasts as long as {this.cooldownLength} which is currently 20mins */
    get cooldown() { return this.cache.user.cooldown == this.cooldownLength ? null : new Date(Number(this.cache.user.cooldown * 1000n)); }
    /** @returns The scope of the latest whole-market user refresh. */
    get userDataScope(): UserDataScope { return this._userDataScope ?? "full"; }
    /** @returns {Decimal} - The user's collateral in Shares. */
    get userCollateral() { return toDecimal(this.cache.user.collateral, 18n); }
    /** @returns {USD} - The user's debt in USD. */
    get userDebt() { return toDecimal(this.cache.user.debt, 18n); }
    /** @returns {USD} - The user's maximum debt in USD. */
    get userMaxDebt() { return toDecimal(this.cache.user.maxDebt, 18n); }
    /** @returns {USD} - The user's remaining credit with a .1% buffer in USD */
    get userRemainingCredit(): USD {
        const remaining = this.cache.user.maxDebt - this.cache.user.debt;
        return toDecimal(remaining, 18n).mul(.999);
    }

    /**
     * Get the user's position health.
     * @returns {Percentage | null} - The user's position health Percentage or null if infinity
     */
    get positionHealth() {
        if (this.cache.user.positionHealth == UINT256_MAX) {
            return null;
        }

        return this.formatPositionHealth(this.cache.user.positionHealth);
    }

    /**
     * Get the total user deposits in USD.
     * @returns {USD} - The total user deposits in USD.
     */
    get userDeposits() {
        this.requireFullUserTokenData("reading userDeposits");
        let total_deposits = Decimal(0);
        for(const token of this.tokens) {
            total_deposits = total_deposits.add(token.getUserAssetBalance(true));
        }

        return total_deposits;
    }

    /**
     * Get the user's net position in USD.
     * @returns {USD} - The user's net position in USD.
     */
    get userNet() {
        this.requireFullUserTokenData("reading userNet");
        return this.userDeposits.sub(this.userDebt);
    }

    /** @returns Market LTV */
    get ltv() {
        if (this.tokens.length === 0) {
            return { min: new Decimal(0), max: new Decimal(0) };
        }

        let min = this.tokens[0]!.ltv();
        let max = min;

        for (const token of this.tokens) {
            const ltv = new Decimal(token.ltv());
            if (ltv.lessThan(min)) {
                min = ltv;
            }
            if (ltv.greaterThan(max)) {
                max = ltv;
            }
        }

        if(min == max) {
            return `${min.mul(100)}%`;
        }

        return `${min.mul(100)}% - ${max.mul(100)}%`;
    }

    /** @returns Total market deposits in USD, summed across the market's tokens.
     *  Renamed from `tvl` to match the sibling getter naming
     *  (`totalDebt`, `totalCollateral`). Backed by the per-token
     *  `getDeposits` (which now values via `totalAssets`, not `totalSupply`,
     *  so the liquidity ≤ deposits invariant holds). */
    get totalDeposits() {
        let total = new Decimal(0);
        for(const token of this.tokens) {
            total = total.add(token.getDeposits(true));
        }
        return total;
    }

    /** @returns Total market debt */
    get totalDebt() {
        let marketDebt = new Decimal(0);
        for(const token of this.tokens) {
            if(token.isBorrowable) {
                marketDebt = marketDebt.add(token.getDebt(true));
            }
        }
        return marketDebt;
    }

    /** @returns Total market collateral */
    get totalCollateral() {
        let marketCollateral = new Decimal(0);
        for(const token of this.tokens) {
            marketCollateral = marketCollateral.add(token.getTotalCollateral(true));
        }
        return marketCollateral;
    }

    /**
     * Returns what tokens eligible and ineligible to borrow from
     * @returns What tokens can and cannot be borrowed from
     */
    getBorrowableCTokens() {
        this.requireFullUserTokenData("reading borrowable token eligibility");
        const result: {
            eligible: BorrowableCToken[],
            ineligible: BorrowableCToken[]
        } = {
            eligible: [],
            ineligible: []
        };

        const users_market_collateral = this.userCollateral;

        for(const token of this.tokens) {
            if(token.isBorrowable && token.getDebtCap(true).greaterThan(0)) {
                if(token.getUserCollateral(false).greaterThan(0) || users_market_collateral.lessThanOrEqualTo(0)) {
                    result.ineligible.push(token as BorrowableCToken);
                } else {
                    result.eligible.push(token as BorrowableCToken);
                }
            }
        }

        return result;
    }

    /**
     * Get the total user deposits change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user deposits change (ex: 50, which would be $50/day)
     */
    getUserDepositsChange(rate: ChangeRate) {
        this.requireFullUserTokenData(`reading user deposit change for rate ${rate}`);
        let total_change = Decimal(0);
        for(const token of this.tokens) {
            const amount = token.getUserAssetBalance(true);
            total_change = total_change.add(token.earnChange(amount, rate));
        }

        return total_change;
    }


    /**
     * Get the total user debt change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user debt change (ex: 50, which would be $50/day)
     */
    getUserDebtChange(rate: ChangeRate) {
        this.requireFullUserTokenData(`reading user debt change for rate ${rate}`);
        let total_change = Decimal(0);
        for(const token of this.tokens) {
            if(!token.isBorrowable) {
                continue;
            }

            const amount = token.getUserDebt(true);
            total_change = total_change.add((token as BorrowableCToken).borrowChange(amount, rate));
        }

        return total_change;
    }

    /**
     * Get the total user net change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user net change (ex: 50, which would be $50/day)
     */
    getUserNetChange(rate: ChangeRate) {
        this.requireFullUserTokenData(`reading user net change for rate ${rate}`);
        const earn = this.getUserDepositsChange(rate);
        const debt = this.getUserDebtChange(rate);
        return earn.sub(debt);
    }

    /**
     * Searchs through all tokens and finds highest APY
     * @returns The highest APY among all tokens
     */
    highestApy(): Percentage {
        let maxApy = new Decimal(0);
        for(const token of this.tokens) {
            const tokenApy = token.getApy();
            if(tokenApy.greaterThan(maxApy)) {
                maxApy = tokenApy;
            }
        }
        return maxApy;
    }

    /**
     * Does this market have the ability to borrow
     * @returns True if borrowing is allowed, false otherwise
     */
    hasBorrowing() {
        let canBorrow = false;
        for(const token of this.tokens) {
            if(token.isBorrowable) {
                canBorrow = true;
                break;
            }
        }
        return canBorrow;
    }

    /**
     * Gets the market status of
     * @param account - Wallet address
     * @returns collateral, max debt, debt for the market
     */
    async getSnapshots(account: address): Promise<AccountSnapshot[]> {
        // Each ctoken.getSnapshot is an independent view call — dispatch in
        // parallel so N tokens is one round-trip latency, not N.
        return Promise.all(this.tokens.map((token) => token.getSnapshot(account)));
    }

    hasUserActivity() {
        return this.tokens.some((token) =>
            token.cache.userAssetBalance > 0n ||
            token.cache.userShareBalance > 0n ||
            token.cache.userCollateral > 0n ||
            token.cache.userDebt > 0n
        );
    }

    private hasCompleteUserTokenPayload(userData: UserMarket) {
        if (userData.tokens.length !== this.tokens.length) {
            return false;
        }

        const tokenAddresses = new Set(userData.tokens.map((token) => token.address));
        return this.tokens.every((token) => tokenAddresses.has(token.address));
    }

    applyState(dynamicData: DynamicMarketData, userData?: UserMarket) {
        this.cache.dynamic = dynamicData;

        if(userData != undefined) {
            this.cache.user = userData;
            if (this.hasCompleteUserTokenPayload(userData)) {
                this._userDataScope = "full";
            }
        }

        for(const token of this.tokens) {
            const nextDynamic = dynamicData.tokens.find((t) => t.address == token.address);
            const nextUser = userData?.tokens.find((t) => t.address == token.address);
            token.cache = {
                ...token.cache,
                ...(nextDynamic ?? {}),
                ...(nextUser ?? {}),
            };

            if (nextUser != undefined) {
                (token as any).markUserCacheFresh?.();
            }
        }
    }

    applyUserSummary(userData: UserMarketSummary) {
        this.cache.user = {
            ...this.cache.user,
            ...userData,
        };
        this._userDataScope = "summary";

        for (const token of this.tokens) {
            (token as any).invalidateUserCache?.();
        }
    }

    async reloadMarketData() {
        const dynamic_data = await this.reader.getDynamicMarketData();
        const dynamic = dynamic_data.find(m => m.address == this.address);
        if(dynamic == undefined) {
            throw new Error(`Could not find dynamic data for market ${this.address}.`);
        }
        this.applyState(dynamic);
    }

    async reloadUserData(account: address) {
        const { dynamicMarkets, userMarkets } = await this.reader.getMarketStates([this.address], account);
        const dynamic = dynamicMarkets[0];
        const user = userMarkets[0];

        if(dynamic == undefined || user == undefined) {
            throw new Error(`Could not reload market state for ${this.address}.`);
        }

        this.applyState(dynamic, user);
    }

    async reloadUserSummary(account: address) {
        const userMarkets = await this.reader.getMarketSummaries([this.address], account);
        const user = userMarkets[0];

        if(user == undefined) {
            throw new Error(`Could not reload market user summary for ${this.address}.`);
        }

        this.applyUserSummary(user);
    }

    static getActiveUserMarkets(markets: Market[]): Market[] {
        return markets.filter((market) => market.hasUserActivity());
    }

    private static groupByReaderDeployment(markets: Market[]) {
        const groups = new Map<string | ProtocolReader, { reader: ProtocolReader; markets: Market[] }>();

        for (const market of markets) {
            const groupKey = market.reader.batchKey ?? market.reader;
            const existing = groups.get(groupKey);
            if (existing) {
                existing.markets.push(market);
            } else {
                groups.set(groupKey, {
                    reader: market.reader,
                    markets: [market],
                });
            }
        }

        return groups.values();
    }

    static async reloadUserMarkets(markets: Market[], account: address): Promise<Market[]> {
        if(markets.length === 0) {
            return [];
        }

        for(const { reader, markets: groupedMarkets } of this.groupByReaderDeployment(markets)) {
            const addresses = groupedMarkets.map((market) => market.address);
            const { dynamicMarkets, userMarkets } = await reader.getMarketStates(addresses, account);
            const dynamicByAddress = new Map(dynamicMarkets.map((market) => [market.address, market]));
            const userByAddress = new Map(userMarkets.map((market) => [market.address, market]));

            for(const market of groupedMarkets) {
                const dynamic = dynamicByAddress.get(market.address);
                const user = userByAddress.get(market.address);

                if(dynamic == undefined || user == undefined) {
                    throw new Error(`Could not reload market state for ${market.address}.`);
                }

                market.applyState(dynamic, user);
            }
        }

        return markets;
    }

    static async reloadUserMarketSummaries(markets: Market[], account: address): Promise<Market[]> {
        if(markets.length === 0) {
            return [];
        }

        for(const { reader, markets: groupedMarkets } of this.groupByReaderDeployment(markets)) {
            const addresses = groupedMarkets.map((market) => market.address);
            const userMarkets = await reader.getMarketSummaries(addresses, account);
            const userByAddress = new Map(userMarkets.map((market) => [market.address, market]));

            for(const market of groupedMarkets) {
                const user = userByAddress.get(market.address);

                if(user == undefined) {
                    throw new Error(`Could not reload market user summary for ${market.address}.`);
                }

                market.applyUserSummary(user);
            }
        }

        return markets;
    }

    private static buildDeployDataIndex(setup: SetupConfigSnapshot): Map<string, DeployData> {
        const index = new Map<string, DeployData>();
        const deployments = setup.contracts.markets as Record<string, any>;

        for (const [name, data] of Object.entries(deployments)) {
            if (typeof data !== 'object' || data == null || typeof data.address !== 'string') {
                continue;
            }

            const key = data.address.toLowerCase();
            if (!index.has(key)) {
                index.set(key, {
                    name,
                    plugins: 'plugins' in data ? data.plugins as { [key: string]: address } : {},
                });
            }
        }

        return index;
    }

    private static buildOpportunityIndex(opportunities: MerklOpportunity[]): Map<string, MerklOpportunity> {
        const index = new Map<string, MerklOpportunity>();

        for (const opportunity of opportunities) {
            const key = opportunity.identifier.toLowerCase();
            if (!index.has(key)) {
                index.set(key, opportunity);
            }
        }

        return index;
    }

    private static buildYieldIndex(yields: NativeYield[]): Map<string, NativeYield> {
        const index = new Map<string, NativeYield>();

        for (const yieldEntry of yields) {
            const key = yieldEntry.symbol.toUpperCase();
            if (!index.has(key)) {
                index.set(key, yieldEntry);
            }
        }

        return index;
    }

    /**
     * Preview the impact of the user descision for their deposit/borrow/leverage
     * @param user - Wallet address
     * @param collateral_ctoken - The collateral token
     * @param debt_ctoken - The debt token
     * @param deposit_amount - The colalteral amount
     * @param borrow_amount - The debt amount
     * @returns Supply, borrow & earn rates
     */
    async previewAssetImpact(user: address, collateral_ctoken: CToken, debt_ctoken: BorrowableCToken, deposit_amount: TokenInput, borrow_amount: TokenInput, rate_change: ChangeRate) {
        const amount_in = toBigInt(deposit_amount, collateral_ctoken.asset.decimals);
        const amount_out = toBigInt(borrow_amount, debt_ctoken.asset.decimals);

        const { supply, borrow } = await this.reader.previewAssetImpact(user, collateral_ctoken.address, debt_ctoken.address, amount_in, amount_out);

        const supply_apy = Decimal(supply * getRateSeconds('year')).div(WAD);
        const borrow_apy = Decimal(borrow * getRateSeconds('year')).div(WAD);

        const supply_percent = Decimal(supply * getRateSeconds(rate_change)).div(WAD);
        const borrow_percent = Decimal(borrow * getRateSeconds(rate_change)).div(WAD);
        const supply_change = collateral_ctoken.convertTokensToUsd(amount_in).mul(supply_percent);
        const borrow_change = debt_ctoken.convertTokensToUsd(amount_out).mul(borrow_percent);

        return {
            supply: {
                percent: supply_apy,
                change: supply_change
            },
            borrow: {
                percent: borrow_apy,
                change: borrow_change
            },
            earn: {
                percent: supply_apy.sub(borrow_apy),
                change: supply_change.sub(borrow_change)
            }
        }
    }

    /**
     * Grabs the new position health when doing a redeem
     * @param ctoken - Token you are expecting to redeem on
     * @param amount - Amount of assets being redeemed
     * @returns The new position health
     */
    async previewPositionHealthLeverageDeposit(
        deposit_ctoken: CToken,
        deposit_amount: TokenInput,
        borrow_ctoken: BorrowableCToken,
        borrow_amount: TokenInput
    ) {
        return this.previewPositionHealth(deposit_ctoken, borrow_ctoken, true, deposit_amount, false, borrow_amount);
    }

    async previewPositionHealthLeverageDown(
        deposit_ctoken: CToken,
        borrow_ctoken: BorrowableCToken,
        newLeverage: Decimal,
        currentLeverage: Decimal
    ) {
        // Full deleverage always closes to zero debt → infinite position health aka null.
        if (newLeverage.equals(1)) {
            return null;
        }

        const { collateralAssetReduction } = deposit_ctoken.previewLeverageDown(newLeverage, currentLeverage);
        const repayUsd = deposit_ctoken.convertTokensToUsd(collateralAssetReduction, true);
        const repayTokens = borrow_ctoken.convertUsdToTokens(repayUsd, true);

        return this.previewPositionHealth(
            deposit_ctoken,
            borrow_ctoken,
            false,
            FormatConverter.bigIntToDecimal(collateralAssetReduction, deposit_ctoken.asset.decimals),
            true,
            repayTokens
        );
    }

    async previewPositionHealthLeverageUp(
        deposit_ctoken: CToken,
        borrow_ctoken: BorrowableCToken,
        newLeverage: Decimal,
        depositAssets?: bigint
    ) {
        if ((depositAssets ?? 0n) > 0n) {
            return this.previewPositionHealthDepositAndLeverage(
                deposit_ctoken,
                borrow_ctoken,
                newLeverage,
                depositAssets!,
            );
        }

        const preview = deposit_ctoken.previewLeverageUp(newLeverage, borrow_ctoken);

        return this.previewPositionHealth(
            deposit_ctoken,
            borrow_ctoken,
            true,
            preview.collateralIncreaseInAssets,
            false,
            preview.debtIncreaseInAssets
        );
    }

    async previewPositionHealthDepositAndLeverage(
        deposit_ctoken: CToken,
        borrow_ctoken: BorrowableCToken,
        newLeverage: Decimal,
        depositAssets: bigint
    ) {
        const preview = deposit_ctoken.previewDepositAndLeverage(
            newLeverage,
            borrow_ctoken,
            depositAssets,
        );

        return this.previewPositionHealth(
            deposit_ctoken,
            borrow_ctoken,
            true,
            preview.collateralIncreaseInAssets,
            false,
            preview.debtIncreaseInAssets
        );
    }

    /**
     * A dynamic position health previewer for any action
     * @param deposit_ctoken - Deposit side ctoken
     * @param borrow_ctoken - Borrow side ctoken
     * @param isDeposit - Is this a deposit your previewing?
     * @param collateral_amount - Amount of collateral being deposited, or redeemed if isDeposit is false
     * @param isRepay - Is this a repay your previewing?
     * @param debt_amount - Amount of debt being repayed, or borrowed if isRepay is false
     * @param bufferTime - Buffer time to add onto the price oracle timestamps
     * @returns a position health decimal or null if infinity
     */
    async previewPositionHealth(
        deposit_ctoken: CToken | null = null,
        borrow_ctoken: BorrowableCToken | null = null,
        isDeposit: boolean = false,
        collateral_amount: TokenInput = Decimal(0),
        isRepay: boolean = false,
        debt_amount: TokenInput = Decimal(0),
        bufferTime: bigint = 0n
    ) {
        const user = this.getAccountOrThrow();

        // Pass underlying asset amounts — NOT shares.
        // The on-chain reader's _collateralValue calls previewDeposit(assets) internally,
        // and _debtValue prices assets with the underlying token's oracle price.
        // Passing shares here would cause double-conversion (shares treated as assets).
        const onchain_collateral_amount = deposit_ctoken ? FormatConverter.decimalToBigInt(collateral_amount, deposit_ctoken.asset.decimals) : 0n;
        const onchain_debt_amount = borrow_ctoken ? FormatConverter.decimalToBigInt(debt_amount, borrow_ctoken.asset.decimals) : 0n;

        const data = await this.reader.getPositionHealth(
            this.address,
            user,
            deposit_ctoken ? deposit_ctoken.address : EMPTY_ADDRESS,
            borrow_ctoken ? borrow_ctoken.address : EMPTY_ADDRESS,
            isDeposit,
            onchain_collateral_amount,
            isRepay,
            onchain_debt_amount,
            bufferTime
        );

        if(data.errorCodeHit) {
            throw new Error(`Error code hit when calculating position health preview. This usually means price is stale so we couldn't get a valid health value.`);
        }

        return this.formatPositionHealth(data.positionHealth);
    }

    formatPositionHealth(positionHealth: bigint): Percentage | null {
        // Defensive edge case handling where we explicitly update UINT256_MAX to
        // null return which gets processed as infinity position health on the frontend.
        if (positionHealth === UINT256_MAX) {
            return null;
        }

        return Decimal(positionHealth).div(WAD_DECIMAL).sub(1);
    }

    /**
     * Grabs the new position health when doing a redeem
     * @param ctoken - Token you are expecting to redeem on
     * @param amount - Amount of assets being redeemed
     * @returns The new position health
     */
    async previewPositionHealthRedeem(ctoken: CToken, amount: TokenInput) {
        const user = this.getAccountOrThrow();
        const redeemShares = ctoken.convertTokenInputToShares(amount);
        const redeemAssets = FormatConverter.decimalToBigInt(amount, ctoken.asset.decimals);
        const existing_collateral = ctoken.cache.userCollateral;

        if(redeemShares > existing_collateral) {
            throw new Error(`Insufficient collateral: Existing (${existing_collateral}) < Redeem amount (${redeemShares})`);
        }

        const data = await this.reader.getPositionHealth(
            this.address,
            user,
            ctoken.address,
            EMPTY_ADDRESS,
            false,
            redeemAssets,
            false,
            0n,
            0n
        );

        if(data.errorCodeHit) {
            throw new Error(`Error code hit when calculating position health preview. This usually means price is stale so we couldn't get a valid health value.`);
        }

        return this.formatPositionHealth(data.positionHealth);
    }

    /**
     * Grabs the new position health when doing a deposit
     * @param ctoken - Token you are expecting to deposit on
     * @param amount - Amount of assets being deposited
     * @returns The new position health
     */
    async previewPositionHealthDeposit(ctoken: CToken, amount: TokenInput) {
        return this.previewPositionHealth(ctoken, null, true, amount);
    }

    /**
     * Grabs the new position health when doing a borrow
     * @param token - Token you are expecting to borrow on
     * @param amount - Amount of assets being borrowed
     * @returns The new position health
     */
    async previewPositionHealthBorrow(token: BorrowableCToken, amount: TokenInput) {
        const user = this.getAccountOrThrow();
        const data = await this.reader.getPositionHealth(
            this.address,
            user,
            EMPTY_ADDRESS,
            token.address,
            false,
            0n,
            false,
            FormatConverter.decimalToBigInt(amount, token.decimals),
            0n
        );

        if(data.errorCodeHit) {
            throw new Error(`Error code hit when calculating position health preview. This usually means price is stale so we couldn't get a valid health value.`);
        }

        return this.formatPositionHealth(data.positionHealth);
    }

    /**
     * Grabs the new position health when doing a repay
     * @param token - Token you are expecting to repay on
     * @param amount - Amount of assets being repayed
     * @returns The new position health
     */
    async previewPositionHealthRepay(token: BorrowableCToken, amount: TokenInput) {
        const user = this.getAccountOrThrow();
        const data = await this.reader.getPositionHealth(
            this.address,
            user,
            EMPTY_ADDRESS,
            token.address,
            false,
            0n,
            true,
            FormatConverter.decimalToBigInt(amount, token.decimals),
            0n
        );

        if(data.errorCodeHit) {
            throw new Error(`Error code hit when calculating position health preview. This usually means price is stale so we couldn't get a valid health value.`);
        }

        return this.formatPositionHealth(data.positionHealth);
    }

    /**
     * Grabs the new liquidity values based on changes
     * @param account - The user's account address
     * @param cTokenModified - The ctoken you are modifiying
     * @param redemptionShares - Shares being redeemed
     * @param borrowAssets - Amount of assets being borrowed
     * @returns An object containing the hypothetical liquidity values
     */
    async hypotheticalLiquidityOf(account: address, cTokenModified: address = EMPTY_ADDRESS, redemptionShares: bigint = 0n, borrowAssets: bigint = 0n) {
        return this.contract.hypotheticalLiquidityOf(account, cTokenModified, redemptionShares, borrowAssets);
    }

    /**
     * Fetch the expiration date of a user's cooldown period
     * @param account - The user's account address
     * @param fetch - Whether to fetch the cooldown length from the contract
     * @returns The expiration date of the cooldown period or null if not in cooldown
     */
    async expiresAt(account: address, fetch = false) {
        const cooldownTimestamp = await this.contract.accountAssets(account);
        const cooldownLength = fetch || this.cooldownLength == 0n ? await this.contract.MIN_HOLD_PERIOD() : this.cooldownLength;
        const unlockTime = cooldownTimestamp + cooldownLength;
        return unlockTime == cooldownLength ? null : new Date(Number(unlockTime * 1000n));
    }

    /**
     * Fetch multiple market cooldown expirations
     * @param markets - Markets you want to search
     * @returns An object mapping market addresses to their cooldown expiration dates OR null if its not in cooldown
     */
    async multiHoldExpiresAt(markets: Market[]) {
        const account = this.getAccountOrThrow();
        if(markets.length == 0) {
            throw new Error("You can't fetch expirations for no markets.");
        }

        const marketAddresses = markets.map(market => market.address);
        const cooldownTimestamps = await this.reader.marketMultiCooldown(marketAddresses, account);

        let cooldowns: { [address: address]: Date | null } = {};
        for(let i = 0; i < markets.length; i++) {
            const market = markets[i]!;
            const cooldownTimestamp = cooldownTimestamps[i]!;
            const cooldownLength = market.cooldownLength;

            cooldowns[market.address] = cooldownTimestamp == cooldownLength ? null : new Date(Number(cooldownTimestamp * 1000n));
        }

        return cooldowns;
    }

    /**
     * Grab all the markets available and set them up using the protocol reader efficient RPC calls / API cached calls
     * @param reader  - instace of the ProtocolReader class
     * @param oracle_manager - instance of the OracleManager class
     * @param provider - The RPC provider
     * @returns An array of Market instances setup with protocol reader data
     */
    static async getAll(
        reader: ProtocolReader,
        oracle_manager: OracleManager,
        provider?: curvance_read_provider,
        signer?: curvance_signer | null,
        account?: address | null,
        milestones: Milestones = {},
        incentives: Incentives = {},
        setup?: SetupConfigSnapshot,
    ) {
        const resolvedSetup = setup ?? resolveDefaultSetupConfig("Market.getAll");
        const resolvedProvider = provider ?? resolvedSetup.readProvider;
        const resolvedSigner = signer === undefined ? resolvedSetup.signer : signer;
        const resolvedAccount = account === undefined ? resolvedSetup.account : account;

        const all_data = await reader.getAllMarketData(resolvedAccount);
        // Filter out USDC — DeFiLlama incorrectly returns YZM vault yield labeled as USDC
        const [yields, merklLendOpps, merklBorrowOpps] = await Promise.all([
            Api.fetchNativeYields(resolvedSetup).then(y => y.filter(y => y.symbol.toUpperCase() !== 'USDC')),
            fetchMerklOpportunities({ action: 'LEND' }).catch(() => [] as MerklOpportunity[]),
            fetchMerklOpportunities({ action: 'BORROW' }).catch(() => [] as MerklOpportunity[]),
        ]);
        const deployIndex = this.buildDeployDataIndex(resolvedSetup);
        const lendOppIndex = this.buildOpportunityIndex(merklLendOpps);
        const borrowOppIndex = this.buildOpportunityIndex(merklBorrowOpps);
        const yieldIndex = this.buildYieldIndex(yields);

        let markets: Market[] = [];
        for(let i = 0; i < all_data.staticMarket.length; i++) {
            const staticData  = all_data.staticMarket[i]!;
            const dynamicData = all_data.dynamicMarket[i]!;
            const userData    = all_data.userData.markets[i]!;

            const market_address = staticData.address;
            const deploy_data = deployIndex.get(market_address.toLowerCase());

            if(deploy_data == undefined) {
                console.warn(`Could not find deploy data for market: ${market_address}, skipping...`);
                continue;
            }

            if(staticData == undefined) {
                console.warn(`Could not find static market data for index: ${i}`);
                continue;
            }

            if(dynamicData == undefined) {
                console.warn(`Could not find dynamic market data for index: ${i}`);
                continue;
            }

            if(userData == undefined) {
                console.warn(`Could not find user market data for index: ${i}`);
                continue;
            }

            const market = new Market(
                resolvedProvider,
                resolvedSigner,
                resolvedAccount,
                staticData,
                dynamicData,
                userData,
                deploy_data,
                oracle_manager,
                reader,
                resolvedSetup,
            );
            if(milestones[market.address] != undefined) {
                market.milestone = milestones[market.address]!;
            }
            if(incentives[market.address] != undefined) {
                market.incentives = incentives[market.address]!;
            }

            for(const token of market.tokens) {
                const tokenKey = token.address.toLowerCase();
                const lendOpp = lendOppIndex.get(tokenKey);
                if(lendOpp != undefined) {
                    token.incentiveSupplyApy = new Decimal(lendOpp.apr / 100);
                }

                const borrowOpp = borrowOppIndex.get(tokenKey);
                if(borrowOpp != undefined) {
                    token.incentiveBorrowApy = new Decimal(borrowOpp.apr / 100);
                }

                const api_yield = yieldIndex.get(token.asset.symbol.toUpperCase());
                if(api_yield != undefined) {
                    token.nativeApy = new Decimal(api_yield.apy / 100);
                }
            }

            markets.push(market);
        }

        return markets;
    }
}
