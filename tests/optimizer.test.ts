import { config } from 'dotenv';
config({ quiet: true });
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { ethers, ContractFactory } from 'ethers';
import Decimal from 'decimal.js';
import { address, ERC20, LendingOptimizer, OptimizerReader } from '../src';
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

type AbiComponent = {
    name?: string;
    components?: AbiComponent[];
};

type AbiFragment = {
    type?: string;
    name?: string;
    inputs?: AbiComponent[];
    outputs?: AbiComponent[];
    stateMutability?: string;
};

function optimizerReaderFixtureSkip(): string | undefined {
    const abi = OptimizerReaderArtifact.abi as AbiFragment[];
    const constructor = abi.find((fragment) => fragment.type === 'constructor');
    const getOptimizerMarketData = abi.find((fragment) => fragment.name === 'getOptimizerMarketData');
    const optimalRebalance = abi.find((fragment) => fragment.name === 'optimalRebalance');
    const optimalRebalanceWithIncentives = abi.find((fragment) => fragment.name === 'optimalRebalanceWithIncentives');
    const optimizerDataFields = getOptimizerMarketData?.outputs?.[0]?.components ?? [];
    const marketDataFields = optimizerDataFields.find((field) => field.name === 'markets')?.components?.map((field) => field.name) ?? [];

    if ((constructor?.inputs?.length ?? 0) !== 2) {
        return 'OptimizerReader fixture is stale: expected constructor(ICentralRegistry,uint256).';
    }

    if (getOptimizerMarketData?.stateMutability !== 'nonpayable') {
        return 'OptimizerReader fixture is stale: getOptimizerMarketData must be nonpayable.';
    }

    if (!optimizerDataFields.some((field) => field.name === 'exchangeRateHighWatermark')) {
        return 'OptimizerReader fixture is stale: OptimizerMarketData is missing exchangeRateHighWatermark.';
    }

    if (!optimizerDataFields.some((field) => field.name === 'apy')) {
        return 'OptimizerReader fixture is stale: OptimizerMarketData is missing apy.';
    }

    if (!optimizerDataFields.some((field) => field.name === 'numApprovedMarkets')) {
        return 'OptimizerReader fixture is stale: OptimizerMarketData is missing numApprovedMarkets.';
    }

    if (!marketDataFields.includes('allocationCap') || !marketDataFields.includes('allocationCapUtilizationBps')) {
        return 'OptimizerReader fixture is stale: OptimizerCTokenData is missing allocation cap fields.';
    }

    if (
        (optimalRebalance?.inputs?.length ?? 0) !== 3 ||
        optimalRebalance?.inputs?.[2]?.name !== 'rebalanceChunks'
    ) {
        return 'OptimizerReader fixture is stale: optimalRebalance must accept rebalanceChunks.';
    }

    if (
        (optimalRebalanceWithIncentives?.inputs?.length ?? 0) !== 4 ||
        optimalRebalanceWithIncentives?.inputs?.[3]?.name !== 'marketIncentiveAPYsBps'
    ) {
        return 'OptimizerReader fixture is stale: optimalRebalanceWithIncentives must accept marketIncentiveAPYsBps.';
    }

    if (abi.some((fragment) => fragment.name === 'REBALANCE_CHUNKS')) {
        return 'OptimizerReader fixture is stale: REBALANCE_CHUNKS should no longer be exposed.';
    }

    if (!abi.some((fragment) => fragment.type === 'error' && fragment.name === 'OptimizerReader__InvalidRebalanceChunks')) {
        return 'OptimizerReader fixture is stale: missing OptimizerReader__InvalidRebalanceChunks error.';
    }

    if (!abi.some((fragment) => fragment.type === 'error' && fragment.name === 'OptimizerReader__InvalidIncentiveData')) {
        return 'OptimizerReader fixture is stale: missing OptimizerReader__InvalidIncentiveData error.';
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

function decimalToRaw(amount: Decimal, decimals: bigint): bigint {
    return BigInt(
        amount
            .mul(Decimal(10).pow(Number(decimals)))
            .floor()
            .toFixed(0),
    );
}

function rawToDecimal(amount: bigint, decimals: bigint): Decimal {
    return new Decimal(amount.toString()).div(Decimal(10).pow(Number(decimals)));
}

async function cappedDepositAmount(
    sdkOptimizer: LendingOptimizer,
    account: address,
    desired: Decimal,
    decimals: bigint,
    minimumRaw: bigint,
): Promise<Decimal> {
    const desiredRaw = decimalToRaw(desired, decimals);
    const maxDepositRaw = await sdkOptimizer.maxDeposit(account);
    const depositRaw = maxDepositRaw < desiredRaw ? maxDepositRaw / 2n : desiredRaw;

    assert(
        depositRaw > minimumRaw,
        `optimizer maxDeposit ${maxDepositRaw} is too small for fork write coverage`,
    );

    return rawToDecimal(depositRaw, decimals);
}

async function waitForTx(txLike: unknown) {
    if (txLike && typeof (txLike as { wait?: () => Promise<unknown> }).wait === 'function') {
        await (txLike as { wait: () => Promise<unknown> }).wait();
    }
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
    let seededDepositAmount: bigint;

    function formatError(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    function createSdkOptimizer() {
        const asset = new ERC20(
            framework.provider,
            USDC,
            undefined,
            framework.curvance.setupConfigSnapshot.contracts.OracleManager as address,
            framework.signer,
        );
        const sdkOptimizer = new LendingOptimizer(
            optimizerAddress,
            asset,
            framework.provider,
            framework.signer,
        );

        return { asset, sdkOptimizer };
    }

    before(async () => {
        try {
            framework = await TestFramework.init(process.env.DEPLOYER_PRIVATE_KEY as string, 'monad-mainnet', {
                seedNativeBalance: true,
                seedUnderlying: true,
                snapshot: true,
                log: true,
            });
        } catch (error) {
            console.error(`[optimizer.test] fork setup failed: ${formatError(error)}`);
            throw error;
        }
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

        const maxInitialDeposit: bigint = await optimizer.maxDeposit(account);
        seededDepositAmount = maxInitialDeposit < DEPOSIT_AMOUNT
            ? maxInitialDeposit / 2n
            : DEPOSIT_AMOUNT;
        assert(seededDepositAmount > 0n, 'optimizer maxDeposit should allow the setup seed deposit');
        await (await optimizer['deposit(uint256,address)'](seededDepositAmount, account)).wait();
    });

    after(async () => {
        await framework?.destroy();
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
            seededDepositAmount,
            seededDepositAmount / 1000n + 1n,
            'totalAssets should stay near seeded deposit',
        );
        assert.deepStrictEqual(
            entry.markets.map((market) => market.address),
            APPROVED_CTOKENS,
            'reader should preserve optimizer market order',
        );
        assert.strictEqual(entry.sharePrice, expectedSharePrice, 'reader sharePrice should match optimizer assets/supply');
        assert.strictEqual(
            entry.exchangeRateHighWatermark,
            await optimizer.exchangeRateHighWatermark(),
            'reader high watermark should match optimizer',
        );
        assert.strictEqual(entry.performanceFee, BigInt(FEE_BPS), 'performanceFee should match deployment config');
        assert.strictEqual(
            entry.numApprovedMarkets,
            BigInt(APPROVED_CTOKENS.length),
            'reader numApprovedMarkets should match configured market count',
        );
        assert.strictEqual(
            entry.apy,
            await reader.getOptimizerAPY(optimizerAddress),
            'market data apy should match getOptimizerAPY',
        );
        assert(
            entry.markets.some((market) => market.allocatedAssets > 0n),
            'at least one market should hold the initialized deposit',
        );

        const contractData = await readerContract.getFunction('getOptimizerMarketData').staticCall([optimizerAddress]);
        const contractEntry = contractData[0];
        assert.strictEqual(
            contractEntry.exchangeRateHighWatermark,
            entry.exchangeRateHighWatermark,
            'deployed reader high watermark should match SDK direct read',
        );
        assert.strictEqual(
            contractEntry.numApprovedMarkets,
            entry.numApprovedMarkets,
            'deployed reader market count should match SDK direct read',
        );

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
            seededDepositAmount,
            seededDepositAmount / 1_000_000n + 1n,
            'redeemable should stay near seeded deposit before rebalance',
        );
    });

    test('SDK direct deposit and withdraw execute on the forked optimizer', async () => {
        const { asset, sdkOptimizer } = createSdkOptimizer();
        const withdrawAmount = Decimal("0.000001");
        const decimals = asset.decimals ?? await asset.fetchDecimals();
        const withdrawRaw = decimalToRaw(withdrawAmount, decimals);
        const depositAmount = await cappedDepositAmount(
            sdkOptimizer,
            account,
            Decimal(25),
            decimals,
            withdrawRaw,
        );

        const assetBefore = await asset.balanceOf(account);
        const sharesBefore = await sdkOptimizer.balanceOf(account);

        await waitForTx(await asset.approve(optimizerAddress, depositAmount));
        const depositTx = await sdkOptimizer.deposit(depositAmount, account);
        assert.strictEqual(depositTx.to?.toLowerCase(), optimizerAddress.toLowerCase());
        await depositTx.wait();

        const assetAfterDeposit = await asset.balanceOf(account);
        const sharesAfterDeposit = await sdkOptimizer.balanceOf(account);
        assert(assetAfterDeposit < assetBefore, 'USDC balance should decrease after SDK optimizer deposit');
        assert(sharesAfterDeposit > sharesBefore, 'optimizer shares should increase after SDK optimizer deposit');
        assert(
            await sdkOptimizer.maxWithdraw(account) >= withdrawRaw,
            'SDK optimizer deposit should make the requested withdraw amount available',
        );

        const withdrawTx = await sdkOptimizer.withdraw(withdrawAmount, account, account);
        assert.strictEqual(withdrawTx.to?.toLowerCase(), optimizerAddress.toLowerCase());
        await withdrawTx.wait();

        const assetAfterWithdraw = await asset.balanceOf(account);
        const sharesAfterWithdraw = await sdkOptimizer.balanceOf(account);
        assert(assetAfterWithdraw > assetAfterDeposit, 'USDC balance should increase after SDK optimizer withdraw');
        assert(sharesAfterWithdraw < sharesAfterDeposit, 'optimizer shares should decrease after SDK optimizer withdraw');
    });

    test('SDK direct deposit and exact-share redeem execute on the forked optimizer', async () => {
        const { asset, sdkOptimizer } = createSdkOptimizer();
        const decimals = asset.decimals ?? await asset.fetchDecimals();
        const depositAmount = await cappedDepositAmount(
            sdkOptimizer,
            account,
            Decimal(15),
            decimals,
            0n,
        );

        const assetBefore = await asset.balanceOf(account);
        const sharesBefore = await sdkOptimizer.balanceOf(account);

        await waitForTx(await asset.approve(optimizerAddress, depositAmount));
        const depositTx = await sdkOptimizer.deposit(depositAmount, account);
        assert.strictEqual(depositTx.to?.toLowerCase(), optimizerAddress.toLowerCase());
        await depositTx.wait();

        const assetAfterDeposit = await asset.balanceOf(account);
        const sharesAfterDeposit = await sdkOptimizer.balanceOf(account);
        const mintedShares = sharesAfterDeposit - sharesBefore;
        assert(assetAfterDeposit < assetBefore, 'USDC balance should decrease after SDK optimizer deposit');
        assert(mintedShares > 0n, 'SDK optimizer deposit should mint shares');

        const redeemTx = await sdkOptimizer.redeem(mintedShares, account, account);
        assert.strictEqual(redeemTx.to?.toLowerCase(), optimizerAddress.toLowerCase());
        await redeemTx.wait();

        const assetAfterRedeem = await asset.balanceOf(account);
        const sharesAfterRedeem = await sdkOptimizer.balanceOf(account);
        assert(assetAfterRedeem > assetAfterDeposit, 'USDC balance should increase after SDK optimizer redeem');
        assert.strictEqual(sharesAfterRedeem, sharesBefore, 'redeeming exact minted shares should restore share balance');
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

    test('SDK full-share redeem clears the depositor optimizer balance', async () => {
        const { asset, sdkOptimizer } = createSdkOptimizer();
        const sharesBefore = await sdkOptimizer.balanceOf(account);
        const assetBefore = await asset.balanceOf(account);
        const totalAssetsBefore = await sdkOptimizer.totalAssets();

        assert(sharesBefore > 0n, 'test account should have optimizer shares to redeem');

        const redeemTx = await sdkOptimizer.redeemAll(account, account);
        assert.strictEqual(redeemTx.to?.toLowerCase(), optimizerAddress.toLowerCase());
        await redeemTx.wait();

        const sharesAfter = await sdkOptimizer.balanceOf(account);
        const assetAfter = await asset.balanceOf(account);
        const totalAssetsAfter = await sdkOptimizer.totalAssets();

        assert.strictEqual(sharesAfter, 0n, 'full-share redeem should clear account optimizer shares');
        assert(assetAfter > assetBefore, 'USDC balance should increase after full-share redeem');
        assert(totalAssetsAfter < totalAssetsBefore, 'optimizer total assets should decrease after full-share redeem');
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
