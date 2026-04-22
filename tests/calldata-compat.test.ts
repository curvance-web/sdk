import assert from "node:assert/strict";
import test from "node:test";
import { Calldata } from "../src/classes/Calldata";

const ADDRESS = "0x00000000000000000000000000000000000000aa";

class LegacyProviderBackedCalldata extends Calldata<{}> {
    address = ADDRESS as any;
    override provider: any;
    contract = {
        interface: {
            encodeFunctionData: () => "0xdeadbeef",
        },
    } as any;

    constructor(provider: any) {
        super();
        this.provider = provider;
    }
}

test("Calldata preserves legacy provider-as-signer subclasses", async () => {
    const calls: any[] = [];
    const legacySigner = {
        address: "0x0000000000000000000000000000000000000abc",
        sendTransaction: async (tx: any) => {
            calls.push(tx);
            return { hash: "0x1" };
        },
        call: async (tx: any) => {
            calls.push({ simulated: true, ...tx });
            return "0x";
        },
    };

    const calldata = new LegacyProviderBackedCalldata(legacySigner);
    const tx = await calldata.executeCallData("0xfeed" as any, { value: 123n });
    const simulation = await calldata.simulateCallData("0xfeed" as any, { value: 456n });

    assert.deepEqual(tx, { hash: "0x1" });
    assert.deepEqual(simulation, { success: true });
    assert.deepEqual(calls, [
        {
            to: ADDRESS,
            data: "0xfeed",
            value: 123n,
        },
        {
            simulated: true,
            to: ADDRESS,
            data: "0xfeed",
            from: legacySigner.address,
            value: 456n,
        },
    ]);
});
