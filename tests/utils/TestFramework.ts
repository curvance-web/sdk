import { ethers, JsonRpcProvider } from "ethers";
import { getTestSetup, NonceManagerSigner, setNativeBalance } from "./helper";
import { address, BorrowableCToken, ChainRpcPrefix, curvance_signer, ERC20, Market, setupChain } from "../../src";
import Decimal from "decimal.js";

const DEFUALT_API_URL = "https://api.curvance.com";
export class TestFramework {
    private_key: string;
    provider: JsonRpcProvider;
    signer: NonceManagerSigner
    chain: ChainRpcPrefix;
    curvance: Awaited<ReturnType<typeof setupChain>>;
    snapshot_id: number | undefined;
    init_snapshot_id: number | undefined;
    log: boolean = false;
    impersonated_storage: {original_curvance: Awaited<ReturnType<typeof setupChain>> | null} = {original_curvance: null};
    apiUrl: string = DEFUALT_API_URL;

    // Token storage slot configuration - maps chain to token addresses to balance mapping slots
    private static tokenStorageSlots: {[chain: string]: {[tokenAddress: string]: number}} = {
        'monad-mainnet': {
            "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c": 5, // WBTC - try slot 5
            "0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c": 3, // shMON
            "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A": 3, // WMON
            "0x336D414754967C6682B5A665C7DAF6F1409E63e8": 0, // muBOND
            "0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E": 7, // sAUSD
            "0x754704Bc059F8C67012fEd69BC8A327a5aafb603": 9, // USDC



        },
        'monad-testnet': {
            // Add testnet token slots here if needed
        },
        'local-monad-mainnet': {
            // Add local mainnet token slots here if needed
        }
    };

    private static seedByHolder: {[chain: string]: {[tokenAddress: string]: address}} = {
        'monad-mainnet': {
            "0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081": "0xd60F5cFAeEe229dcEa029323AD36CA76625D5F2C", // gMON
            "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a": "0xC6dc74D5CB5a711bc29Da0D3c9D3E6F320b540A6", // AUSD
            "0x9c82eB49B51F7Dc61e22Ff347931CA32aDc6cd90": "0x567713Ae76857Ecd5F5A1AC0D7EEfED6CebB4AD9", // loAZND
            "0x2416092f143378750bb29b79eD961ab195CcEea5": "0x12959F938A6ab2D0F10e992470b6e19807a95477", // ezETH
            "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242": "0x3d4567d5482527179207d838Af18feD493C46AE5", // wETH
            "0x0c65A0BC65a5D819235B71F554D210D3F80E0852": "0x5e777D229de19b47252E079Af2B0B4AedC959269", // aprMON
            "0xA3227C5969757783154C60bF0bC1944180ed81B9": "0x32BAe06Ec52B5f59BC3c5eC8C3d8C666c600b388", // sMON
            "0x103222f020e98Bba0AD9809A011FDF8e6F067496": "0x85402dCB299A003797705Ee6C4D8b3af62010120", // earnAUSD
        },
        'monad-testnet': {},
        'local-monad-mainnet': {}
    };

    constructor(private_key: string, provider: JsonRpcProvider, signer: NonceManagerSigner, chain: ChainRpcPrefix, curvance: Awaited<ReturnType<typeof setupChain>>, log: boolean = false, apiUrl: string = DEFUALT_API_URL) {
        this.private_key = private_key;
        this.provider = provider;
        this.signer = signer;
        this.chain = chain;
        this.curvance = curvance;
        this.log = log;
        this.apiUrl = apiUrl;

        this.snapshot().then((id) => {
            this.init_snapshot_id = id;
        });
    }

