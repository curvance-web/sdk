import { JsonRpcProvider, toBeHex, Wallet } from 'ethers';
import { Block } from 'ethers';
import { ChainRpcPrefix } from '../../src/helpers';
import { TestFramework } from './TestFramework';
import { setupChain } from '../../src/setup';

export const MARKET_HOLD_PERIOD_SECS = 1200; // 20 minutes
const TEST_RPC_PREFLIGHT_TIMEOUT_MS = Number(process.env.TEST_RPC_PREFLIGHT_TIMEOUT_MS ?? 10_000);

const fresh = Wallet.createRandom();
export const TEST_ACCOUNTS = [
    { account_name: 'DEPLOYER', account_pk: process.env.DEPLOYER_PRIVATE_KEY as string },
    { account_name: 'FRESH', account_pk: fresh.privateKey as string },
];

// Utility function to fast forward time on Anvil
export async function fastForwardTime(provider: JsonRpcProvider, seconds: number) {
    // Increase time by the specified amount
    await provider.send('evm_increaseTime', [seconds]);
    await mineBlock(provider);
}

export async function mineBlock(provider: JsonRpcProvider) {
    const beforeBlock = await provider.getBlock('latest');

    await provider.send('evm_mine', []);

    let newBlock: Block | null = null;
    do {
        newBlock = await provider.getBlock('latest');
        if(newBlock?.number == beforeBlock?.number) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    } while (beforeBlock?.number === newBlock?.number);
}

export async function setNativeBalance(provider: JsonRpcProvider, targetAddress: string, amount: bigint) {
    const haxAmount = toBeHex(amount);
    await provider.send("anvil_setBalance", [targetAddress, haxAmount]);
    await mineBlock(provider);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeout != null) {
            clearTimeout(timeout);
        }
    }
}

export const getTestSetup = async (private_key: string) => {
    const provider = new JsonRpcProvider(process.env.TEST_RPC);
    const wallet = new Wallet(private_key, provider);
    let startingNonce: number;

    try {
        await withTimeout(
            provider.send('eth_chainId', []),
            TEST_RPC_PREFLIGHT_TIMEOUT_MS,
            `TEST_RPC preflight (${process.env.TEST_RPC})`,
        );
        startingNonce = await withTimeout(
            wallet.getNonce('latest'),
            TEST_RPC_PREFLIGHT_TIMEOUT_MS,
            `TEST_RPC nonce read (${process.env.TEST_RPC})`,
        );
    } catch (error) {
        provider.destroy();
        throw error;
    }

    return {
        provider,
        signer: new NonceManagerSigner(wallet, startingNonce)
    };
}

export const getRpcUrl = (chain_prefix: ChainRpcPrefix) => {
    return `https://${chain_prefix}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
}


export class NonceManagerSigner extends Wallet {
    private currentNonce: number;
    
    constructor(baseSigner: Wallet, startingNonce: number) {
        super(baseSigner.privateKey, baseSigner.provider);
        this.currentNonce = startingNonce;
    }
    
    override async sendTransaction(transaction: any) {
        if (!transaction.nonce) {
            transaction.nonce = this.currentNonce++;
        }

        try {
            const tx = await super.sendTransaction(transaction);
            return tx;
        } catch (error) {
            this.currentNonce--;
            throw error;
        }
    }
}
