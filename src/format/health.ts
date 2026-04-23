import { Decimal } from "decimal.js";

export type HealthStatus = 'Danger' | 'Caution' | 'Healthy';

export const DANGER_HEALTH_THRESHOLD = 0.05;
export const LOW_HEALTH_THRESHOLD = 0.10;
export const CAUTION_HEALTH_UPPER = 0.20;

export function getHealthStatus(percentageValue: number | null | undefined): HealthStatus {
    if (percentageValue == null) return 'Healthy';

    if (percentageValue < DANGER_HEALTH_THRESHOLD) return 'Danger';
    if (percentageValue >= DANGER_HEALTH_THRESHOLD && percentageValue <= CAUTION_HEALTH_UPPER) return 'Caution';
    if (percentageValue > CAUTION_HEALTH_UPPER) return 'Healthy';

    return 'Healthy';
}

export function healthFactorToPercentage(rawHealthFactor: number | null | undefined): number {
    return Math.max((rawHealthFactor ?? 5) - 1, 0);
}

export function formatHealthFactorPercentage(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'percent',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(value);
}

export function formatHealthFactor(value?: number | null): string {
    if (value === null || value === undefined) return '∞';
    if (value >= 9.99) return '>999%';
    return formatHealthFactorPercentage(Math.max(value, 0));
}

export function getLiquidityStatus(ratio: Decimal.Value): 'green' | 'yellow' | 'red' {
    const v = new Decimal(ratio).toNumber();
    if (v < 0.75) return 'green';
    if (v >= 0.76 && v <= 0.9) return 'yellow';
    if (v > 0.91) return 'red';
    return 'yellow';
}
