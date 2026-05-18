import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { chain_config, chain_rpc_config } from "../src/chains";
import { chains } from "../src/contracts";

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

test("test:fork includes every env-backed fork test file", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const forkScript = packageJson.scripts["test:fork"] as string;
    const expectedForkTests = [
        "fork-integration.ts",
        "basic.test.ts",
        "arb-basic.test.ts",
        "optimizer.test.ts",
        "leverage.test.ts",
        "zap.test.ts",
    ];

    const missing = expectedForkTests
        .filter((file) => !forkScript.includes(`tests/${file}`));

    assert.deepEqual(missing, []);
});

test("package lifecycle rebuilds dist before pack and publish", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const distSmokeSource = readRepoFile("tests/dist-smoke.cjs");

    assert.equal(packageJson.scripts.prepack, "npm run build");
    assert.equal(packageJson.scripts.prepublishOnly, "npm run build");
    assert.doesNotMatch(distSmokeSource, /--ignore-scripts/);
    assert.match(distSmokeSource, /require\(packageRoot\)/);
    assert.match(distSmokeSource, /dist\/chains\/services\.js/);
    assert.match(distSmokeSource, /dist\/chains\/services\.d\.ts/);
});

test("test scripts that name concrete test files point to existing files", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const missing: string[] = [];

    for (const [scriptName, command] of Object.entries(packageJson.scripts as Record<string, string>)) {
        if (!scriptName.startsWith("test:")) {
            continue;
        }

        for (const match of command.matchAll(/tests[\/\\]([^\s"'`]+\.(?:ts|cjs|mjs|js))/g)) {
            const testPath = match[0];
            if (testPath.includes("*")) {
                continue;
            }
            if (!existsSync(path.join(repoRoot, testPath))) {
                missing.push(`${scriptName}:${testPath}`);
            }
        }
    }

    assert.deepEqual(missing, []);
});

test("chain config, RPC config, and contract manifests stay aligned", () => {
    const configuredChains = Object.keys(chain_config).sort();
    const rpcChains = Object.keys(chain_rpc_config).sort();
    const contractChains = Object.keys(chains).sort();

    assert.deepEqual(configuredChains, rpcChains);
    assert.deepEqual(configuredChains, contractChains);

    for (const [chain, config] of Object.entries(chain_config)) {
        assert.ok(config.environment, `${chain} must declare an environment`);
        assert.ok(config.services?.curvanceApi, `${chain} must declare Curvance API service aliases`);
        assert.ok(
            typeof config.services.curvanceApi.rewardsSlug === "string" &&
            config.services.curvanceApi.rewardsSlug.trim().length > 0,
            `${chain} rewardsSlug must be an explicit non-empty string`,
        );
        assert.ok(
            Array.isArray(config.services.curvanceApi.rewardChainAliases),
            `${chain} rewardChainAliases must be explicit`,
        );
        assert.ok(
            config.services.curvanceApi.rewardChainAliases.every((alias) => (
                typeof alias === "string" && alias.trim().length > 0
            )),
            `${chain} rewardChainAliases must be non-empty strings`,
        );
        assert.ok(
            typeof config.services.curvanceApi.nativeYieldSlug === "string" ||
            config.services.curvanceApi.nativeYieldSlug === null,
            `${chain} nativeYieldSlug must be explicit string or null`,
        );
        if (typeof config.services.curvanceApi.nativeYieldSlug === "string") {
            assert.ok(
                config.services.curvanceApi.nativeYieldSlug.trim().length > 0,
                `${chain} nativeYieldSlug must be non-empty when enabled`,
            );
        }
        assert.ok(
            Array.isArray(config.services.curvanceApi.suppressedNativeYieldSymbols),
            `${chain} suppressedNativeYieldSymbols must be explicit`,
        );
        assert.ok(
            config.services.curvanceApi.suppressedNativeYieldSymbols.every((symbol) => (
                typeof symbol === "string" && symbol.trim().length > 0
            )),
            `${chain} suppressedNativeYieldSymbols must be non-empty strings`,
        );
        assert.ok(
            config.services.dexAggregators,
            `${chain} must explicitly declare DEX aggregator service config`,
        );
        const kyberSwap = config.services.dexAggregators.kyberSwap;
        if (kyberSwap != null) {
            assert.ok(
                typeof kyberSwap.chainSlug === "string" && kyberSwap.chainSlug.trim().length > 0,
                `${chain} KyberSwap chainSlug must be an explicit non-empty string`,
            );
            assert.ok(
                typeof kyberSwap.apiBase === "string" && kyberSwap.apiBase.trim().length > 0,
                `${chain} KyberSwap apiBase must be an explicit non-empty string`,
            );
            assert.ok(
                typeof kyberSwap.router === "string" && kyberSwap.router.trim().length > 0,
                `${chain} KyberSwap router must be an explicit non-empty string`,
            );
        }
        assert.ok((chains as any)[chain].ProtocolReader, `${chain} contracts must include ProtocolReader`);
        assert.ok((chains as any)[chain].OracleManager, `${chain} contracts must include OracleManager`);
    }
});

test("external service aliases stay in chain config", () => {
    const apiSource = readRepoFile("src/classes/Api.ts");
    const marketSource = readRepoFile("src/classes/Market.ts");
    const monadChainSource = readRepoFile("src/chains/monad.ts");
    const chainServicesSource = readRepoFile("src/chains/services.ts");
    const kyberSource = readRepoFile("src/classes/DexAggregators/KyberSwap.ts");

    assert.match(apiSource, /resolveCurvanceApiServices/);
    assert.match(apiSource, /chain_config\[config\.chain\]\?\.services\.curvanceApi/);
    assert.match(apiSource, /const rewardsSlug = resolveCurvanceApiServices\(resolvedConfig\)\.rewardsSlug;/);
    assert.match(apiSource, /\/v1\/rewards\/active\/\$\{rewardsSlug\}/);
    assert.match(apiSource, /services\.rewardChainAliases/);
    assert.match(apiSource, /resolveCurvanceApiServices\(resolvedConfig\)\.nativeYieldSlug/);
    assert.match(marketSource, /setup\.services\.curvanceApi\.suppressedNativeYieldSymbols/);
    assert.doesNotMatch(apiSource, /normalized === "monad-mainnet"|normalized === "arb-sepolia"/);
    assert.doesNotMatch(apiSource, /chain == 'monad-mainnet'|\['monad'\]\.includes/);
    assert.doesNotMatch(
        marketSource,
        /chain === "monad-mainnet" && yieldEntry\.symbol\.toUpperCase\(\) === "USDC"/,
    );
    assert.match(chainServicesSource, /export const MONAD_KYBER_SWAP_SERVICE: KyberSwapServiceConfig = \{/);
    assert.match(chainServicesSource, /chainSlug: "monad"/);
    assert.match(monadChainSource, /new KyberSwap\(EMPTY_ADDRESS,\s*kyberSwap\.router,\s*kyberSwap\.chainSlug,\s*kyberSwap\.apiBase\)/);
    assert.match(kyberSource, /router: address = MONAD_KYBER_SWAP_SERVICE\.router/);
    assert.doesNotMatch(kyberSource, /https:\/\/aggregator-api\.kyberswap\.com/);
});

test("production RPC origins have fallback or explicit non-production environment", () => {
    const missingFallbacks = Object.entries(chain_config)
        .filter(([, config]) => config.environment === "production-mainnet")
        .filter(([chain]) => chain_rpc_config[chain as keyof typeof chain_rpc_config].fallbacks.length === 0)
        .map(([chain]) => chain);

    assert.deepEqual(missingFallbacks, []);
});

test("CToken market-bound ERC20 helpers pass the market OracleManager explicitly", () => {
    const source = readRepoFile("src/classes/CToken.ts");
    const helperCalls = [...source.matchAll(/new ERC20\(\s*this\.provider,[\s\S]*?this\.signer,\s*\)/g)]
        .map((match) => match[0]);
    const missingOracleManager = helperCalls
        .filter((call) => !call.includes("this.setup.contracts.OracleManager as address"));

    assert.ok(helperCalls.length > 0, "expected to find CToken market-bound ERC20 helper constructors");
    assert.deepEqual(missingOracleManager, []);
});

test("deployment manifests do not declare duplicate market addresses", () => {
    const duplicates: string[] = [];

    for (const [chain, config] of Object.entries(chains)) {
        const seen = new Map<string, string>();
        const markets = (config as any).markets as Record<string, any>;
        for (const [name, market] of Object.entries(markets)) {
            if (typeof market !== "object" || market == null || typeof market.address !== "string") {
                continue;
            }
            const key = market.address.toLowerCase();
            const existing = seen.get(key);
            if (existing != undefined) {
                duplicates.push(`${chain}:${existing}/${name}:${key}`);
            }
            seen.set(key, name);
        }
    }

    assert.deepEqual(duplicates, []);
});

test("README public examples stay multichain-safe", () => {
    const readme = readRepoFile("README.md");
    const merklSectionStart = readme.indexOf("### Merkl rewards");
    const merklSectionEnd = readme.indexOf("### Portfolio snapshots");
    assert.notEqual(merklSectionStart, -1, "README Merkl section must exist");
    assert.notEqual(merklSectionEnd, -1, "README snapshot section must exist");
    const merklSection = readme.slice(merklSectionStart, merklSectionEnd);

    assert.match(readme, /chain:\s*ChainRpcPrefix/);
    assert.match(readme, /chainId:\s*number/);
    assert.match(readme, /setupConfigSnapshot:\s*Readonly<SetupConfigSnapshot>/);
    assert.match(readme, /chain\?:\s*"monad-mainnet"\s*\|\s*"arb-sepolia"\s*\|\s*"any"/);
    assert.match(readme, /checkerCompatibility\?:\s*\{/);
    assert.doesNotMatch(readme, /bps:\s*10n/);
    const feePolicyExampleStart = readme.indexOf("const feePolicy = flatFeePolicy({");
    const feePolicyExampleEnd = readme.indexOf("const { markets }", feePolicyExampleStart);
    assert.notEqual(feePolicyExampleStart, -1, "README checker-compatible fee policy example must exist");
    assert.notEqual(feePolicyExampleEnd, -1, "README checker-compatible fee policy example must be bounded");
    const feePolicyExample = readme.slice(feePolicyExampleStart, feePolicyExampleEnd);
    assert.doesNotMatch(feePolicyExample, /stableToStableBps/);
    assert.match(merklSection, /fetchMerklOpportunities\(\{\s*chainId:\s*143\s*\}\)/);
    assert.match(merklSection, /fetchMerklUserRewards\(\{\s*wallet:\s*address,\s*chainId:\s*143\s*\}\)/);
    assert.match(merklSection, /fetchMerklCampaignsBySymbol\(\{\s*tokenSymbol:\s*"USDC",\s*chainId:\s*143\s*\}\)/);
    assert.doesNotMatch(readme, /fetchMerklUserRewards\(\{[^}]*chainId:\s*undefined/s);
});

test("default fee receiver is setup-resolved instead of hardcoded in production source", () => {
    const feePolicySource = readRepoFile("src/feePolicy.ts");
    const setupSource = readRepoFile("src/setup.ts");
    const kyberSource = readRepoFile("src/classes/DexAggregators/KyberSwap.ts");

    assert.doesNotMatch(feePolicySource, /CURVANCE_DAO_FEE_RECEIVER/);
    assert.doesNotMatch(feePolicySource, /0x0Acb7eF4D8733C719d60e0992B489b629bc55C02/i);
    assert.match(setupSource, /await reader\.getDaoAddress\(\)/);
    assert.match(
        setupSource,
        /const setupDaoAddress = options\.feePolicy == null \|\| requiresCheckerPolicy[\s\S]*\? await reader\.getDaoAddress\(\)[\s\S]*: null;/,
    );
    assert.match(setupSource, /validateCheckerFeePolicy\(nextSetupConfig,\s*setupDaoAddress\);/);
    assert.match(kyberSource, /new KyberSwap\(context\.checkerDao \?\? this\.dao,/);
});

test("Kyber current-router calldata validation fails closed in source", () => {
    const source = readRepoFile("src/classes/DexAggregators/KyberSwap.ts");
    const validator = extractBlock(source, "function validateSwapCalldata");

    assert.match(source, /this\.apiBase = validateApiUrl\(api\)\.replace\(\/\\\/\+\$\/,\s*""\);/);
    assert.match(source, /this\.api = `\$\{this\.apiBase\}\/\$\{this\.chain\}`;/);
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

test("Merkl campaign lookups stay protocol and chain scoped", () => {
    const source = readRepoFile("src/integrations/merkl.ts");
    const marketSource = readRepoFile("src/classes/Market.ts");
    const start = source.indexOf("export async function fetchMerklCampaignsBySymbol");
    const end = source.indexOf("type FetchOpportunitiesParams", start);
    assert.notEqual(start, -1, "fetchMerklCampaignsBySymbol must exist");
    assert.notEqual(end, -1, "FetchOpportunitiesParams must follow fetchMerklCampaignsBySymbol");
    const body = source.slice(start, end);

    assert.match(body, /url\.searchParams\.set\('mainProtocolId', PROTOCOL_ID\);/);
    assert.match(body, /url\.searchParams\.set\('tokenSymbol', tokenSymbol\);/);
    assert.match(body, /url\.searchParams\.set\('chainId', String\(chainId\)\);/);
    assert.match(body, /campaigns\.filter\(\(campaign\) => campaignMatchesChain\(campaign, chainId\)\)/);
    assert.match(marketSource, /const chainId = resolvedSetup\.chainId;/);
    assert.match(marketSource, /resolvedSetup\.environment === "production-mainnet"/);
    assert.doesNotMatch(
        marketSource,
        /chain_config\[resolvedSetup\.chain\]\?\.chainId/,
        "Market boot should pass Merkl the setup snapshot chainId instead of exported chain config",
    );
    assert.doesNotMatch(
        marketSource,
        /chain_config\[resolvedSetup\.chain\]\?\.environment/,
        "Market boot should use the setup snapshot environment for production-only boot checks",
    );
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

test("CToken DEX execution paths stay behind the market-bound adapter getter", () => {
    const source = readRepoFile("src/classes/CToken.ts");
    const zapperSource = readRepoFile("src/classes/Zapper.ts");
    const nativeTokenSource = readRepoFile("src/classes/NativeToken.ts");
    const directStaticDexReads = [...source.matchAll(/currentChainConfig\.dexAgg/g)].map((match) => match.index);

    assert.equal(
        directStaticDexReads.length,
        0,
        "CToken should not fall back to mutable chain_config.dexAgg for route discovery or execution",
    );
    assert.match(source, /private get boundDexAgg\(\): IDexAgg \| null \{ return this\.market\.dexAgg \?\? null; \}/);
    assert.match(source, /DEX aggregator is not bound for token/);
    assert.match(source, /private get currentChainAssets\(\) \{ return this\.setup\.assets; \}/);
    assert.match(source, /const chainSettings = this\.currentChainAssets;/);
    assert.match(source, /\? this\.currentChainAssets\.wrapped_native/);
    assert.doesNotMatch(
        source,
        /currentChainConfig\.(wrapped_native|native_vaults|vaults)/,
        "CToken route and vault/native asset logic should use the setup snapshot, not mutable exported chain config",
    );
    assert.match(source, /const supportsNativeVaultZaps =[\s\S]{0,160}?nativeVaultZapper\.toLowerCase\(\) !== EMPTY_ADDRESS\.toLowerCase\(\);/);
    assert.match(source, /const supportsVaultZaps =[\s\S]{0,160}?vaultZapper\.toLowerCase\(\) !== EMPTY_ADDRESS\.toLowerCase\(\);/);
    assert.match(source, /const router = this\.boundDexAgg\?\.router;/);
    assert.match(source, /typeof router === "string" && router\.toLowerCase\(\) !== EMPTY_ADDRESS\.toLowerCase\(\)/);
    assert.match(source, /const supportsSimpleZaps =[\s\S]{0,240}?this\.hasExecutableDexRoute;/);
    assert.match(source, /if\(supportsNativeVaultZaps && this\.isNativeVault\) this\.zapTypes\.push\('native-vault'\);/);
    assert.match(source, /if\(supportsVaultZaps && this\.isVault\) this\.zapTypes\.push\('vault'\);/);
    assert.match(source, /if\(supportsSimpleZaps\) this\.zapTypes\.push\('simple'\);/);
    assert.match(source, /if\(supportsSimpleZaps && "simplePositionManager" in this\.market\.plugins\) this\.leverageTypes\.push\('simple'\);/);
    assert.match(source, /if\(this\.zapTypes\.includes\('simple'\) && this\.hasExecutableDexRoute\)/);
    const nativeTokenConstructorArgs = [...source.matchAll(/new NativeToken\(([\s\S]*?)\)/g)]
        .map((match) => match[1] ?? "");
    assert.ok(nativeTokenConstructorArgs.length > 0, "CToken should construct native token helpers");
    for (const args of nativeTokenConstructorArgs) {
        assert.match(
            args,
            /this\.currentChainAssets/,
            "Every CToken-created NativeToken should use setup snapshot metadata",
        );
    }
    assert.match(nativeTokenSource, /nativeMetadata\?: NativeTokenMetadata/);
    assert.match(nativeTokenSource, /const metadata = nativeMetadata \?\? chain_config\[chain\]/);
    assert.doesNotMatch(
        source,
        /(?:const|let|var)\s+\w+\s*=\s*this\.currentChainConfig[\s\S]{0,400}?\w+\.dexAgg\.quoteAction/,
    );
    assert.match(
        source,
        /new Zapper\(zap_contract,\s*signer,\s*type,\s*this\.setup,\s*this\.currentDexAgg\)/,
    );
    assert.doesNotMatch(
        zapperSource,
        /getChainConfig/,
        "Zapper should not fall back to mutable chain config for DEX routing",
    );
    assert.match(zapperSource, /constructor\(address: address, signer: curvance_signer, type: ZapperTypes, setup: SetupConfigSnapshot, dexAgg: IDexAgg\)/);
    assert.match(zapperSource, /requires a setup-bound DEX aggregator/);
    assert.doesNotMatch(zapperSource, /config\.dexAgg\.quote/);
    assert.match(zapperSource, /this\.dexAgg\.quote/);
    assert.match(zapperSource, /const wrappedNative = this\.setup\.assets\.wrapped_native;/);
    assert.match(zapperSource, /outputToken\.toLowerCase\(\) === wrappedNative\.toLowerCase\(\)/);
    assert.doesNotMatch(
        zapperSource,
        /config\.wrapped_native/,
        "Zapper native/wrapped calldata should use the setup snapshot, not mutable exported chain config",
    );
});

test("setupChain refreshes token route metadata after binding the context DEX adapter", () => {
    const source = readRepoFile("src/setup.ts");

    assert.match(
        source,
        /const dexAgg = bindDexAggContext\(chain_config\[chain\]\.dexAgg,[\s\S]*?for \(const market of markets\) \{[\s\S]*?market\.dexAgg = dexAgg;[\s\S]*?for \(const token of market\.tokens \?\? \[\]\) \{[\s\S]*?token\.refreshRouteCapabilities\?\.\(\);[\s\S]*?\}/,
    );
});

test("setupChain result types expose typed global milestone data", () => {
    const source = readRepoFile("src/setup.ts");
    const classesIndex = readRepoFile("src/classes/index.ts");

    assert.match(source, /import type \{ MilestoneResponse \} from "\.\/classes\/Api";/);
    assert.match(source, /global_milestone: MilestoneResponse \| null;/);
    assert.match(classesIndex, /export \* from '\.\/Api';/);
});

test("portfolio snapshots read market provenance from setup snapshots", () => {
    const source = readRepoFile("src/integrations/snapshot.ts");

    assert.match(source, /const chainId = market\.setup\.chainId;/);
    assert.doesNotMatch(
        source,
        /chain_config/,
        "Snapshot chain ids should come from each market setup snapshot, not exported chain config",
    );
});

test("MultiDex route advertisement uses an executable child router", () => {
    const source = readRepoFile("src/classes/DexAggregators/MultiDexAgg.ts");

    assert.match(source, /get router\(\): address \{ return this\.executablePrimary\.router; \}/);
    assert.match(source, /get dao\(\): address \{ return this\.executablePrimary\.dao; \}/);
    assert.match(
        source,
        /this\.aggregators\.find\(\(agg\) => agg\.router\.toLowerCase\(\) !== EMPTY_ADDRESS\.toLowerCase\(\)\) \?\? this\.primary/,
    );
});

test("MultiDex token dedupe preserves the first quoteable duplicate route", () => {
    const source = readRepoFile("src/classes/DexAggregators/MultiDexAgg.ts");
    const body = extractBlock(source, "async getAvailableTokens");

    assert.match(body, /const seen = new Map<string, number>\(\);/);
    assert.match(body, /const existingIndex = seen\.get\(addr\);/);
    assert.match(body, /seen\.set\(addr, tokens\.length\);/);
    assert.match(
        body,
        /tokens\[existingIndex\]\?\.quote == undefined && token\.quote != undefined[\s\S]*?tokens\[existingIndex\] = token;/,
    );
});

test("market preview paths reject foreign token objects before reader RPC", () => {
    const source = readRepoFile("src/classes/Market.ts");
    const guardedMethods = [
        "async previewAssetImpact",
        "async previewPositionHealthLeverageDown",
        "async previewPositionHealthLeverageUp",
        "async previewPositionHealthDepositAndLeverage",
        "async previewPositionHealth(",
        "async previewPositionHealthRedeem",
        "async previewPositionHealthBorrow",
        "async previewPositionHealthRepay",
    ];

    assert.match(source, /private assertTokenBelongsToMarket/);
    const guard = extractBlock(source, "private assertTokenBelongsToMarket");
    assert.match(guard, /if \(tokenMarket === this\)/);
    assert.match(guard, /sameReaderDeployment/);
    assert.match(guard, /tokenReaderKey != null && tokenReaderKey === readerKey/);
    assert.doesNotMatch(
        guard,
        /tokenChain == null \|\| marketChain == null/,
        "market token guard must not allow detached sibling market objects only because chain provenance is missing",
    );
    for (const method of guardedMethods) {
        const body = extractBlock(source, method);
        assert.match(body, /this\.assertTokenBelongsToMarket\(/, `${method} must validate token ownership`);
    }
});

test("CToken leverage paths reject foreign borrow tokens before snapshots and quotes", () => {
    const source = readRepoFile("src/classes/CToken.ts");
    const guardedHelpers = [
        "private async _getLeverageSnapshot",
        "private assertSimpleLeverageSwapAssetsDiffer",
        "private async assertLeverageBorrowCapacity",
        "private assertSelectedBorrowDebtCanDeleverage",
        "previewLeverageDown(",
    ];

    assert.match(source, /private assertBorrowTokenBelongsToMarket/);
    const guard = extractBlock(source, "private assertBorrowTokenBelongsToMarket");
    assert.match(guard, /if \(borrowMarket === this\.market\)/);
    assert.match(guard, /sameReaderDeployment/);
    assert.match(guard, /borrowReaderKey != null && borrowReaderKey === collateralReaderKey/);
    assert.doesNotMatch(
        guard,
        /borrowChain == null \|\| collateralChain == null/,
        "borrow-token guard must not allow detached sibling market objects only because chain provenance is missing",
    );
    assert.match(
        source,
        /private resolveLeverageUpPreview\(\{[\s\S]*?\}: ResolveLeverageUpPreviewParams\): LeverageUpPreview \{\s*this\.assertBorrowTokenBelongsToMarket\(borrow\);/,
        "resolveLeverageUpPreview must validate borrow token ownership",
    );
    for (const method of guardedHelpers) {
        const body = extractBlock(source, method);
        assert.match(body, /this\.assertBorrowTokenBelongsToMarket\(/, `${method} must validate borrow token ownership`);
    }

    for (const method of ["async leverageUp", "async leverageDown", "async depositAndLeverage"]) {
        const body = extractBlock(source, method);
        const firstSignerOrApproval = body.search(/this\.requireSigner\(|ensureUnderlyingAmount|_checkTokenApproval|_getLeverageSnapshot|quoteAction/);
        assert.notEqual(firstSignerOrApproval, -1, `${method} should have an execution boundary`);
        const preflight = body.slice(0, firstSignerOrApproval);
        assert.match(preflight, /this\.assertBorrowTokenBelongsToMarket\(/, `${method} must guard before execution work`);
    }
});

test("ProtocolReader token-object wrappers reject foreign market tokens before contract reads", () => {
    const source = readRepoFile("src/classes/ProtocolReader.ts");
    const guardedMethods = [
        "async maxRedemptionOf",
        "async hypotheticalRedemptionOf",
        "async hypotheticalBorrowOf",
        "async hypotheticalLeverageOf",
    ];

    assert.match(source, /private assertTokenBelongsToReader/);
    const guard = extractBlock(source, "private assertTokenBelongsToReader");
    assert.match(guard, /if \(tokenReader === this\)/);
    assert.match(guard, /tokenReaderKey != null && tokenReaderKey === readerKey/);
    assert.doesNotMatch(
        guard,
        /address\.toLowerCase\(\)/,
        "reader guard must not treat same raw reader addresses as equivalent without a deployment key",
    );
    for (const method of guardedMethods) {
        const body = extractBlock(source, method);
        assert.match(body, /this\.assertTokenBelongsToReader\(/, `${method} must validate token reader provenance`);
    }
});

test("Market cooldown batching accepts only same reader instance or deployment key", () => {
    const source = readRepoFile("src/classes/Market.ts");
    const body = extractBlock(source, "async multiHoldExpiresAt");

    assert.match(body, /market\.reader === this\.reader/);
    assert.match(body, /marketReaderKey != null && marketReaderKey === readerKey/);
    assert.match(body, /Cannot batch cooldowns across chains/);
    assert.match(body, /Cannot batch cooldowns across different ProtocolReader deployments/);
    assert.doesNotMatch(
        body,
        /reader\.address\.toLowerCase\(\)/,
        "cooldown batching must not treat same raw ProtocolReader addresses as equivalent without a deployment key",
    );
});

test("Zapper direct helper paths reject foreign CToken objects before calldata or quotes", () => {
    const source = readRepoFile("src/classes/Zapper.ts");
    const guardedMethods = [
        "async nativeZap",
        "async simpleZap",
        "async getSimpleZapCalldata",
        "async getVaultZapCalldata",
        "async getZapVaultData",
        "async getNativeZapCalldata",
    ];

    assert.match(source, /private assertCTokenBelongsToSetup/);
    const guard = extractBlock(source, "private assertCTokenBelongsToSetup");
    assert.match(guard, /tokenMarket\.setup === this\.setup/);
    assert.match(guard, /without the same setup snapshot/);
    assert.doesNotMatch(
        guard,
        /tokenChain == null \|\| tokenChain === this\.setup\.chain/,
        "zapper setup guard must require the same setup snapshot instead of accepting missing or same-chain-only provenance",
    );
    for (const method of guardedMethods) {
        const body = extractBlock(source, method);
        assert.match(body, /this\.assertCTokenBelongsToSetup\(ctoken\);/, `${method} must validate CToken setup provenance`);
    }
});

test("PositionManager vault share helper rejects mixed-market token objects before amount scaling", () => {
    const source = readRepoFile("src/classes/PositionManager.ts");
    const body = extractBlock(source, "static async getVaultExpectedShares");
    const guardIndex = body.indexOf("PositionManager.assertVaultExpectedSharesTokensMatch(deposit_ctoken, borrow_ctoken);");
    const amountIndex = body.indexOf("FormatConverter.decimalToBigInt");
    const guard = extractBlock(source, "private static assertVaultExpectedSharesTokensMatch");

    assert.match(source, /private static assertVaultExpectedSharesTokensMatch/);
    assert.match(guard, /if \(depositMarket === borrowMarket\)/);
    assert.match(guard, /sameReaderDeployment/);
    assert.match(guard, /depositReaderKey != null && depositReaderKey === borrowReaderKey/);
    assert.doesNotMatch(
        guard,
        /depositChain == null \|\| borrowChain == null/,
        "vault expected-share guard must not allow detached sibling market objects only because chain provenance is missing",
    );
    assert.notEqual(guardIndex, -1, "getVaultExpectedShares must validate token provenance");
    assert.notEqual(amountIndex, -1, "getVaultExpectedShares must scale the borrow amount after validation");
    assert.ok(guardIndex < amountIndex, "token provenance guard must run before borrow-token decimals are used");
});

test("LendingOptimizer default construction prefers an asset-bound provider over moved setup globals", () => {
    const source = readRepoFile("src/classes/LendingOptimizer.ts");
    const constructorBody = extractBlock(source, "constructor(");

    assert.match(constructorBody, /const assetProvider = \(asset as ERC20 & \{ provider\?: curvance_read_provider \}\)\.provider;/);
    assert.match(constructorBody, /const assetSigner = provider == null && assetProvider != null/);
    assert.match(constructorBody, /assetProvider \?\? defaultReadProvider/);
    assert.match(constructorBody, /const canInheritDefaultSigner = provider == null && \(assetProvider == null \|\| assetProvider === defaultReadProvider\);/);
    assert.match(constructorBody, /signer \?\? legacySigner \?\? assetSigner \?\?/);
});

test("market-level user-cache reads stay behind full-user freshness guards", () => {
    const source = readRepoFile("src/classes/Market.ts");
    const hasUserActivity = extractBlock(source, "hasUserActivity()");

    assert.doesNotMatch(source, /\bctoken\.cache\.user(?:Collateral|Debt|ShareBalance|AssetBalance)\b/);
    assert.match(hasUserActivity, /this\.requireFullUserTokenData\("determining user activity"\);/);
    assert.match(hasUserActivity, /token\.cache\.userCollateral/);
    assert.match(hasUserActivity, /token\.cache\.userDebt/);
});

test("market refresh token rows fail closed on duplicate addresses before applying state", () => {
    const source = readRepoFile("src/classes/Market.ts");
    const applyState = extractBlock(source, "applyState(");
    const refreshTokenRows = source.match(
        /private requireRefreshTokenRows[\s\S]*?return rowsByAddress;\s*\n    }/,
    )?.[0] ?? "";

    assert.match(refreshTokenRows, /rowsByAddress\.has\(key\)/);
    assert.match(refreshTokenRows, /Duplicate \$\{label\} token data/);
    assert.doesNotMatch(
        refreshTokenRows,
        /new Map\(rows\.map/,
        "refresh token validation must not collapse duplicate rows before checking for missing token data",
    );
    assert.match(applyState, /this\.validateStateRows\(dynamicData, userData\);/);
});
