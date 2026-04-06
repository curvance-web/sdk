"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Zapper = exports.zapperTypeToName = void 0;
const helpers_1 = require("../helpers");
const Calldata_1 = require("./Calldata");
const SimpleZapper_json_1 = __importDefault(require("../abis/SimpleZapper.json"));
;
exports.zapperTypeToName = new Map([
    ['native-vault', 'nativeVaultZapper'],
    ['vault', 'vaultZapper'],
    ['simple', 'simpleZapper'],
    ['native-simple', 'simpleZapper'],
]);
class Zapper extends Calldata_1.Calldata {
    provider;
    contract;
    address;
    type;
    constructor(address, provider, type) {
        super();
        this.address = address;
        this.provider = provider;
        this.type = type;
        this.contract = (0, helpers_1.contractSetup)(provider, address, SimpleZapper_json_1.default);
    }
    async nativeZap(ctoken, amount, collateralize) {
        const calldata = await this.getNativeZapCalldata(ctoken, amount, collateralize);
        return this.executeCallData(calldata, { value: amount });
    }
    async simpleZap(ctoken, inputToken, outputToken, amount, collateralize, slippage) {
        const calldata = await this.getSimpleZapCalldata(ctoken, inputToken, outputToken, amount, collateralize, slippage);
        return this.executeCallData(calldata);
    }
    async getSimpleZapCalldata(ctoken, inputToken, outputToken, amount, collateralize, slippage) {
        const isNative = inputToken.toLowerCase() === helpers_1.NATIVE_ADDRESS.toLowerCase();
        const config = (0, helpers_1.getChainConfig)();
        // For native MON: if the deposit token IS wrapped native, just wrap (no swap needed)
        if (isNative && outputToken.toLowerCase() === config.wrapped_native.toLowerCase()) {
            return this.getNativeZapCalldata(ctoken, amount, collateralize, true);
        }
        // For native MON into non-WMON tokens: wrap first, then swap WMON → target
        // The contract handles wrapping when depositAsWrappedNative=true
        const swapInputToken = isNative ? config.wrapped_native : inputToken;
        const quote = await config.dexAgg.quote(this.address, swapInputToken, outputToken, amount, slippage);
        const swap = {
            inputToken: isNative ? helpers_1.NATIVE_ADDRESS : inputToken,
            inputAmount: amount,
            outputToken: outputToken,
            target: quote.to,
            slippage: slippage,
            call: quote.calldata
        };
        const expected_shares = await ctoken.convertToShares(BigInt(quote.min_out));
        return this.getCallData("swapAndDeposit", [
            ctoken.address,
            isNative,
            swap,
            expected_shares,
            collateralize,
            this.provider.address
        ]);
    }
    async getVaultZapCalldata(ctoken, amount, collateralize, wrapped = false) {
        const { underlying_address, expected_shares } = await this.getZapVaultData(ctoken, amount);
        const swap = {
            inputToken: underlying_address,
            inputAmount: amount,
            outputToken: underlying_address,
            target: helpers_1.EMPTY_ADDRESS,
            slippage: 0n,
            call: helpers_1.EMPTY_BYTES
        };
        return this.getCallData("swapAndDeposit", [
            ctoken.address,
            wrapped,
            swap,
            expected_shares,
            collateralize,
            this.provider.address
        ]);
    }
    async getZapVaultData(ctoken, amount) {
        const vault = await ctoken.getUnderlyingVault();
        const vault_underlying = await vault.fetchAsset(false);
        const expected_shares = await ctoken.convertToShares(await vault.previewDeposit(amount));
        return {
            underlying_address: vault_underlying,
            expected_shares: expected_shares
        };
    }
    async getNativeZapCalldata(ctoken, amount, collateralize, wrapped = false) {
        const vaultAssets = (ctoken.isVault || ctoken.isNativeVault)
            ? await ctoken.getUnderlyingVault().previewDeposit(amount)
            : amount;
        const expected_shares = await ctoken.convertToShares(vaultAssets);
        const config = (0, helpers_1.getChainConfig)();
        const swap = {
            inputToken: helpers_1.NATIVE_ADDRESS,
            inputAmount: amount,
            outputToken: wrapped ? config.wrapped_native : helpers_1.NATIVE_ADDRESS,
            target: helpers_1.EMPTY_ADDRESS,
            slippage: 0n,
            call: helpers_1.EMPTY_BYTES
        };
        return this.getCallData("swapAndDeposit", [
            ctoken.address,
            wrapped,
            swap,
            expected_shares,
            collateralize,
            this.provider.address
        ]);
    }
}
exports.Zapper = Zapper;
//# sourceMappingURL=Zapper.js.map