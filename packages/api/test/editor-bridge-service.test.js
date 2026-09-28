import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { EditorBridgeError, EditorBridgeService } from '../dist/domains/collaborative-content/editor-bridge/service.js';
import { EditorSessionService } from '../dist/domains/collaborative-content/editor-session-service.js';
import { CollaborativePatchService } from '../dist/domains/collaborative-content/patch-service.js';
import { OfficeProviderBindingStore } from '../dist/domains/collaborative-content/provider-binding-store.js';
import { ProjectContentOwnerService } from '../dist/domains/video-studio/content-owner/service.js';

const roots = new Set();
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function createHarness({ bytes = Buffer.from('base-docx'), maxContentBytes = 1024 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-f309-editor-bridge-'));
  roots.add(dataDir);
  const owner = new ProjectContentOwnerService({ dataDir });
  const bindings = new OfficeProviderBindingStore({ dataDir });
  let authorityEnabled = true;
  const authority = {
    run: async (_expected, work) => work(),
    resolve: async (installationInstanceId) =>
      authorityEnabled && installationInstanceId === 'plugin-instance-1'
        ? {
            providerId: 'genoffice-docx',
            installationInstanceId,
            providerVersion: '0.8.1039',
            packageDigest: 'sha512-package-1',
            grantRevision: 3,
            lifecycleRevision: 7,
            activationState: 'enabled',
            runtimeState: 'healthy',
            surfaceIntegrity: 'sha256-renderer-1',
            executionLeaseDigest: `sha256:${'1'.repeat(64)}`,
          }
        : undefined,
  };
  let sequence = 0;
  const sessions = new EditorSessionService({
    dataDir,
    bindings,
    owner,
    authority,
    createSessionToken: () => `editor-session-token-${String(++sequence).padStart(32, '0')}`,
  });
  await owner.importContent({
    contentRef: 'project:alpha/assets/proposal.docx',
    bytes,
    mediaType: DOCX,
    operationId: 'import-base',
    actor: { kind: 'human', actorId: 'operator' },
  });
  await bindings.bind({
    contentRef: 'project:alpha/assets/proposal.docx',
    providerId: 'genoffice-docx',
    installationInstanceId: 'plugin-instance-1',
    providerVersion: '0.8.1039',
    expectedBindingRevision: 0,
  });
  const patches = new CollaborativePatchService({
    sessions,
    owner,
    materializer: {
      materialize: async ({ bytes: current, operation }) => Buffer.concat([current, Buffer.from(`|${operation.kind}`)]),
    },
  });
  const bridge = new EditorBridgeService({ sessions, owner, patches, maxContentBytes });
  return {
    bridge,
    owner,
    sessions,
    disableAuthority: () => {
      authorityEnabled = false;
    },
  };
}

async function issueActive(harness, kind, subjectId) {
  const issued = await harness.sessions.issue({
    contentRef: 'project:alpha/assets/proposal.docx',
    principal: { kind, subjectId },
  });
  return harness.sessions.activate({
    sessionToken: issued.sessionToken,
    surfaceIntegrity: 'sha256-renderer-1',
    executionLeaseDigest: `sha256:${'1'.repeat(64)}`,
  });
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('EditorBridgeService', () => {
  it('loads only the content and actor bound by the Host-issued session', async () => {
    const harness = await createHarness();
    const human = await issueActive(harness, 'human', 'operator');

    const loaded = await harness.bridge.load({
      sessionToken: human.sessionToken,
      principal: { kind: 'human', subjectId: 'operator' },
    });

    assert.equal(loaded.fileName, 'proposal.docx');
    assert.equal(loaded.ownerRevision, 1);
    assert.equal(loaded.mediaType, DOCX);
    assert.deepEqual(loaded.bytes, Buffer.from('base-docx'));
    assert.match(loaded.contentIdentity, /^content-[0-9a-f]{64}$/);
    assert.equal('contentRef' in loaded, false);

    await assert.rejects(
      harness.bridge.load({
        sessionToken: human.sessionToken,
        principal: { kind: 'human', subjectId: 'someone-else' },
      }),
      (error) => error instanceof EditorBridgeError && error.code === 'PRINCIPAL_MISMATCH',
    );
  });

  it('fails closed when content exceeds the admitted bridge bound or authority changes during load', async () => {
    const tooLarge = await createHarness({ bytes: Buffer.alloc(17), maxContentBytes: 16 });
    const largeSession = await issueActive(tooLarge, 'human', 'operator');
    await assert.rejects(
      tooLarge.bridge.load({
        sessionToken: largeSession.sessionToken,
        principal: { kind: 'human', subjectId: 'operator' },
      }),
      (error) => error instanceof EditorBridgeError && error.code === 'CONTENT_TOO_LARGE',
    );

    const revoked = await createHarness();
    const revokedSession = await issueActive(revoked, 'human', 'operator');
    revoked.disableAuthority();
    await assert.rejects(
      revoked.bridge.load({
        sessionToken: revokedSession.sessionToken,
        principal: { kind: 'human', subjectId: 'operator' },
      }),
      (error) => error?.code === 'AUTHORITY_CHANGED',
    );
  });

  it('settles a human save through F138 receipt and returns a typed stale-owner conflict', async () => {
    const harness = await createHarness();
    const first = await issueActive(harness, 'human', 'operator');
    const second = await issueActive(harness, 'human', 'operator');

    const applied = await harness.bridge.settle({
      sessionToken: first.sessionToken,
      principal: { kind: 'human', subjectId: 'operator' },
      expectedOwnerRevision: 1,
      operationId: 'human-save-1',
      bytes: Buffer.from('human-v2'),
    });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.receipt.ownerRevision, 2);
    assert.deepEqual((await harness.owner.load('project:alpha/assets/proposal.docx')).bytes, Buffer.from('human-v2'));

    assert.deepEqual(
      await harness.bridge.settle({
        sessionToken: second.sessionToken,
        principal: { kind: 'human', subjectId: 'operator' },
        expectedOwnerRevision: 1,
        operationId: 'human-stale-1',
        bytes: Buffer.from('stale'),
      }),
      { status: 'conflict', actualOwnerRevision: 2 },
    );
  });

  it('never lets the renderer turn a named-cat session into whole-file replacement', async () => {
    const harness = await createHarness();
    const cat = await issueActive(harness, 'cat', 'codex-sol');

    assert.deepEqual(
      await harness.bridge.settle({
        sessionToken: cat.sessionToken,
        principal: { kind: 'cat', subjectId: 'codex-sol' },
        expectedOwnerRevision: 1,
        operationId: 'cat-forged-direct-1',
        bytes: Buffer.from('forged'),
      }),
      { status: 'rejected', reason: 'CAT_DIRECT_REPLACEMENT_FORBIDDEN' },
    );
    assert.deepEqual((await harness.owner.load('project:alpha/assets/proposal.docx')).bytes, Buffer.from('base-docx'));
  });
});
