import assert from 'node:assert/strict';
import { test } from 'node:test';

test('deployment wait tool exposes only the bounded original-Task contract', async () => {
  const { callbackTools, registerDeploymentWaitInputSchema } = await import('../dist/tools/callback-tools.js');
  const tool = callbackTools.find((candidate) => candidate.name === 'cat_cafe_register_deployment_wait');
  assert.ok(tool);
  assert.match(tool.description, /existing original work Task/);
  assert.match(tool.description, /grants no stop\/restart authority/);
  assert.deepEqual(tool.policy.standaloneReason, {
    disposition: 'accepted-boundary',
    kind: 'resource-entry',
    admissionRef: 'file:docs/features/F323-runtime-restart-coordination.md',
  });
  assert.equal('agentKeyCatId' in registerDeploymentWaitInputSchema, false);

  const revision = 'a'.repeat(40);
  assert.equal(
    registerDeploymentWaitInputSchema.when.safeParse({ kind: 'revision_included', revision }).success,
    true,
    'api+web defaults are applied by the public schema',
  );
  assert.equal(
    registerDeploymentWaitInputSchema.when.safeParse({
      kind: 'revision_included',
      revision: 'main',
      services: ['api'],
    }).success,
    false,
  );
  assert.equal(
    registerDeploymentWaitInputSchema.when.safeParse({
      kind: 'new_ready_boot',
      services: ['api', 'api'],
    }).success,
    false,
  );
});
