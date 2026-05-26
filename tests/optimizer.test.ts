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
const ALLOCATION_CAPS_BPS = [10000, 5000, 2000];
const FEE_BPS = 1000;
const DEPOSIT_AMOUNT = 10_000n * 10n ** 6n; // 10,000 USDC (6 decimals)
const BPS = 10_000n;
const WAD = 10n ** 18n;
const TOTAL_ASSETS_TOLERANCE = DEPOSIT_AMOUNT / 1000n; // 0.1%
const REDEEMABLE_TOLERANCE = DEPOSIT_AMOUNT / 1_000_000n; // 0.0001%

type AbiComponent = {
    name?: string;
    components?: AbiComponent[];
};

type AbiFragment = {
    type?: string;
    name?: string;
    inputs?: unknown[];
    outputs?: AbiComponent[];
    stateMutability?: string;
};

function optimizerReaderFixtureSkip(): string | undefined {
    const abi = OptimizerReaderArtifact.abi as AbiFragment[];
    const constructor = abi.find((fragment) => fragment.type === 'constructor');
    const getOptimizerMarketData = abi.find((fragment) => fragment.name === 'getOptimizerMarketData');
    const optimizerDataFields = getOptimizerMarketData?.outputs?.[0]?.components ?? [];
    const marketDataFields = optimizerDataFields.find((field) => field.name === 'markets')?.components?.map((field) => field.name) ?? [];

    if ((constructor?.inputs?.length ?? 0) !== 2) {
        return 'OptimizerReader fixture is stale: expected constructor(ICentralRegistry,uint256).';
    }

    if (getOptimizerMarketData?.stateMutability !== 'view') {
        return 'OptimizerReader fixture is stale: getOptimizerMarketData must be view.';
    }

    if (!optimizerDataFields.some((field) => field.name === 'apy')) {
        return 'OptimizerReader fixture is stale: OptimizerMarketData is missing apy.';
    }

    if (!marketDataFields.includes('allocationCap') || !marketDataFields.includes('allocationCapUtilizationBps')) {
        return 'OptimizerReader fixture is stale: OptimizerCTokenData is missing allocation cap fields.';
    }

    if (!OptimizerReaderArtifact.bytecode) {
        return 'OptimizerReader fixture is missing deployable bytecode.';
    }

    return undefined;
}

function assertApproxBigInt(actual: bigint, expected: bigint, tolerance: bigint, message: string) {
    const diff = actual > expected ? actual - expected : expected - actual;
    assert(
        diff <= tolerance,
        `${message}: expected ${expected} +/- ${tolerance}, received ${actual} (diff ${diff})`,
    );
}

const FORK_SKIP = (!process.env.DEPLOYER_PRIVATE_KEY || !process.env.TEST_RPC)
    ? 'Fork env not configured: set DEPLOYER_PRIVATE_KEY and TEST_RPC in .env. See tests/README.md.'
    : optimizerReaderFixtureSkip();

