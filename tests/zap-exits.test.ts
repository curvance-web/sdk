import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Decimal from "decimal.js";
import { Interface, Wallet } from "ethers";
import {
    CToken,
    RedeemZapCapacityError,
    RedeemZapError,
    type RedeemAndSwapPlan,
    type RedeemSwapAndDepositPlan,
} from "../src";
import type { address } from "../src/types";

const SIGNER = new Wallet(`0x${"33".repeat(32)}`);
const OWNER = SIGNER.address as address;
const SOURCE_CTOKEN = "0x00000000000000000000000000000000000000c1" as address;
const DESTINATION_CTOKEN = "0x00000000000000000000000000000000000000c2" as address;
const SOURCE_MARKET = "0x00000000000000000000000000000000000000a1" as address;
const DESTINATION_MARKET = "0x00000000000000000000000000000000000000a2" as address;
const SOURCE_ASSET = "0x00000000000000000000000000000000000000d1" as address;
const OUTPUT_ASSET = "0x00000000000000000000000000000000000000d2" as address;
const ZAPPER = "0x00000000000000000000000000000000000000e1" as address;
const ROUTER = "0x00000000000000000000000000000000000000e2" as address;
const ORACLE_MANAGER = "0x00000000000000000000000000000000000000e3" as address;
const FEE_RECEIVER = "0x00000000000000000000000000000000000000e4" as address;

