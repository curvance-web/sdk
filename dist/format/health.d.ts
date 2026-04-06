import { Decimal } from "decimal.js";
export type HealthStatus = 'Danger' | 'Caution' | 'Healthy';
export declare const LOW_HEALTH_THRESHOLD = 10;
export declare const CAUTION_HEALTH_UPPER = 20;
export declare function getHealthStatus(percentageValue: number | null | undefined): HealthStatus;
export declare function healthFactorToPercentage(rawHealthFactor: number | null | undefined): number;
export declare function formatHealthFactorPercentage(value: number): string;
export declare function formatHealthFactor(value?: number | null): string;
export declare function getLiquidityStatus(ratio: Decimal.Value): 'green' | 'yellow' | 'red';
//# sourceMappingURL=health.d.ts.map