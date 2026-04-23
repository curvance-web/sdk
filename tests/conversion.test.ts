import { config } from 'dotenv';
config({ quiet: true });
import { test, describe } from 'node:test';
import assert from 'node:assert';
import FormatConverter from '../src/classes/FormatConverter';
import { Decimal } from 'decimal.js';
import { BPS, BPS_SQUARED, RAY, WAD, WAD_BPS, WAD_CUBED_BPS_OFFSET, WAD_SQUARED } from '../src/helpers';


describe('Conversions', () => {
    test('Bigint to USD', function() {
        const usd_bigint = BigInt(500e18);
        const usd_value = FormatConverter.bigIntToUsd(usd_bigint);
        assert.strictEqual(usd_value.toFixed(2), '500.00');
    });

    test('USD to bigint', function() {
        const usd_value = Decimal(12);
        const usd_price = Decimal(0.22);
        const decimals = 6;

        const usd_bigint = FormatConverter.usdToBigIntTokens(usd_value, usd_price, decimals);
        assert.strictEqual(usd_bigint.toString(), '54545454');
    });

    test('USD to token input', function() {
        const usd_value = Decimal(12);
        const usd_price = Decimal(0.22);
        const decimals = 6;

        const token_input = FormatConverter.usdToDecimalTokens(usd_value, usd_price, decimals);
        assert.strictEqual(token_input.toFixed(6), '54.545454');
    });

    test('BigInt Tokens to USD', function() {
        const tokens = BigInt(1000e6);
        const price = BigInt(0.75 * 1e18);
        const decimals = 6;

        const usd_value = FormatConverter.bigIntTokensToUsd(tokens, price, decimals);
        assert.strictEqual(usd_value.toFixed(2), '750.00');
    })

    test('Decimal Tokens to USD', function() {
        const tokens = new Decimal('1000.50');
        const price = new Decimal('0.75');

        const usd_value = FormatConverter.decimalTokensToUsd(tokens, price);
        assert.strictEqual(usd_value.toFixed(2), '750.38');
    });

    test('Bigint to token input', function() {
        const tokens = BigInt(1000e6);
        const decimals = 6;

        const token_input = FormatConverter.bigIntToDecimal(tokens, decimals);
        assert.strictEqual(token_input.toFixed(2), '1000.00');
    });

    test('Decimal to bigint', function() {
        const token_input = new Decimal('250.75');
        const decimals = 8;

        const bigint_value = FormatConverter.decimalToBigInt(token_input, decimals);
        assert.strictEqual(bigint_value.toString(), '25075000000');
    });

    test('Percentage to BPS', function() {
        const percentage = new Decimal('0.005'); // 0.5%
        const bps = FormatConverter.percentageToBps(percentage);
        assert.strictEqual(bps.toString(), '50');
    });

    test('Percentage to BPS-WAD', function() {
        const percentage = new Decimal('0.005'); // 0.5%
        const bps_wad = FormatConverter.percentageToBpsWad(percentage);
        assert.strictEqual(bps_wad.toString(), '5000000000000000');
    });

    test('Bps to BPS-WAD', function() {
        const bps = BigInt(50);
        const bps_wad = FormatConverter.bpsToBpsWad(bps);
        assert.strictEqual(bps_wad.toString(), '5000000000000000');
    });

    test('Token as one token to another', function() {
        const tokenA = {
            price: new Decimal('2.00'),
            decimals: 6n,
            amount: new Decimal('150.50')
        };

        const tokenB = {
            price: new Decimal('0.50'),
            decimals: 18n
        };

        const tokenB_amount = FormatConverter.tokensToTokens(tokenA, tokenB, true);
        assert.strictEqual(tokenB_amount.equals(new Decimal(602)), true);
    });

    test('exported fixed-point constants are exact bigints', function() {
        assert.strictEqual(BPS, 10_000n);
        assert.strictEqual(BPS_SQUARED, 100_000_000n);
        assert.strictEqual(WAD, 1_000_000_000_000_000_000n);
        assert.strictEqual(WAD_BPS, 10_000_000_000_000_000_000_000n);
        assert.strictEqual(RAY, 1_000_000_000_000_000_000_000_000_000n);
        assert.strictEqual(WAD_SQUARED.toString(), `1${"0".repeat(36)}`);
        assert.strictEqual(WAD_CUBED_BPS_OFFSET.toString(), `1${"0".repeat(50)}`);
    });
});
