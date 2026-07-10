/**
 * Shared runtime validators used by policy + agent option normalization.
 *
 * Error messages are a semi-public contract (tests assert on the `name[index]`
 * shape), so the exact strings are pinned here and unit-tested.
 */

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

export function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of strings`);
  return Array.from(value, (item, index) => requireString(item, `${name}[${index}]`));
}

export function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError(`${name} must be a positive integer`);
  return value as number;
}

export function optionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

export function optionalPositiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
