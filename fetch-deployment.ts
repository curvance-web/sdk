import fs from 'fs';
import { config } from 'dotenv'; config();

const DYNAMIC_IRM_SUFFIX = "-DynamicIRM";
const MARKET_KEY_ORDER = ["address", "tokens", "irms", "plugins"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

const orderObjectKeys = (
    source: Record<string, unknown>,
    preferredKeys: readonly string[],
): Record<string, unknown> => {
    const ordered: Record<string, unknown> = {};

    for (const key of preferredKeys) {
        if (key in source) {
            ordered[key] = source[key];
        }
    }

    for (const [key, value] of Object.entries(source)) {
        if (!(key in ordered)) {
            ordered[key] = value;
        }
    }

    return ordered;
}

const orderIrmsByTokens = (
    market: Record<string, unknown>,
    irms: Record<string, unknown>,
): Record<string, unknown> => {
    if (!isRecord(market.tokens)) {
        return irms;
    }

    return orderObjectKeys(irms, Object.keys(market.tokens));
}

const normalizeMarketMetadata = (deployment: unknown) => {
    if (!isRecord(deployment) || !isRecord(deployment.markets)) {
        return;
    }

    for (const [marketName, market] of Object.entries(deployment.markets)) {
        if (!isRecord(market)) {
            continue;
        }

        const irms = isRecord(market.irms) ? { ...market.irms } : {};

        for (const [key, value] of Object.entries(market)) {
            if (!key.endsWith(DYNAMIC_IRM_SUFFIX)) {
                continue;
            }

            const tokenSymbol = key.slice(0, -DYNAMIC_IRM_SUFFIX.length);
            if (typeof value === "string" && typeof irms[tokenSymbol] !== "string") {
                irms[tokenSymbol] = value;
            }

            delete market[key];
        }

        if (Object.keys(irms).length > 0) {
            market.irms = orderIrmsByTokens(market, irms);
        }

        deployment.markets[marketName] = orderObjectKeys(market, MARKET_KEY_ORDER);
    }
}

const getAbi = (contract_name: string) => {
    const repo = process.env.CONTRACT_REPO_PATH as string;
    const path = `${repo}/artifacts`;
    const abiPath = `${path}/${contract_name}.sol/${contract_name}.json`;

    if (!fs.existsSync(abiPath)) {
        throw new Error(`ABI for contract ${contract_name} not found at ${abiPath}`);
    }

    return JSON.parse(fs.readFileSync(abiPath, 'utf-8')).abi;
}

const contracts_used = [
    "BaseCToken",
    "BorrowableCToken",
    "IDynamicIRM",
    "MarketManagerIsolated",
    "ProtocolReader",
    "RedstoneCoreAdaptor",
    "SimpleZapper",
    "SimplePositionManager",
    "OptimizerReader",
    "LendingOptimizer",
];

if(process.env.CONTRACT_REPO_PATH == undefined) {
    throw new Error("CONTRACT_REPO_PATH is not set in .env file. Please set it to the path of your contracts repository.");
}

for(const contractName of contracts_used) {
    const abi = getAbi(contractName);
    fs.writeFileSync(`./src/abis/${contractName}.json`, JSON.stringify(abi, null, 2));
}
console.log('Contract ABIs have been refreshed.');

if(process.env.DEPLOYMENT_REPO_PATH == undefined) {
    throw new Error("DEPLOYMENT_REPO_PATH is not set in .env file. Please set it to the path of your deployment repository.");
}

const deployed_path = `${process.env.DEPLOYMENT_REPO_PATH}/output`;
fs.readdirSync(deployed_path).forEach(file => {
    if(file.endsWith(".json")) {
        const address_file = JSON.parse(fs.readFileSync(`${deployed_path}/${file}`, "utf-8"));
        normalizeMarketMetadata(address_file);
        fs.writeFileSync(`./src/contracts/${file}`, JSON.stringify(address_file, null, 2));
    }
});
console.log('Deployed contract addresses have been refreshed.');
