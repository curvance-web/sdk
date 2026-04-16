import { address, curvance_read_provider } from "../types";
import { contractSetup } from "../helpers";
import { Contract } from "ethers";
import { setup_config } from "../setup";

export interface IOracleManager {
    getPrice(asset: address, inUSD: boolean, getLower: boolean): Promise<[bigint, bigint]>;
}

export class OracleManager {
    provider: curvance_read_provider;
    address: address;
    contract: Contract & IOracleManager;

    constructor(address: address, provider: curvance_read_provider = setup_config.readProvider) {
        this.provider = provider;
        this.address = address as address;
        this.contract = contractSetup<IOracleManager>(provider, this.address, [
            "function getPrice(address, bool, bool) view returns (uint256, uint256)",
        ]);
    }

    async getPrice(asset: address, inUSD: boolean, getLower: boolean) {
        const [price, errorCode] = await this.contract.getPrice(asset, inUSD, getLower) as [bigint, bigint];

        if(errorCode != 0n) {
            let addon_msg = "unknown";
            switch(errorCode) {
                case 1n:
                    addon_msg = "indicates that price should be taken with caution.";
                    break;
                case 2n:
                    addon_msg = "indicates a complete failure in receiving a price.";
                    break;
            }

            throw new Error(`Error getting price for asset ${asset}: code ${errorCode} - ${addon_msg}`);
        }

        return price;
    }
}
