"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeToken = void 0;
const decimal_js_1 = __importDefault(require("decimal.js"));
const helpers_1 = require("../helpers");
const setup_1 = require("../setup");
const OracleManager_1 = require("./OracleManager");
const chains_1 = require("../chains");
class NativeToken {
    name;
    symbol;
    provider;
    address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    decimals = 18n;
    constructor(chain, provider) {
        const config = chains_1.chain_config[chain];
        this.symbol = config.native_symbol;
        this.name = config.native_name || config.native_symbol;
        this.provider = provider;
    }
    async balanceOf(account = null, in_token_input = false) {
        if (account == null) {
            const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
            account = signer.address;
        }
        let balance = 0n;
        if ('provider' in this.provider && this.provider.provider) {
            balance = await this.provider.provider.getBalance(account);
        }
        else if ('getBalance' in this.provider) {
            balance = await this.provider.getBalance(account);
        }
        else {
            throw new Error("Provider does not support balance queries");
        }
        return in_token_input ? (0, decimal_js_1.default)(balance).div(helpers_1.WAD) : balance;
    }
    async getPrice(inTokenInput, inUSD = true, getLower = false) {
        const oracle_manager = new OracleManager_1.OracleManager(setup_1.setup_config.contracts.OracleManager, this.provider);
        const price = await oracle_manager.getPrice(this.address, inUSD, getLower);
        return inTokenInput ? (0, decimal_js_1.default)(price).div(helpers_1.WAD) : price;
    }
}
exports.NativeToken = NativeToken;
//# sourceMappingURL=NativeToken.js.map