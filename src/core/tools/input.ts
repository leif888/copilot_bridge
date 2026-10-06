import { ToolError } from './types';

/**
 * Tool arguments arrive as `object` straight off the model's JSON, so every
 * field has to be read defensively.
 *
 * The `optional*` readers never throw — `describe()` runs before validation and
 * must not blow up on malformed input. The `require*` readers throw
 * {@link ToolError} with a message written for the model to act on.
 */

function asObject(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

export function optionalString(input: unknown, field: string): string | undefined {
  const value = asObject(input)[field];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function requireString(input: unknown, field: string): string {
  const value = optionalString(input, field);
  if (value === undefined) {
    throw new ToolError(`"${field}" is required and must be a non-empty string.`);
  }
  return value;
}

export function optionalInteger(input: unknown, field: string): number | undefined {
  const value = asObject(input)[field];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** An integer clamped to `[min, max]`, defaulting to `fallback` when absent. */
export function boundedInteger(
  input: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = optionalInteger(input, field);
  if (value === undefined) {
    return fallback;
  }
  if (value < min || value > max) {
    throw new ToolError(`"${field}" must be between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

export function optionalBoolean(input: unknown, field: string): boolean | undefined {
  const value = asObject(input)[field];
  return typeof value === 'boolean' ? value : undefined;
}

export function booleanOr(input: unknown, field: string, fallback: boolean): boolean {
  return optionalBoolean(input, field) ?? fallback;
}
