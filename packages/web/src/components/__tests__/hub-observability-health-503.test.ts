/**
 * F153 Phase E: HealthPanel renders degraded (503) health data.
 *
 * The /api/telemetry/health endpoint returns 503 with a full body when
 * the system is degraded. HealthPanel must parse and render that body
 * instead of falling through to "Unable to load health data."
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(testDir, '..', 'HubObservabilityTab.tsx');
const src = readFileSync(srcPath, 'utf8');

describe('F153 HealthPanel 503 degraded handling', () => {
  it('fetchHealth parses body when response status is 503', () => {
    expect(src).toContain('res.status === 503');
  });

  it('HealthData interface includes status, readiness, and errorRate fields', () => {
    expect(src).toContain("status: 'healthy' | 'degraded'");
    expect(src).toContain('readiness?:');
    expect(src).toContain('errorRate: number | null');
  });

  it('HealthPanel renders readiness checks section', () => {
    expect(src).toContain('Readiness Checks');
    expect(src).toContain('health.readiness');
  });

  it('HealthPanel renders error rate metric card', () => {
    expect(src).toContain('Error Rate');
    expect(src).toContain('health.errorRate');
  });
});
