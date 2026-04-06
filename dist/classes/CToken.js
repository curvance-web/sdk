"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CToken = void 0;
const helpers_1 = require("../helpers");
const ProtocolReader_1 = require("./ProtocolReader");
const ERC20_1 = require("./ERC20");
const Calldata_1 = require("./Calldata");
const decimal_js_1 = __importDefault(require("decimal.js"));
const BaseCToken_json_1 = __importDefault(require("../abis/BaseCToken.json"));
const Redstone_1 = require("./Redstone");
const Zapper_1 = require("./Zapper");
const setup_1 = require("../setup");
const PositionManager_1 = require("./PositionManager");
const NativeToken_1 = require("./NativeToken");
const ERC4626_1 = require("./ERC4626");
const FormatConverter_1 = __importDefault(require("./FormatConverter"));
const chains_1 = require("../chains");
class CToken extends Calldata_1.Calldata {
    provider;
    address;
    contract;
    abi;
    cache;
    market;
    zapTypes = [];
    leverageTypes = [];
    isVault = false;
    isNativeVault = false;
    isWrappedNative = false;
    nativeApy = (0, decimal_js_1.default)(0);
    incentiveSupplyApy = (0, decimal_js_1.default)(0);
    incentiveBorrowApy = (0, decimal_js_1.default)(0);
    constructor(provider, address, cache, market) {
        super();
        this.provider = provider;
        this.address = address;
        this.contract = (0, helpers_1.contractSetup)(provider, address, BaseCToken_json_1.default);
        this.cache = cache;
        this.market = market;
        const chain_config = (0, helpers_1.getChainConfig)();
        const assetAddr = this.asset.address.toLowerCase();
        this.isNativeVault = chain_config.native_vaults.some(vault => vault.contract.toLowerCase() == assetAddr);
        this.isVault = chain_config.vaults.some(vault => vault.contract.toLowerCase() == assetAddr);
        this.isWrappedNative = chain_config.wrapped_native.toLowerCase() == assetAddr;
        if ([
            'csAUSD',
            'cwsrUSD',
            'cezETH',
            'csyzUSD',
            'cearnAUSD',
            'cYZM'
        ].includes(this.symbol)) {
            return;
        }
        if (this.isNativeVault)
            this.zapTypes.push('native-vault');
        if ("nativeVaultPositionManager" in this.market.plugins && this.isNativeVault)
            this.leverageTypes.push('native-vault');
        if (this.isWrappedNative)
            this.zapTypes.push('native-simple');
        if (this.isVault)
            this.zapTypes.push('vault');
        if ("vaultPositionManager" in this.market.plugins && this.isVault)
            this.leverageTypes.push('vault');
        if ("simplePositionManager" in this.market.plugins)
            this.leverageTypes.push('simple');
        this.zapTypes.push('simple');
    }
    get adapters() { return this.cache.adapters; }
    get borrowPaused() { return this.cache.borrowPaused; }
    get collateralizationPaused() { return this.cache.collateralizationPaused; }
    get mintPaused() { return this.cache.mintPaused; }
    get marketManager() { return this.market; }
    get decimals() { return this.cache.decimals; }
    get symbol() { return this.cache.symbol; }
    get name() { return this.cache.name; }
    get asset() { return this.cache.asset; }
    get isBorrowable() { return this.cache.isBorrowable; }
    get exchangeRate() { return this.cache.exchangeRate; }
    get canZap() { return this.zapTypes.length > 0; }
    get maxLeverage() {
        // Cap max leverage slightly below theoretical max (1% of leverage factor)
        // to account for share rounding and fee losses that prevent reaching the exact max.
        const theoretical = (0, decimal_js_1.default)(this.cache.maxLeverage).div(helpers_1.BPS);
        const factor = theoretical.sub(1);
        return (0, decimal_js_1.default)(1).add(factor.mul((0, decimal_js_1.default)(0.99)));
    }
    get canLeverage() { return this.leverageTypes.length > 0; }
    get totalAssets() { return this.cache.totalAssets; }
    get totalSupply() { return this.cache.totalSupply; }
    get liquidationPrice() {
        if (this.cache.liquidationPrice == helpers_1.UINT256_MAX)
            return null;
        return (0, helpers_1.toDecimal)(this.cache.liquidationPrice, 18n);
    }
    get irmTargetRate() { return (0, decimal_js_1.default)(this.cache.irmTargetRate).div(helpers_1.WAD); }
    get irmMaxRate() { return (0, decimal_js_1.default)(this.cache.irmMaxRate).div(helpers_1.WAD); }
    get irmTargetUtilization() { return (0, decimal_js_1.default)(this.cache.irmTargetUtilization).div(helpers_1.WAD); }
    get interestFee() { return (0, decimal_js_1.default)(this.cache.interestFee).div(helpers_1.BPS); }
    virtualConvertToAssets(shares) {
        return (shares * this.totalAssets) / this.totalSupply;
    }
    virtualConvertToShares(assets) {
        return (assets * this.totalSupply) / this.totalAssets;
    }
    getLeverage() {
        if (this.getUserCollateral(true).equals(0)) {
            return null;
        }
        const leverage = this.getUserCollateral(true).div(this.getUserCollateral(true).sub(this.market.userDebt));
        return leverage.eq(1) ? null : leverage;
    }
    getRemainingCollateral(formatted = true) {
        const diff = this.cache.collateralCap - this.cache.collateral;
        return formatted ? this.convertTokensToUsd(diff) : diff;
    }
    getRemainingDebt(formatted = true) {
        const diff = this.cache.debtCap - this.cache.debt;
        return formatted ? this.convertTokensToUsd(diff) : diff;
    }
    getCollRatio(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.collRatio).div(helpers_1.BPS) : this.cache.collRatio;
    }
    getCollReqSoft(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.collReqSoft).div(helpers_1.BPS) : this.cache.collReqSoft;
    }
    getCollReqHard(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.collReqHard).div(helpers_1.BPS) : this.cache.collReqHard;
    }
    getLiqIncBase(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.liqIncBase).div(helpers_1.BPS) : this.cache.liqIncBase;
    }
    getLiqIncCurve(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.liqIncCurve).div(helpers_1.BPS) : this.cache.liqIncCurve;
    }
    getLiqIncMin(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.liqIncMin).div(helpers_1.BPS) : this.cache.liqIncMin;
    }
    getLiqIncMax(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.liqIncMax).div(helpers_1.BPS) : this.cache.liqIncMax;
    }
    getCloseFactorBase(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.closeFactorBase).div(helpers_1.BPS) : this.cache.closeFactorBase;
    }
    getCloseFactorCurve(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.closeFactorCurve).div(helpers_1.BPS) : this.cache.closeFactorCurve;
    }
    getCloseFactorMin(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.closeFactorMin).div(helpers_1.BPS) : this.cache.closeFactorMin;
    }
    getCloseFactorMax(inBPS) {
        return inBPS ? (0, decimal_js_1.default)(this.cache.closeFactorMax).div(helpers_1.BPS) : this.cache.closeFactorMax;
    }
    getUserShareBalance(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.userShareBalance, false) : FormatConverter_1.default.bigIntToDecimal(this.cache.userShareBalance, this.decimals);
    }
    getUserAssetBalance(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.userAssetBalance) : FormatConverter_1.default.bigIntToDecimal(this.cache.userAssetBalance, this.asset.decimals);
    }
    getUserUnderlyingBalance(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.userUnderlyingBalance) : FormatConverter_1.default.bigIntToDecimal(this.cache.userUnderlyingBalance, this.decimals);
    }
    getCollateralCap(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.collateralCap) : this.cache.collateralCap;
    }
    getDebtCap(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.debtCap) : this.cache.debtCap;
    }
    getCollateral(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.collateral) : this.cache.collateral;
    }
    getDebt(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.debt) : this.cache.debt;
    }
    getUserCollateral(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.userCollateral, false) : FormatConverter_1.default.bigIntToDecimal(this.cache.userCollateral, this.decimals);
    }
    async fetchUserCollateral(formatted = false) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const collateral = await this.contract.collateralPosted(signer.address);
        this.cache.userCollateral = collateral;
        return formatted ? (0, helpers_1.toDecimal)(collateral, this.decimals) : collateral;
    }
    getUserDebt(inUSD) {
        return inUSD ? this.convertTokensToUsd(this.cache.userDebt) : FormatConverter_1.default.bigIntToDecimal(this.cache.userDebt, this.asset.decimals);
    }
    earnChange(amount, rateType) {
        const rate = this.getApy(false);
        const rate_seconds = (0, helpers_1.getRateSeconds)(rateType);
        const rate_percent = (0, decimal_js_1.default)(rate * rate_seconds).div(helpers_1.WAD);
        return amount.mul(rate_percent);
    }
    /**
     * Grabs the collateralization ratio and converts it to a Percentage.
     * @returns Percentage representation of the LTV (e.g. 0.75 for 75% LTV)
     */
    ltv() {
        return (0, decimal_js_1.default)(this.cache.collRatio).div(helpers_1.BPS);
    }
    getUnderlyingVault() {
        if (!this.isVault && !this.isNativeVault) {
            throw new Error("CToken does not use a vault asset as its underlying asset");
        }
        return new ERC4626_1.ERC4626(this.provider, this.getAsset(false));
    }
    async getVaultAsset(asErc20) {
        return asErc20 ? await this.getUnderlyingVault().fetchAsset(true) : await this.getUnderlyingVault().fetchAsset(false);
    }
    getAsset(asErc20) {
        return asErc20 ? new ERC20_1.ERC20(this.provider, this.cache.asset.address, this.cache.asset) : this.cache.asset.address;
    }
    getPrice(asset = false, lower = false, formatted = true) {
        let price = asset ? this.cache.assetPrice : this.cache.sharePrice;
        if (lower) {
            price = asset ? this.cache.assetPriceLower : this.cache.sharePriceLower;
        }
        return formatted ? (0, decimal_js_1.default)(price).div(helpers_1.WAD) : price;
    }
    getApy(asPercentage = true) {
        // TODO: add underlying yield rate
        return asPercentage ? (0, decimal_js_1.default)(this.cache.supplyRate).div(helpers_1.WAD).mul(helpers_1.SECONDS_PER_YEAR) : this.cache.supplyRate;
    }
    getTotalBorrowRate() {
        return this.getBorrowRate(true).sub(this.incentiveBorrowApy);
    }
    getTotalSupplyRate() {
        return this.getSupplyRate(true).add(this.incentiveSupplyApy).add(this.nativeApy);
    }
    getBorrowRate(inPercentage = true) {
        return inPercentage ? (0, decimal_js_1.default)(this.cache.borrowRate).div(helpers_1.WAD).mul(helpers_1.SECONDS_PER_YEAR) : this.cache.borrowRate;
    }
    getSupplyRate(asPercentage = true) {
        // TODO: add underlying yield rate
        return asPercentage ? (0, decimal_js_1.default)(this.cache.supplyRate).div(helpers_1.WAD).mul(helpers_1.SECONDS_PER_YEAR) : this.cache.supplyRate;
    }
    getTvl(inUSD = true) {
        const tvl = this.cache.totalSupply;
        return inUSD ? this.convertTokensToUsd(tvl) : tvl;
    }
    async fetchTvl(inUSD = true) {
        const tvl = await this.fetchTotalSupply();
        this.cache.totalSupply = tvl;
        return inUSD ? this.getTvl(true) : this.getTvl(false);
    }
    getTotalCollateral(inUSD = true) {
        const totalCollateral = this.cache.collateral;
        return inUSD ? this.convertTokensToUsd(totalCollateral) : totalCollateral;
    }
    async fetchTotalCollateral(inUSD = true) {
        const totalCollateral = await this.contract.marketCollateralPosted();
        return inUSD ? this.fetchConvertTokensToUsd(totalCollateral) : totalCollateral;
    }
    getPositionManager(type) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        let manager_contract = this.getPluginAddress(type, 'positionManager');
        if (manager_contract == null) {
            throw new Error("Plugin does not have an associated contract");
        }
        return new PositionManager_1.PositionManager(manager_contract, signer, type);
    }
    getZapper(type) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const zap_contract = this.getPluginAddress(type, 'zapper');
        if (zap_contract == null) {
            return null;
        }
        return new Zapper_1.Zapper(zap_contract, signer, type);
    }
    async isZapAssetApproved(instructions, amount) {
        if (instructions == 'none' || typeof instructions != 'object') {
            return true;
        }
        if (instructions.inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase()) {
            return true;
        }
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const asset = new ERC20_1.ERC20(signer, instructions.inputToken);
        const plugin = this.getPluginAddress(instructions.type, 'zapper');
        const allowance = await asset.allowance(signer.address, plugin);
        return allowance >= amount;
    }
    async approveZapAsset(instructions, amount) {
        if (instructions == 'none' || typeof instructions != 'object') {
            throw new Error("Plugin does not have an associated contract");
        }
        if (instructions.inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase()) {
            return;
        }
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const asset = new ERC20_1.ERC20(signer, instructions.inputToken);
        const plugin = this.getPluginAddress(instructions.type, 'zapper');
        return asset.approve(plugin, amount);
    }
    async isPluginApproved(plugin, type) {
        if (plugin == 'none') {
            return true;
        }
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const plugin_address = this.getPluginAddress(plugin, type);
        if (plugin_address == null) {
            throw new Error("Plugin does not have an associated contract");
        }
        return this.contract.isDelegate(signer.address, plugin_address);
    }
    async approvePlugin(plugin, type) {
        const plugin_address = this.getPluginAddress(plugin, type);
        if (plugin_address == null) {
            throw new Error("Plugin does not have an associated contract");
        }
        return this.contract.setDelegateApproval(plugin_address, true);
    }
    getPluginAddress(plugin, type) {
        switch (type) {
            case 'zapper': {
                if (plugin == 'none')
                    return null;
                if (!Zapper_1.zapperTypeToName.has(plugin)) {
                    throw new Error("Plugin does not have a contract to map too");
                }
                const plugin_name = Zapper_1.zapperTypeToName.get(plugin);
                if (!plugin_name || !setup_1.setup_config.contracts.zappers || !(plugin_name in setup_1.setup_config.contracts.zappers)) {
                    throw new Error(`Plugin ${plugin_name} not found in zappers`);
                }
                return setup_1.setup_config.contracts.zappers[plugin_name];
            }
            case 'positionManager': {
                switch (plugin) {
                    case 'vault': return this.market.plugins.vaultPositionManager;
                    case 'native-vault': return this.market.plugins.nativeVaultPositionManager;
                    case 'simple': return this.market.plugins.simplePositionManager;
                    default: throw new Error("Unknown position manager type");
                }
            }
            default: throw new Error("Unsupported plugin type");
        }
    }
    async getAllowance(check_contract, underlying = true) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const erc20 = new ERC20_1.ERC20(this.provider, underlying ? this.asset.address : this.address);
        const allowance = await erc20.allowance(signer.address, check_contract);
        return allowance;
    }
    /**
     * Approves the underlying asset to be used with the ctoken contract.
     * @param amount - if null it will approve the max uint256, otherwise the amount specified
     * @returns tx
     */
    async approveUnderlying(amount = null, target = null) {
        const erc20 = new ERC20_1.ERC20(this.provider, this.asset.address);
        const tx = await erc20.approve(target ? target : this.address, amount);
        return tx;
    }
    async approve(amount = null, spender) {
        const erc20 = new ERC20_1.ERC20(this.provider, this.address);
        const tx = await erc20.approve(spender, amount);
        return tx;
    }
    async fetchDecimals() {
        const decimals = await this.contract.decimals();
        this.cache.decimals = decimals;
        return decimals;
    }
    async fetchIsBorrowable() {
        const canBorrow = await this.contract.isBorrowable();
        this.cache.isBorrowable = canBorrow;
        return canBorrow;
    }
    async fetchAsset() {
        const asset = await this.contract.asset();
        this.cache.asset.address = asset;
        return asset;
    }
    async fetchMarketManagerAddr() {
        return this.contract.marketManager();
    }
    async fetchSymbol() {
        const symbol = await this.contract.symbol();
        this.cache.symbol = symbol;
        return symbol;
    }
    async fetchName() {
        const name = await this.contract.name();
        this.cache.name = name;
        return name;
    }
    async fetchPrice(asset = false, getLower = false, inUSD = true) {
        const priceForAddress = asset ? this.asset.address : this.address;
        const price = await this.market.oracle_manager.getPrice(priceForAddress, inUSD, getLower);
        if (getLower) {
            this.cache.sharePriceLower = price;
        }
        else {
            this.cache.sharePrice = price;
        }
        return price;
    }
    async fetchTotalSupply() {
        return this.contract.totalSupply();
    }
    async fetchTotalAssets() {
        return this.contract.totalAssets();
    }
    async getExchangeRate() {
        const rate = await this.contract.exchangeRate();
        this.cache.exchangeRate = rate;
        return rate;
    }
    async marketCollateralPosted() {
        return this.contract.marketCollateralPosted();
    }
    async balanceOf(account) {
        return this.contract.balanceOf(account);
    }
    async maxDeposit(receiver) {
        return this.contract.maxDeposit(receiver);
    }
    async transfer(receiver, amount) {
        const shares = this.convertTokenInputToShares(amount);
        return this.contract.transfer(receiver, shares);
    }
    async redeemCollateral(amount, receiver = null, owner = null) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        receiver ??= signer.address;
        owner ??= signer.address;
        const shares = this.convertTokenInputToShares(amount);
        const calldata = this.getCallData("redeemCollateral", [shares, receiver, owner]);
        return this.oracleRoute(calldata);
    }
    async postCollateral(amount) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const shares = this.convertTokenInputToShares(amount);
        const balance = await this.balanceOf(signer.address);
        const collateral = await this.fetchUserCollateral();
        const available_shares = balance - collateral;
        const max_shares = available_shares < shares ? available_shares : shares;
        const calldata = this.getCallData("postCollateral", [max_shares]);
        const tx = await this.oracleRoute(calldata);
        // Reload collateral state after execution
        await this.fetchUserCollateral();
        return tx;
    }
    async getZapBalance(zap) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        let asset;
        if (typeof zap === 'object') {
            if (zap.type === 'native-vault' || zap.type === 'native-simple' || zap.inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase()) {
                asset = new NativeToken_1.NativeToken(setup_1.setup_config.chain, this.provider);
            }
            else {
                asset = new ERC20_1.ERC20(this.provider, zap.inputToken);
            }
        }
        else {
            switch (zap) {
                case 'none':
                    asset = this.getAsset(true);
                    break;
                case 'vault':
                    asset = await this.getVaultAsset(true);
                    break;
                case 'native-vault':
                    asset = new NativeToken_1.NativeToken(setup_1.setup_config.chain, this.provider);
                    break;
                case 'native-simple':
                    asset = new NativeToken_1.NativeToken(setup_1.setup_config.chain, this.provider);
                    break;
                default: throw new Error("Unsupported zap type for balance fetch");
            }
        }
        return asset.balanceOf(signer.address, false);
    }
    // TODO: Hack to remove
    async ensureUnderlyingAmount(amount, zap) {
        const balance = await this.getZapBalance(zap);
        const isZapping = typeof zap === 'object' && zap.type !== 'none';
        // Use the zap input token's decimals when zapping, otherwise the deposit token's decimals
        let decimals = this.asset.decimals;
        if (isZapping && zap.inputToken) {
            if (zap.inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase()) {
                decimals = 18n;
            }
            else {
                const inputErc20 = new ERC20_1.ERC20(this.provider, zap.inputToken);
                decimals = inputErc20.decimals ?? await inputErc20.contract.decimals();
            }
        }
        const assets = FormatConverter_1.default.decimalToBigInt(amount, decimals);
        if (assets > balance) {
            console.warn('[WARNING] Detected higher deposit amount then underlying balance, changing to the underlying balance. Diff: ', {
                balance: balance,
                formatted: FormatConverter_1.default.bigIntToDecimal(balance, decimals),
                attempt: {
                    raw: assets,
                    formatted: amount
                },
            });
            return FormatConverter_1.default.bigIntToDecimal(balance, decimals);
        }
        return amount;
    }
    async removeCollateral(amount, removeAll = false) {
        const current_shares = await this.fetchUserCollateral();
        let max_shares;
        if (removeAll) {
            max_shares = current_shares;
        }
        else {
            const shares = this.convertTokenInputToShares(amount);
            max_shares = current_shares < shares ? current_shares : shares;
            // If within 0.1% of full collateral, remove everything to avoid dust
            const threshold = current_shares / 1000n || 10n;
            if (current_shares - max_shares <= threshold) {
                max_shares = current_shares;
            }
        }
        const calldata = this.getCallData("removeCollateral", [max_shares]);
        const tx = await this.oracleRoute(calldata);
        // Reload collateral state after execution
        await this.fetchUserCollateral();
        return tx;
    }
    convertTokenInputToShares(amount) {
        return this.virtualConvertToShares(FormatConverter_1.default.decimalToBigInt(amount, this.asset.decimals));
    }
    convertTokenToToken(fromToken, toToken, amount, formatted, shares = false) {
        const fromData = {
            price: fromToken.getPrice(shares ? false : true),
            decimals: shares ? fromToken.decimals : fromToken.asset.decimals,
            amount: amount
        };
        const toData = {
            price: toToken.getPrice(shares ? false : true),
            decimals: shares ? toToken.decimals : toToken.asset.decimals
        };
        return formatted
            ? FormatConverter_1.default.tokensToTokens(fromData, toData, true)
            : FormatConverter_1.default.tokensToTokens(fromData, toData, false);
    }
    async convertToAssets(shares) {
        return this.contract.convertToAssets(shares);
    }
    async convertToShares(assets, bufferBps = 2n) {
        const shares = await this.contract.convertToShares(assets);
        return bufferBps > 0n ? shares * (10000n - bufferBps) / 10000n : shares;
    }
    async maxRedemption(in_shares = false, bufferTime = 0n, breakdown = false) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const data = await this.market.reader.maxRedemptionOf(signer.address, this, bufferTime);
        if (data.errorCodeHit) {
            throw new Error(`Error fetching max redemption. Possible stale price or other issues...`);
        }
        if (breakdown) {
            return {
                max_collateral: in_shares ? data.maxCollateralizedShares : FormatConverter_1.default.bigIntToDecimal(this.virtualConvertToAssets(data.maxCollateralizedShares), this.asset.decimals),
                max_uncollateralized: in_shares ? data.maxUncollateralizedShares : FormatConverter_1.default.bigIntToDecimal(this.virtualConvertToAssets(data.maxUncollateralizedShares), this.asset.decimals),
            };
        }
        const all_shares = data.maxCollateralizedShares + data.maxUncollateralizedShares;
        if (in_shares)
            return all_shares;
        const all_assets = this.virtualConvertToAssets(all_shares);
        return FormatConverter_1.default.bigIntToDecimal(all_assets, this.asset.decimals);
    }
    /** @returns A list of tokens mapped to their respective zap options */
    async getDepositTokens(search = null) {
        const underlying = this.getAsset(true);
        let tokens = [{
                interface: underlying,
                type: 'none'
            }];
        let tokens_exclude = [this.asset.address.toLocaleLowerCase()];
        if (this.zapTypes.includes('native-vault')) {
            tokens.push({
                interface: new NativeToken_1.NativeToken(setup_1.setup_config.chain, this.provider),
                type: 'native-vault'
            });
            tokens_exclude.push(helpers_1.EMPTY_ADDRESS, helpers_1.NATIVE_ADDRESS);
        }
        if (this.zapTypes.includes('native-simple')) {
            tokens.push({
                interface: new NativeToken_1.NativeToken(setup_1.setup_config.chain, this.provider),
                type: 'native-simple'
            });
            if (!this.zapTypes.includes('native-vault')) {
                tokens_exclude.push(helpers_1.EMPTY_ADDRESS, helpers_1.NATIVE_ADDRESS);
            }
        }
        if (this.zapTypes.includes('vault')) {
            const vault_asset = await this.getVaultAsset(true);
            tokens.push({
                interface: vault_asset,
                type: 'vault'
            });
            tokens_exclude.push(vault_asset.address.toLocaleLowerCase());
        }
        if (this.zapTypes.includes('simple')) {
            let dexAggSearch = await chains_1.chain_config[setup_1.setup_config.chain].dexAgg.getAvailableTokens(this.provider, search);
            tokens = tokens.concat(dexAggSearch.filter(token => !tokens_exclude.includes(token.interface.address.toLocaleLowerCase())));
            // Add native MON as a zap option for any token with a simple zapper
            // (not just wrapped native). The simple zapper handles wrapping + swapping.
            if (!tokens_exclude.includes(helpers_1.NATIVE_ADDRESS.toLowerCase()) && !this.isWrappedNative) {
                tokens.push({
                    interface: new NativeToken_1.NativeToken(setup_1.setup_config.chain, this.provider),
                    type: 'simple'
                });
                tokens_exclude.push(helpers_1.NATIVE_ADDRESS.toLowerCase());
            }
        }
        if (search) {
            const lowerSearch = search.toLowerCase();
            tokens = tokens.filter(token => (token.interface.name ?? '').toLowerCase().includes(lowerSearch) ||
                (token.interface.symbol ?? '').toLowerCase().includes(lowerSearch));
        }
        return tokens;
    }
    async hypotheticalRedemptionOf(amount) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const shares = this.convertTokenInputToShares(amount);
        return this.market.reader.hypotheticalRedemptionOf(signer.address, this, shares);
    }
    /**
     * Compute slippage BPS for the contract's checkSlippage modifier when leveraging up.
     * Share rounding (vault + cToken) causes equity loss ≈ 20bps × (leverage - 1).
     * The user's swap slippage is preserved for DEX protection; this adds a buffer
     * so the on-chain sanity check doesn't reject legitimate leverage operations.
     */
    _leverageUpSlippage(slippage, leverage) {
        const leverageFactor = leverage.sub(1);
        if (leverageFactor.lte(0))
            return slippage;
        // ~20bps per unit of leverage factor for rounding losses
        const buffer = BigInt(leverageFactor.mul(20).ceil().toFixed(0));
        return slippage + buffer;
    }
    previewLeverageUp(newLeverage, borrow, depositAmount) {
        const currentLeverage = this.getLeverage() ?? (0, decimal_js_1.default)(0);
        if (newLeverage.lte(currentLeverage)) {
            throw new Error("New leverage must be more than current leverage");
        }
        if (newLeverage.gt(this.maxLeverage)) {
            newLeverage = this.maxLeverage;
        }
        const collateralAvail = this.cache.userCollateral + (depositAmount ? depositAmount : BigInt(0));
        const collateralInUsd = this.convertTokensToUsd(collateralAvail, false);
        const currentDebt = this.market.userDebt;
        const notional = collateralInUsd.sub(currentDebt);
        // Cap effective leverage slightly below target to account for protocol
        // leverage fee and rounding losses. The fee reduces collateral gained
        // relative to debt incurred, causing equity loss ≈ fee% × (leverage-1).
        // Capping at 98% of the leverage factor ensures the on-chain slippage
        // check passes even at max leverage.
        const leverageFactor = newLeverage.sub(1);
        const borrowPrice = borrow.getPrice(true);
        // Raw borrow amount — what the user actually owes as debt
        const rawDebtInUsd = notional.mul(newLeverage).sub(notional);
        const rawBorrowAmount = rawDebtInUsd.sub(currentDebt).div(borrowPrice);
        // Reduced borrow amount — what we send to the contract to avoid
        // tripping the on-chain slippage check at max leverage
        const effectiveLeverage = (0, decimal_js_1.default)(1).add(leverageFactor.mul((0, decimal_js_1.default)(0.99)));
        const effectiveDebtInUsd = notional.mul(effectiveLeverage).sub(notional);
        const borrowAmount = effectiveDebtInUsd.sub(currentDebt).div(borrowPrice);
        const newCollateralInUsd = notional.add(rawDebtInUsd);
        return {
            borrowAmount,
            rawBorrowAmount,
            newDebt: rawDebtInUsd,
            newDebtInAssets: borrow.convertUsdToTokens(rawDebtInUsd, true),
            newCollateral: newCollateralInUsd,
            newCollateralInAssets: this.convertUsdToTokens(newCollateralInUsd, true)
        };
    }
    previewLeverageDown(newLeverage, currentLeverage, borrow) {
        if (newLeverage.gte(currentLeverage)) {
            throw new Error("New leverage must be less than current leverage");
        }
        if (newLeverage.lt((0, decimal_js_1.default)(1))) {
            throw new Error("New leverage must be at least 1");
        }
        const collateralAvail = this.cache.userCollateral;
        const collateralInUsd = this.convertTokensToUsd(collateralAvail, false);
        const currentDebt = this.market.userDebt;
        const equity = collateralInUsd.sub(currentDebt);
        const targetCollateralUsd = equity.mul(newLeverage);
        const newDebtUsd = targetCollateralUsd.sub(equity);
        const collateralAssetReductionUsd = collateralInUsd.sub(targetCollateralUsd);
        const collateralAssetReduction = FormatConverter_1.default.decimalToBigInt(collateralAssetReductionUsd.div(this.getPrice(true)), this.asset.decimals);
        const leverageDiff = (0, decimal_js_1.default)(1).sub(newLeverage.div(currentLeverage));
        return {
            collateralAssetReduction,
            collateralAssetReductionUsd,
            leverageDiff,
            newDebt: newDebtUsd,
            newDebtInAssets: borrow ? borrow.convertUsdToTokens(newDebtUsd, true) : undefined,
            newCollateral: targetCollateralUsd,
            newCollateralInAssets: this.convertUsdToTokens(targetCollateralUsd, true)
        };
    }
    async leverageUp(borrow, newLeverage, type, slippage_ = (0, decimal_js_1.default)(0.05), simulate = false) {
        try {
            (0, helpers_1.validateProviderAsSigner)(this.provider);
            const slippage = this._leverageUpSlippage(FormatConverter_1.default.percentageToBps(slippage_), newLeverage);
            const manager = this.getPositionManager(type);
            let calldata;
            const { borrowAmount } = this.previewLeverageUp(newLeverage, borrow);
            switch (type) {
                case 'simple': {
                    const { action, quote } = await chains_1.chain_config[setup_1.setup_config.chain].dexAgg.quoteAction(manager.address, borrow.asset.address, this.asset.address, FormatConverter_1.default.decimalToBigInt(borrowAmount, borrow.asset.decimals), slippage);
                    calldata = manager.getLeverageCalldata({
                        borrowableCToken: borrow.address,
                        borrowAssets: FormatConverter_1.default.decimalToBigInt(borrowAmount, borrow.asset.decimals),
                        cToken: this.address,
                        expectedShares: this.virtualConvertToShares(BigInt(quote.min_out)),
                        swapAction: action,
                        auxData: "0x",
                    }, FormatConverter_1.default.bpsToBpsWad(slippage));
                    break;
                }
                case 'native-vault':
                case 'vault': {
                    calldata = manager.getLeverageCalldata({
                        borrowableCToken: borrow.address,
                        borrowAssets: FormatConverter_1.default.decimalToBigInt(borrowAmount, borrow.asset.decimals),
                        cToken: this.address,
                        expectedShares: await PositionManager_1.PositionManager.getVaultExpectedShares(this, borrow, borrowAmount),
                        swapAction: PositionManager_1.PositionManager.emptySwapAction(),
                        auxData: "0x",
                    }, FormatConverter_1.default.bpsToBpsWad(slippage));
                    break;
                }
                default:
                    if (simulate)
                        return { success: false, error: "Unsupported position manager type" };
                    throw new Error("Unsupported position manager type");
            }
            if (simulate)
                return this.simulateOracleRoute(calldata, { to: manager.address });
            await this._checkPositionManagerApproval(manager);
            return this.oracleRoute(calldata, { to: manager.address });
        }
        catch (error) {
            if (simulate)
                return { success: false, error: error?.reason || error?.message || String(error) };
            throw error;
        }
    }
    async leverageDown(borrowToken, currentLeverage, newLeverage, type, slippage_ = (0, decimal_js_1.default)(0.05), simulate = false) {
        try {
            if (newLeverage.gte(currentLeverage)) {
                if (simulate)
                    return { success: false, error: "New leverage must be less than current leverage" };
                throw new Error("New leverage must be less than current leverage");
            }
            (0, helpers_1.validateProviderAsSigner)(this.provider);
            const config = (0, helpers_1.getChainConfig)();
            const slippage = (0, helpers_1.toBps)(slippage_);
            const manager = this.getPositionManager(type);
            let calldata;
            const { collateralAssetReduction } = this.previewLeverageDown(newLeverage, currentLeverage);
            const isFullDeleverage = newLeverage.equals(1);
            const repay_balance = isFullDeleverage ? await borrowToken.fetchDebtBalanceAtTimestamp(100n, false) : null;
            switch (type) {
                case 'simple': {
                    let swapCollateral = collateralAssetReduction;
                    if (isFullDeleverage) {
                        const initialQuote = await config.dexAgg.quote(manager.address, this.asset.address, borrowToken.asset.address, collateralAssetReduction, slippage);
                        if (initialQuote.out < repay_balance) {
                            swapCollateral = collateralAssetReduction * repay_balance * 1005n / (initialQuote.out * 1000n);
                        }
                    }
                    const { action, quote } = await config.dexAgg.quoteAction(manager.address, this.asset.address, borrowToken.asset.address, swapCollateral, slippage);
                    const minRepay = isFullDeleverage ? 1n : quote.out - (BigInt((0, decimal_js_1.default)(quote.out).mul(.05).toFixed(0)));
                    // For full deleverage, add 50bps buffer to the contract-level slippage
                    // check to account for oracle price variance in the oracleRoute multicall.
                    const contractSlippage = isFullDeleverage
                        ? slippage + 50n
                        : slippage;
                    calldata = manager.getDeleverageCalldata({
                        cToken: this.address,
                        collateralAssets: swapCollateral,
                        borrowableCToken: borrowToken.address,
                        repayAssets: BigInt(minRepay),
                        swapActions: [action],
                        auxData: "0x",
                    }, FormatConverter_1.default.bpsToBpsWad(contractSlippage));
                    break;
                }
                default:
                    if (simulate)
                        return { success: false, error: "Unsupported position manager type" };
                    throw new Error("Unsupported position manager type");
            }
            if (simulate)
                return this.simulateOracleRoute(calldata, { to: manager.address });
            await this._checkPositionManagerApproval(manager);
            return this.oracleRoute(calldata, { to: manager.address });
        }
        catch (error) {
            if (simulate)
                return { success: false, error: error?.reason || error?.message || String(error) };
            throw error;
        }
    }
    async depositAndLeverage(depositAmount, borrow, multiplier, type, slippage_ = (0, decimal_js_1.default)(0.05), simulate = false) {
        try {
            if (multiplier.lte((0, decimal_js_1.default)(1))) {
                if (simulate)
                    return { success: false, error: "Multiplier must be greater than 1" };
                throw new Error("Multiplier must be greater than 1");
            }
            depositAmount = await this.ensureUnderlyingAmount(depositAmount, 'none');
            const slippage = this._leverageUpSlippage((0, helpers_1.toBps)(slippage_), multiplier);
            const manager = this.getPositionManager(type);
            let calldata;
            const depositAssets = FormatConverter_1.default.decimalToBigInt(depositAmount, this.asset.decimals);
            const { borrowAmount } = this.previewLeverageUp(multiplier, borrow, depositAssets);
            switch (type) {
                case 'simple': {
                    const { action, quote } = await chains_1.chain_config[setup_1.setup_config.chain].dexAgg.quoteAction(manager.address, borrow.asset.address, this.asset.address, FormatConverter_1.default.decimalToBigInt(borrowAmount, borrow.asset.decimals), slippage);
                    calldata = manager.getDepositAndLeverageCalldata(FormatConverter_1.default.decimalToBigInt(depositAmount, this.asset.decimals), {
                        borrowableCToken: borrow.address,
                        borrowAssets: FormatConverter_1.default.decimalToBigInt(borrowAmount, borrow.asset.decimals),
                        cToken: this.address,
                        expectedShares: this.virtualConvertToShares(BigInt(quote.min_out)),
                        swapAction: action,
                        auxData: "0x",
                    }, FormatConverter_1.default.bpsToBpsWad(slippage));
                    break;
                }
                case 'native-vault':
                case 'vault': {
                    calldata = manager.getDepositAndLeverageCalldata(FormatConverter_1.default.decimalToBigInt(depositAmount, this.asset.decimals), {
                        borrowableCToken: borrow.address,
                        borrowAssets: FormatConverter_1.default.decimalToBigInt(borrowAmount, borrow.asset.decimals),
                        cToken: this.address,
                        expectedShares: await PositionManager_1.PositionManager.getVaultExpectedShares(this, borrow, borrowAmount),
                        swapAction: PositionManager_1.PositionManager.emptySwapAction(),
                        auxData: "0x",
                    }, FormatConverter_1.default.bpsToBpsWad(slippage));
                    break;
                }
                default:
                    if (simulate)
                        return { success: false, error: "Unsupported position manager type" };
                    throw new Error("Unsupported position manager type");
            }
            if (simulate)
                return this.simulateOracleRoute(calldata, { to: manager.address });
            return this.oracleRoute(calldata, { to: manager.address });
        }
        catch (error) {
            if (simulate)
                return { success: false, error: error?.reason || error?.message || String(error) };
            throw error;
        }
    }
    async simulateDeposit(amount, zap = 'none', receiver = null) {
        try {
            amount = await this.ensureUnderlyingAmount(amount, zap);
            const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
            receiver ??= signer.address;
            const isZapping = typeof zap === 'object' && zap.type !== 'none';
            const depositAssets = FormatConverter_1.default.decimalToBigInt(amount, this.asset.decimals);
            let zapAssets = depositAssets;
            if (isZapping && zap.inputToken) {
                const isNative = zap.inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase();
                const zapDecimals = isNative ? 18n : (() => {
                    const inputErc20 = new ERC20_1.ERC20(this.provider, zap.inputToken);
                    return inputErc20.decimals ?? inputErc20.contract.decimals();
                })();
                zapAssets = FormatConverter_1.default.decimalToBigInt(amount, await zapDecimals);
            }
            const default_calldata = this.getCallData("deposit", [depositAssets, receiver]);
            const { calldata, calldata_overrides } = await this.zap(zapAssets, zap, false, default_calldata);
            return this.simulateOracleRoute(calldata, calldata_overrides);
        }
        catch (error) {
            return { success: false, error: error?.reason || error?.message || String(error) };
        }
    }
    async simulateDepositAsCollateral(amount, zap = 'none', receiver = null) {
        try {
            amount = await this.ensureUnderlyingAmount(amount, zap);
            const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
            receiver ??= signer.address;
            const isZapping = typeof zap === 'object' && zap.type !== 'none';
            const depositAssets = FormatConverter_1.default.decimalToBigInt(amount, this.asset.decimals);
            let zapAssets = depositAssets;
            if (isZapping && zap.inputToken) {
                const isNative = zap.inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase();
                const zapDecimals = isNative ? 18n : (() => {
                    const inputErc20 = new ERC20_1.ERC20(this.provider, zap.inputToken);
                    return inputErc20.decimals ?? inputErc20.contract.decimals();
                })();
                zapAssets = FormatConverter_1.default.decimalToBigInt(amount, await zapDecimals);
            }
            const default_calldata = this.getCallData("depositAsCollateral", [depositAssets, receiver]);
            const { calldata, calldata_overrides } = await this.zap(zapAssets, zap, true, default_calldata);
            return this.simulateOracleRoute(calldata, calldata_overrides);
        }
        catch (error) {
            return { success: false, error: error?.reason || error?.message || String(error) };
        }
    }
    async zap(assets, zap, collateralize = false, default_calldata) {
        let calldata;
        let calldata_overrides = {};
        let slippage = 0n;
        let inputToken = null;
        let type_of_zap;
        if (typeof zap == 'object') {
            slippage = BigInt(zap.slippage.mul(helpers_1.BPS).toString());
            inputToken = zap.inputToken;
            type_of_zap = zap.type;
        }
        else {
            type_of_zap = zap;
        }
        let zapper = this.getZapper(type_of_zap);
        if (zapper == null) {
            if (type_of_zap != 'none') {
                throw new Error("Zapper type selected but no zapper contract found");
            }
            return { calldata: default_calldata, calldata_overrides, zapper: null };
        }
        switch (type_of_zap) {
            case 'simple':
                if (inputToken == null)
                    throw new Error("Input token must be provided for simple zap");
                calldata = await zapper.getSimpleZapCalldata(this, inputToken, this.asset.address, assets, collateralize, slippage);
                const isNativeSimpleZap = inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase();
                calldata_overrides = isNativeSimpleZap ? { value: assets, to: zapper.address } : { to: zapper.address };
                break;
            case 'vault':
                calldata = await zapper.getVaultZapCalldata(this, assets, collateralize);
                calldata_overrides = { to: zapper.address };
                break;
            case 'native-vault':
                calldata = await zapper.getNativeZapCalldata(this, assets, collateralize);
                calldata_overrides = { value: assets, to: zapper.address };
                break;
            case 'native-simple':
                calldata = await zapper.getNativeZapCalldata(this, assets, collateralize, true);
                calldata_overrides = { value: assets, to: zapper.address };
                break;
            default:
                throw new Error("This zap type is not supported: " + type_of_zap);
        }
        return { calldata, calldata_overrides, zapper };
    }
    async deposit(amount, zap = 'none', receiver = null) {
        amount = await this.ensureUnderlyingAmount(amount, zap);
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        receiver ??= signer.address;
        // When zapping, the swap amount uses input token decimals, but the
        // default deposit calldata uses the deposit token decimals.
        const isZapping = typeof zap === 'object' && zap.type !== 'none';
        const depositAssets = FormatConverter_1.default.decimalToBigInt(amount, this.asset.decimals);
        let zapAssets = depositAssets;
        if (isZapping && zap.inputToken) {
            if (zap.inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase()) {
                zapAssets = FormatConverter_1.default.decimalToBigInt(amount, 18n);
            }
            else {
                const inputErc20 = new ERC20_1.ERC20(this.provider, zap.inputToken);
                const zapDecimals = inputErc20.decimals ?? await inputErc20.contract.decimals();
                zapAssets = FormatConverter_1.default.decimalToBigInt(amount, zapDecimals);
            }
        }
        const zapType = typeof zap == 'object' ? zap.type : zap;
        const isNative = zapType == 'native-simple' || zapType == 'native-vault' || zapType == 'none'
            || (typeof zap == 'object' && zap.inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase());
        const default_calldata = this.getCallData("deposit", [depositAssets, receiver]);
        const { calldata, calldata_overrides } = await this.zap(zapAssets, zap, false, default_calldata);
        if (isNative) {
            await this._checkAssetApproval(depositAssets);
        }
        else {
            const isApproved = await this.isZapAssetApproved(zap, zapAssets);
            if (!isApproved) {
                throw new Error(`Zap asset is not approved for the plugin. Call approveZapAsset() first.`);
            }
            const zapper = this.getZapper(zapType);
            if (!zapper) {
                throw new Error(`No zapper contract found for type '${zapType}' on ${this.symbol}`);
            }
            await this._checkZapperApproval(zapper);
        }
        return this.oracleRoute(calldata, calldata_overrides);
    }
    async depositAsCollateral(amount, zap = 'none', receiver = null) {
        amount = await this.ensureUnderlyingAmount(amount, zap);
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        receiver ??= signer.address;
        // When zapping, the swap amount uses input token decimals, but collateral
        // cap checks and the default deposit calldata use the deposit token decimals.
        const isZapping = typeof zap === 'object' && zap.type !== 'none';
        const depositAssets = FormatConverter_1.default.decimalToBigInt(amount, this.asset.decimals);
        let zapAssets = depositAssets;
        if (isZapping && zap.inputToken) {
            if (zap.inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase()) {
                zapAssets = FormatConverter_1.default.decimalToBigInt(amount, 18n);
            }
            else {
                const inputErc20 = new ERC20_1.ERC20(this.provider, zap.inputToken);
                const zapDecimals = inputErc20.decimals ?? await inputErc20.contract.decimals();
                zapAssets = FormatConverter_1.default.decimalToBigInt(amount, zapDecimals);
            }
        }
        if (!isZapping) {
            const collateralCapError = "There is not enough collateral left in this tokens collateral cap for this deposit.";
            const remainingCollateral = this.getRemainingCollateral(false);
            if (remainingCollateral == 0n)
                throw new Error(collateralCapError);
            if (remainingCollateral > 0n) {
                const shares = this.virtualConvertToShares(depositAssets);
                if (shares > remainingCollateral) {
                    throw new Error(collateralCapError);
                }
            }
        }
        const default_calldata = this.getCallData("depositAsCollateral", [depositAssets, receiver]);
        const { calldata, calldata_overrides, zapper } = await this.zap(zapAssets, zap, true, default_calldata);
        await this._checkDepositApprovals(zapper, zapAssets);
        return this.oracleRoute(calldata, calldata_overrides);
    }
    async redeem(amount) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const receiver = signer.address;
        const owner = signer.address;
        const buffer = this.market.userDebt.greaterThan(0) ? 100n : 0n;
        const balance_avail = await this.balanceOf(signer.address);
        const max_shares = await this.maxRedemption(true, buffer);
        const converted_shares = this.convertTokenInputToShares(amount);
        let shares = max_shares < converted_shares ? max_shares : converted_shares;
        if (balance_avail - shares <= 10n) {
            shares = balance_avail;
        }
        const calldata = this.getCallData("redeem", [shares, receiver, owner]);
        return this.oracleRoute(calldata);
    }
    async redeemShares(amount) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const receiver = signer.address;
        const owner = signer.address;
        const calldata = this.getCallData("redeem", [amount, receiver, owner]);
        return this.oracleRoute(calldata);
    }
    async collateralPosted(account = null) {
        if (!account)
            account = (0, helpers_1.validateProviderAsSigner)(this.provider).address;
        return this.contract.collateralPosted(account);
    }
    async multicall(calls) {
        return this.contract.multicall(calls);
    }
    async getSnapshot(account) {
        const snapshot = await this.contract.getSnapshot(account);
        return {
            asset: snapshot.asset,
            decimals: BigInt(snapshot.decimals),
            isCollateral: snapshot.isCollateral,
            collateralPosted: BigInt(snapshot.collateralPosted),
            debtBalance: BigInt(snapshot.debtBalance)
        };
    }
    convertTokensToUsd(tokenAmount, asset = true) {
        const price = this.getPrice(asset, false, false);
        return FormatConverter_1.default.bigIntTokensToUsd(tokenAmount, price, this.decimals);
    }
    async fetchConvertTokensToUsd(tokenAmount, asset = true) {
        // Reload cache
        await this.fetchPrice(asset);
        await this.fetchDecimals();
        return this.convertTokensToUsd(tokenAmount, asset);
    }
    convertUsdToTokens(usdAmount, asset = true, lower = false) {
        const price = this.getPrice(asset, lower);
        return usdAmount.div(price);
    }
    convertAssetsToUsd(tokenAmount) {
        const price = this.getPrice(true, false, false);
        const decimals = this.decimals;
        return FormatConverter_1.default.bigIntTokensToUsd(tokenAmount, price, decimals);
    }
    async convertSharesToUsd(tokenAmount) {
        tokenAmount = this.virtualConvertToShares(tokenAmount);
        const price = this.getPrice(false, false, false);
        const decimals = this.decimals;
        return FormatConverter_1.default.bigIntTokensToUsd(tokenAmount, price, decimals);
    }
    buildMultiCallAction(calldata) {
        return {
            target: this.address,
            isPriceUpdate: false,
            data: calldata
        };
    }
    async _checkPositionManagerApproval(manager) {
        const isApproved = await this.isPluginApproved(manager.type, 'positionManager');
        if (!isApproved) {
            throw new Error(`PositionManager ${manager.address} is not approved for ${this.symbol}`);
        }
    }
    async _checkZapperApproval(zapper) {
        if (!setup_1.setup_config.approval_protection) {
            return;
        }
        if (setup_1.setup_config.approval_protection && zapper) {
            const plugin_allowed = await this.isPluginApproved(zapper.type, 'zapper');
            if (!plugin_allowed) {
                throw new Error(`Please approve the ${zapper.type} Zapper to be able to move ${this.symbol} on your behalf.`);
            }
        }
    }
    async _checkErc20Approval(erc20_address, amount, spender) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const erc20 = new ERC20_1.ERC20(signer, erc20_address);
        const allowance = await erc20.allowance(signer.address, spender);
        if (allowance < amount) {
            const symbol = await erc20.fetchSymbol();
            throw new Error(`Please approve ${symbol} for ${spender}: ${amount}`);
        }
    }
    async _checkAssetApproval(assets) {
        if (!setup_1.setup_config.approval_protection) {
            return;
        }
        const asset = this.getAsset(true);
        const owner = (0, helpers_1.validateProviderAsSigner)(this.provider).address;
        const allowance = await asset.allowance(owner, this.address);
        if (allowance < assets) {
            throw new Error(`Please approve the ${asset.symbol} token for ${this.symbol}`);
        }
    }
    async _checkDepositApprovals(zapper, assets) {
        if (!setup_1.setup_config.approval_protection) {
            return;
        }
        if (zapper) {
            await this._checkZapperApproval(zapper);
        }
        await this._checkAssetApproval(assets);
    }
    async oracleRoute(calldata, override = {}) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        const price_updates = await this.getPriceUpdates();
        if (price_updates.length > 0) {
            const token_action = this.buildMultiCallAction(calldata);
            calldata = this.getCallData("multicall", [[...price_updates, token_action]]);
        }
        const tx = await this.executeCallData(calldata, override);
        await this.market.reloadUserData(signer.address);
        return tx;
    }
    async simulateOracleRoute(calldata, override = {}) {
        const price_updates = await this.getPriceUpdates();
        if (price_updates.length > 0) {
            const token_action = this.buildMultiCallAction(calldata);
            calldata = this.getCallData("multicall", [[...price_updates, token_action]]);
        }
        return this.simulateCallData(calldata, override);
    }
    async getPriceUpdates() {
        let price_updates = [];
        if (this.adapters.includes(ProtocolReader_1.AdaptorTypes.REDSTONE_CORE)) {
            const redstone = await Redstone_1.Redstone.buildMultiCallAction(this);
            price_updates.push(redstone);
        }
        return price_updates;
    }
}
exports.CToken = CToken;
//# sourceMappingURL=CToken.js.map