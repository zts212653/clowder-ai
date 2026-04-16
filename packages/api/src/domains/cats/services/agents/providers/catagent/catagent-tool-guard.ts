/**
 * CatAgent Tool Guard — F159: Native Provider Security Baseline (AC-B3)
 *
 * Injection prevention at the host/provider integration layer:
 * 1. Schema validation — reject undeclared fields, enforce types, require required fields
 * 2. Shell-safe command building — enforce `--` separator, reject flag injection
 *
 * These guards are consumed by Phase D tool implementations (read_file, list_files, search_content).
 * No @anthropic-ai/sdk dependency — uses inline types from catagent-tools.ts.
 */

import type { ToolSchema } from './catagent-tools.js';

/** Validation error with structured context for audit/logging */
export class ToolInputValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reason: string,
  ) {
    super(`Tool input validation failed for "${toolName}": ${reason}`);
    this.name = 'ToolInputValidationError';
  }
}

/** Reject fields not declared in schema.properties */
function rejectUndeclaredFields(name: string, input: Record<string, unknown>, declared: Set<string>): void {
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) {
      throw new ToolInputValidationError(name, `undeclared field "${key}"`);
    }
  }
}

/** Ensure required fields are present and non-empty */
function checkRequiredFields(name: string, input: Record<string, unknown>, required: readonly string[]): void {
  for (const key of required) {
    const val = input[key];
    if (val === undefined || val === null) {
      throw new ToolInputValidationError(name, `required field "${key}" is missing`);
    }
    if (typeof val === 'string' && val.trim() === '') {
      throw new ToolInputValidationError(name, `required field "${key}" is empty`);
    }
  }
}

/** Type-check declared fields that are present */
function checkFieldTypes(name: string, input: Record<string, unknown>, properties: Record<string, unknown>): void {
  for (const [key, spec] of Object.entries(properties)) {
    const val = input[key];
    if (val === undefined || val === null) continue;
    const expectedType = (spec as { type?: string }).type;
    if (!expectedType) continue;

    const actualType = Array.isArray(val) ? 'array' : typeof val;
    if (actualType !== expectedType) {
      throw new ToolInputValidationError(name, `field "${key}" expected type "${expectedType}", got "${actualType}"`);
    }
  }
}

/**
 * Validate tool input against declared JSON schema.
 *
 * Rejects undeclared fields, missing/empty required fields, and type mismatches.
 * Intentionally strict: unknown fields are rejected, not silently dropped.
 */
export function validateToolInput(schema: ToolSchema, input: Record<string, unknown>): void {
  const { properties, required = [] } = schema.input_schema;
  rejectUndeclaredFields(schema.name, input, new Set(Object.keys(properties)));
  checkRequiredFields(schema.name, input, required);
  checkFieldTypes(schema.name, input, properties);
}

/**
 * Build a shell-safe command array for execFile.
 *
 * Enforces:
 * - `--` separator before any user-supplied arguments
 * - Rejection of flag injection in user args (strings starting with `-`)
 * - All arguments as array elements (never concatenated into shell string)
 */
export function buildSafeCommand(
  binary: string,
  fixedArgs: readonly string[],
  userArgs: readonly string[],
): [bin: string, args: string[]] {
  for (const arg of userArgs) {
    if (arg.startsWith('-')) {
      throw new ToolInputValidationError(binary, `user argument "${arg}" looks like a flag — potential injection`);
    }
  }
  return [binary, [...fixedArgs, '--', ...userArgs]];
}
