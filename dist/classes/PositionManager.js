"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionManager = void 0;
const Calldata_1 = require("./Calldata");
const helpers_1 = require("../helpers");
const SimplePositionManager_json_1 = __importDefault(require("../abis/SimplePositionManager.json"));
const FormatConverter_1 = __importDefault(require("./FormatConverter"));
class PositionManager extends Calldata_1.Calldata {
    provider;
    contract;
    address;
    type;
    constructor(address, provider, type) {
        super();
        this.address = address;
        this.provider = provider;
        this.type = type;
        this.contract = (0, helpers_1.contractSetup)(provider, address, SimplePositionManager_json_1.default);
    }
    static emptySwapAction() {
        return {
            inputToken: helpers_1.EMPTY_ADDRESS,
            inputAmount: 0n,
            outputToken: helpers_1.EMPTY_ADDRESS,
            target: helpers_1.EMPTY_ADDRESS,
            slippage: 0n,
            call: "0x"
        };
    }
    static async getExpectedShares(deposit_ctoken, amount) {
        return deposit_ctoken.convertToShares(amount);
    }
    static async getVaultExpectedShares(deposit_ctoken, borrow_ctoken, borrow_amount) {
        const borrow_amount_as_bn = FormatConverter_1.default.decimalToBigInt(borrow_amount, borrow_ctoken.asset.decimals);
        const underlying_vault = deposit_ctoken.getUnderlyingVault();
        const vault_shares = await underlying_vault.previewDeposit(borrow_amount_as_bn);
        return deposit_ctoken.convertToShares(vault_shares);
    }
    getDeleverageCalldata(action, slippage) {
        return this.getCallData("deleverage", [action, slippage]);
    }
    getLeverageCalldata(action, slippage) {
        return this.getCallData("leverage", [action, slippage]);
    }
    getDepositAndLeverageCalldata(assets, action, slippage) {
        return this.getCallData("depositAndLeverage", [assets, action, slippage]);
    }
}
exports.PositionManager = PositionManager;
//# sourceMappingURL=PositionManager.js.map