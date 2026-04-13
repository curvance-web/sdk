import fs from 'fs';
import { config } from 'dotenv'; config();

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
        fs.writeFileSync(`./src/contracts/${file}`, JSON.stringify(address_file, null, 2));
    }
});
console.log('Deployed contract addresses have been refreshed.');