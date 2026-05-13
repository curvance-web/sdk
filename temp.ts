import { Contract, JsonRpcProvider } from 'ethers';
import { address, contractSetup, ERC20, LendingOptimizer, OptimizerReader } from './src';
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
const lend_optimizer           = contracts.Optimizers['cAUSD+'] as address;
const ec_address               = "0x379D4a8FBc23A8Fd8c2b3738Dbf1fEBe9a64399c";
const rebalancer_wallet        = "0xD21DC65f42fB039A1c403a38C18C2731211eCBC7";
// New OptimizerReader with cap buffer + optimalRebalanceAt projection.
const optimizer_reader_address = "0xc40d006435ea90E60e08D16066343E970652E3f4" as address;
// Slippage band (BPS) around each market's ideal allocation.
const slippage_bps             = 100n;

async function main() {
    const snapshot_id = await provider.send("evm_snapshot", []) as number;
    const seed_amount = new Decimal(10_000n);
    const seed_amount_bn = FormatConverter.decimalToBigInt(seed_amount, 6n);

    try {
        // Setup perms & gas, remove market perms
        {
            await provider.send("anvil_setBalance", [ec_address, FormatConverter.decimalToBigInt(Decimal(10_000), 18n).toString()]);
            await provider.send("anvil_setBalance", [rebalancer_wallet, FormatConverter.decimalToBigInt(Decimal(10_000), 18n).toString()]);
        }

        // Seed the wallet with aUSD
        {
            const signer = await impersonate(steal_money_from);
            const ausd = new ERC20(signer, ausd_address);
            const balance_before = await ausd.balanceOf(me_address);
            console.log(`Seed Balance before: ${balance_before}`);

            await ausd.rawTransfer(ec_address, 77777n);
            await ausd.transfer(me_address, seed_amount);
            console.log(`Seed Transferred ${seed_amount} aUSD (${seed_amount_bn} raw)`);
        }

        // Deposit with my wallet
        {
            const signer = await impersonate(me_address);
            const ausd = new ERC20(signer, ausd_address);
            const optimizer = contractSetup(signer, lend_optimizer, [
                "function deposit(uint256 assets, address receiver) external returns (uint256 shares)"
            ]) as Contract & {
                deposit(assets: bigint, receiver: string): Promise<{ shares: bigint }>;
            };

            console.log(`AUSD balance before deposit: ${await ausd.balanceOf(me_address)}`);
            await ausd.approve(lend_optimizer, null);
            await optimizer.deposit(seed_amount_bn, me_address);
            console.log(`Deposited ${seed_amount} aUSD into the optimizer`);
            console.log(`AUSD balance after deposit: ${await ausd.balanceOf(me_address)}`);
        }

        // Rebalance. optimalRebalance == optimalRebalanceAt(_, _, block.timestamp),
        // which is the safe default — forward projection adds no real benefit
        // beyond the cap buffer and risks reverts on full-drain / bad-market
        // scenarios.
        {
            const signer = await impersonate(rebalancer_wallet);
            const reader = new OptimizerReader(optimizer_reader_address, provider);

            const instructions = await reader.optimalRebalance(lend_optimizer, slippage_bps);
            console.log("Optimal Rebalance Actions:");
            console.log(instructions.actions);
            console.log("Allocation Bounds:");
            console.log(instructions.bounds);

            const optimizer = new LendingOptimizer(lend_optimizer, new ERC20(signer, ausd_address), provider, signer);
            await optimizer.rebalance(instructions);
        }
    } catch (err) {
        console.error("Error during execution:", err);
    }

    provider.send("evm_revert", [snapshot_id]);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});