    static async init(private_key: string, chain: ChainRpcPrefix, {
        seedNativeBalance = true,
        seedUnderlying = true,
        snapshot = true,
        log = false,
        apiUrl = DEFUALT_API_URL,
    }: {
        seedNativeBalance?: boolean,
        seedUnderlying?: boolean,
        snapshot?: boolean,
        log?: boolean,
        apiUrl?: string,
    }) {
        const setup = await getTestSetup(private_key);
        const framework = new TestFramework(
            private_key,
            setup.provider,
            setup.signer,
            chain,
            await setupChain(chain, setup.signer, true, apiUrl),
            log,
            apiUrl
        );

        if(seedNativeBalance) await framework.seedNativeBalance();
        if(seedUnderlying) await framework.seedUnderlying();
        if(snapshot) await framework.snapshot();

        return framework;
    }

    get account(): address {
        return this.signer.address as address;
    }

    async destroy() {
        if(this.init_snapshot_id != null) {
            await this.provider.send("evm_revert", [this.init_snapshot_id]);
        }

        if(this.impersonated_storage.original_curvance != null) {
            await this.impersonateStop();
        }
    }

    async reset() {
        await this.revertToLastSnapshot();
        await this.snapshot();

        const setup = await getTestSetup(this.private_key);
        this.provider = setup.provider;
        this.signer = setup.signer;
        try {
            this.curvance = await setupChain(this.chain, this.signer, true, this.apiUrl);
        } catch(e: any) {
            console.error(`[reset] setupChain failed: ${e.message}`);
            throw e;
        }
    }

    async skipMarketCooldown(market: address, account?: address | undefined) {
        const ACCOUNT_ASSETS_SLOT = 2;
        const COOLDOWN_TIMESTAMP_OFFSET = 0;

        account = account || this.account;
        const getStorageSlot = () => {
            const mappingSlot = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['address', 'uint256'],
                    [account, ACCOUNT_ASSETS_SLOT]
                )
            );

