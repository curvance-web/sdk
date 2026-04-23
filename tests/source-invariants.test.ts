import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

function readRepoFile(relativePath: string): string {
    return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function extractBlock(source: string, needle: string): string {
    const start = source.indexOf(needle);
    assert.notEqual(start, -1, `Could not find source block: ${needle}`);

    const firstBrace = source.indexOf("{", start);
    assert.notEqual(firstBrace, -1, `Could not find opening brace for: ${needle}`);

    let depth = 0;
    for (let i = firstBrace; i < source.length; i++) {
        const char = source[i];
        if (char === "{") depth++;
        if (char === "}") depth--;

        if (depth === 0) {
            return source.slice(firstBrace + 1, i);
        }
    }

    throw new Error(`Could not extract source block: ${needle}`);
}

test("test:transport includes every deterministic test file", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const transportScript = packageJson.scripts["test:transport"] as string;
    const manualOrEnvBackedTests = new Set([
        "arb-basic.test.ts",
        "basic.test.ts",
        "leverage.test.ts",
        "optimizer.test.ts",
        "zap.test.ts",
    ]);

    const missing = readdirSync(path.join(repoRoot, "tests"))
        .filter((file) => file.endsWith(".test.ts"))
        .filter((file) => !manualOrEnvBackedTests.has(file))
        .filter((file) => !transportScript.includes(`tests/${file}`));

    assert.deepEqual(missing, []);
});

test("Kyber current-router calldata validation fails closed in source", () => {
    const source = readRepoFile("src/classes/DexAggregators/KyberSwap.ts");
    const validator = extractBlock(source, "function validateSwapCalldata");

    assert.match(
        source,
        /validateSwapCalldata\(build_data\.data\.data,\s*\{[\s\S]*tokenIn,[\s\S]*tokenOut,[\s\S]*amount,[\s\S]*recipient: wallet,[\s\S]*minReturnAmount: min_out,[\s\S]*feeBps: feeBps \?\? 0n,[\s\S]*feeReceiver,[\s\S]*\}\);/,
    );
    assert.doesNotMatch(source, /console\.warn/);
    assert.match(validator, /validateEqualAddress\(desc\.srcToken,\s*expected\.tokenIn,\s*'srcToken'\);/);
    assert.match(validator, /validateEqualAddress\(desc\.dstToken,\s*expected\.tokenOut,\s*'dstToken'\);/);
    assert.match(validator, /validateRecipientAddress\(desc\.dstReceiver,\s*expected\.recipient\);/);
    assert.match(validator, /BigInt\(desc\.amount\) !== expected\.amount/);
    assert.match(validator, /BigInt\(desc\.minReturnAmount\) < expected\.minReturnAmount/);
    assert.match(validator, /execution\.approveTarget/);
    assert.match(validator, /execution\.targetData/);
    assert.match(validator, /desc\.permit/);
    assert.match(validator, /desc\.srcReceivers/);
    assert.match(validator, /throw new Error\(`KyberSwap calldata could not be decoded for fee validation:/);
});

test("deposit approval source keeps zap delegation branch-specific", () => {
    const source = readRepoFile("src/classes/CToken.ts");
    const body = extractBlock(source, "private async _checkDepositApprovals");
    const beforeCollateralizeBranch = body.slice(0, body.indexOf("if (collateralize)"));

    assert.match(body, /if\(zapType != 'none'\)/);
    assert.match(body, /if \(collateralize\)/);
    assert.match(body, /await this\._checkZapperApproval\(zapper\);/);
    assert.match(
        body,
        /await this\._checkDelegateApproval\(receiverAddress,\s*signer\.address as address,\s*"the connected signer"\);/,
    );
    assert.match(
        body,
        /await this\._checkDelegateApproval\(receiverAddress,\s*zapper\.address,\s*`\$\{zapper\.type\} Zapper`\);/,
    );
    assert.match(
        body,
        /else if \(collateralize && receiver && receiver\.toLowerCase\(\) !== signer\.address\.toLowerCase\(\)\)/,
    );
    assert.doesNotMatch(beforeCollateralizeBranch, /_checkZapperApproval|_checkDelegateApproval/);
});

test("market-level user-cache reads stay behind full-user freshness guards", () => {
    const source = readRepoFile("src/classes/Market.ts");
    const hasUserActivity = extractBlock(source, "hasUserActivity()");

    assert.doesNotMatch(source, /\bctoken\.cache\.user(?:Collateral|Debt|ShareBalance|AssetBalance)\b/);
    assert.match(hasUserActivity, /this\.requireFullUserTokenData\("determining user activity"\);/);
    assert.match(hasUserActivity, /token\.cache\.userCollateral/);
    assert.match(hasUserActivity, /token\.cache\.userDebt/);
});
