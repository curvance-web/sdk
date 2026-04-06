"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Redstone = void 0;
const sdk_1 = require("@redstone-finance/sdk");
const helpers_1 = require("../helpers");
const ethers_1 = require("ethers");
const RedstoneCoreAdaptor_json_1 = __importDefault(require("../abis/RedstoneCoreAdaptor.json"));
const setup_1 = require("../setup");
class Redstone {
    static async getPayload(symbol, log = false) {
        let payload_params = {
            dataServiceId: "redstone-primary-prod",
            dataPackagesIds: [symbol],
            uniqueSignersCount: 3,
            authorizedSigners: [
                "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
                "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
                "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
                "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE"
            ]
        };
        const response = await (0, sdk_1.requestDataPackages)(payload_params);
        const [payload, timestamp] = await Promise.all([
            (0, sdk_1.convertDataPackagesResponse)(response),
            (0, sdk_1.getResponseTimestamp)(response)
        ]);
        if (log) {
            const json = await (0, sdk_1.convertDataPackagesResponse)(response, "json");
            console.log(json);
        }
        return {
            payload: `0x${payload}`,
            timestamp
        };
    }
    static async buildMultiCallAction(ctoken) {
        const adaptor = setup_1.setup_config.contracts.adaptors.RedstoneCoreAdaptor;
        const contract = (0, helpers_1.contractSetup)(ctoken.provider, adaptor, RedstoneCoreAdaptor_json_1.default);
        const { payload, timestamp } = await Redstone.getPayload(ctoken.asset.symbol);
        const writePrice = contract.interface.encodeFunctionData("writePrice", [
            ctoken.asset.address,
            true,
            timestamp
        ]);
        const encodedWritePrice = (0, ethers_1.solidityPacked)(["bytes", "bytes"], [writePrice, payload]);
        return {
            target: adaptor,
            isPriceUpdate: true,
            data: encodedWritePrice
        };
    }
}
exports.Redstone = Redstone;
//# sourceMappingURL=Redstone.js.map