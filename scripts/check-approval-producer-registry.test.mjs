import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateApprovalProducerRegistrySources } from './check-approval-producer-registry.mjs';

const valid = {
  catalogSource: `
export const APPROVAL_PRODUCER_CATALOG = {
  F128: { label: 'Thread' },
  F225: { label: 'Handoff' },
  authorization: { label: 'Authorization' },
} as const;
export const APPROVAL_PRODUCER_IDS = Object.freeze(['F128', 'F225', 'authorization']);
`,
  apiCompositionSource: `
const approvalProducerRegistry = new ApprovalProducerRegistry({
    F128: { adapter: f128 },
    F225: { adapter: f225 },
    authorization: { adapter: authorization },
  });
`,
  webRegistrySource: `
import { APPROVAL_PRODUCER_CATALOG, APPROVAL_PRODUCER_IDS } from '@cat-cafe/shared';
export const APPROVAL_FEATURES = Object.fromEntries(APPROVAL_PRODUCER_IDS.map((id) => [id, APPROVAL_PRODUCER_CATALOG[id]]));
`,
  architectureSource: `
- packages/shared/src/approval-producer-catalog.ts
- packages/api/src/domains/approval-hub/ApprovalIngress.ts
- packages/api/src/domains/approval-hub/ApprovalProducerRegistry.ts
- packages/api/src/domains/approval-hub/requireAnchoredPublication.ts
- packages/api/src/routes/approval-hub-routes.ts
- packages/web/src/lib/approval-features.ts
- packages/web/src/components/ApprovalProvenanceLinks.tsx
`,
};

describe('F246 approval producer parity checker', () => {
  it('accepts one catalog with exhaustive API bindings and derived Web metadata', () => {
    assert.deepEqual(validateApprovalProducerRegistrySources(valid), []);
  });

  it('reports missing and extra API bindings', () => {
    const violations = validateApprovalProducerRegistrySources({
      ...valid,
      apiCompositionSource: `
const approvalProducerRegistry = new ApprovalProducerRegistry({
    F128: { adapter: f128 },
    F028: { adapter: wrong },
    authorization: { adapter: authorization },
  });
`,
    });
    assert.ok(violations.some((violation) => violation.includes('missing API binding: F225')));
    assert.ok(violations.some((violation) => violation.includes('extra API binding: F028')));
  });

  it('keeps non-F producer IDs in the catalog-to-runtime comparison', () => {
    const violations = validateApprovalProducerRegistrySources({
      ...valid,
      apiCompositionSource: `
const approvalProducerRegistry = new ApprovalProducerRegistry({
    F128: { adapter: f128 },
    F225: { adapter: f225 },
  });
`,
    });
    assert.ok(violations.some((violation) => violation.includes('missing API binding: authorization')));
  });

  it('rejects duplicate or incomplete producer order IDs', () => {
    const violations = validateApprovalProducerRegistrySources({
      ...valid,
      catalogSource: valid.catalogSource.replace(
        "Object.freeze(['F128', 'F225', 'authorization'])",
        "Object.freeze(['F128', 'F128', 'authorization'])",
      ),
    });
    assert.ok(violations.some((violation) => violation.includes('duplicate producer order ID: F128')));
    assert.ok(violations.some((violation) => violation.includes('missing producer order ID: F225')));
  });

  it('rejects an order ID with no catalog metadata', () => {
    const violations = validateApprovalProducerRegistrySources({
      ...valid,
      catalogSource: valid.catalogSource.replace(
        "Object.freeze(['F128', 'F225', 'authorization'])",
        "Object.freeze(['F128', 'F225', 'authorization', 'F999'])",
      ),
    });
    assert.ok(violations.some((violation) => violation.includes('missing catalog entry: F999')));
  });

  it('rejects a second handwritten Web metadata registry', () => {
    const violations = validateApprovalProducerRegistrySources({
      ...valid,
      webRegistrySource: `export const APPROVAL_FEATURES = { F128: { label: 'Thread' } };`,
    });
    assert.ok(violations.some((violation) => violation.includes('shared catalog')));
    assert.ok(violations.some((violation) => violation.includes('handwritten metadata')));
  });

  it('reports missing architecture anchors', () => {
    const violations = validateApprovalProducerRegistrySources({
      ...valid,
      architectureSource: 'cell_id: approval-index',
    });
    assert.ok(violations.some((violation) => violation.includes('ApprovalProducerRegistry.ts')));
  });
});
