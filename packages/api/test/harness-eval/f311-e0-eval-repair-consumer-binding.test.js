import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { stringify } from 'yaml';

import { createF311E0EvalRepairOwnerBindingProvider } from '../../dist/infrastructure/capability-evolution/change/f311-e0-eval-repair-owner-provider.js';
import { createF311ConsumerBindingFixture } from './helpers/f311-consumer-binding-fixture.js';

const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const PREFIX = 'evolution-program-bcc336788a7df9d6075b1efb4c0a7e68';
const INPUT_ROOT = 'docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs';
const MEASUREMENT_REF = `docs/harness-feedback/measurement-sources/capability-evolution/${PREFIX}.yaml`;
const TARGET_REF = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'capability:f311-investor-roadshow-expression',
};
const VALUE_OWNER_REF = { ownerFeatureId: 'F311', ownerStateRef: 'user:default-user' };
const NAMED_CONSUMER_REF = { ownerFeatureId: 'F311', ownerStateRef: 'cat:codex-sol' };

async function writeFixture(transform = () => {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'f311-consumer-binding-'));
  const artifacts = createF311ConsumerBindingFixture({
    targetRef: TARGET_REF,
    valueOwnerRef: VALUE_OWNER_REF,
    consumerRef: NAMED_CONSUMER_REF,
  });
  transform(artifacts);
  for (const [ref, artifact] of artifacts) {
    await mkdir(dirname(join(repoRoot, ref)), { recursive: true });
    await writeFile(join(repoRoot, ref), stringify(artifact));
  }
  return repoRoot;
}

function provider(repoRoot, valueOwnerRef = VALUE_OWNER_REF) {
  const principal = {
    invocationId: 'inv-owner-source-1',
    userId: 'default-user',
    catId: 'codex-sol',
    threadId: 'thread-owner-source',
    originMessageId: 'message-owner-source',
  };
  return createF311E0EvalRepairOwnerBindingProvider({
    repoRoot,
    ownerUserId: 'default-user',
    programReader: {
      async get() {
        return { program: { programId: PROGRAM_ID, objectRef: TARGET_REF, cycle: 1, valueOwnerRef } };
      },
    },
    invocationRegistry: {
      async peekRecord() {
        return { ...principal, ownerAuthProvenance: 'strict', originTriggerMessageId: principal.originMessageId };
      },
    },
  });
}

describe('F311 E0 eval-repair consumer/value-owner split', () => {
  it('loads a canonical named consumer without transferring value-decision authority', async () => {
    const repoRoot = await writeFixture();
    try {
      const bindings = await provider(repoRoot).resolve();
      assert.ok(bindings);
      assert.equal(
        (
          await bindings.valueDecisionAuthorityVerifier.verify(
            { kind: 'owner_session', userId: 'default-user' },
            { programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID } },
          )
        ).status,
        'verified',
      );
      assert.deepEqual(
        await bindings.valueDecisionAuthorityVerifier.verify(
          { kind: 'owner_session', userId: 'codex-sol' },
          { programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID } },
        ),
        { status: 'blocked', reason: 'value_owner_unverified' },
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects missing or forged consumer joins and Program value-owner drift', async () => {
    const missingRoot = await writeFixture((artifacts) => {
      delete artifacts.get(`${INPUT_ROOT}/${PREFIX}-measurement-role-assignment-v1.yaml`).roles.consumer;
    });
    try {
      await assert.rejects(provider(missingRoot).resolve());
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }

    const repoRoot = await writeFixture((artifacts) => {
      artifacts.get(MEASUREMENT_REF).roles.consumer = {
        ownerFeatureId: 'F311',
        ownerStateRef: 'cat:attacker',
      };
    });
    try {
      await assert.rejects(provider(repoRoot).resolve(), /canonical owner inputs/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }

    const driftRoot = await writeFixture();
    try {
      const bindings = await provider(driftRoot, {
        ownerFeatureId: 'F311',
        ownerStateRef: 'user:attacker',
      }).resolve();
      const result = await bindings.lineageResolver.resolve({
        programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
        cycleRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${PROGRAM_ID}:1` },
        interventionRef: TARGET_REF,
      });
      assert.deepEqual(result, { status: 'blocked', reason: 'lineage_mismatch' });
    } finally {
      await rm(driftRoot, { recursive: true, force: true });
    }
  });
});
