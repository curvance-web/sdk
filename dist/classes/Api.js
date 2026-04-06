"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Api = void 0;
const setup_1 = require("../setup");
class Api {
    url;
    constructor() {
        this.url = setup_1.setup_config.api_url;
    }
    static async fetchNativeYields() {
        const { api_url } = setup_1.setup_config;
        let chain = setup_1.setup_config.chain;
        if (api_url == null) {
            console.error("You must have an API URL setup to fetch native yields.");
            return [];
        }
        if (chain == 'monad-mainnet') {
            chain = 'monad';
        }
        if (['monad'].includes(chain)) {
            try {
                const res = await fetch(`${api_url}/v1/${chain}/native_apy`);
                const yields = await res.json();
                // Add validation
                if (!yields || !yields.native_apy || !Array.isArray(yields.native_apy)) {
                    console.error("Invalid API response structure for native yields");
                    return [];
                }
                return yields.native_apy;
            }
            catch (error) {
                console.error("Error fetching native yields:", error);
                return [];
            }
        }
        else {
            return [];
        }
    }
    static async getRewards() {
        const { chain, api_url } = setup_1.setup_config;
        let milestones = {};
        let incentives = {};
        let rewards;
        try {
            rewards = await fetch(`${api_url}/v1/rewards/active/${chain}`).then(res => res.json());
        }
        catch (e) {
            console.error("Failed to fetch rewards data from API:", e);
            rewards = {
                milestones: [],
                incentives: []
            };
        }
        for (const milestone of rewards.milestones) {
            milestones[milestone.market] = milestone;
        }
        for (const incentive of rewards.incentives) {
            const market = incentive.market;
            if (!(market in incentives)) {
                incentives[market] = [];
            }
            incentives[market].push(incentive);
        }
        return { milestones, incentives };
    }
}
exports.Api = Api;
//# sourceMappingURL=Api.js.map