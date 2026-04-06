export declare const chains: {
    "monad-mainnet": {
        CentralRegistry: string;
        OracleManager: string;
        adaptors: {
            ChainlinkAdaptor: string;
            RedstoneClassicAdaptor: string;
            RedstoneCoreAdaptor: string;
        };
        calldataCheckers: {
            RedstoneAdaptorMulticallChecker: string;
            KyberSwapChecker: string;
        };
        zappers: {
            nativeVaultZapper: string;
            vaultZapper: string;
            simpleZapper: string;
        };
        "VaultAggregator-AUSD-sAUSD": string;
        "StaticPriceAggregator-loAZND": string;
        markets: {
            "MUBOND | AUSD": {
                address: string;
                "muBOND-DynamicIRM": string;
                tokens: {
                    muBOND: string;
                    AUSD: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "AUSD-DynamicIRM": string;
            };
            "loAZND | AUSD": {
                address: string;
                "loAZND-DynamicIRM": string;
                tokens: {
                    loAZND: string;
                    AUSD: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "AUSD-DynamicIRM": string;
            };
            "ezETH | WETH": {
                address: string;
                "ezETH-DynamicIRM": string;
                tokens: {
                    ezETH: string;
                    WETH: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "WETH-DynamicIRM": string;
            };
            "shMON | WMON": {
                address: string;
                "shMON-DynamicIRM": string;
                tokens: {
                    shMON: string;
                    WMON: string;
                };
                plugins: {
                    nativeVaultPositionManager: string;
                    simplePositionManager: string;
                };
                "WMON-DynamicIRM": string;
            };
            "aprMON | WMON": {
                address: string;
                "aprMON-DynamicIRM": string;
                tokens: {
                    aprMON: string;
                    WMON: string;
                };
                plugins: {
                    nativeVaultPositionManager: string;
                    simplePositionManager: string;
                };
                "WMON-DynamicIRM": string;
            };
            "sMON | WMON": {
                address: string;
                "sMON-DynamicIRM": string;
                tokens: {
                    sMON: string;
                    WMON: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "WMON-DynamicIRM": string;
            };
            "sAUSD | AUSD": {
                address: string;
                "sAUSD-DynamicIRM": string;
                tokens: {
                    sAUSD: string;
                    AUSD: string;
                };
                plugins: {
                    simplePositionManager: string;
                    vaultPositionManager: string;
                };
                "AUSD-DynamicIRM": string;
            };
            "earnAUSD | AUSD": {
                address: string;
                "earnAUSD-DynamicIRM": string;
                tokens: {
                    earnAUSD: string;
                    AUSD: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "AUSD-DynamicIRM": string;
            };
            "WMON | AUSD": {
                address: string;
                "WMON-DynamicIRM": string;
                tokens: {
                    WMON: string;
                    AUSD: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "AUSD-DynamicIRM": string;
            };
            "WMON | USDC": {
                address: string;
                "WMON-DynamicIRM": string;
                tokens: {
                    WMON: string;
                    USDC: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "USDC-DynamicIRM": string;
            };
            "WBTC | USDC": {
                address: string;
                "WBTC-DynamicIRM": string;
                tokens: {
                    WBTC: string;
                    USDC: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "USDC-DynamicIRM": string;
            };
            "WETH | USDC": {
                address: string;
                "WETH-DynamicIRM": string;
                tokens: {
                    WETH: string;
                    USDC: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "USDC-DynamicIRM": string;
            };
            "gMON | WMON": {
                address: string;
                "gMON-DynamicIRM": string;
                tokens: {
                    gMON: string;
                    WMON: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "WMON-DynamicIRM": string;
            };
            "syzUSD | AUSD": {
                address: string;
                "syzUSD-DynamicIRM": string;
                tokens: {
                    syzUSD: string;
                    AUSD: string;
                };
                plugins: {};
                "AUSD-DynamicIRM": string;
            };
            "wsrUSD | AUSD": {
                address: string;
                tokens: {
                    wsrUSD: string;
                    AUSD: string;
                };
                plugins: {
                    simplePositionManager: string;
                };
                "AUSD-DynamicIRM": string;
                "wsrUSD-DynamicIRM": string;
            };
            "YZM | AUSD": {
                address: string;
                plugins: {
                    simplePositionManager: string;
                };
                "YZM-DynamicIRM": string;
                tokens: {
                    YZM: string;
                    AUSD: string;
                };
                "AUSD-DynamicIRM": string;
            };
            "vUSD | AUSD": {
                address: string;
                plugins: {
                    simplePositionManager: string;
                };
                "vUSD-DynamicIRM": string;
                tokens: {
                    vUSD: string;
                    AUSD: string;
                };
                "AUSD-DynamicIRM": string;
            };
            "eBTC | WBTC": {
                address: string;
                plugins: {
                    simplePositionManager: string;
                };
                "eBTC-DynamicIRM": string;
                tokens: {
                    eBTC: string;
                    WBTC: string;
                };
                "WBTC-DynamicIRM": string;
            };
        };
        ProtocolReader: string;
        "CombinedAggregator-ezETH": string;
        "CombinedAggregator-earnAUSD": string;
        DAOTimelock: string;
        "VaultAggregator-USDC-YZM": string;
        "VaultAggregator-AUSD-vUSD": string;
    };
    "arb-sepolia": {
        CentralRegistry: string;
        OracleManager: string;
        adaptors: {
            ChainlinkAdaptor: string;
            RedstoneClassicAdaptor: string;
            RedstoneCoreAdaptor: string;
        };
        calldataCheckers: {
            RedstoneAdaptorMulticallChecker: string;
        };
        zappers: {
            nativeVaultZapper: string;
            vaultZapper: string;
            simpleZapper: string;
        };
        MockOracle: string;
        USDC: string;
        AUSD: string;
        BTC: string;
        ETH: string;
        Faucet: string;
        markets: {
            "Stable Market": {
                address: string;
                "USDC-DynamicIRM": string;
                tokens: {
                    USDC: string;
                    AUSD: string;
                };
                "AUSD-DynamicIRM": string;
            };
            "Volatile Market": {
                address: string;
                "BTC-DynamicIRM": string;
                tokens: {
                    BTC: string;
                    ETH: string;
                };
                "ETH-DynamicIRM": string;
            };
        };
        ProtocolReader: string;
    };
};
//# sourceMappingURL=index.d.ts.map