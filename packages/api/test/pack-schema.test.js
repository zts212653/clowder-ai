/**
 * F129 Pack Schema Tests
 * Validates fail-closed Zod schemas for pack.yaml, guardrails, defaults, masks, workflows.
 * AC-A1: pack.yaml schema defined
 * AC-A8: fail-closed (unknown fields rejected), high-risk fields bounded
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Dynamic import after build
async function getSchemas() {
  const {
    PackManifestSchema,
    PackGuardrailsSchema,
    PackDefaultsSchema,
    PackMaskSchema,
    PackWorkflowSchema,
    PackWorldDriverSchema,
  } = await import('@cat-cafe/shared');
  return {
    PackManifestSchema,
    PackGuardrailsSchema,
    PackDefaultsSchema,
    PackMaskSchema,
    PackWorkflowSchema,
    PackWorldDriverSchema,
  };
}

describe('PackManifestSchema', () => {
  test('accepts valid manifest', async () => {
    const { PackManifestSchema } = await getSchemas();
    const result = PackManifestSchema.safeParse({
      name: 'quant-cats',
      version: '1.0.0',
      description: 'Quantitative finance collaboration pack',
      packType: 'domain',
      author: 'alice',
      license: 'MIT',
    });
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
    assert.equal(result.data.name, 'quant-cats');
    assert.equal(result.data.packType, 'domain');
  });

  test('accepts minimal manifest (only required fields)', async () => {
    const { PackManifestSchema } = await getSchemas();
    const result = PackManifestSchema.safeParse({
      name: 'my-pack',
      version: '0.1.0',
      description: 'A simple pack',
      packType: 'scenario',
    });
    assert.ok(result.success);
  });

  test('rejects unknown fields (fail-closed AC-A8)', async () => {
    const { PackManifestSchema } = await getSchemas();
    const result = PackManifestSchema.safeParse({
      name: 'my-pack',
      version: '1.0.0',
      description: 'Test',
      packType: 'domain',
      sneakyField: 'should be rejected',
    });
    assert.ok(!result.success, 'Should reject unknown fields');
    assert.ok(result.error.issues.some((i) => i.message.includes('Unrecognized key')));
  });

  test('rejects invalid packType', async () => {
    const { PackManifestSchema } = await getSchemas();
    const result = PackManifestSchema.safeParse({
      name: 'my-pack',
      version: '1.0.0',
      description: 'Test',
      packType: 'evil-plugin',
    });
    assert.ok(!result.success);
  });

  test('rejects name with uppercase or special chars', async () => {
    const { PackManifestSchema } = await getSchemas();
    const result = PackManifestSchema.safeParse({
      name: 'My_Pack!',
      version: '1.0.0',
      description: 'Test',
      packType: 'domain',
    });
    assert.ok(!result.success);
  });

  test('rejects description > 500 chars', async () => {
    const { PackManifestSchema } = await getSchemas();
    const result = PackManifestSchema.safeParse({
      name: 'my-pack',
      version: '1.0.0',
      description: 'x'.repeat(501),
      packType: 'domain',
    });
    assert.ok(!result.success);
  });

  test('rejects empty name', async () => {
    const { PackManifestSchema } = await getSchemas();
    const result = PackManifestSchema.safeParse({
      name: '',
      version: '1.0.0',
      description: 'Test',
      packType: 'domain',
    });
    assert.ok(!result.success);
  });
});

describe('PackGuardrailsSchema', () => {
  test('accepts valid guardrails', async () => {
    const { PackGuardrailsSchema } = await getSchemas();
    const result = PackGuardrailsSchema.safeParse({
      constraints: [
        {
          id: 'risk-disclosure',
          scope: 'all-cats',
          rule: 'All financial advice must include risk disclosure',
          severity: 'block',
        },
      ],
    });
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
  });

  test('accepts constraints scoped to specific breeds', async () => {
    const { PackGuardrailsSchema } = await getSchemas();
    const result = PackGuardrailsSchema.safeParse({
      constraints: [
        {
          id: 'analyst-only',
          scope: 'specific-breeds',
          breeds: ['ragdoll'],
          rule: 'Only ragdoll cats handle analysis tasks',
          severity: 'warn',
        },
      ],
    });
    assert.ok(result.success);
  });

  test('rejects rule > 500 chars', async () => {
    const { PackGuardrailsSchema } = await getSchemas();
    const result = PackGuardrailsSchema.safeParse({
      constraints: [
        {
          id: 'long-rule',
          scope: 'all-cats',
          rule: 'x'.repeat(501),
          severity: 'block',
        },
      ],
    });
    assert.ok(!result.success);
  });

  test('rejects unknown fields in constraint (fail-closed)', async () => {
    const { PackGuardrailsSchema } = await getSchemas();
    const result = PackGuardrailsSchema.safeParse({
      constraints: [
        {
          id: 'test',
          scope: 'all-cats',
          rule: 'Test rule',
          severity: 'block',
          hidden: 'injection attempt',
        },
      ],
    });
    assert.ok(!result.success, 'Should reject unknown fields in constraint');
  });

  test('rejects > 50 constraints', async () => {
    const { PackGuardrailsSchema } = await getSchemas();
    const constraints = Array.from({ length: 51 }, (_, i) => ({
      id: `c-${i}`,
      scope: 'all-cats',
      rule: `Rule ${i}`,
      severity: 'block',
    }));
    const result = PackGuardrailsSchema.safeParse({ constraints });
    assert.ok(!result.success);
  });
});

describe('PackDefaultsSchema', () => {
  test('accepts valid defaults', async () => {
    const { PackDefaultsSchema } = await getSchemas();
    const result = PackDefaultsSchema.safeParse({
      behaviors: [
        {
          id: 'use-jargon',
          scope: 'all-cats',
          behavior: 'Use professional financial terminology by default',
          overridable: true,
        },
      ],
    });
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
  });

  test('enforces overridable: true (rejects false)', async () => {
    const { PackDefaultsSchema } = await getSchemas();
    const result = PackDefaultsSchema.safeParse({
      behaviors: [
        {
          id: 'locked',
          scope: 'all-cats',
          behavior: 'This should not be lockable',
          overridable: false,
        },
      ],
    });
    assert.ok(!result.success, 'overridable must always be true');
  });

  test('rejects behavior > 500 chars', async () => {
    const { PackDefaultsSchema } = await getSchemas();
    const result = PackDefaultsSchema.safeParse({
      behaviors: [
        {
          id: 'long',
          scope: 'all-cats',
          behavior: 'x'.repeat(501),
          overridable: true,
        },
      ],
    });
    assert.ok(!result.success);
  });
});

describe('PackMaskSchema', () => {
  test('accepts valid mask', async () => {
    const { PackMaskSchema } = await getSchemas();
    const result = PackMaskSchema.safeParse({
      id: 'quant-analyst',
      name: 'Quantitative Analyst',
      roleOverlay: 'You additionally serve as a quantitative financial analyst',
      personalityOverlay: 'Data-driven, precise, rigorous',
      expertise: ['quantitative finance', 'risk modeling', 'derivatives'],
      activation: 'always',
    });
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
  });

  test('rejects roleOverlay > 300 chars', async () => {
    const { PackMaskSchema } = await getSchemas();
    const result = PackMaskSchema.safeParse({
      id: 'test',
      name: 'Test',
      roleOverlay: 'x'.repeat(301),
      activation: 'always',
    });
    assert.ok(!result.success);
  });

  test('rejects > 10 expertise items', async () => {
    const { PackMaskSchema } = await getSchemas();
    const result = PackMaskSchema.safeParse({
      id: 'test',
      name: 'Test',
      roleOverlay: 'Test overlay',
      expertise: Array.from({ length: 11 }, (_, i) => `skill-${i}`),
      activation: 'always',
    });
    assert.ok(!result.success);
  });

  test('rejects unknown activation value', async () => {
    const { PackMaskSchema } = await getSchemas();
    const result = PackMaskSchema.safeParse({
      id: 'test',
      name: 'Test',
      roleOverlay: 'Test',
      activation: 'sneaky-always',
    });
    assert.ok(!result.success);
  });
});

describe('PackWorkflowSchema', () => {
  test('accepts valid workflow with allowed actions', async () => {
    const { PackWorkflowSchema } = await getSchemas();
    const result = PackWorkflowSchema.safeParse({
      id: 'research-flow',
      name: 'Research Workflow',
      trigger: 'user-asks-for-analysis',
      steps: [
        { action: 'apply-mask', params: { maskId: 'quant-analyst' } },
        { action: 'search-knowledge', params: { query: 'latest market data' } },
        { action: 'notify-user' },
      ],
    });
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
  });

  test('rejects free-text action (not in allowed enum)', async () => {
    const { PackWorkflowSchema } = await getSchemas();
    const result = PackWorkflowSchema.safeParse({
      id: 'evil-flow',
      name: 'Evil',
      trigger: 'always',
      steps: [{ action: 'execute-arbitrary-code' }],
    });
    assert.ok(!result.success, 'Should reject actions not in allowed enum');
  });

  test('rejects empty steps array', async () => {
    const { PackWorkflowSchema } = await getSchemas();
    const result = PackWorkflowSchema.safeParse({
      id: 'empty',
      name: 'Empty',
      trigger: 'never',
      steps: [],
    });
    assert.ok(!result.success);
  });

  test('rejects > 20 steps', async () => {
    const { PackWorkflowSchema } = await getSchemas();
    const steps = Array.from({ length: 21 }, () => ({ action: 'notify-user' }));
    const result = PackWorkflowSchema.safeParse({
      id: 'huge',
      name: 'Huge',
      trigger: 'always',
      steps,
    });
    assert.ok(!result.success);
  });
});

describe('PackWorldDriverSchema', () => {
  test('accepts valid world driver', async () => {
    const { PackWorldDriverSchema } = await getSchemas();
    const result = PackWorldDriverSchema.safeParse({
      resolver: 'hybrid',
      roles: ['DM', 'player'],
      actions: ['roll-dice', 'move', 'attack'],
      canonRules: ['No meta-gaming', 'Respect turn order'],
    });
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
  });

  test('rejects resolver: llm (must be agent, not llm)', async () => {
    const { PackWorldDriverSchema } = await getSchemas();
    const result = PackWorldDriverSchema.safeParse({
      resolver: 'llm',
    });
    assert.ok(!result.success, 'resolver must be code|agent|hybrid, not llm');
  });

  test('rejects unknown fields', async () => {
    const { PackWorldDriverSchema } = await getSchemas();
    const result = PackWorldDriverSchema.safeParse({
      resolver: 'code',
      secretOverride: true,
    });
    assert.ok(!result.success);
  });
});
