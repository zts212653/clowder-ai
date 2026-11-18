import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readPackageCapabilityRejection } from '../dist/domains/plugin/read-package-capabilities.js';
import { OFFICIAL_AGENT_ACCESS_OPERATIONS, AGENT_ACCESS_OPERATIONS } from '@clowder-ai/agent-contract';

const managedModule = { runtime: { transport: 'builtin', entrypoint: 'dist/index.js' } };
const officialPlugin = { pluginId: 'official.agent-access', ...managedModule };

/**
 * Every operation the Host actually calls must be required by admission.
 *
 * `planFinalizer` is the OpenCode recovery run: the Host invokes it on the happy
 * path of a tool-only turn, so a package allowed to omit it from its declaration
 * would install cleanly and then fail at exactly the moment a turn needs rescuing.
 * Admission is the only place that can refuse it up front.
 */
async function declarationMissing(operation) {
  const root = await mkdtemp(join(tmpdir(), 'clowder-agent-access-ops-'));
  const declared = OFFICIAL_AGENT_ACCESS_OPERATIONS.filter((declaredOp) => declaredOp !== operation);
  await writeFile(
    join(root, 'agent-access.json'),
    JSON.stringify({ protocolVersion: 1, operations: declared, transports: ['native', 'acp', 'a2a'] }),
  );
  return { root, rejection: await readPackageCapabilityRejection(officialPlugin, root) };
}

test('planFinalizer is part of the official operation contract', () => {
  assert.ok(
    OFFICIAL_AGENT_ACCESS_OPERATIONS.includes('planFinalizer'),
    'the Host calls planFinalizer, so it must be a required official operation',
  );
});

test('a declaration omitting planFinalizer is rejected before install', async (t) => {
  const { root, rejection } = await declarationMissing('planFinalizer');
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.match(rejection ?? '', /missing operations.*planFinalizer/i);
});

test('every official operation is enforced, not just the older ones', async (t) => {
  for (const operation of OFFICIAL_AGENT_ACCESS_OPERATIONS) {
    const { root, rejection } = await declarationMissing(operation);
    t.after(() => rm(root, { recursive: true, force: true }));
    // Two layers refuse an incomplete declaration: the base operations fail the
    // schema refine, the official-only ones fail the admission check. Either way
    // the package must not install, which is what this asserts.
    assert.ok(
      rejection && /operations/i.test(rejection),
      `omitting ${operation} must be rejected, got: ${String(rejection)}`,
    );
  }
});

test('the base protocol operations remain a subset of the official ones', () => {
  for (const operation of AGENT_ACCESS_OPERATIONS)
    assert.ok(OFFICIAL_AGENT_ACCESS_OPERATIONS.includes(operation), `${operation} must remain official`);
});
