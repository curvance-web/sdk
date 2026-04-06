"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.all_markets = exports.setup_config = void 0;
exports.setupChain = setupChain;
const helpers_1 = require("./helpers");
const Market_1 = require("./classes/Market");
const ProtocolReader_1 = require("./classes/ProtocolReader");
const OracleManager_1 = require("./classes/OracleManager");
const retry_provider_1 = require("./retry-provider");
const chains_1 = require("./chains");
const Api_1 = require("./classes/Api");
exports.all_markets = [];
async function setupChain(chain, provider = null, approval_protection = false, api_url = "https://api.curvance.com") {
    if (!(chain in chains_1.chain_config)) {
        throw new Error("Chain does not have a corresponding config");
    }
    if (provider == null) {
        provider = chains_1.chain_config[chain].provider;
    }
    provider = (0, retry_provider_1.wrapProviderWithRetries)(provider);
    exports.setup_config = {
        chain,
        provider,
        approval_protection,
        contracts: (0, helpers_1.getContractAddresses)(chain),
        api_url,
    };
    if (!("ProtocolReader" in exports.setup_config.contracts)) {
        throw new Error(`Chain configuration for ${chain} is missing ProtocolReader address.`);
    }
    else if (!("OracleManager" in exports.setup_config.contracts)) {
        throw new Error(`Chain configuration for ${chain} is missing OracleManager address.`);
    }
    const { milestones, incentives } = await Api_1.Api.getRewards();
    const reader = new ProtocolReader_1.ProtocolReader(exports.setup_config.contracts.ProtocolReader);
    const oracle_manager = new OracleManager_1.OracleManager(exports.setup_config.contracts.OracleManager);
    exports.all_markets = await Market_1.Market.getAll(reader, oracle_manager, exports.setup_config.provider, milestones, incentives);
    return {
        markets: exports.all_markets,
        reader,
        dexAgg: chains_1.chain_config[chain].dexAgg,
        global_milestone: milestones['global'] ?? null
    };
}
//# sourceMappingURL=setup.js.map