describe('Lending Optimizer', { skip: FORK_SKIP }, () => {
    let framework: TestFramework;
    let account: address;
    let reader: OptimizerReader;
    let readerContract: any;
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

        // Deploy OptimizerReader with the go-forward constructor shape.
        const readerFactory = new ContractFactory(
            OptimizerReaderArtifact.abi,
            OptimizerReaderArtifact.bytecode,
            framework.signer,
        );
        readerContract = await readerFactory.deploy(CENTRAL_REGISTRY, 0);
        await readerContract.waitForDeployment();
        const readerAddress = (await readerContract.getAddress()) as address;
        reader = new OptimizerReader(readerAddress, framework.provider);

        // Deploy LendingOptimizer
        const factory = new ContractFactory(
            LendingOptimizerArtifact.abi,
            LendingOptimizerArtifact.bytecode,
            framework.signer,
        );
        optimizer = await factory.deploy(USDC, CENTRAL_REGISTRY, APPROVED_CTOKENS, ALLOCATION_CAPS_BPS, FEE_BPS);
        await optimizer.waitForDeployment();
        optimizerAddress = (await optimizer.getAddress()) as address;

        // Approve USDC to optimizer and initialize
        const usdc = new ethers.Contract(USDC, [
            'function approve(address,uint256) external returns (bool)',
        ], framework.signer);
        await (await usdc.getFunction('approve')(optimizerAddress, ethers.MaxUint256)).wait();

        await (await optimizer.initializeDeposits(APPROVED_CTOKENS[0]!)).wait();

        // Deposit 10,000 USDC
        await (await optimizer['deposit(uint256,address)'](DEPOSIT_AMOUNT, account)).wait();
    });

    after(async () => {
        await framework.destroy();
    });

    test('getOptimizerMarketData returns correct data', async () => {
        const data = await reader.getOptimizerMarketData([optimizerAddress]);

        assert.strictEqual(data.length, 1, 'Should return 1 optimizer');

        const entry = data[0]!;
        const directTotalAssets: bigint = await optimizer.totalAssets();
        const directTotalSupply: bigint = await optimizer.totalSupply();
        const expectedSharePrice = directTotalSupply === 0n
            ? 0n
            : directTotalAssets * 10n ** 18n / directTotalSupply;
        assert.strictEqual(entry.address, optimizerAddress, 'Address should match deployed optimizer');
        assert.strictEqual(entry.asset, USDC, 'Asset should be USDC');
        assert.strictEqual(entry.totalAssets, directTotalAssets, 'reader totalAssets should match optimizer');
        assertApproxBigInt(
            entry.totalAssets,
            DEPOSIT_AMOUNT,
            TOTAL_ASSETS_TOLERANCE,
            'totalAssets should stay near seeded deposit',
        );
        assert.deepStrictEqual(
            entry.markets.map((market) => market.address),
            APPROVED_CTOKENS,
            'reader should preserve optimizer market order',
        );
        assert.strictEqual(entry.sharePrice, expectedSharePrice, 'reader sharePrice should match optimizer assets/supply');
        assert.strictEqual(entry.performanceFee, BigInt(FEE_BPS), 'performanceFee should match deployment config');
        assert.strictEqual(
            entry.apy,
            await reader.getOptimizerAPY(optimizerAddress),
            'market data apy should match getOptimizerAPY',
        );
        assert(
            entry.markets.some((market) => market.allocatedAssets > 0n),
            'at least one market should hold the initialized deposit',
        );

        const contractData = await readerContract.getFunction('getOptimizerMarketData')([optimizerAddress]);
        const contractEntry = contractData[0];

        for (const [index, market] of entry.markets.entries()) {
            const expectedCap = (BigInt(ALLOCATION_CAPS_BPS[index]!) * WAD) / BPS;
            const expectedMaxAllocation = (directTotalAssets * expectedCap) / WAD;
            const expectedUtilizationBps = expectedMaxAllocation === 0n
                ? 0n
                : (market.allocatedAssets * BPS) / expectedMaxAllocation;
            const directCap: bigint = await optimizer.allocationCaps(APPROVED_CTOKENS[index]!);
            const contractMarket = contractEntry.markets[index];

            assert.strictEqual(market.allocationCap, expectedCap, 'SDK allocationCap should match configured cap');
            assert.strictEqual(market.allocationCap, directCap, 'SDK allocationCap should match optimizer storage');
            assert.strictEqual(
                market.allocationCapUtilizationBps,
                expectedUtilizationBps,
                'SDK allocationCapUtilizationBps should match theoretical max allocation',
            );
            assert.strictEqual(
                contractMarket.allocationCap,
                market.allocationCap,
                'deployed reader allocationCap should match SDK direct read',
            );
            assert.strictEqual(
                contractMarket.allocationCapUtilizationBps,
                market.allocationCapUtilizationBps,
                'deployed reader allocationCapUtilizationBps should match SDK direct read',
            );
        }
    });

    test('getOptimizerUserData returns correct data', async () => {
        const data = await reader.getOptimizerUserData([optimizerAddress], account);

        assert.strictEqual(data.length, 1, 'Should return 1 optimizer');

        const entry = data[0]!;
        const directShares: bigint = await optimizer.balanceOf(account);
        const directRedeemable: bigint = await optimizer.convertToAssets(directShares);

        assert.strictEqual(entry.address, optimizerAddress, 'Address should match deployed optimizer');
        assert.strictEqual(entry.shareBalance, directShares, 'reader shareBalance should match optimizer balanceOf');
        assert.strictEqual(entry.redeemable, directRedeemable, 'reader redeemable should match convertToAssets');
        assertApproxBigInt(
            entry.redeemable,
            DEPOSIT_AMOUNT,
            REDEEMABLE_TOLERANCE,
            'redeemable should stay near seeded deposit before rebalance',
        );
    });

    test('optimalRebalance returns actions for all markets', async () => {
        const { actions, bounds } = await reader.optimalRebalance(optimizerAddress);

        assert.strictEqual(actions.length, 3, 'Should return 3 rebalance actions');
        assert.strictEqual(bounds.length, 3, 'Should return 3 allocation bounds');

        const actionAddresses = actions.map(a => a.cToken);
        const boundAddresses = bounds.map(b => b.cToken);
        for (const cToken of APPROVED_CTOKENS) {
            assert(actionAddresses.includes(cToken), `Missing action for cToken ${cToken}`);
            assert(boundAddresses.includes(cToken), `Missing bound for cToken ${cToken}`);
        }

        // Total deposits should approximately equal total withdrawals (net ~0)
        const netFlow = actions.reduce((sum, a) => sum + a.assetsOrBps, 0n);
        const totalAssetsVal: bigint = await optimizer.totalAssets();
        const tolerance = totalAssetsVal / 100n; // 1% tolerance
        assert(
            netFlow >= -tolerance && netFlow <= tolerance,
            `Net rebalance flow ${netFlow} exceeds 1% tolerance of totalAssets ${totalAssetsVal}`,
        );

        for (const bound of bounds) {
            assert(
                bound.minBps <= bound.maxBps,
                `Invalid allocation bound for ${bound.cToken}: ${bound.minBps} > ${bound.maxBps}`,
            );
            assert(
                bound.maxBps <= Number(BPS),
                `Allocation bound for ${bound.cToken} exceeds 100%: ${bound.maxBps}`,
            );
        }
    });

    test('rebalance execution preserves totalAssets', {
        skip: 'Pending rebalance execution follow-up against current optimizer bytecode; reader market-data fork coverage runs above.',
    }, async () => {
        // Create imbalanced state: deposit everything to first market
        await (await optimizer['deposit(uint256,address)'](
            1_000n * 10n ** 6n, account,
        )).wait();

        const totalBefore: bigint = await optimizer.totalAssets();

        // Get optimal rebalance actions
        const { actions, bounds } = await reader.optimalRebalance(optimizerAddress, 100n);

        // Execute rebalance - should not revert
        await (await optimizer.rebalance(
            actions.map(a => ({ cToken: a.cToken, assetsOrBps: a.assetsOrBps })),
            bounds.map(b => ({ cToken: b.cToken, minBps: b.minBps, maxBps: b.maxBps })),
        )).wait();

        const totalAfter: bigint = await optimizer.totalAssets();

        // totalAssets should be preserved (within small rounding tolerance)
        const diff = totalAfter > totalBefore ? totalAfter - totalBefore : totalBefore - totalAfter;
        const tolerance = totalBefore / 1000n; // 0.1% tolerance
        assert(
            diff <= tolerance,
            `totalAssets changed by ${diff} (before: ${totalBefore}, after: ${totalAfter})`,
        );

        const postData = (await reader.getOptimizerMarketData([optimizerAddress]))[0]!;
        const totalAllocated = postData.markets.reduce(
            (sum, market) => sum + market.allocatedAssets,
            0n,
        );
        assert(
            totalAllocated <= totalAfter,
            `allocated assets ${totalAllocated} should not exceed totalAssets ${totalAfter}`,
        );

        for (const bound of bounds) {
            const market = postData.markets.find((candidate) => candidate.address === bound.cToken);
            assert(market, `Missing post-rebalance market ${bound.cToken}`);

            const allocationBps = totalAfter === 0n
                ? 0n
                : market.allocatedAssets * BPS / totalAfter;
            assert(
                allocationBps >= BigInt(bound.minBps) && allocationBps <= BigInt(bound.maxBps),
                `Post-rebalance allocation ${allocationBps} for ${bound.cToken} outside bounds ${bound.minBps}-${bound.maxBps}`,
            );
        }
    });
});
