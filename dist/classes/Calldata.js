"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Calldata = void 0;
const helpers_1 = require("../helpers");
class Calldata {
    getCallData(functionName, exec_params) {
        return this.contract.interface.encodeFunctionData(functionName, exec_params);
    }
    async executeCallData(calldata, overrides = {}) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        return signer.sendTransaction({
            to: this.address,
            data: calldata,
            ...overrides
        });
    }
    async simulateCallData(calldata, overrides = {}) {
        const signer = (0, helpers_1.validateProviderAsSigner)(this.provider);
        try {
            await signer.call({
                to: this.address,
                data: calldata,
                from: signer.address,
                ...overrides
            });
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error?.reason || error?.message || String(error) };
        }
    }
}
exports.Calldata = Calldata;
//# sourceMappingURL=Calldata.js.map