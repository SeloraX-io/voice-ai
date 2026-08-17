/**
 * Primitive readers shared by every validator in this folder.
 *
 * They exist as a separate module because two validators now need them — the
 * agent configuration and the tool definitions — and duplicating them would let
 * the two drift into reporting the same mistake differently.
 *
 * Each reader pushes an error and returns a fallback rather than throwing, so a
 * caller can collect every problem in one pass and the form can highlight all
 * of them at once.
 */

export interface FieldError {
  /** Dotted path, e.g. "variables.0.name". Empty string means the whole body. */
  path: string;
  message: string;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readString(
  value: unknown,
  path: string,
  errors: FieldError[],
  fallback: string,
): string {
  if (typeof value !== "string") {
    errors.push({ path, message: "Must be text." });
    return fallback;
  }
  return value;
}

export function readBoolean(value: unknown, path: string, errors: FieldError[]): boolean {
  if (typeof value !== "boolean") {
    errors.push({ path, message: "Must be true or false." });
    return false;
  }
  return value;
}

export function readNumber(
  value: unknown,
  path: string,
  range: { min: number; max: number },
  errors: FieldError[],
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, message: "Must be a number." });
    return fallback;
  }
  if (value < range.min || value > range.max) {
    errors.push({ path, message: `Must be between ${range.min} and ${range.max}.` });
    return fallback;
  }
  return value;
}

export function readEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  errors: FieldError[],
  fallback: T,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push({ path, message: `Must be one of: ${allowed.join(", ")}.` });
    return fallback;
  }
  return value as T;
}