function createHarness(options: {
    borrowable?: boolean;
    sourceAsset?: address;
    destinationAsset?: address;
    balance?: bigint;
    maxRedemption?: bigint;
    liquidity?: bigint;
    sourceApproved?: boolean;
    targetApproved?: boolean;
    collateralCap?: bigint;
    collateralPosted?: bigint;
    maxDeposit?: bigint;
    mintPaused?: boolean;
    collateralizationPaused?: boolean;
    redeemPaused?: boolean;
    cooldownTimestamp?: bigint;
    holdPeriod?: bigint;
    excludedZapSymbols?: string[];
    marketAccount?: address;
    destinationReloadError?: Error;
    convertToShares?: (assets: bigint) => bigint;
    convertToAssets?: (shares: bigint) => bigint;
    redeemForAssets?: (shares: bigint) => bigint;
} = {}) {
    let timestamp = 1_000n;
    let sourceApproved = options.sourceApproved ?? true;
    let targetApproved = options.targetApproved ?? true;
    let sourceBalance = options.balance ?? 1_000n;
    let sourceMaxRedemption = options.maxRedemption ?? 800n;
    const sourceAsset = options.sourceAsset ?? SOURCE_ASSET;
    const destinationAsset = options.destinationAsset ?? OUTPUT_ASSET;
    const calls = {
        balances: 0,
        maxRedemptions: 0,
        liquidity: 0,
        redemptionPauses: 0,
        holdReads: 0,
        quoteAmounts: [] as bigint[],
        builds: 0,
        simulations: 0,
        executions: 0,
        sourceApprovals: 0,
        targetApprovals: 0,
        destinationReloads: 0,
        collateralReads: 0,
        redemptionPreviews: 0,
    };
    const dexAgg = {
        dao: FEE_RECEIVER,
        router: ROUTER,
        async prepareQuote(
            _wallet: string,
            tokenIn: string,
            tokenOut: string,
            amount: bigint,
        ) {
            assert.equal(tokenIn.toLowerCase(), sourceAsset.toLowerCase());
            assert.equal(tokenOut.toLowerCase(), destinationAsset.toLowerCase());
            calls.quoteAmounts.push(amount);
            return {
                min_out: amount - 20n,
                out: amount - 10n,
                async build() {
                    calls.builds += 1;
                    return {
                        to: ROUTER,
                        calldata: "0x1234" as const,
                        min_out: amount - 20n,
                        out: amount - 10n,
                    };
                },
            };
        },
    } as any;
    const setup = {
        chain: "monad-mainnet",
        chainId: 143,
        contracts: {
            OracleManager: ORACLE_MANAGER,
            zappers: { simpleZapper: ZAPPER },
        },
        assets: {
            wrapped_native: "0x00000000000000000000000000000000000000f1" as address,
            native_symbol: "MON",
            native_name: "Monad",
            native_vaults: [],
            vaults: [],
            excluded_zap_symbols: options.excludedZapSymbols ?? [],
            excluded_zap_addresses: [],
        },
        feePolicy: {
            feeReceiver: FEE_RECEIVER,
            getFeeBps: () => 4n,
        },
    } as any;
    const sourceInterface = new Interface([
        "function redeemFor(uint256 shares,address receiver,address owner) returns (uint256 assets)",
    ]);
    const provider = {
        async getBlock() {
            return { timestamp };
        },
        async call(request: { data: string }) {
            calls.redemptionPreviews += 1;
            const decoded = sourceInterface.decodeFunctionData("redeemFor", request.data);
            const shares = BigInt(decoded.shares);
            const assets = options.redeemForAssets?.(shares) ??
                options.convertToAssets?.(shares) ??
                shares;
            return sourceInterface.encodeFunctionResult("redeemFor", [assets]);
        },
    } as any;

    const source = Object.create(CToken.prototype) as CToken;
    (source as any).provider = provider;
    (source as any).address = SOURCE_CTOKEN;
    (source as any).cache = {
        symbol: "cSOURCE",
        decimals: 18n,
        isBorrowable: options.borrowable ?? true,
        asset: { address: sourceAsset, decimals: 0n, symbol: "SRC" },
    };
    (source as any).market = {
        address: SOURCE_MARKET,
        setup,
        signer: SIGNER,
        account: options.marketAccount ?? OWNER,
        dexAgg,
        userDebt: new Decimal(0),
        contract: {
            async accountAssets() {
                calls.holdReads += 1;
                return options.cooldownTimestamp ?? 0n;
            },
            async MIN_HOLD_PERIOD() {
                calls.holdReads += 1;
                return options.holdPeriod ?? 0n;
            },
            async redeemPaused() {
                calls.redemptionPauses += 1;
                return options.redeemPaused ? 2n : 1n;
            },
        },
        reloadUserData: async () => undefined,
    };
    (source as any).contract = {
        interface: sourceInterface,
        async balanceOf() {
            calls.balances += 1;
            return sourceBalance;
        },
        async assetsHeld() {
            calls.liquidity += 1;
            return options.liquidity ?? 600n;
        },
        async convertToShares(assets: bigint) {
            return options.convertToShares?.(assets) ?? assets;
        },
        async convertToAssets(shares: bigint) {
            return options.convertToAssets?.(shares) ?? shares;
        },
        async isDelegate() {
            return sourceApproved;
        },
    };
    (source as any).maxRedemption = async () => {
        calls.maxRedemptions += 1;
        return sourceMaxRedemption;
    };
    (source as any).getExecutionDebtBufferTime = () => 0n;
    (source as any).simulateOracleRoute = async () => {
        calls.simulations += 1;
        return { success: true };
    };
    (source as any).oracleRoute = async () => {
        calls.executions += 1;
        return { hash: "0xexit" };
    };
    (source as any).approvePlugin = async () => {
        calls.sourceApprovals += 1;
        sourceApproved = true;
        return { hash: "0xsourceapproval" };
    };

    const destination = Object.create(CToken.prototype) as CToken;
    (destination as any).provider = provider;
    (destination as any).address = DESTINATION_CTOKEN;
    (destination as any).cache = {
        symbol: "cDESTINATION",
        decimals: 18n,
        isBorrowable: false,
        asset: { address: destinationAsset, decimals: 0n, symbol: "DST" },
    };
    (destination as any).market = {
        address: DESTINATION_MARKET,
        setup,
        signer: SIGNER,
        account: OWNER,
        dexAgg,
        contract: {
            async actionsPaused() {
                return [
                    options.mintPaused ?? false,
                    options.collateralizationPaused ?? false,
                    false,
                ];
            },
            async collateralCaps() {
                calls.collateralReads += 1;
                return options.collateralCap ?? 10_000n;
            },
        },
        async reloadUserData() {
            calls.destinationReloads += 1;
            if (options.destinationReloadError) throw options.destinationReloadError;
        },
    };
    (destination as any).contract = {
        async maxDeposit() {
            return options.maxDeposit ?? 1_000_000n;
        },
        async convertToShares(assets: bigint) {
            return assets;
        },
        async marketCollateralPosted() {
            calls.collateralReads += 1;
            return options.collateralPosted ?? 0n;
        },
        async isDelegate() {
            return targetApproved;
        },
    };
    (destination as any).approvePlugin = async () => {
        calls.targetApprovals += 1;
        targetApproved = true;
        return { hash: "0xtargetapproval" };
    };

    return {
        source,
        destination,
        calls,
        setTimestamp(value: bigint) {
            timestamp = value;
        },
        setSourceApproved(value: boolean) {
            sourceApproved = value;
        },
        setTargetApproved(value: boolean) {
            targetApproved = value;
        },
        setSourceBalance(value: bigint) {
            sourceBalance = value;
        },
        setSourceMaxRedemption(value: bigint) {
            sourceMaxRedemption = value;
        },
    };
}

