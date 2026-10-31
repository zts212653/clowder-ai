import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { CANONICAL_TOOL_REGISTRY } from '../src/canonical-server-tools.js';
import { developmentWorkInputSchema } from '../src/tools/development-work-tools.js';

test('development owner action is in the canonical invocation-only write surface', () => {
  const tool = CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === 'cat_cafe_development_work');
  assert.ok(tool);
  assert.deepEqual(tool.actionInventory, ['admit', 'adopt', 'bind', 'resume']);
  const payload = {
    action: 'admit',
    scope: { featureRef: 'feature:F310', phaseKey: 'B', acceptedRevision: 'a'.repeat(40) },
    sourceMessageRevision: `sha256:${'a'.repeat(64)}`,
    admission: { basis: 'explicit_entrustment', sourceRefs: ['message:source'], idempotencyKey: 'source' },
  };
  assert.equal(z.object(developmentWorkInputSchema).strict().safeParse(payload).success, true);
  assert.equal(
    z
      .object(developmentWorkInputSchema)
      .strict()
      .safeParse({ ...payload, ownerCatId: 'other', threadId: 'foreign' }).success,
    false,
  );
  assert.equal(
    z
      .object(developmentWorkInputSchema)
      .strict()
      .safeParse({ ...payload, scope: { ...payload.scope, workUnitRef: 'new-name' } }).success,
    false,
  );
});

test('development terminal return has its own authenticated full-profile action', () => {
  const tool = CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === 'cat_cafe_development_return');
  assert.ok(tool);
  assert.deepEqual(tool.actionInventory, ['register', 'report']);
  assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
});
