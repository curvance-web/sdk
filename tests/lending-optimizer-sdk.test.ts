import { config } from 'dotenv';
config({ quiet: true });
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import Decimal from 'decimal.js';
import { ethers, ContractFactory } from 'ethers';
import { address, ERC20 } from '../src';
import { LendingOptimizer } from '../src/classes/LendingOptimizer';
import { TestFramework } from './utils/TestFramework';
import { setNativeBalance } from './utils/helper';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LendingOptimizerArtifact = require('./utils/LendingOptimizer.json');

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
const USDC_DECIMALS = 6n;
const SEED_DEPOSIT = 10_000n * 10n ** USDC_DECIMALS;

const FORK_SKIP = (!process.env.DEPLOYER_PRIVATE_KEY || !process.env.TEST_RPC)
    ? 'Fork env not configured: set DEPLOYER_PRIVATE_KEY and TEST_RPC in .env. See tests/README.md.'
    : undefined;

describe('LendingOptimizer SDK — deposit + withdraw + redeem', { skip: FORK_SKIP }, () => {
    let framework: TestFramework;
    let account: address;
    let optimizer: LendingOptimizer;
    let optimizerAddress: address;
    let usdc: ERC20;

    before(async () => {
        framework = await TestFramework.init(
            process.env.DEPLOYER_PRIVATE_KEY as string,
            'monad-mainnet',
            { seedNativeBalance: true, seedUnderlying: true, snapshot: true, log: true },
        );
        account = framework.account;

        // Grant market + harvest permissions to the deployer via DAO timelock.
        await setNativeBalance(framework.provider, DAO_TIMELOCK, 100_000_000_000_000_000_000n);
        await framework.provider.send('anvil_impersonateAccount', [DAO_TIMELOCK]);
        const timelockSigner = await framework.provider.getSigner(DAO_TIMELOCK);
        const centralRegistry = new ethers.Contract(CENTRAL_REGISTRY, [
            'function addMarketPermissions(address) external',
            'function addHarvestPermissions(address) external',
        ], timelockSigner);
        await (await centralRegistry.getFunction('addMarketPermissions')(account)).wait();
        await (await centralRegistry.getFunction('addHarvestPermissions')(account)).wait();
        await framework.provider.send('anvil_stopImpersonatingAccount', [DAO_TIMELOCK]);

        // Deploy LendingOptimizer.
        const factory = new ContractFactory(
            LendingOptimizerArtifact.abi,
            LendingOptimizerArtifact.bytecode,
            framework.signer,
        );
        const deployed = await factory.deploy(
            USDC, CENTRAL_REGISTRY, APPROVED_CTOKENS, ALLOCATION_CAPS_BPS, FEE_BPS,
        );
        await deployed.waitForDeployment();
        optimizerAddress = (await deployed.getAddress()) as address;

        // Bootstrap: deployer pre-approves + initializes with non-zero totalSupply.
        const usdcDirect = new ethers.Contract(USDC, [
            'function approve(address,uint256) external returns (bool)',
        ], framework.signer);
        await (await usdcDirect.getFunction('approve')(optimizerAddress, ethers.MaxUint256)).wait();
        await (await (deployed as any).initializeDeposits(0)).wait();

        // Seed the vault with an initial deposit so totalSupply > 0 before
        // the SDK tests exercise the deposit path. Mirrors optimizer.test.ts.
        await (await (deployed as any)['deposit(uint256,address)'](SEED_DEPOSIT, account)).wait();

        // SDK instances.
        usdc = new ERC20(
            framework.provider,
            USDC,
            { decimals: USDC_DECIMALS } as any,
            undefined,
            framework.signer,
        );
        optimizer = new LendingOptimizer(
            optimizerAddress,
            usdc,
            framework.provider,
            framework.signer,
        );
    });

    after(async () => {
        await framework.destroy();
    });

    test('deposit via SDK mints shares and grows totalAssets', async () => {
        const totalBefore = await optimizer.totalAssets();
        const sharesBefore = await optimizer.balanceOf(account);

        const tx = await optimizer.deposit(new Decimal('1000'), account);
        const receipt = await tx.wait();
        assert.strictEqual(receipt?.status, 1, 'deposit tx should succeed');

        const totalAfter = await optimizer.totalAssets();
        const sharesAfter = await optimizer.balanceOf(account);

        assert(sharesAfter > sharesBefore, 'share balance should grow');
        assert(totalAfter > totalBefore, 'totalAssets should grow');
    });

    test('deposit defaults receiver to signer when omitted', async () => {
        const sharesBefore = await optimizer.balanceOf(account);

        const tx = await optimizer.deposit(new Decimal('500'));
        await tx.wait();

        const sharesAfter = await optimizer.balanceOf(account);
        assert(sharesAfter > sharesBefore, 'receiver should default to signer address');
    });

    test('deposit with zero amount rejects before tx broadcast', async () => {
        await assert.rejects(
            () => optimizer.deposit(new Decimal('0'), account),
            /zero/i,
            'zero-amount deposit should throw a client-side error',
        );
    });

    test('withdraw via SDK burns shares and shrinks totalAssets', async () => {
        const totalBefore = await optimizer.totalAssets();
        const sharesBefore = await optimizer.balanceOf(account);

        const tx = await optimizer.withdraw(new Decimal('250'), account, account);
        const receipt = await tx.wait();
        assert.strictEqual(receipt?.status, 1, 'withdraw tx should succeed');

        const totalAfter = await optimizer.totalAssets();
        const sharesAfter = await optimizer.balanceOf(account);

        assert(sharesAfter < sharesBefore, 'share balance should shrink');
        assert(totalAfter < totalBefore, 'totalAssets should shrink');
    });

    test('withdraw defaults receiver + owner to signer when omitted', async () => {
        const sharesBefore = await optimizer.balanceOf(account);

        const tx = await optimizer.withdraw(new Decimal('100'));
        await tx.wait();

        const sharesAfter = await optimizer.balanceOf(account);
        assert(sharesAfter < sharesBefore, 'signer defaults should allow self-withdrawal');
    });

    test('withdraw with zero amount rejects before tx broadcast', async () => {
        await assert.rejects(
            () => optimizer.withdraw(new Decimal('0')),
            /zero/i,
            'zero-amount withdraw should throw a client-side error',
        );
    });

    test('redeem(shares) with full balance zeros the share position', async () => {
        const shareBalance = await optimizer.balanceOf(account);
        assert(shareBalance > 0n, 'precondition: signer should hold shares');

        const tx = await optimizer.redeem(shareBalance, account, account);
        const receipt = await tx.wait();
        assert.strictEqual(receipt?.status, 1, 'redeem tx should succeed');

        const sharesAfter = await optimizer.balanceOf(account);
        assert.strictEqual(sharesAfter, 0n, 'full redeem should leave zero share dust');
    });

    test('redeem with zero shares rejects before tx broadcast', async () => {
        await assert.rejects(
            () => optimizer.redeem(0n),
            /zero/i,
            'zero-share redeem should throw a client-side error',
        );
    });
});
