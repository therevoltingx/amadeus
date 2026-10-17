/**
 * Zod v4-mini helpers for MCP tool input schemas.
 * MCP SDK expects schemas with _zod; main zod does not expose it.
 */
import * as z from 'zod/v4-mini';

export { z };

export function numWithMinMax(opts?: { min?: number; max?: number }) {
  let s = z.number();
  if (opts?.min != null) s = s.check(z.minimum(opts.min));
  if (opts?.max != null) s = s.check(z.maximum(opts.max));
  return s;
}

export function defaultNum(def: number, opts?: { min?: number; max?: number }) {
  return z._default(z.optional(numWithMinMax(opts)), def);
}

export function intWithMin(min: number) {
  return z.int().check(z.minimum(min));
}

export function intDefault(def: number, opts?: { min?: number }) {
  let s = z.int();
  if (opts?.min != null) s = s.check(z.minimum(opts.min));
  return z._default(z.optional(s), def);
}

export function intOptionalNullable(opts?: { min?: number }) {
  let s = z.int();
  if (opts?.min != null) s = s.check(z.minimum(opts.min));
  return z.optional(z.nullable(s));
}

export function numOptionalNullable(opts?: { min?: number; max?: number }) {
  return z.optional(z.nullable(numWithMinMax(opts)));
}

export function numMinOptional(min: number) {
  return z.optional(numWithMinMax({ min }));
}

export function strMin1() {
  return z.string().check(z.minLength(1));
}

export function intPositive() {
  return z.int().check(z.positive());
}

export function arrayNum(minLen: number, maxLen: number) {
  return z.array(z.number()).check(
    z.refine((arr: number[]) => arr.length >= minLen && arr.length <= maxLen, `array length between ${minLen} and ${maxLen}`)
  );
}
