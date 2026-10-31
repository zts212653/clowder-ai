/**
 * F153 Phase K: Unit tests for observability panel helpers.
 *
 * Tests pure logic extracted into observability-helpers.ts —
 * filter functions, metric aggregation, formatting.
 */

import { describe, expect, it } from 'vitest';
import {
  type EnvVar,
  filterTelemetryEditable,
  formatUptime,
  getTelemetryConfigVars,
  sumByPrefix,
} from '@/components/observability-helpers';

// ── Test fixtures ──

function makeEnvVar(overrides: Partial<EnvVar> & { name: string }): EnvVar {
  return {
    defaultValue: '',
    description: 'test',
    category: 'other',
    sensitive: false,
    currentValue: null,
    ...overrides,
  };
}

const TELEMETRY_VARS: EnvVar[] = [
  makeEnvVar({ name: 'PROMPT_CAPTURE', category: 'telemetry', runtimeEditable: true, allowedValues: ['off', 'on'] }),
  makeEnvVar({ name: 'PROMPT_CAPTURE_CATS', category: 'telemetry', runtimeEditable: true }),
  makeEnvVar({ name: 'TELEMETRY_ALERT_ERROR_RATE', category: 'telemetry', runtimeEditable: false }),
  makeEnvVar({ name: 'OTEL_SDK_DISABLED', category: 'telemetry', runtimeEditable: false }),
  makeEnvVar({ name: 'TELEMETRY_HMAC_SALT', category: 'telemetry', sensitive: true, runtimeEditable: false }),
  makeEnvVar({ name: 'NON_TELEMETRY', category: 'evidence', runtimeEditable: true }),
];

// ── filterTelemetryEditable ──

describe('filterTelemetryEditable', () => {
  it('returns only telemetry-category, non-sensitive, runtimeEditable=true vars', () => {
    const result = filterTelemetryEditable(TELEMETRY_VARS);
    const names = result.map((v) => v.name);
    expect(names).toEqual(['PROMPT_CAPTURE', 'PROMPT_CAPTURE_CATS']);
  });

  it('excludes sensitive vars even if runtimeEditable', () => {
    const vars = [makeEnvVar({ name: 'SECRET', category: 'telemetry', sensitive: true, runtimeEditable: true })];
    expect(filterTelemetryEditable(vars)).toHaveLength(0);
  });

  it('excludes non-telemetry category vars', () => {
    const vars = [makeEnvVar({ name: 'OTHER', category: 'evidence', runtimeEditable: true })];
    expect(filterTelemetryEditable(vars)).toHaveLength(0);
  });

  it('excludes vars with runtimeEditable=false', () => {
    const vars = [makeEnvVar({ name: 'LOCKED', category: 'telemetry', runtimeEditable: false })];
    expect(filterTelemetryEditable(vars)).toHaveLength(0);
  });

  it('excludes vars with runtimeEditable=undefined', () => {
    const vars = [makeEnvVar({ name: 'UNSET', category: 'telemetry' })];
    expect(filterTelemetryEditable(vars)).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(filterTelemetryEditable([])).toEqual([]);
  });
});

// ── getTelemetryConfigVars ──

describe('getTelemetryConfigVars', () => {
  it('returns telemetry vars that are NOT runtimeEditable=true (includes sensitive)', () => {
    const result = getTelemetryConfigVars(TELEMETRY_VARS);
    const names = result.map((v) => v.name);
    expect(names).toEqual(['TELEMETRY_ALERT_ERROR_RATE', 'OTEL_SDK_DISABLED', 'TELEMETRY_HMAC_SALT']);
  });

  it('includes vars with runtimeEditable=undefined (legacy/unset)', () => {
    const vars = [makeEnvVar({ name: 'LEGACY', category: 'telemetry' })];
    expect(getTelemetryConfigVars(vars)).toHaveLength(1);
  });

  it('excludes non-telemetry category vars', () => {
    const vars = [makeEnvVar({ name: 'OTHER', category: 'evidence', runtimeEditable: false })];
    expect(getTelemetryConfigVars(vars)).toHaveLength(0);
  });
});

// ── sumByPrefix ──

describe('sumByPrefix', () => {
  const metrics = {
    'cat_cafe_invocation_completed{status="ok"}': 10,
    'cat_cafe_invocation_completed{status="error"}': 3,
    cat_cafe_invocation_active: 5,
    other_metric: 99,
  };

  it('sums all metrics matching prefix', () => {
    expect(sumByPrefix(metrics, 'cat_cafe_invocation_completed')).toBe(13);
  });

  it('filters within prefix when filter provided', () => {
    expect(sumByPrefix(metrics, 'cat_cafe_invocation_completed', 'status="ok"')).toBe(10);
    expect(sumByPrefix(metrics, 'cat_cafe_invocation_completed', 'status="error"')).toBe(3);
  });

  it('returns 0 when no keys match prefix', () => {
    expect(sumByPrefix(metrics, 'nonexistent')).toBe(0);
  });

  it('returns 0 for empty metrics', () => {
    expect(sumByPrefix({}, 'cat_cafe')).toBe(0);
  });

  it('returns 0 when prefix matches but filter excludes all', () => {
    expect(sumByPrefix(metrics, 'cat_cafe_invocation_completed', 'status="timeout"')).toBe(0);
  });
});

// ── formatUptime ──

describe('formatUptime', () => {
  it('formats minutes only when under 1 hour', () => {
    expect(formatUptime(300)).toBe('5m');
    expect(formatUptime(0)).toBe('0m');
    expect(formatUptime(59)).toBe('0m');
    expect(formatUptime(60)).toBe('1m');
  });

  it('formats hours and minutes when >= 1 hour', () => {
    expect(formatUptime(3600)).toBe('1h 0m');
    expect(formatUptime(3661)).toBe('1h 1m');
    expect(formatUptime(7200)).toBe('2h 0m');
    expect(formatUptime(90061)).toBe('25h 1m');
  });
});
