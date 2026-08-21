const { spawnSync } = require("node:child_process");
const path = require("node:path");
require("dotenv").config({ quiet: true });

const repoRoot = path.resolve(__dirname, "..");
const rpcUrl = process.env.TEST_RPC?.trim();

if (!rpcUrl) {
    console.error(
        "Zap repay fork gate requires TEST_RPC pointing at an Anvil-compatible Monad fork.",
    );
    process.exit(1);
}

try {
    new URL(rpcUrl);
} catch {
    console.error(`Zap repay fork gate received an invalid TEST_RPC URL: ${rpcUrl}`);
    process.exit(1);
}

const result = spawnSync(
    process.execPath,
    [
        "--require",
        "ts-node/register",
        "tests/zap-repay-fork.ts",
    ],
    {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            CURVANCE_REQUIRE_ZAP_REPAY_FORK: "1",
        },
        maxBuffer: 10 * 1024 * 1024,
    },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
    console.error(`Could not execute zap repay fork gate: ${result.error.message}`);
    process.exit(1);
}
if (result.status !== 0) {
    process.exit(result.status ?? 1);
}

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const expectedCases = [
    "same-token repay-all projects interest, simulates, executes, and refunds excess",
    "ERC20 exact-input zap repayment spends the planned input and reduces live debt",
    "ERC20-to-USDC repay-all refreshes after interest, reapproves, simulates, and clears debt",
    "native-to-USDC repay-all survives interest accrual and clears debt through Kyber",
];
const missingCases = expectedCases.filter((name) => !output.includes(`# Subtest: ${name}`));
const skipped = output.match(/# skipped (\d+)/)?.[1];
if (missingCases.length > 0 || skipped !== "0") {
    if (missingCases.length > 0) {
        console.error(`Zap repay fork gate did not execute: ${missingCases.join(", ")}`);
    }
    if (skipped !== "0") {
        console.error(`Zap repay fork gate expected '# skipped 0', received ${skipped ?? "no summary"}.`);
    }
    process.exit(1);
}

console.log("Zap repay fork gate executed without skipped fork coverage.");
