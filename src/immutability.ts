export type DeepReadonly<T> = T extends (...args: any[]) => any
    ? T
    : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        return value as DeepReadonly<T>;
    }

    const objectValue = value as object;
    if (seen.has(objectValue)) {
        return value as DeepReadonly<T>;
    }
    seen.add(objectValue);

    for (const key of Reflect.ownKeys(objectValue)) {
        const child = (value as Record<PropertyKey, unknown>)[key];
        if ((typeof child === "object" || typeof child === "function") && child !== null) {
            deepFreeze(child, seen);
        }
    }

    return Object.freeze(value) as DeepReadonly<T>;
}
