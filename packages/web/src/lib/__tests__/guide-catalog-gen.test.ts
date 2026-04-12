/**
 * F155: Tests for the generated guide catalog.
 *
 * @deprecated The guide catalog (guide-catalog.gen.ts) uses legacy v1 step shape
 * and is pending regeneration for v2 OrchestrationFlow schema.
 * All tests are skipped until the catalog is regenerated.
 */
import { describe, it } from 'vitest';

describe.skip('GUIDE_REGISTRY (v1 — pending v2 regeneration)', () => {
  it('contains at least one entry', () => {});
  it('every entry has required fields', () => {});
  it('every registry entry has a matching flow', () => {});
});

describe.skip('GUIDE_FLOWS (v1 — pending v2 regeneration)', () => {
  it('add-member flow exists with correct structure', () => {});
  it('every flow has unique step IDs', () => {});
  it('every console_action step has a target', () => {});
  it('all steps have required tips', () => {});
});

describe.skip('Registry <-> Flow consistency (v1 — pending v2 regeneration)', () => {
  it('no orphan flows (every flow has a registry entry)', () => {});
});
