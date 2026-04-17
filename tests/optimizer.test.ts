import { config } from 'dotenv';
config({ quiet: true });
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { ethers, ContractFactory } from 'ethers';
import { address, OptimizerReader } from '../src';
import { TestFramework } from './utils/TestFramework';
import { setNativeBalance } from './utils/helper';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LendingOptimizerArtifact = require('./utils/LendingOptimizer.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OptimizerReaderArtifact = require('./utils/OptimizerReader.json');

const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as address;
const CENTRAL_REGISTRY = '0x1310f352f1389969Ece6741671c4B919523912fF' as address;
const DAO_TIMELOCK = '0x2677738657F27e1A3591E00AD7E5a78807688C08' as address;

const APPROVED_CTOKENS: address[] = [
    '0x8EE9FC28B8Da872c38A496e9dDB9700bb7261774', // WMON|USDC
    '0x7C9d4f1695C6282Da5e5509Aa51fC9fb417C6f1d', // WBTC|USDC
    '0x21aDBb60a5fB909e7F1fB48aACC4569615CD97b5', // WETH|USDC
];
const ALLOCATION_CAPS_BPS = [6000, 5000, 2000];
const FEE_BPS = 1000;
const DEPOSIT_AMOUNT = 10_000n * 10n ** 6n; // 10,000 USDC (6 decimals)

const FORK_SKIP = (!process.env.DEPLOYER_PRIVATE_KEY || !process.env.TEST_RPC)
    ? 'Fork env not configured: set DEPLOYER_PRIVATE_KEY and TEST_RPC in .env. See tests/README.md.'
    : undefined;

describe('Lending Optimizer', { skip: FORK_SKIP }, () => {
    let framework: TestFramework;
    let account: address;
    let reader: OptimizerReader;
    let optimizer: any;
    let optimizerAddress: address;

    before(async () => {
        framework = await TestFramework.init(process.env.DEPLOYER_PRIVATE_KEY as string, 'monad-mainnet', {
            seedNativeBalance: true,
            seedUnderlying: true,
            snapshot: true,
            log: true,
        });
        account = framework.account;

        // Impersonate DAOTimelock to grant permissions
        await setNativeBalance(framework.provider, DAO_TIMELOCK, 100000000000000000000n);
        await framework.provider.send('anvil_impersonateAccount', [DAO_TIMELOCK]);
        const timelockSigner = await framework.provider.getSigner(DAO_TIMELOCK);

        const centralRegistry = new ethers.Contract(CENTRAL_REGISTRY, [
            'function addMarketPermissions(address) external',
            'function addHarvestPermissions(address) external',
        ], timelockSigner);

        await (await centralRegistry.getFunction('addMarketPermissions')(account)).wait();
        await (await centralRegistry.getFunction('addHarvestPermissions')(account)).wait();
        await framework.provider.send('anvil_stopImpersonatingAccount', [DAO_TIMELOCK]);

        // Deploy OptimizerReader (stateless, no constructor args)
        const readerFactory = new ContractFactory(
            OptimizerReaderArtifact.abi,
            OptimizerReaderArtifact.bytecode,
            framework.signer,
        );
        const readerContract = await readerFactory.deploy();
        await readerContract.waitForDeployment();
        const readerAddress = (await readerContract.getAddress()) as address;
        reader = new OptimizerReader(readerAddress, framework.provider);
        console.log(`OptimizerReader deployed at: ${readerAddress}`);

        // Deploy LendingOptimizer
        const factory = new ContractFactory(
            LendingOptimizerArtifact.abi,
            LendingOptimizerArtifact.bytecode,
            framework.signer,
        );
        optimizer = await factory.deploy(USDC, CENTRAL_REGISTRY, APPROVED_CTOKENS, ALLOCATION_CAPS_BPS, FEE_BPS);
        await optimizer.waitForDeployment();
        optimizerAddress = (await optimizer.getAddress()) as address;
        console.log(`LendingOptimizer deployed at: ${optimizerAddress}`);

        // Approve USDC to optimizer and initialize
        const usdc = new ethers.Contract(USDC, [
            'function approve(address,uint256) external returns (bool)',
        ], framework.signer);
        await (await usdc.getFunction('approve')(optimizerAddress, ethers.MaxUint256)).wait();

        await (await optimizer.initializeDeposits(0)).wait();

        // Deposit 10,000 USDC
        await (await optimizer['deposit(uint256,address)'](DEPOSIT_AMOUNT, account)).wait();
        console.log(`Deposited ${DEPOSIT_AMOUNT} USDC into optimizer`);
    });

    after(async () => {
        await framework.destroy();
    });

    test('getOptimizerMarketData returns correct data', async () => {
        const data = await reader.getOptimizerMarketData([optimizerAddress]);

        assert.strictEqual(data.length, 1, 'Should return 1 optimizer');

        const entry = data[0]!;
        assert.strictEqual(entry.address, optimizerAddress, 'Address should match deployed optimizer');
        assert.strictEqual(entry.asset, USDC, 'Asset should be USDC');
        assert(entry.totalAssets > 0n, 'totalAssets should be > 0');
        assert.strictEqual(entry.markets.length, 3, 'Should have 3 markets');
        assert(entry.sharePrice > 0n, 'sharePrice should be > 0');
        assert(entry.performanceFee > 0n, 'performanceFee should be > 0');
    });

    test('getOptimizerUserData returns correct data', async () => {
        const data = await reader.getOptimizerUserData([optimizerAddress], account);

        assert.strictEqual(data.length, 1, 'Should return 1 optimizer');

        const entry = data[0]!;
        assert(entry.shareBalance > 0n, 'shareBalance should be > 0 after deposit');
        assert(entry.redeemable > 0n, 'redeemable should be > 0 after deposit');
    });

    test('optimalDeposit returns a valid cToken', async () => {
        const target = await reader.optimalDeposit(optimizerAddress, 1_000n * 10n ** 6n);

        assert(
            APPROVED_CTOKENS.includes(target),
            `optimalDeposit returned ${target}, expected one of ${APPROVED_CTOKENS}`,
        );
    });

    test('optimalWithdrawal returns a valid cToken', async () => {
        const target = await reader.optimalWithdrawal(optimizerAddress, 1_000n * 10n ** 6n);

        assert(
            APPROVED_CTOKENS.includes(target),
            `optimalWithdrawal returned ${target}, expected one of ${APPROVED_CTOKENS}`,
        );
    });

    test('optimalRebalance returns actions for all markets', async () => {
        const actions = await reader.optimalRebalance(optimizerAddress);

        assert.strictEqual(actions.length, 3, 'Should return 3 rebalance actions');

        const actionAddresses = actions.map(a => a.cToken);
        for (const cToken of APPROVED_CTOKENS) {
            assert(actionAddresses.includes(cToken), `Missing action for cToken ${cToken}`);
        }

        // Total deposits should approximately equal total withdrawals (net ~0)
        const netFlow = actions.reduce((sum, a) => sum + a.assets, 0n);
        const totalAssetsVal: bigint = await optimizer.totalAssets();
        const tolerance = totalAssetsVal / 100n; // 1% tolerance
        assert(
            netFlow >= -tolerance && netFlow <= tolerance,
            `Net rebalance flow ${netFlow} exceeds 1% tolerance of totalAssets ${totalAssetsVal}`,
        );
    });

    test('rebalance execution preserves totalAssets', async () => {
        // Create imbalanced state: deposit everything to first market
        await (await optimizer['deposit(uint256,address,address)'](
            1_000n * 10n ** 6n, account, APPROVED_CTOKENS[0],
        )).wait();

        const totalBefore: bigint = await optimizer.totalAssets();

        // Get optimal rebalance actions
        const actions = await reader.optimalRebalance(optimizerAddress);

        // Execute rebalance - should not revert
        await (await optimizer.rebalance(
            actions.map(a => ({ cToken: a.cToken, assets: a.assets })),
        )).wait();

        const totalAfter: bigint = await optimizer.totalAssets();

        // totalAssets should be preserved (within small rounding tolerance)
        const diff = totalAfter > totalBefore ? totalAfter - totalBefore : totalBefore - totalAfter;
        const tolerance = totalBefore / 1000n; // 0.1% tolerance
        assert(
            diff <= tolerance,
            `totalAssets changed by ${diff} (before: ${totalBefore}, after: ${totalAfter})`,
        );
    });
});
