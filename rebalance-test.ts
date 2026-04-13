import { Contract, JsonRpcProvider } from 'ethers';
import { address, contractSetup, ERC20 } from './src';
import FormatConverter from './src/classes/FormatConverter';
import Decimal from 'decimal.js';
import contracts from "./src/contracts/monad-mainnet.json"

const provider = new JsonRpcProvider('http://localhost:8545');

const impersonate = async (address: string) => {
    await provider.send("anvil_impersonateAccount", [address]);
    return provider.getSigner(address);
}

const steal_money_from         = "0x4A4593C5D963473A95f0762Bd6dF4571542AF651";
const me_address               = "0xe2165a834F93C39483123Ac31533780b9c679ed4";  // divey.eth
const ausd_address             = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const lend_optimizer           = contracts.Optimizers['AUSD-Test'] as address;
const ec_address               = "0x379D4a8FBc23A8Fd8c2b3738Dbf1fEBe9a64399c";
const central_registry_address = "0x1310f352f1389969Ece6741671c4B919523912fF";
const rebalancer_wallet        = "0xBAaf22d2Bc4Ac001BBDDA7De73d3ae1bA71dfDDB";

async function main() {
    const seed_amount = new Decimal(10_000n);
    const seed_amount_bn = FormatConverter.decimalToBigInt(seed_amount, 6n);

    // Setup perms & gas
    {
        await provider.send("anvil_setBalance", [ec_address, FormatConverter.decimalToBigInt(Decimal(10_000), 18n).toString()]);
        await provider.send("anvil_setBalance", [rebalancer_wallet, FormatConverter.decimalToBigInt(Decimal(10_000), 18n).toString()]);
        const signer = await impersonate(ec_address);
        const central_registry = contractSetup(signer, central_registry_address, [
            "function addMarketPermissions(address newAddress) external"
        ]) as Contract & {
            addMarketPermissions(address: string): Promise<void>;
        };

        await central_registry.addMarketPermissions(me_address);
        await central_registry.addMarketPermissions(rebalancer_wallet);
    }

    // Seed the wallet with aUSD
    {
        const signer = await impersonate(steal_money_from);
        const ausd = new ERC20(signer, ausd_address);
        const balance_before = await ausd.balanceOf(me_address);
        console.log(`Seed Balance before: ${balance_before}`);

        await ausd.transfer(me_address, seed_amount);
        console.log(`Seed Transferred ${seed_amount} aUSD (${seed_amount_bn} raw)`);
    }

    // Initialize deposits & deposit into the optimizer
    const signer = await impersonate(me_address);
    const ausd = new ERC20(signer, ausd_address);
    const optimizer = contractSetup(signer, lend_optimizer, [
        "function initializeDeposits(address targetMarket) external",
        "function deposit(uint256 assets, address receiver) external returns (uint256 shares)"
    ]) as Contract & {
        initializeDeposits(targetMarket: string): Promise<void>;
        deposit(assets: bigint, receiver: string): Promise<{ shares: bigint }>;
    };
    await ausd.approve(lend_optimizer, null);
    await Promise.all([
        optimizer.initializeDeposits("0xfD493ce1A0ae986e09d17004B7E748817a47d73c"), // sAUSD | AUSD
        optimizer.initializeDeposits("0xAd4AA2a713fB86FBb6b60dE2aF9E32a11DB6Abf2"), // earnAUSD | AUSD
        optimizer.initializeDeposits("0x6E182EB501800C555bd5E662E6D350D627F504D8"), // WMON | AUSD
        optimizer.initializeDeposits("0x8E94704607E857eB3E10Bd21D90bf8C1Ecba0452"), // syzUSD | AUSD
        optimizer.initializeDeposits("0x88e0994E8130EF72bf614CBBcF722839B167c8d1"), // wsrUSD | AUSD
        optimizer.initializeDeposits("0xcdc9D2c4EaD8f2A9FD3D6F5a00bA4e6001ab7898"), // YZM | AUSD
        optimizer.initializeDeposits("0x4806902Ec0320e5334c2B2679FFB58C830348F1c"), // vUSD | AUSD
    ]);

    console.log(`AUSD balance before deposit: ${await ausd.balanceOf(me_address)}`);
    await optimizer.deposit(seed_amount_bn, me_address);
    console.log(`Deposited ${seed_amount} aUSD into the optimizer`);
    console.log(`AUSD balance after deposit: ${await ausd.balanceOf(me_address)}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});