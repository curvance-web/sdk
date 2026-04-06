import { ChangeRate } from "../helpers";
import { Contract } from "ethers";
import { DynamicMarketData, ProtocolReader, StaticMarketData, UserMarket } from "./ProtocolReader";
import { AccountSnapshot, CToken } from "./CToken";
import { Decimal } from "decimal.js";
import { address, curvance_provider, Percentage, TokenInput, USD } from "../types";
import { OracleManager } from "./OracleManager";
import { BorrowableCToken } from "./BorrowableCToken";
import { IncentiveResponse, Incentives, MilestoneResponse, Milestones } from "./Api";
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
    name: string;
    plugins: {
        [key: string]: address;
    };
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
export interface IMarket {
    accountAssets(account: address): Promise<bigint>;
    MIN_HOLD_PERIOD(): Promise<bigint>;
    hypotheticalLiquidityOf(account: address, cTokenModified: address, redemptionShares: bigint, borrowAssets: bigint): Promise<HypotheticalLiquidityOf>;
    statusOf(account: address): Promise<StatusOf>;
}
export declare class Market {
    provider: curvance_provider;
    address: address;
    contract: Contract & IMarket;
    tokens: (CToken | BorrowableCToken)[];
    oracle_manager: OracleManager;
    reader: ProtocolReader;
    cache: {
        static: StaticMarketData;
        dynamic: DynamicMarketData;
        user: UserMarket;
        deploy: DeployData;
    };
    milestone: MilestoneResponse | null;
    incentives: Array<IncentiveResponse>;
    constructor(provider: curvance_provider, static_data: StaticMarketData, dynamic_data: DynamicMarketData, user_data: UserMarket, deploy_data: DeployData, oracle_manager: OracleManager, reader: ProtocolReader);
    /** @returns {string} - The name of the market at deployment. */
    get name(): string;
    /** @returns {Plugins} - The address of the market's plugins by deploy name. */
    get plugins(): Plugins;
    /** @returns {bigint} - The length of the cooldown period in seconds. */
    get cooldownLength(): bigint;
    /** @returns {bigint[]} - A list of oracle identifiers which can be mapped to AdaptorTypes enum */
    get adapters(): bigint[];
    /** @returns {Date | null} - Market cooldown, activated by Collateralization or Borrowing. Lasts as long as {this.cooldownLength} which is currently 20mins */
    get cooldown(): Date | null;
    /** @returns {Decimal} - The user's collateral in Shares. */
    get userCollateral(): Decimal;
    /** @returns {USD} - The user's debt in USD. */
    get userDebt(): Decimal;
    /** @returns {USD} - The user's maximum debt in USD. */
    get userMaxDebt(): Decimal;
    /** @returns {USD} - The user's remaining credit with a .1% buffer in USD */
    get userRemainingCredit(): USD;
    /**
     * Get the user's position health.
     * @returns {Percentage | null} - The user's position health Percentage or null if infinity
     */
    get positionHealth(): Decimal | null;
    /**
     * Get the total user deposits in USD.
     * @returns {USD} - The total user deposits in USD.
     */
    get userDeposits(): Decimal;
    /**
     * Get the user's net position in USD.
     * @returns {USD} - The user's net position in USD.
     */
    get userNet(): Decimal;
    /** @returns Market LTV */
    get ltv(): string | {
        min: Decimal;
        max: Decimal;
    };
    /** @returns Total market deposits */
    get tvl(): Decimal;
    /** @returns Total market debt */
    get totalDebt(): Decimal;
    /** @returns Total market collateral */
    get totalCollateral(): Decimal;
    /**
     * Returns what tokens eligible and ineligible to borrow from
     * @returns What tokens can and cannot be borrowed from
     */
    getBorrowableCTokens(): {
        eligible: BorrowableCToken[];
        ineligible: BorrowableCToken[];
    };
    /**
     * Get the total user deposits change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user deposits change (ex: 50, which would be $50/day)
     */
    getUserDepositsChange(rate: ChangeRate): Decimal;
    /**
     * Get the total user debt change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user debt change (ex: 50, which would be $50/day)
     */
    getUserDebtChange(rate: ChangeRate): Decimal;
    /**
     * Get the total user net change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user net change (ex: 50, which would be $50/day)
     */
    getUserNetChange(rate: ChangeRate): Decimal;
    /**
     * Searchs through all tokens and finds highest APY
     * @returns The highest APY among all tokens
     */
    highestApy(): Percentage;
    /**
     * Does this market have the ability to borrow
     * @returns True if borrowing is allowed, false otherwise
     */
    hasBorrowing(): boolean;
    /**
     * Gets the market status of
     * @param account - Wallet address
     * @returns collateral, max debt, debt for the market
     */
    getSnapshots(account: address): Promise<AccountSnapshot[]>;
    reloadMarketData(): Promise<void>;
    reloadUserData(account: address): Promise<void>;
    /**
     * Preview the impact of the user descision for their deposit/borrow/leverage
     * @param user - Wallet address
     * @param collateral_ctoken - The collateral token
     * @param debt_ctoken - The debt token
     * @param deposit_amount - The colalteral amount
     * @param borrow_amount - The debt amount
     * @returns Supply, borrow & earn rates
     */
    previewAssetImpact(user: address, collateral_ctoken: CToken, debt_ctoken: BorrowableCToken, deposit_amount: TokenInput, borrow_amount: TokenInput, rate_change: ChangeRate): Promise<{
        supply: {
            percent: Decimal;
            change: Decimal;
        };
        borrow: {
            percent: Decimal;
            change: Decimal;
        };
        earn: {
            percent: Decimal;
            change: Decimal;
        };
    }>;
    /**
     * Grabs the new position health when doing a redeem
     * @param ctoken - Token you are expecting to redeem on
     * @param amount - Amount of assets being redeemed
     * @returns The new position health
     */
    previewPositionHealthLeverageDeposit(deposit_ctoken: CToken, deposit_amount: TokenInput, borrow_ctoken: BorrowableCToken, borrow_amount: TokenInput): Promise<Decimal | null>;
    previewPositionHealthLeverageDown(deposit_ctoken: CToken, borrow_ctoken: BorrowableCToken, newLeverage: Decimal, currentLeverage: Decimal): Promise<Decimal | null>;
    previewPositionHealthLeverageUp(deposit_ctoken: CToken, borrow_ctoken: BorrowableCToken, newLeverage: Decimal, depositAssets?: bigint): Promise<Decimal | null>;
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
    previewPositionHealth(deposit_ctoken?: CToken | null, borrow_ctoken?: BorrowableCToken | null, isDeposit?: boolean, collateral_amount?: TokenInput, isRepay?: boolean, debt_amount?: TokenInput, bufferTime?: bigint): Promise<Decimal | null>;
    formatPositionHealth(positionHealth: bigint): Percentage | null;
    /**
     * Grabs the new position health when doing a redeem
     * @param ctoken - Token you are expecting to redeem on
     * @param amount - Amount of assets being redeemed
     * @returns The new position health
     */
    previewPositionHealthRedeem(ctoken: CToken, amount: TokenInput): Promise<Decimal | null>;
    /**
     * Grabs the new position health when doing a deposit
     * @param ctoken - Token you are expecting to deposit on
     * @param amount - Amount of assets being deposited
     * @returns The new position health
     */
    previewPositionHealthDeposit(ctoken: CToken, amount: TokenInput): Promise<Decimal | null>;
    /**
     * Grabs the new position health when doing a borrow
     * @param token - Token you are expecting to borrow on
     * @param amount - Amount of assets being borrowed
     * @returns The new position health
     */
    previewPositionHealthBorrow(token: BorrowableCToken, amount: TokenInput): Promise<Decimal | null>;
    /**
     * Grabs the new position health when doing a repay
     * @param token - Token you are expecting to repay on
     * @param amount - Amount of assets being repayed
     * @returns The new position health
     */
    previewPositionHealthRepay(token: BorrowableCToken, amount: TokenInput): Promise<Decimal | null>;
    /**
     * Grabs the new liquidity values based on changes
     * @param account - The user's account address
     * @param cTokenModified - The ctoken you are modifiying
     * @param redemptionShares - Shares being redeemed
     * @param borrowAssets - Amount of assets being borrowed
     * @returns An object containing the hypothetical liquidity values
     */
    hypotheticalLiquidityOf(account: address, cTokenModified?: address, redemptionShares?: bigint, borrowAssets?: bigint): Promise<HypotheticalLiquidityOf>;
    /**
     * Fetch the expiration date of a user's cooldown period
     * @param account - The user's account address
     * @param fetch - Whether to fetch the cooldown length from the contract
     * @returns The expiration date of the cooldown period or null if not in cooldown
     */
    expiresAt(account: address, fetch?: boolean): Promise<Date | null>;
    /**
     * Fetch multiple market cooldown expirations
     * @param markets - Markets you want to search
     * @returns An object mapping market addresses to their cooldown expiration dates OR null if its not in cooldown
     */
    multiHoldExpiresAt(markets: Market[]): Promise<{
        [address: `0x${string}`]: Date | null;
    }>;
    /**
     * Grab all the markets available and set them up using the protocol reader efficient RPC calls / API cached calls
     * @param reader  - instace of the ProtocolReader class
     * @param oracle_manager - instance of the OracleManager class
     * @param provider - The RPC provider
     * @returns An array of Market instances setup with protocol reader data
     */
    static getAll(reader: ProtocolReader, oracle_manager: OracleManager, provider?: curvance_provider, milestones?: Milestones, incentives?: Incentives): Promise<Market[]>;
}
//# sourceMappingURL=Market.d.ts.map