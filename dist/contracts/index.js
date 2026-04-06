"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.chains = void 0;
const monad_mainnet_json_1 = __importDefault(require("./monad-mainnet.json"));
const arb_sepolia_json_1 = __importDefault(require("./arb-sepolia.json"));
exports.chains = {
    "monad-mainnet": monad_mainnet_json_1.default,
    "arb-sepolia": arb_sepolia_json_1.default,
};
//# sourceMappingURL=index.js.map