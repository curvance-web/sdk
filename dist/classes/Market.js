"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Market = void 0;
const helpers_1 = require("../helpers");
const CToken_1 = require("./CToken");
const MarketManagerIsolated_json_1 = __importDefault(require("../abis/MarketManagerIsolated.json"));
const decimal_js_1 = require("decimal.js");
const setup_1 = require("../setup");
const merkl_1 = require("../integrations/merkl");
const BorrowableCToken_1 = require("./BorrowableCToken");
const FormatConverter_1 = __importDefault(require("./FormatConverter"));
const Api_1 = require("./Api");
class Market {
    provider;
    address;
    contract;
    tokens = [];
    oracle_manager;
    reader;
    cache;
    milestone = null;
    incentives = [];
    constructor(provider, static_data, dynamic_data, user_data, deploy_data, oracle_manager, reader) {
        this.provider = provider;
        this.address = static_data.address;
        this.oracle_manager = oracle_manager;
        this.reader = reader;
        this.contract = (0, helpers_1.contractSetup)(provider, this.address, MarketManagerIsolated_json_1.default);
        this.cache = { static: static_data, dynamic: dynamic_data, user: user_data, deploy: deploy_data };
        for (let i = 0; i < static_data.tokens.length; i++) {
            // @NOTE: Merged fields from the 3 types, so you wanna make sure there is no collisions
            // Otherwise we will have some dataloss
            const tokenData = {
                ...static_data.tokens[i],
                ...dynamic_data.tokens[i],
                ...user_data.tokens[i]
            };
            if (tokenData.isBorrowable) {
                const ctoken = new BorrowableCToken_1.BorrowableCToken(provider, tokenData.address, tokenData, this);
                this.tokens.push(ctoken);
            }
            else {
                const ctoken = new CToken_1.CToken(provider, tokenData.address, tokenData, this);
                this.tokens.push(ctoken);
            }
        }
    }
    /** @returns {string} - The name of the market at deployment. */
    get name() { return this.cache.deploy.name; }
    /** @returns {Plugins} - The address of the market's plugins by deploy name. */
    get plugins() { return this.cache.deploy.plugins ?? {}; }
    /** @returns {bigint} - The length of the cooldown period in seconds. */
    get cooldownLength() { return this.cache.static.cooldownLength; }
    /** @returns {bigint[]} - A list of oracle identifiers which can be mapped to AdaptorTypes enum */
    get adapters() { return this.cache.static.adapters; }
    /** @returns {Date | null} - Market cooldown, activated by Collateralization or Borrowing. Lasts as long as {this.cooldownLength} which is currently 20mins */
    get cooldown() { return this.cache.user.cooldown == this.cooldownLength ? null : new Date(Number(this.cache.user.cooldown * 1000n)); }
    /** @returns {Decimal} - The user's collateral in Shares. */
    get userCollateral() { return (0, helpers_1.toDecimal)(this.cache.user.collateral, 18n); }
    /** @returns {USD} - The user's debt in USD. */
    get userDebt() { return (0, helpers_1.toDecimal)(this.cache.user.debt, 18n); }
    /** @returns {USD} - The user's maximum debt in USD. */
    get userMaxDebt() { return (0, helpers_1.toDecimal)(this.cache.user.maxDebt, 18n); }
    /** @returns {USD} - The user's remaining credit with a .1% buffer in USD */
    get userRemainingCredit() {
        const remaining = this.cache.user.maxDebt - this.cache.user.debt;
        return (0, helpers_1.toDecimal)(remaining, 18n).mul(.999);
    }
    /**
     * Get the user's position health.
     * @returns {Percentage | null} - The user's position health Percentage or null if infinity
     */
    get positionHealth() {
        if (this.cache.user.positionHealth == helpers_1.UINT256_MAX) {
            return null;
        }
        return this.formatPositionHealth(this.cache.user.positionHealth);
    }
    /**
     * Get the total user deposits in USD.
     * @returns {USD} - The total user deposits in USD.
     */
    get userDeposits() {
        let total_deposits = (0, decimal_js_1.Decimal)(0);
        for (const token of this.tokens) {
            total_deposits = total_deposits.add(token.getUserAssetBalance(true));
        }
        return total_deposits;
    }
    /**
     * Get the user's net position in USD.
     * @returns {USD} - The user's net position in USD.
     */
    get userNet() {
        return this.userDeposits.sub(this.userDebt);
    }
    /** @returns Market LTV */
    get ltv() {
        if (this.tokens.length === 0) {
            return { min: new decimal_js_1.Decimal(0), max: new decimal_js_1.Decimal(0) };
        }
        let min = this.tokens[0].ltv();
        let max = min;
        for (const token of this.tokens) {
            const ltv = new decimal_js_1.Decimal(token.ltv());
            if (ltv.lessThan(min)) {
                min = ltv;
            }
            if (ltv.greaterThan(max)) {
                max = ltv;
            }
        }
        if (min == max) {
            return `${min.mul(100)}%`;
        }
        return `${min.mul(100)}% - ${max.mul(100)}%`;
    }
    /** @returns Total market deposits */
    get tvl() {
        let marketTvl = new decimal_js_1.Decimal(0);
        for (const token of this.tokens) {
            marketTvl = marketTvl.add(token.getTvl(true));
        }
        return marketTvl;
    }
    /** @returns Total market debt */
    get totalDebt() {
        let marketDebt = new decimal_js_1.Decimal(0);
        for (const token of this.tokens) {
            if (token.isBorrowable) {
                marketDebt = marketDebt.add(token.getDebt(true));
            }
        }
        return marketDebt;
    }
    /** @returns Total market collateral */
    get totalCollateral() {
        let marketCollateral = new decimal_js_1.Decimal(0);
        for (const token of this.tokens) {
            marketCollateral = marketCollateral.add(token.getTotalCollateral(true));
        }
        return marketCollateral;
    }
    /**
     * Returns what tokens eligible and ineligible to borrow from
     * @returns What tokens can and cannot be borrowed from
     */
    getBorrowableCTokens() {
        const result = {
            eligible: [],
            ineligible: []
        };
        const users_market_collateral = this.userCollateral;
        for (const token of this.tokens) {
            if (token.isBorrowable && token.getDebtCap(true).greaterThan(0)) {
                if (token.getUserCollateral(false).greaterThan(0) || users_market_collateral.lessThanOrEqualTo(0)) {
                    result.ineligible.push(token);
                }
                else {
                    result.eligible.push(token);
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
    getUserDepositsChange(rate) {
        let total_change = (0, decimal_js_1.Decimal)(0);
        for (const token of this.tokens) {
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
    getUserDebtChange(rate) {
        let total_change = (0, decimal_js_1.Decimal)(0);
        for (const token of this.tokens) {
            if (!token.isBorrowable) {
                continue;
            }
            const amount = token.getUserDebt(true);
            total_change = total_change.add(token.borrowChange(amount, rate));
        }
        return total_change;
    }
    /**
     * Get the total user net change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user net change (ex: 50, which would be $50/day)
     */
    getUserNetChange(rate) {
        const earn = this.getUserDepositsChange(rate);
        const debt = this.getUserDebtChange(rate);
        return earn.sub(debt);
    }
    /**
     * Searchs through all tokens and finds highest APY
     * @returns The highest APY among all tokens
     */
    highestApy() {
        let maxApy = new decimal_js_1.Decimal(0);
        for (const token of this.tokens) {
            const tokenApy = token.getApy();
            if (tokenApy.greaterThan(maxApy)) {
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
        for (const token of this.tokens) {
            if (token.isBorrowable) {
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
    async getSnapshots(account) {
        let snapshots = [];
        for (const token of this.tokens) {
            const snapshot = await token.getSnapshot(account);
            snapshots.push(snapshot);
        }
        return snapshots;
    }
    async reloadMarketData() {
        const dynamic_data = await this.reader.getDynamicMarketData();
        this.cache.dynamic = dynamic_data.find(m => m.address == this.address);
        for (const token of this.tokens) {
            const new_cache = this.cache.dynamic.tokens.find(t => t.address == token.address);
            token.cache = { ...token.cache, ...new_cache };
        }
    }
    async reloadUserData(account) {
        const data = (await this.reader.getUserData(account))
            .markets.find(market => market.address == this.address);
        this.cache.user = data;
        for (const token of this.tokens) {
            const new_cache = data.tokens.find(t => t.address == token.address);
            token.cache = { ...token.cache, ...new_cache };
        }
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
    async previewAssetImpact(user, collateral_ctoken, debt_ctoken, deposit_amount, borrow_amount, rate_change) {
        const amount_in = (0, helpers_1.toBigInt)(deposit_amount, collateral_ctoken.asset.decimals);
        const amount_out = (0, helpers_1.toBigInt)(borrow_amount, debt_ctoken.asset.decimals);
        const { supply, borrow } = await this.reader.previewAssetImpact(user, collateral_ctoken.address, debt_ctoken.address, amount_in, amount_out);
        const supply_apy = (0, decimal_js_1.Decimal)(supply * (0, helpers_1.getRateSeconds)('year')).div(helpers_1.WAD);
        const borrow_apy = (0, decimal_js_1.Decimal)(borrow * (0, helpers_1.getRateSeconds)('year')).div(helpers_1.WAD);
        const supply_percent = (0, decimal_js_1.Decimal)(supply * (0, helpers_1.getRateSeconds)(rate_change)).div(helpers_1.WAD);
        const borrow_percent = (0, decimal_js_1.Decimal)(borrow * (0, helpers_1.getRateSeconds)(rate_change)).div(helpers_1.WAD);
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
        };
    }
    /**
     * Grabs the new position health when doing a redeem
     * @param ctoken - Token you are expecting to redeem on
     * @param amount - Amount of assets being redeemed
     * @returns The new position health
     */
    async previewPositionHealthLeverageDeposit(deposit_ctoken, deposit_amount, borrow_ctoken, borrow_amount) {
        return this.previewPositionHealth(deposit_ctoken, borrow_ctoken, true, deposit_amount, false, borrow_amount);
    }
    async previewPositionHealthLeverageDown(deposit_ctoken, borrow_ctoken, newLeverage, currentLeverage) {
        // Full deleverage always closes to zero debt → infinite position health aka null.
        if (newLeverage.equals(1)) {
            return null;
        }
        const { collateralAssetReduction } = deposit_ctoken.previewLeverageDown(newLeverage, currentLeverage);
        const repayUsd = deposit_ctoken.convertTokensToUsd(collateralAssetReduction, true);
        const repayTokens = borrow_ctoken.convertUsdToTokens(repayUsd, true);
        return this.previewPositionHealth(deposit_ctoken, borrow_ctoken, false, FormatConverter_1.default.bigIntToDecimal(collateralAssetReduction, deposit_ctoken.asset.decimals), true, repayTokens);
    }
    async previewPositionHealthLeverageUp(deposit_ctoken, borrow_ctoken, newLeverage, depositAssets) {
        const { borrowAmount } = deposit_ctoken.previewLeverageUp(newLeverage, borrow_ctoken, depositAssets);
        // borrowAmount is the reduced amount sent to the contract — this is both
        // what enters the vault/swap (becomes collateral) and what the user owes (debt).
        // Use price-based conversion for collateral increase — this matches how the
        // on-chain health reader values positions (via oracle prices, not vault rates).
        const borrowUsd = borrowAmount.mul(borrow_ctoken.getPrice(true));
        const collateralFromBorrow = borrowUsd.div(deposit_ctoken.getPrice(true));
        // Total collateral increase = initial deposit + borrowed amount swapped to collateral.
        // The on-chain reader starts from the user's current position, so the deposit
        // must be included or the preview will undercount collateral (showing ~0% health).
        const depositInTokens = depositAssets
            ? FormatConverter_1.default.bigIntToDecimal(depositAssets, deposit_ctoken.asset.decimals)
            : (0, decimal_js_1.Decimal)(0);
        const collateralIncrease = collateralFromBorrow.add(depositInTokens);
        return this.previewPositionHealth(deposit_ctoken, borrow_ctoken, true, collateralIncrease, false, borrowAmount);
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
    async previewPositionHealth(deposit_ctoken = null, borrow_ctoken = null, isDeposit = false, collateral_amount = (0, decimal_js_1.Decimal)(0), isRepay = false, debt_amount = (0, decimal_js_1.Decimal)(0), bufferTime = 0n) {
        const provider = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const user = provider.address;
        // Pass underlying asset amounts — NOT shares.
        // The on-chain reader's _collateralValue calls previewDeposit(assets) internally,
        // and _debtValue prices assets with the underlying token's oracle price.
        // Passing shares here would cause double-conversion (shares treated as assets).
        const onchain_collateral_amount = deposit_ctoken ? FormatConverter_1.default.decimalToBigInt(collateral_amount, deposit_ctoken.asset.decimals) : 0n;
        const onchain_debt_amount = borrow_ctoken ? FormatConverter_1.default.decimalToBigInt(debt_amount, borrow_ctoken.asset.decimals) : 0n;
        const data = await this.reader.getPositionHealth(this.address, user, deposit_ctoken ? deposit_ctoken.address : helpers_1.EMPTY_ADDRESS, borrow_ctoken ? borrow_ctoken.address : helpers_1.EMPTY_ADDRESS, isDeposit, onchain_collateral_amount, isRepay, onchain_debt_amount, bufferTime);
        if (data.errorCodeHit) {
            throw new Error(`Error code hit when calculating position health preview. This usually means price is stale so we couldn't get a valid health value.`);
        }
        return this.formatPositionHealth(data.positionHealth);
    }
    formatPositionHealth(positionHealth) {
        // Defensive edge case handling where we explicitly update UINT256_MAX to
        // null return which gets processed as infinity position health on the frontend.
        if (positionHealth === helpers_1.UINT256_MAX) {
            return null;
        }
        return (0, decimal_js_1.Decimal)(positionHealth).div(helpers_1.WAD_DECIMAL).sub(1);
    }
    /**
     * Grabs the new position health when doing a redeem
     * @param ctoken - Token you are expecting to redeem on
     * @param amount - Amount of assets being redeemed
     * @returns The new position health
     */
    async previewPositionHealthRedeem(ctoken, amount) {
        const provider = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const user = provider.address;
        const redeem_amount = ctoken.convertTokenInputToShares(amount);
        const existing_collateral = ctoken.cache.userCollateral;
        if (redeem_amount > existing_collateral) {
            throw new Error(`Insufficient collateral: Existing (${existing_collateral}) < Redeem amount (${redeem_amount})`);
        }
        const data = await this.reader.getPositionHealth(this.address, user, ctoken.address, helpers_1.EMPTY_ADDRESS, false, redeem_amount, false, 0n, 0n);
        if (data.errorCodeHit) {
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
    async previewPositionHealthDeposit(ctoken, amount) {
        return this.previewPositionHealth(ctoken, null, true, amount);
    }
    /**
     * Grabs the new position health when doing a borrow
     * @param token - Token you are expecting to borrow on
     * @param amount - Amount of assets being borrowed
     * @returns The new position health
     */
    async previewPositionHealthBorrow(token, amount) {
        const provider = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const user = provider.address;
        const data = await this.reader.getPositionHealth(this.address, user, helpers_1.EMPTY_ADDRESS, token.address, false, 0n, false, FormatConverter_1.default.decimalToBigInt(amount, token.decimals), 0n);
        if (data.errorCodeHit) {
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
    async previewPositionHealthRepay(token, amount) {
        const provider = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const user = provider.address;
        const data = await this.reader.getPositionHealth(this.address, user, helpers_1.EMPTY_ADDRESS, token.address, false, 0n, true, FormatConverter_1.default.decimalToBigInt(amount, token.decimals), 0n);
        if (data.errorCodeHit) {
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
    async hypotheticalLiquidityOf(account, cTokenModified = helpers_1.EMPTY_ADDRESS, redemptionShares = 0n, borrowAssets = 0n) {
        return this.contract.hypotheticalLiquidityOf(account, cTokenModified, redemptionShares, borrowAssets);
    }
    /**
     * Fetch the expiration date of a user's cooldown period
     * @param account - The user's account address
     * @param fetch - Whether to fetch the cooldown length from the contract
     * @returns The expiration date of the cooldown period or null if not in cooldown
     */
    async expiresAt(account, fetch = false) {
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
    async multiHoldExpiresAt(markets) {
        const provider = (0, helpers_1.validateProviderAsSigner)(this.provider);
        if (markets.length == 0) {
            throw new Error("You can't fetch expirations for no markets.");
        }
        const marketAddresses = markets.map(market => market.address);
        const cooldownTimestamps = await this.reader.marketMultiCooldown(marketAddresses, provider.address);
        let cooldowns = {};
        for (let i = 0; i < markets.length; i++) {
            const market = markets[i];
            const cooldownTimestamp = cooldownTimestamps[i];
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
    static async getAll(reader, oracle_manager, provider = setup_1.setup_config.provider, milestones = {}, incentives = {}) {
        const user = "address" in provider ? provider.address : helpers_1.EMPTY_ADDRESS;
        const all_data = await reader.getAllMarketData(user);
        const deploy_keys = Object.keys(setup_1.setup_config.contracts.markets);
        // Filter out USDC — DeFiLlama incorrectly returns YZM vault yield labeled as USDC
        const [yields, merklLendOpps, merklBorrowOpps] = await Promise.all([
            Api_1.Api.fetchNativeYields().then(y => y.filter(y => y.symbol.toUpperCase() !== 'USDC')),
            (0, merkl_1.fetchMerklOpportunities)({ action: 'LEND' }).catch(() => []),
            (0, merkl_1.fetchMerklOpportunities)({ action: 'BORROW' }).catch(() => []),
        ]);
        let markets = [];
        for (let i = 0; i < all_data.staticMarket.length; i++) {
            const staticData = all_data.staticMarket[i];
            const dynamicData = all_data.dynamicMarket[i];
            const userData = all_data.userData.markets[i];
            const market_address = staticData.address;
            let deploy_data;
            for (const obj_key of deploy_keys) {
                const data = setup_1.setup_config.contracts.markets[obj_key];
                if (typeof data != 'object') {
                    continue;
                }
                if (market_address == data.address) {
                    deploy_data = {
                        name: obj_key,
                        plugins: 'plugins' in data ? data.plugins : {}
                    };
                    break;
                }
            }
            if (deploy_data == undefined) {
                console.warn(`Could not find deploy data for market: ${market_address}, skipping...`);
                continue;
            }
            if (staticData == undefined) {
                console.warn(`Could not find static market data for index: ${i}`);
                continue;
            }
            if (dynamicData == undefined) {
                console.warn(`Could not find dynamic market data for index: ${i}`);
                continue;
            }
            if (userData == undefined) {
                console.warn(`Could not find user market data for index: ${i}`);
                continue;
            }
            const market = new Market(provider, staticData, dynamicData, userData, deploy_data, oracle_manager, reader);
            if (milestones[market.address] != undefined) {
                market.milestone = milestones[market.address];
            }
            if (incentives[market.address] != undefined) {
                market.incentives = incentives[market.address];
            }
            for (const token of market.tokens) {
                const lendOpp = merklLendOpps.find(o => o.identifier.toLowerCase() === token.address.toLowerCase());
                if (lendOpp != undefined) {
                    token.incentiveSupplyApy = new decimal_js_1.Decimal(lendOpp.apr / 100);
                }
                const borrowOpp = merklBorrowOpps.find(o => o.identifier.toLowerCase() === token.address.toLowerCase());
                if (borrowOpp != undefined) {
                    token.incentiveBorrowApy = new decimal_js_1.Decimal(borrowOpp.apr / 100);
                }
                const api_yield = yields.find(y => y.symbol.toUpperCase() == token.asset.symbol.toUpperCase());
                if (api_yield != undefined) {
                    token.nativeApy = new decimal_js_1.Decimal(api_yield.apy / 100);
                }
            }
            markets.push(market);
        }
        return markets;
    }
}
exports.Market = Market;
//# sourceMappingURL=Market.js.map