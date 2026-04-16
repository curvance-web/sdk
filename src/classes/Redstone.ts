import { convertDataPackagesResponse, getResponseTimestamp, requestDataPackages } from "@redstone-finance/sdk";
import { address, bytes } from "../types";
import { contractSetup } from "../helpers";
import { solidityPacked, TransactionResponse } from "ethers";
import { MulticallAction } from "./CToken";
import abi from '../abis/RedstoneCoreAdaptor.json';
import { MarketToken } from "./Market";

export interface IRedstoneCoreAdaptor {
    writePrice(asset: address, inUSD: boolean, redstoneTimestamp: bigint): Promise<TransactionResponse>;
}

export class Redstone {
    static async getPayload(symbol: string, log: boolean = false) {
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

        const response = await requestDataPackages(payload_params);
        const [payload, timestamp] = await Promise.all([
            convertDataPackagesResponse(response),
            getResponseTimestamp(response)
        ]);

        if(log) {
            const json = await convertDataPackagesResponse(response, "json");
            console.log(json);
        }

        return {
            payload: `0x${payload}` as bytes,
            timestamp
        };

    }

    static async buildMultiCallAction(ctoken: MarketToken) {
        const adaptor = ctoken.market.setup.contracts.adaptors.RedstoneCoreAdaptor as address;
        const contract = contractSetup<IRedstoneCoreAdaptor>(ctoken.provider, adaptor, abi);
        const { payload, timestamp } = await Redstone.getPayload(ctoken.asset.symbol);
        
        const writePrice = contract.interface.encodeFunctionData("writePrice", [
            ctoken.asset.address,
            true,
            timestamp
        ]);
        const encodedWritePrice = solidityPacked(["bytes", "bytes"], [writePrice, payload]);

        return {
            target: adaptor,
            isPriceUpdate: true,
            data: encodedWritePrice
        } as MulticallAction;
    }
}
