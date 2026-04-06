"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERC20 = void 0;
const helpers_1 = require("../helpers");
const setup_1 = require("../setup");
const OracleManager_1 = require("./OracleManager");
const decimal_js_1 = __importDefault(require("decimal.js"));
const FormatConverter_1 = __importDefault(require("./FormatConverter"));
class ERC20 {
    provider;
    address;
    contract;
    cache = undefined;
    constructor(provider, address, cache = undefined) {
        this.provider = provider;
        this.address = address;
        this.cache = cache;
        this.contract = (0, helpers_1.contractSetup)(provider, address, [
            "function balanceOf(address owner) view returns (uint256)",
            "function transfer(address to, uint256 amount) returns (bool)",
            "function approve(address spender, uint256 amount) returns (bool)",
            "function name() view returns (string)",
            "function symbol() view returns (string)",
            "function decimals() view returns (uint8)",
            "function allowance(address owner, address spender) view returns (uint256)",
        ]);
    }
    get name() { return this.cache?.name; }
    get symbol() { return this.cache?.symbol; }
    get decimals() { return this.cache?.decimals; }
    get totalSupply() { return this.cache?.totalSupply; }
    get image() { return this.cache?.image; }
    get balance() { return this.cache?.balance ? (0, helpers_1.toDecimal)(this.cache.balance, this.cache.decimals) : undefined; }
    get price() { return this.cache?.price; }
    async balanceOf(account, in_token_input = false) {
        const amount = await this.contract.balanceOf(account);
        const decimals = this.decimals ?? await this.contract.decimals();
        return in_token_input ? FormatConverter_1.default.bigIntToDecimal(amount, decimals) : amount;
    }
    async transfer(to, amount) {
        const decimals = this.decimals ?? await this.contract.decimals();
        const tokens = (0, helpers_1.toBigInt)(amount, decimals);
        return this.contract.transfer(to, tokens);
    }
    async rawTransfer(to, amount) {
        return this.contract.transfer(to, amount);
    }
    async approve(spender, amount) {
        const decimals = this.decimals ?? await this.fetchDecimals();
        const tokens = amount == null ? helpers_1.UINT256_MAX : (0, helpers_1.toBigInt)(amount, decimals);
        return this.contract.approve(spender, tokens);
    }
    async fetchName() {
        const name = await this.contract.name();
        this.setCache('name', name);
        return name;
    }
    async fetchSymbol() {
        const symbol = await this.contract.symbol();
        this.setCache('symbol', symbol);
        return symbol;
    }
    async fetchDecimals() {
        const decimals = await this.contract.decimals();
        this.setCache('decimals', decimals);
        return decimals;
    }
    async fetchTotalSupply() {
        const totalSupply = await this.contract.totalSupply();
        this.setCache('totalSupply', totalSupply);
        return totalSupply;
    }
    async allowance(owner, spender) {
        return this.contract.allowance(owner, spender);
    }
    async getPrice(inTokenInput, inUSD = true, getLower = false) {
        const oracle_manager = new OracleManager_1.OracleManager(setup_1.setup_config.contracts.OracleManager, this.provider);
        const price = await oracle_manager.getPrice(this.address, inUSD, getLower);
        return inTokenInput ? (0, decimal_js_1.default)(price).div(helpers_1.WAD) : price;
    }
    setCache(key, value) {
        if (!this.cache) {
            this.cache = {};
        }
        this.cache[key] = value;
    }
}
exports.ERC20 = ERC20;
//# sourceMappingURL=ERC20.js.map