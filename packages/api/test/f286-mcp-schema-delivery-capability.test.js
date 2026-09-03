import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const modulePromise = import('../dist/domains/cats/services/agents/providers/mcp-schema-delivery-capability.js');

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;

function subject(overrides = {}) {
  return {
    provider: 'openai',
    carrier: 'app_server',
    modelFamily: 'gpt-5.6-sol',
    hostVersion: '0.149.1',
    configDigest: SHA_A,
    profileId: 'full',
    ...overrides,
  };
}

function attestation(overrides = {}) {
  return {
    v: 1,
    subject: subject(),
    deliveryMode: 'catalog-deferred',
    discoverySurface: 'host-catalog',
    evidence: {
      kind: 'host-probe',
      ref: 'docs/research/2026-08-29-f286-phase-d-natural-experiment.md#codex-catalog-probe',
    },
    fixtureRevision: 'f286-schema-delivery-v1',
    resultDigest: SHA_B,
    createdAt: '2026-08-29T16:00:00.000Z',
    ...overrides,
  };
}

describe('F286 MCP schema-delivery capability', () => {
  it('binds an exact version/config attestation to a sanitized launch projection', async () => {
    const { resolveMcpSchemaDeliveryForLaunch } = await modulePromise;
    const result = resolveMcpSchemaDeliveryForLaunch({
      profileClass: 'full',
      subject: subject(),
      attestation: attestation(),
      attestationRef: 'docs/features/evidence/F286/provider-schema-delivery/openai-app-server.json',
    });

    assert.deepEqual(result, {
      profileClass: 'full',
      profileId: 'full',
      requestedMode: 'catalog-deferred',
      hostVersion: '0.149.1',
      attestation: {
        ref: 'docs/features/evidence/F286/provider-schema-delivery/openai-app-server.json',
        digest: result.attestation.digest,
      },
    });
    assert.match(result.attestation.digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(result).includes('cat-cafe-collab'));
  });

  it('returns typed unknown and emits health evidence for a subject mismatch', async () => {
    const { resolveMcpSchemaDeliveryForLaunch } = await modulePromise;
    const health = [];
    const result = resolveMcpSchemaDeliveryForLaunch({
      profileClass: 'full',
      subject: subject({ hostVersion: '0.150.0' }),
      attestation: attestation(),
      attestationRef: 'docs/features/evidence/F286/provider-schema-delivery/openai-app-server.json',
      onHealthEvent: (event) => health.push(event),
    });

    assert.deepEqual(result, {
      profileClass: 'full',
      profileId: 'full',
      requestedMode: 'unknown',
      hostVersion: '0.150.0',
      fallbackReason: 'attestation_subject_mismatch',
    });
    assert.deepEqual(health, [
      {
        code: 'mcp_schema_delivery_attestation_subject_mismatch',
        provider: 'openai',
        carrier: 'app_server',
        hostVersion: '0.150.0',
        profileId: 'full',
      },
    ]);
  });

  it('treats a missing attestation as unknown without changing profile identity', async () => {
    const { resolveMcpSchemaDeliveryForLaunch } = await modulePromise;
    assert.deepEqual(
      resolveMcpSchemaDeliveryForLaunch({
        profileClass: 'readonly',
        subject: subject({ profileId: 'readonly' }),
      }),
      {
        profileClass: 'readonly',
        profileId: 'readonly',
        requestedMode: 'unknown',
        hostVersion: '0.149.1',
        fallbackReason: 'attestation_unavailable',
      },
    );
  });

  it('rejects raw schema, prompt, server inventory, and credential fields', async () => {
    const { mcpSchemaDeliveryCapabilityAttestationSchema } = await modulePromise;
    for (const forbidden of [
      { rawSchemas: [{ name: 'secret' }] },
      { prompt: 'hidden context' },
      { serverNames: ['cat-cafe-collab'] },
      { credential: 'token' },
    ]) {
      assert.throws(() => mcpSchemaDeliveryCapabilityAttestationSchema.parse({ ...attestation(), ...forbidden }));
    }
  });

  it('declares only the provider/carrier discovery surface proven by the Phase D contract', async () => {
    const { resolveMcpSchemaDeliveryDiscoverySurface } = await modulePromise;

    assert.equal(
      resolveMcpSchemaDeliveryDiscoverySurface({ provider: 'anthropic', carrier: 'print_sdk' }),
      'provider-tool-search',
    );
    assert.equal(
      resolveMcpSchemaDeliveryDiscoverySurface({ provider: 'openai', carrier: 'app_server' }),
      'host-catalog',
    );
    assert.equal(resolveMcpSchemaDeliveryDiscoverySurface({ provider: 'openai', carrier: 'exec_json' }), 'unknown');
  });

  it('memoizes one bounded host-version probe per executable', async () => {
    const { createMemoizedHostVersionProbe } = await modulePromise;
    let calls = 0;
    const probe = createMemoizedHostVersionProbe((command) => {
      calls += 1;
      return command === 'codex' ? 'codex-cli 0.149.1\n' : '2.1.247 (Claude Code)\n';
    });

    assert.equal(probe('codex'), '0.149.1');
    assert.equal(probe('codex'), '0.149.1');
    assert.equal(probe('claude'), '2.1.247');
    assert.equal(calls, 2);

    const runtimeVersion = createMemoizedHostVersionProbe(() => 'v22.14.0\n');
    assert.equal(
      runtimeVersion('node-wrapper'),
      undefined,
      'must not misidentify a wrapper runtime as the provider CLI',
    );
  });

  it('persists one immutable evidence subject and refuses a conflicting overwrite', async () => {
    const { persistMcpSchemaDeliveryAttestation } = await modulePromise;
    const dir = mkdtempSync(join(tmpdir(), 'f286-attestation-'));
    const path = join(dir, 'attestation.json');
    const first = persistMcpSchemaDeliveryAttestation(path, attestation());
    const second = persistMcpSchemaDeliveryAttestation(path, attestation());

    assert.equal(first.digest, second.digest);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), attestation());
    assert.throws(
      () => persistMcpSchemaDeliveryAttestation(path, attestation({ resultDigest: SHA_A })),
      /attestation_conflicting_subject/,
    );
  });

  it('loads the exact deterministic subject for a provider launch', async () => {
    const {
      createMcpSchemaDeliveryConfigDigest,
      createMcpSchemaDeliveryLaunchConfig,
      mcpSchemaDeliveryAttestationFileName,
      persistMcpSchemaDeliveryAttestation,
      resolveMcpSchemaDeliveryForProviderLaunch,
    } = await modulePromise;
    const repoRoot = mkdtempSync(join(tmpdir(), 'f286-launch-'));
    const config = createMcpSchemaDeliveryLaunchConfig({
      declaredServerNames: ['cat-cafe-memory', 'cat-cafe-collab', 'cat-cafe-memory'],
      profileId: 'full',
      hostSurface: 'host-catalog',
    });
    assert.deepEqual(config.declaredServerNames, ['cat-cafe-collab', 'cat-cafe-memory']);
    const exactSubject = subject({ configDigest: createMcpSchemaDeliveryConfigDigest(config) });
    const evidenceDir = join(repoRoot, 'docs/features/evidence/F286/provider-schema-delivery');
    mkdirSync(evidenceDir, { recursive: true });
    persistMcpSchemaDeliveryAttestation(
      join(evidenceDir, mcpSchemaDeliveryAttestationFileName(exactSubject)),
      attestation({ subject: exactSubject }),
    );

    const result = resolveMcpSchemaDeliveryForProviderLaunch({
      repoRoot,
      command: 'codex',
      provider: 'openai',
      carrier: 'app_server',
      modelFamily: 'gpt-5.6-sol',
      profileClass: 'full',
      profileId: 'full',
      config,
      hostVersionProbe: () => '0.149.1',
    });
    assert.equal(result.requestedMode, 'catalog-deferred');
    assert.equal(result.hostVersion, '0.149.1');
    assert.match(result.attestation.ref, /openai--app-server--gpt-5.6-sol--0.149.1--full--/);
  });

  it('keeps availability independent when the host version cannot be probed', async () => {
    const { resolveMcpSchemaDeliveryForProviderLaunch } = await modulePromise;
    const health = [];
    const result = resolveMcpSchemaDeliveryForProviderLaunch({
      repoRoot: '/unused',
      command: 'missing-host',
      provider: 'openai',
      carrier: 'app_server',
      modelFamily: 'gpt-5.6-sol',
      profileClass: 'full',
      profileId: 'full',
      config: {},
      hostVersionProbe: () => undefined,
      onHealthEvent: (event) => health.push(event),
    });
    assert.deepEqual(result, {
      profileClass: 'full',
      profileId: 'full',
      requestedMode: 'unknown',
      fallbackReason: 'host_version_unavailable',
    });
    assert.equal(health[0].code, 'mcp_schema_delivery_host_version_unavailable');
  });
});