            const cooldownTimestampSlot = BigInt(mappingSlot) + BigInt(COOLDOWN_TIMESTAMP_OFFSET);
            return ethers.toQuantity(cooldownTimestampSlot);
        }

        const slot = getStorageSlot();
        const value = "0x0000000000000000000000000000000000000000000000000000000000000000"; // 0 timestamp
        await this.provider.send("anvil_setStorageAt", [
            market,
            slot,
            value
        ]);
    }

    async impersonateStart(account: address) {
        this.impersonated_storage.original_curvance = Object.assign({}, this.curvance);
        await this.provider.send("anvil_impersonateAccount", [account]);

        const impersonatedSigner = await this.provider.getSigner(account);
        this.curvance = await setupChain(this.chain, impersonatedSigner, true, this.apiUrl);
    }

    async impersonateStop() {
        await this.provider.send("anvil_stopImpersonatingAccount", [this.account]);
        this.curvance = this.impersonated_storage.original_curvance!;
        this.impersonated_storage.original_curvance = null;
    }

    async seedUnderlying() {
        const processedAddresses = new Set<string>();

        for(const market of this.curvance.markets) {
            for(const token of market.tokens) {
                const tokenAddress = token.asset.address.toLowerCase();

                // Skip if we've already processed this token address
                if (processedAddresses.has(tokenAddress)) {
                    continue;
                }

                // Mark this address as processed
                processedAddresses.add(tokenAddress);

                if(TestFramework.seedByHolder[this.chain]?.hasOwnProperty(token.asset.address)) {
                    const holder = TestFramework.seedByHolder[this.chain]![token.asset.address];
                    // Impersonate the holder account to transfer tokens
                    await this.provider.send("anvil_impersonateAccount", [holder]);
                    const holderSigner = await this.provider.getSigner(holder);

                    const erc20 = new ERC20(
                        this.provider,
                        token.asset.address,
                        undefined,
                        undefined,
                        holderSigner as curvance_signer,
                    );
                    const holderBalance = await erc20.balanceOf(holderSigner.address as address);

                    // Transfer a large amount from the holder to our test account
                    const transferAmount = holderBalance / 10n;
                    try {
                        const tx = await erc20.rawTransfer(this.account, transferAmount);
                        await tx.wait();
                        if(this.log) {
                            const readableAmount = Decimal(transferAmount.toString()).div(Decimal(10).pow(token.getAsset(true).decimals || 18));
                            console.log(`✅ Transferred ${readableAmount} of ${token.getAsset(true).symbol} from holder ${holder} to test account ${this.account}`);
                        }
                    } catch (transferError) {
                        console.log(`❌ Failed to transfer ${token.getAsset(true).symbol} from holder ${holder} to test account ${this.account}. Error: ${transferError}`);
                    }

                    // Stop impersonating the holder account
                    await this.provider.send("anvil_stopImpersonatingAccount", [holder]);
                    continue; // Skip direct balance setting if we used a holder
                }

                // Get the storage slot from chain-specific config, default to 0
                const chainSlots = TestFramework.tokenStorageSlots[this.chain] || {};
                const storageSlot = chainSlots[token.asset.address] || 0;

                await this.setERC20Balance(token.asset.address, this.account, BigInt(100000000e18), storageSlot);

                // Verify the balance was set correctly
                const erc20 = new ERC20(
                    this.provider,
                    token.asset.address,
                    undefined,
                    undefined,
                    this.signer,
                );
                try {
                    const actualBalance = await erc20.balanceOf(this.account);
                    const expectedBalance = BigInt(100000000e18);

                    if (actualBalance < expectedBalance) {
                        console.log(`❌ Failed to set balance for ${token.getAsset(true).symbol} (${token.asset.address}). Expected: ${expectedBalance}, Actual: ${actualBalance}, Slot: ${storageSlot}`);
                    } else if(this.log) {
                        console.log(`✅ Set ${token.getAsset(true).symbol} balance to 100m-e18 using slot ${storageSlot} for account ${this.account}`);
                    }
                } catch (balanceError) {
                    console.log(`❌ Failed to verify balance for ${token.getAsset(true).symbol} (${token.asset.address}), Slot: ${storageSlot}. Error: ${balanceError}`);
                }
            }
        }
    }

    async setERC20Balance(tokenAddress: address, account: address, balance: bigint, balanceSlot: number = 0) {
        // Calculate the storage slot for the balance mapping
        // Most ERC20 tokens store balances in a mapping at slot 0, but some may use different slots
        const slot = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['address', 'uint256'],
                [account, balanceSlot]
            )
        );

        // Convert balance to 32-byte hex string (pad to 64 hex characters)
        const value = "0x" + balance.toString(16).padStart(64, '0');

        await this.provider.send("anvil_setStorageAt", [
            tokenAddress,
            slot,
            value
        ]);
    }

    async seedNativeBalance(amount: bigint = 100000000000000000000000000n) {
        await setNativeBalance(this.provider, this.account, amount);
    }

    async snapshot(): Promise<number> {
        this.snapshot_id = await this.provider.send("evm_snapshot", []) as number;
        return this.snapshot_id;
    }

    async revertToLastSnapshot() {
        if(this.snapshot_id == null) {
            throw new Error("No snapshot to revert to");
        }

        await this.provider.send("evm_revert", [this.snapshot_id]);
    }

    async getMarket(findMarketName: string): Promise<[Market, BorrowableCToken, BorrowableCToken]> {
        let market: Market | undefined;
        let tokenA: BorrowableCToken | undefined;
        let tokenB: BorrowableCToken | undefined;

        for(const curvance_market of this.curvance.markets) {
            if(curvance_market.name == findMarketName) {
                market = curvance_market;
                tokenA = curvance_market.tokens[0] as BorrowableCToken;
                tokenB = curvance_market.tokens[1] as BorrowableCToken;
                break;
            }
        }

        if(market == undefined || tokenA == undefined || tokenB == undefined) {
            throw new Error(`Market ${findMarketName} not found in curvance markets`);
        }

        return [ market, tokenA, tokenB ];
    }
}