describe("typed SimpleZapper exit plans", () => {
    test("uses fresh balance, maxRedemption, and borrowable liquidity without clipping", async () => {
        const { source, calls } = createHarness();
        const plan = await source.quoteRedeemAndSwap(
            OUTPUT_ASSET,
            new Decimal(500),
            new Decimal("0.005"),
        );

        assert.equal(plan.capacity.shareBalance, 1_000n);
        assert.equal(plan.capacity.maxRedemptionShares, 800n);
        assert.equal(plan.capacity.liquidityShares, 600n);
        assert.equal(plan.capacity.executableShares, 600n);
        assert.equal(plan.sourceShares, 500n);
        assert.equal(plan.sourceAssets, 500n);
        assert.equal(plan.forceRedeemCollateral, false);
        assert.equal(plan.value, 0n);
        assert.equal(plan.minimumOutput, 480n);
        assert.equal(plan.expectedOutput, 490n);
        assert.equal(plan.feeBps, 4n);
        assert.equal(calls.balances, 1);
        assert.equal(calls.maxRedemptions, 1);
        assert.equal(calls.liquidity, 1);
        assert.equal(calls.redemptionPauses, 1);
        assert.deepEqual(calls.quoteAmounts, [500n]);
        assert.equal(calls.builds, 1);
        assert.equal(Object.isFrozen(plan), true);
        assert.equal(Object.isFrozen(plan.capacity), true);
        assert.equal(Object.isFrozen(plan.swapAction), true);
    });

    test("returns a typed capacity error instead of silently clipping", async () => {
        const { source, calls } = createHarness();
        await assert.rejects(
            source.quoteRedeemAndSwap(
                OUTPUT_ASSET,
                new Decimal(601),
                new Decimal("0.005"),
            ),
            (error: unknown) => {
                assert.ok(error instanceof RedeemZapCapacityError);
                assert.equal(error.requestedShares, 601n);
                assert.equal(error.capacity.executableShares, 600n);
                return true;
            },
        );
        assert.deepEqual(calls.quoteAmounts, []);
    });

    test("accepts an exact request at the executable capacity", async () => {
        const { source } = createHarness();
        const plan = await source.quoteRedeemAndSwap(
            OUTPUT_ASSET,
            new Decimal(600),
            new Decimal("0.005"),
        );

        assert.equal(plan.sourceShares, plan.capacity.executableShares);
        assert.equal(plan.sourceAssets, 600n);
    });

    test("preserves exact fresh MAX shares across asset rounding and plan refresh", async () => {
        const harness = createHarness({
            borrowable: false,
            balance: 601n,
            maxRedemption: 601n,
            convertToShares: (assets) => assets * 2n / 3n,
            convertToAssets: (shares) => shares * 3n / 2n,
        });

        const ordinary = await harness.source.quoteRedeemAndSwap(
            OUTPUT_ASSET,
            new Decimal(901),
            new Decimal("0.005"),
        );
        assert.equal(ordinary.sourceShares, 600n);
        assert.equal(ordinary.redeemMax, false);

        const maximum = await harness.source.quoteRedeemAndSwap(
            OUTPUT_ASSET,
            new Decimal(901),
            new Decimal("0.005"),
            { redeemMax: true },
        );
        assert.equal(maximum.sourceShares, 601n);
        assert.equal(maximum.sourceShares, maximum.capacity.executableShares);
        assert.equal(maximum.sourceAssets, 901n);
        assert.equal(maximum.redeemMax, true);

        harness.setSourceBalance(603n);
        harness.setSourceMaxRedemption(603n);
        const refreshed = await harness.source.refreshRedeemAndSwapPlan(maximum);
        assert.equal(refreshed.sourceShares, 603n);
        assert.equal(refreshed.sourceShares, refreshed.capacity.executableShares);
        assert.equal(refreshed.sourceAssets, 904n);
        assert.equal(refreshed.redeemMax, true);
        assert.deepEqual(harness.calls.quoteAmounts, [900n, 901n, 904n]);
    });

    test("quotes the exact redeemFor output when accrual-time fee shares dilute convertToAssets", async () => {
        const harness = createHarness({
            borrowable: false,
            balance: 1_000n,
            maxRedemption: 1_000n,
            convertToAssets: (shares) => shares,
            redeemForAssets: (shares) => shares - 1n,
        });

        const plan = await harness.source.quoteRedeemAndSwap(
            OUTPUT_ASSET,
            new Decimal(1_000),
            new Decimal("0.005"),
            { redeemMax: true },
        );

        assert.equal(plan.sourceShares, 1_000n);
        assert.equal(plan.capacity.executableAssets, 1_000n);
        assert.equal(plan.sourceAssets, 999n);
        assert.equal(plan.quotedSourceAssetRefund, 0n);
        assert.deepEqual(harness.calls.quoteAmounts, [999n]);
        assert.equal(harness.calls.redemptionPreviews, 1);
        assert.deepEqual(await harness.source.simulateRedeemAndSwap(plan), { success: true });
        assert.equal(harness.calls.redemptionPreviews, 2);
    });

    test("keeps a bounded pre-approval input buffer until exact redeemFor preview is authorized", async () => {
        const harness = createHarness({
            borrowable: false,
            balance: 10_000n,
            maxRedemption: 10_000n,
            sourceApproved: false,
        });

        const approvalPlan = await harness.source.quoteRedeemAndSwap(
            OUTPUT_ASSET,
            new Decimal(10_000),
            new Decimal("0.005"),
            { redeemMax: true },
        );
        assert.equal(approvalPlan.sourceAssets, 9_999n);
        assert.equal(approvalPlan.quotedSourceAssetRefund, 1n);
        assert.equal(harness.calls.redemptionPreviews, 0);

        await harness.source.approveRedeemAndSwap(approvalPlan);
        const executionPlan = await harness.source.refreshRedeemAndSwapPlan(approvalPlan);
        assert.equal(executionPlan.sourceAssets, 10_000n);
        assert.equal(executionPlan.quotedSourceAssetRefund, 0n);
        assert.equal(harness.calls.redemptionPreviews, 1);
    });

    test("rejects a fresh source redemption pause before requesting a route", async () => {
        const { source, calls } = createHarness({ redeemPaused: true });

        await assert.rejects(
            source.quoteRedeemAndSwap(
                OUTPUT_ASSET,
                new Decimal(500),
                new Decimal("0.005"),
            ),
            (error: unknown) => {
                assert.ok(error instanceof RedeemZapError);
                assert.equal(error.code, "source-unavailable");
                assert.match(error.message, /redemptions are currently paused/i);
                return true;
            },
        );
        assert.equal(calls.redemptionPauses, 1);
        assert.deepEqual(calls.quoteAmounts, []);
    });

    test("rejects a fresh source action hold before requesting a route", async () => {
        const { source, calls } = createHarness({
            cooldownTimestamp: 990n,
            holdPeriod: 20n,
        });

        await assert.rejects(
            source.quoteRedeemAndSwap(
                OUTPUT_ASSET,
                new Decimal(500),
                new Decimal("0.005"),
            ),
            (error: unknown) => {
                assert.ok(error instanceof RedeemZapError);
                assert.equal(error.code, "source-unavailable");
                assert.match(error.message, /action hold is active/i);
                return true;
            },
        );
        assert.equal(calls.holdReads, 2);
        assert.deepEqual(calls.quoteAmounts, []);
    });

    test("rejects symbol-excluded source and Move destination assets", async () => {
        const sourceExcluded = createHarness({ excludedZapSymbols: ["SRC"] });
        await assert.rejects(
            sourceExcluded.source.quoteRedeemAndSwap(
                OUTPUT_ASSET,
                new Decimal(500),
                new Decimal("0.005"),
            ),
            /excluded source asset SRC/i,
        );

        const destinationExcluded = createHarness({ excludedZapSymbols: ["DST"] });
        await assert.rejects(
            destinationExcluded.source.quoteRedeemSwapAndDeposit(
                destinationExcluded.destination,
                new Decimal(500),
                new Decimal("0.005"),
            ),
            (error: unknown) => {
                assert.ok(error instanceof RedeemZapError);
                assert.equal(error.code, "unsupported-token");
                assert.match(error.message, /destination asset DST is excluded/i);
                return true;
            },
        );
    });

    test("rejects copied plans and refreshes into a new immutable plan", async () => {
        const harness = createHarness();
        const plan = await harness.source.quoteRedeemAndSwap(
            OUTPUT_ASSET,
            new Decimal(500),
            new Decimal("0.005"),
        );
        await assert.rejects(
            harness.source.simulateRedeemAndSwap({ ...plan } as RedeemAndSwapPlan).then((result) => {
                if (!result.success) throw new Error(result.error);
            }),
            /not created by this SDK instance/i,
        );

        harness.setTimestamp(1_001n);
        const refreshed = await harness.source.refreshRedeemAndSwapPlan(plan);
        assert.notEqual(refreshed, plan);
        assert.equal(plan.quotedAt, 1_000n);
        assert.equal(refreshed.quotedAt, 1_001n);
        assert.equal(Object.isFrozen(refreshed), true);
    });

    test("rejects a source market loaded for a different account", async () => {
        const { source } = createHarness({
            marketAccount: "0x00000000000000000000000000000000000000aa" as address,
        });

        await assert.rejects(
            source.quoteRedeemAndSwap(
                OUTPUT_ASSET,
                new Decimal(500),
                new Decimal("0.005"),
            ),
            (error: unknown) => {
                assert.ok(error instanceof RedeemZapError);
                assert.equal(error.code, "invalid-account");
                assert.match(error.message, /loaded for .* not the connected account/i);
                return true;
            },
        );
    });

    test("requires source delegation, then simulates and executes exact calldata", async () => {
        const harness = createHarness({ sourceApproved: false });
        const plan = await harness.source.quoteRedeemAndSwap(
            OUTPUT_ASSET,
            new Decimal(500),
            new Decimal("0.005"),
        );
        assert.equal(await harness.source.isRedeemAndSwapApproved(plan), false);
        const blocked = await harness.source.simulateRedeemAndSwap(plan);
        assert.equal(blocked.success, false);
        assert.match(blocked.error ?? "", /approve Simple Zapper/i);

        await harness.source.approveRedeemAndSwap(plan);
        assert.equal(await harness.source.isRedeemAndSwapApproved(plan), true);
        const simulation = await harness.source.simulateRedeemAndSwap(plan);
        assert.equal(simulation.success, true);
        const tx = await harness.source.redeemAndSwap(plan);
        assert.equal((tx as any).hash, "0xexit");
        assert.equal(harness.calls.sourceApprovals, 1);
        assert.equal(harness.calls.simulations, 2);
        assert.equal(harness.calls.executions, 1);
        assert.equal(harness.calls.balances, 4);
        assert.equal(harness.calls.maxRedemptions, 4);
        assert.equal(harness.calls.liquidity, 4);
    });

    test("runs the wallet-exit intent guard after simulation and before broadcast", async () => {
        const harness = createHarness();
        const plan = await harness.source.quoteRedeemAndSwap(
            OUTPUT_ASSET,
            new Decimal(500),
            new Decimal("0.005"),
        );
        const intentError = new Error("withdraw intent changed");

        await assert.rejects(
            harness.source.redeemAndSwap(plan, {
                beforeBroadcast() {
                    throw intentError;
                },
            }),
            (error: unknown) => error === intentError,
        );
        assert.equal(harness.calls.simulations, 1);
        assert.equal(harness.calls.executions, 0);
    });

    test("same-underlying Move uses a no-op swap but still binds atomic deposit calldata", async () => {
        const { source, destination, calls } = createHarness({
            destinationAsset: SOURCE_ASSET,
        });
        const plan = await source.quoteRedeemSwapAndDeposit(
            destination,
            new Decimal(500),
            new Decimal("0.005"),
        );

        assert.equal(plan.swapAction.target, "0x0000000000000000000000000000000000000000");
        assert.equal(plan.swapAction.call, "0x");
        assert.equal(plan.feeBps, 0n);
        assert.equal(plan.minimumOutput, 500n);
        assert.equal(plan.expectedDestinationShares, 500n);
        assert.equal(plan.minimumDestinationShares, 499n);
        assert.equal(plan.collateralizeFor, false);
        assert.equal(plan.targetCollateral, null);
        assert.deepEqual(calls.quoteAmounts, []);
        assert.equal(calls.collateralReads, 0);
    });

    test("requires destination maxDeposit to cover the expected route output", async () => {
        const { source, destination } = createHarness({ maxDeposit: 485n });

        await assert.rejects(
            source.quoteRedeemSwapAndDeposit(
                destination,
                new Decimal(500),
                new Decimal("0.005"),
            ),
            (error: unknown) => {
                assert.ok(error instanceof RedeemZapError);
                assert.equal(error.code, "target-unavailable");
                assert.match(error.message, /below the quoted output 490/i);
                return true;
            },
        );
    });

    test("target delegation and fresh cap reads apply only to collateralized Move", async () => {
        const harness = createHarness({ targetApproved: false });
        const plan = await harness.source.quoteRedeemSwapAndDeposit(
            harness.destination,
            new Decimal(500),
            new Decimal("0.005"),
            true,
        );
        assert.ok(plan.targetCollateral);
        assert.equal(await harness.source.isRedeemSwapAndDepositApproved(plan), true);
        assert.equal(await harness.source.isRedeemSwapAndDepositTargetApproved(plan), false);
        const blocked = await harness.source.simulateRedeemSwapAndDeposit(plan);
        assert.equal(blocked.success, false);
        assert.match(blocked.error ?? "", /collateralize destination/i);

        await harness.source.approveRedeemSwapAndDepositTarget(plan);
        assert.equal(await harness.source.isRedeemSwapAndDepositTargetApproved(plan), true);
        const tx = await harness.source.redeemSwapAndDeposit(plan);
        assert.equal((tx as any).hash, "0xexit");
        assert.equal(harness.calls.targetApprovals, 1);
        assert.equal(harness.calls.executions, 1);
        assert.equal(harness.calls.destinationReloads, 1);
        assert.ok(harness.calls.collateralReads >= 4);
    });

    test("runs the Move intent guard after simulation and before broadcast", async () => {
        const harness = createHarness();
        const plan = await harness.source.quoteRedeemSwapAndDeposit(
            harness.destination,
            new Decimal(500),
            new Decimal("0.005"),
        );
        const intentError = new Error("move intent changed");

        await assert.rejects(
            harness.source.redeemSwapAndDeposit(plan, {
                beforeBroadcast() {
                    throw intentError;
                },
            }),
            (error: unknown) => error === intentError,
        );
        assert.equal(harness.calls.simulations, 1);
        assert.equal(harness.calls.executions, 0);
    });

    test("Move preserves the settled transaction when destination refresh fails", async () => {
        const refreshError = new Error("destination refresh RPC unavailable");
        const harness = createHarness({ destinationReloadError: refreshError });
        const plan = await harness.source.quoteRedeemSwapAndDeposit(
            harness.destination,
            new Decimal(500),
            new Decimal("0.005"),
        );

        await assert.rejects(
            harness.source.redeemSwapAndDeposit(plan),
            (error: unknown) => {
                assert.equal(error, refreshError);
                assert.equal((error as any).transaction?.hash, "0xexit");
                return true;
            },
        );
        assert.equal(harness.calls.executions, 1);
        assert.equal(harness.calls.destinationReloads, 1);
    });

    test("collateralized Move fails with a typed error when fresh target capacity is insufficient", async () => {
        const { source, destination } = createHarness({
            collateralCap: 480n,
            collateralPosted: 0n,
        });
        await assert.rejects(
            source.quoteRedeemSwapAndDeposit(
                destination,
                new Decimal(500),
                new Decimal("0.005"),
                true,
            ),
            (error: unknown) => {
                assert.ok(error instanceof RedeemZapError);
                assert.equal(error.code, "target-collateral-unavailable");
                return true;
            },
        );
    });

    test("expired external routes fail closed before simulation", async () => {
        const harness = createHarness();
        const plan: RedeemSwapAndDepositPlan = await harness.source.quoteRedeemSwapAndDeposit(
            harness.destination,
            new Decimal(500),
            new Decimal("0.005"),
        );
        harness.setTimestamp(plan.routeValidUntil);
        const result = await harness.source.simulateRedeemSwapAndDeposit(plan);
        assert.equal(result.success, false);
        assert.match(result.error ?? "", /route is expired/i);
        assert.equal(harness.calls.simulations, 0);
    });
});
