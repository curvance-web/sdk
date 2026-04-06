"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const decimal_js_1 = __importDefault(require("decimal.js"));
class FormatConverter {
    /**
     * USD is always done with 18 decimals of precision.
     * @param value The bigint value to convert
     * @returns The USD representation of the bigint value
     */
    static bigIntToUsd(value) {
        return FormatConverter.bigIntToDecimal(value, 18);
    }
    static bigIntTokensToUsd(tokens, price, decimals) {
        if (typeof decimals === 'bigint') {
            decimals = Number(decimals);
        }
        const decimalTokens = FormatConverter.bigIntToDecimal(tokens, decimals);
        const decimalPrice = FormatConverter.bigIntToUsd(price);
        return decimalTokens.mul(decimalPrice).toDecimalPlaces(decimals, decimal_js_1.default.ROUND_DOWN);
    }
    static tokensToTokens(from, to, formatted) {
        const from_value_usd = FormatConverter.decimalTokensToUsd(from.amount, from.price);
        const to_amount = FormatConverter.usdToDecimalTokens(from_value_usd, to.price, to.decimals);
        return formatted ? to_amount : FormatConverter.decimalToBigInt(to_amount, to.decimals);
    }
    /**
     * Convert Decimal representation of tokens to USD representation.
     * @param tokens - The amount of tokens in Decimal representation
     * @param price - The price of a single token in USD (Decimal representation)
     * @returns The equivalent amount in USD
     */
    static decimalTokensToUsd(tokens, price) {
        return tokens.mul(price).toDecimalPlaces(18, decimal_js_1.default.ROUND_DOWN);
    }
    /**
     * Return the Decimal representation of a USD value given price and decimals.
     * @param value - USD value of tokens
     * @param price - Price of single token in USD (Decimal or bigint)
     * @param decimals - Number of decimals for the token
     * @returns - The Decimal representation of the token amount
     */
    static usdToDecimalTokens(value, price, decimals) {
        if (!decimal_js_1.default.isDecimal(price)) {
            price = this.bigIntToUsd(price);
        }
        if (typeof decimals === 'bigint') {
            decimals = Number(decimals);
        }
        return value.div(price).toDecimalPlaces(decimals, decimal_js_1.default.ROUND_DOWN);
    }
    /**
     * Return the bigint representation of a USD value given price and decimals.
     * @param value - USD value of tokens
     * @param price - Price of single token in USD (Decimal or bigint)
     * @param decimals - Number of decimals for the token
     * @returns The bigint representation of the token amount
     */
    static usdToBigIntTokens(value, price, decimals) {
        return FormatConverter.decimalToBigInt(FormatConverter.usdToDecimalTokens(value, price, decimals), decimals);
    }
    /**
     * Formats a bigint value into Decimal with the given amount of precision.
     * @param value The bigint value to convert
     * @param decimals The number of decimal places
     * @returns The Decimal representation of the bigint value
     */
    static bigIntToDecimal(value, decimals) {
        if (typeof decimals === 'bigint') {
            decimals = Number(decimals);
        }
        const decimalValue = new decimal_js_1.default(value.toString());
        const scale = new decimal_js_1.default(10).pow(decimals);
        return decimalValue.div(scale).toDecimalPlaces(decimals, decimal_js_1.default.ROUND_DOWN);
    }
    /**
     * Takes a TokenInput (Decimal) and converts it to bigint based on the token's decimals.
     * @param value - The TokenInput value to convert
     * @param decimals - The number of decimal places for the token
     * @returns The bigint representation of the TokenInput value
     */
    static decimalToBigInt(value, decimals) {
        if (!decimal_js_1.default.isDecimal(value)) {
            throw new Error("Value must be a Decimal instance");
        }
        if (typeof decimals === 'bigint') {
            decimals = Number(decimals);
        }
        const scaled = value.mul((0, decimal_js_1.default)(10).pow(decimals));
        // Use floor() to truncate, then toFixed() to avoid scientific notation
        return BigInt(scaled.floor().toFixed(0));
    }
    /**
     * Converts basis points (BPS) to BPS in WAD format.
     1 BPS = 0.0001 = 1e-4
     1 BPS in WAD = 1e-4 * 1e18 = 1e14

     10,000 BPS = 1 = 1e0
     10,000 BPS in WAD = 1 * 1e18 = 1e18

     Therefore, to convert BPS to BPS-WAD, we multiply by 1e18 and divide by 10,000.

     (1 BPS * 1e18) / 10,000 = 1e14

     (10,000 BPS * 1e18) / 10,000 = 1e18

     This confirms the conversion is correct.

     0.5% = 50 BPS
     50 BPS in WAD = (50 * 1e18) / 10,000 = 5e15

     * Example:
     * 50 BPS = 0.5%
     * 50 BPS in WAD = 5,000,000,000,000,000 (5e15)
     * @param value - value in BPS
     * @returns The BPS value in WAD format
     */
    static bpsToBpsWad(value) {
        return (value * BigInt(1e18)) / 10000n;
    }
    /**
     * Take a percentage value (Decimal) and convert it to BPS (bigint).
     1% = 0.01 = 100 BPS
     Therefore, to convert a percentage to BPS, we multiply by 10,000.

     * Example:
     * 0.5% = 0.005
     * 0.005 * 10,000 = 50 BPS
     * @param value - percentage decimal value
     * @returns The BPS value as a bigint
     */
    static percentageToBps(value) {
        return BigInt(value.mul(10_000).toFixed(0));
    }
    /**
     * Take a percentage value (Decimal) and convert it to BPS in WAD format.
     * Example:
     * 0.5% = 0.005
     * 0.005 * 10,000 = 50 BPS
     * 50 BPS in WAD = 5,000,000,000,000,000
     * @param value - percentage decimal value
     * @returns The BPS value in WAD format
     */
    static percentageToBpsWad(value) {
        const bps = FormatConverter.percentageToBps(value);
        return FormatConverter.bpsToBpsWad(bps);
    }
    /**
     * Takes a percentage value (Decimal) and converts it to a text representation.
     * Example:
     * 0.005 -> "0.50%"
     * @param value - percentage decimal value
     * @returns The percentage as a formatted string
     */
    static percentageToText(value) {
        return `${value.mul(100).toFixed(2)}%`;
    }
}
exports.default = FormatConverter;
//# sourceMappingURL=FormatConverter.js.map