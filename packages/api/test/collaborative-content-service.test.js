import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  EditorSessionError,
  EditorSessionService,
} from '../dist/domains/collaborative-content/editor-session-service.js';
import { CollaborativePatchService } from '../dist/domains/collaborative-content/patch-service.js';
import {
  OfficeProviderBindingConflictError,
  OfficeProviderBindingStore,
} from '../dist/domains/collaborative-content/provider-binding-store.js';
import { SemanticOperationStore } from '../dist/domains/collaborative-content/semantic-operation-store.js';
import { ProjectContentOwnerService } from '../dist/domains/video-studio/content-owner/service.js';

const roots = new Set();
const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-f309-collaboration-'));
  roots.add(dataDir);
  const owner = new ProjectContentOwnerService({ dataDir });
  const bindings = new OfficeProviderBindingStore({ dataDir });
  let authority = {
    providerId: 'genoffice-docx',
    installationInstanceId: 'plugin-instance-1',
    providerVersion: '0.8.1039',
    packageDigest: 'sha512-package-1',
    grantRevision: 3,
    lifecycleRevision: 7,
    activationState: 'enabled',
    runtimeState: 'healthy',
    surfaceIntegrity: 'sha256-renderer-1',
    executionLeaseDigest: `sha256:${'1'.repeat(64)}`,
  };
  let sessionSequence = 0;
  const authorityPort = {
    run: async (_expected, work) => work(),
    resolve: async (installationInstanceId) =>
      authority?.installationInstanceId === installationInstanceId ? { ...authority } : undefined,
  };
  const sessions = new EditorSessionService({
    dataDir,
    bindings,
    owner,
    authority: authorityPort,
    createSessionToken: () => `editor-session-${++sessionSequence}`,
  });
  return {
    dataDir,
    owner,
    bindings,
    sessions,
    authority: authorityPort,
    setAuthority: (next) => {
      authority = next;
    },
  };
}

async function seedContent(harness, contentRef = 'project:alpha/assets/proposal.docx') {
  await harness.owner.importContent({
    contentRef,
    bytes: Buffer.from('base-docx'),
    mediaType,
    operationId: 'import-base',
    actor: { kind: 'human', actorId: 'operator' },
  });
  await harness.bindings.bind({
    contentRef,
    providerId: 'genoffice-docx',
    installationInstanceId: 'plugin-instance-1',
    providerVersion: '0.8.1039',
    expectedBindingRevision: 0,
  });
  return contentRef;
}

async function issueActiveSession(harness, contentRef, kind, subjectId) {
  const issued = await harness.sessions.issue({ contentRef, principal: { kind, subjectId } });
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

describe('OfficeProviderBindingStore', () => {
  it('is the durable single authority and fences stale binding writers', async () => {
    const { dataDir, bindings } = await createHarness();
    const contentRef = 'project:alpha/assets/binding.docx';
    const first = await bindings.bind({
      contentRef,
      providerId: 'genoffice-docx',
      installationInstanceId: 'plugin-instance-1',
      providerVersion: '0.8.1039',
      expectedBindingRevision: 0,
    });
    assert.equal(first.bindingRevision, 1);

    const restarted = new OfficeProviderBindingStore({ dataDir });
    assert.deepEqual(await restarted.get(contentRef), first);
    await assert.rejects(
      restarted.bind({
        contentRef,
        providerId: 'superdoc-docx',
        installationInstanceId: 'plugin-instance-2',
        providerVersion: '2.0.0',
        expectedBindingRevision: 0,
      }),
      (error) => error instanceof OfficeProviderBindingConflictError && error.actualBindingRevision === 1,
    );
    assert.deepEqual(await restarted.get(contentRef), first);
  });
});

describe('EditorSessionService', () => {
  it('binds Host-authenticated actor and exact owner, binding, package, grant, and surface revisions', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const active = await issueActiveSession(harness, contentRef, 'cat', 'codex-sol');

    assert.equal(active.state, 'active');
    assert.match(active.sessionRef, /^editor-session:[0-9a-f]{64}$/);
    assert.deepEqual(active.actor, { kind: 'cat', actorId: 'codex-sol' });
    assert.equal(active.ownerRevision, 1);
    assert.equal(active.bindingRevision, 1);
    assert.equal(active.packageDigest, 'sha512-package-1');
    assert.equal(active.grantRevision, 3);
  });

  it('revokes on renderer mismatch, binding change, or current plugin authority change', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const bad = await harness.sessions.issue({
      contentRef,
      principal: { kind: 'human', subjectId: 'operator' },
    });
    await assert.rejects(
      harness.sessions.activate({ sessionToken: bad.sessionToken, surfaceIntegrity: 'sha256-forged' }),
      (error) => error instanceof EditorSessionError && error.code === 'SURFACE_INTEGRITY_MISMATCH',
    );
    assert.equal(harness.sessions.inspect(bad.sessionToken)?.state, 'revoked');

    const bindingSession = await issueActiveSession(harness, contentRef, 'human', 'operator');
    await harness.bindings.bind({
      contentRef,
      providerId: 'genoffice-docx',
      installationInstanceId: 'plugin-instance-1',
      providerVersion: '0.8.1039',
      expectedBindingRevision: 1,
    });
    await assert.rejects(
      harness.sessions.authorize(bindingSession.sessionToken),
      (error) => error instanceof EditorSessionError && error.code === 'AUTHORITY_CHANGED',
    );

    const authoritySession = await issueActiveSession(harness, contentRef, 'cat', 'codex-sol');
    harness.setAuthority({
      providerId: 'genoffice-docx',
      installationInstanceId: 'plugin-instance-1',
      providerVersion: '0.8.1039',
      packageDigest: 'sha512-package-1',
      grantRevision: 4,
      lifecycleRevision: 8,
      activationState: 'enabled',
      runtimeState: 'healthy',
      surfaceIntegrity: 'sha256-renderer-1',
      executionLeaseDigest: `sha256:${'1'.repeat(64)}`,
    });
    await assert.rejects(
      harness.sessions.authorize(authoritySession.sessionToken),
      (error) => error instanceof EditorSessionError && error.code === 'AUTHORITY_CHANGED',
    );
  });

  it('closing the human surface does not close or impersonate the named-cat session', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const human = await issueActiveSession(harness, contentRef, 'human', 'operator');
    const cat = await issueActiveSession(harness, contentRef, 'cat', 'codex-sol');

    await harness.sessions.close(human.sessionToken);
    await assert.rejects(
      harness.sessions.authorize(human.sessionToken),
      (error) => error instanceof EditorSessionError && error.code === 'SESSION_CLOSED',
    );
    assert.deepEqual((await harness.sessions.authorize(cat.sessionToken)).actor, {
      kind: 'cat',
      actorId: 'codex-sol',
    });
  });

  it('resumes a persisted public session ref only for its Host-authenticated actor', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const issued = await harness.sessions.issue({
      contentRef,
      principal: { kind: 'human', subjectId: 'operator' },
    });

    const active = await harness.sessions.resume({
      sessionRef: issued.sessionRef,
      principal: { kind: 'human', subjectId: 'operator' },
      surfaceIntegrity: 'sha256-renderer-1',
      executionLeaseDigest: `sha256:${'1'.repeat(64)}`,
    });
    assert.notEqual(active.sessionToken, issued.sessionToken);
    assert.equal(active.state, 'active');
    await assert.rejects(
      harness.sessions.authorize(issued.sessionToken),
      (error) => error instanceof EditorSessionError && error.code === 'SESSION_NOT_FOUND',
    );

    await assert.rejects(
      harness.sessions.resume({
        sessionRef: issued.sessionRef,
        principal: { kind: 'human', subjectId: 'someone-else' },
        surfaceIntegrity: 'sha256-renderer-1',
        executionLeaseDigest: `sha256:${'1'.repeat(64)}`,
      }),
      (error) => error instanceof EditorSessionError && error.code === 'PRINCIPAL_MISMATCH',
    );

    await harness.sessions.closeRef({
      sessionRef: issued.sessionRef,
      principal: { kind: 'human', subjectId: 'operator' },
    });
    await assert.rejects(
      harness.sessions.resume({
        sessionRef: issued.sessionRef,
        principal: { kind: 'human', subjectId: 'operator' },
        surfaceIntegrity: 'sha256-renderer-1',
        executionLeaseDigest: `sha256:${'1'.repeat(64)}`,
      }),
      (error) => error instanceof EditorSessionError && error.code === 'SESSION_CLOSED',
    );
  });

  it('restores the non-secret session record after restart and rotates the bearer on actor-bound resume', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const issued = await harness.sessions.issue({
      contentRef,
      principal: { kind: 'human', subjectId: 'operator' },
    });
    const snapshot = await readFile(
      join(harness.dataDir, 'projects', 'collaborative-content-v1', 'editor-sessions.json'),
      'utf8',
    );
    assert.equal(snapshot.includes(issued.sessionToken), false);
    assert.match(snapshot, /"bearerDigest": "sha256:[0-9a-f]{64}"/);
    const restarted = new EditorSessionService({
      dataDir: harness.dataDir,
      bindings: harness.bindings,
      owner: harness.owner,
      authority: harness.authority,
      createSessionToken: () => `editor-restarted-${'r'.repeat(40)}`,
    });

    const prepared = await restarted.prepareResume({
      sessionRef: issued.sessionRef,
      principal: { kind: 'human', subjectId: 'operator' },
    });
    assert.equal(prepared.sessionRef, issued.sessionRef);
    assert.equal('sessionToken' in prepared, false);

    const resumed = await restarted.resume({
      sessionRef: issued.sessionRef,
      principal: { kind: 'human', subjectId: 'operator' },
      surfaceIntegrity: 'sha256-renderer-1',
      executionLeaseDigest: `sha256:${'1'.repeat(64)}`,
    });
    assert.notEqual(resumed.sessionToken, issued.sessionToken);
    assert.equal(resumed.state, 'active');
    assert.deepEqual((await restarted.authorize(resumed.sessionToken)).actor, {
      kind: 'human',
      actorId: 'operator',
    });
    await assert.rejects(
      restarted.authorize(issued.sessionToken),
      (error) => error instanceof EditorSessionError && error.code === 'SESSION_NOT_FOUND',
    );
  });
});

describe('CollaborativePatchService', () => {
  it('replays one semantic operation without a second computation or owner revision and rejects changed intent', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const cat = await issueActiveSession(harness, contentRef, 'cat', 'codex-sol');
    let calls = 0;
    const patches = new CollaborativePatchService({
      semanticOperations: new SemanticOperationStore(harness.dataDir),
      sessions: harness.sessions,
      owner: harness.owner,
      materializer: {
        materialize: async () => {
          calls++;
          return Buffer.from('candidate');
        },
      },
    });
    const input = {
      sessionToken: cat.sessionToken,
      expectedOwnerRevision: 1,
      operationId: 'same-semantic-id',
      operation: { kind: 'comment', target: { paragraphId: 'p-1', textQuote: 'old' }, body: 'Check this' },
    };
    const first = await patches.submit(input);
    assert.equal(first.status, 'applied');
    assert.deepEqual(await patches.submit(input), first);
    assert.equal(calls, 1);
    assert.equal((await harness.owner.listOutbox(contentRef)).length, 2);
    assert.deepEqual(await patches.submit({ ...input, operation: { ...input.operation, body: 'Different request' } }), {
      status: 'rejected',
      reason: 'OPERATION_ID_REUSED',
    });
  });

  it('returns typed unavailable without settling when semantic computation is unavailable', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const cat = await issueActiveSession(harness, contentRef, 'cat', 'codex-sol');
    const patches = new CollaborativePatchService({
      semanticOperations: new SemanticOperationStore(harness.dataDir),
      sessions: harness.sessions,
      owner: harness.owner,
      materializer: {
        materialize: async () => {
          throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'No admitted semantic runner');
        },
      },
    });
    assert.deepEqual(
      await patches.submit({
        sessionToken: cat.sessionToken,
        expectedOwnerRevision: 1,
        operationId: 'unavailable-comment',
        operation: { kind: 'comment', target: { paragraphId: 'p-1', textQuote: 'original' }, body: 'Please check' },
      }),
      { status: 'unavailable', reason: 'PROVIDER_UNAVAILABLE' },
    );
    assert.equal((await harness.owner.load(contentRef)).ownerRevision, 1);
    assert.equal((await harness.owner.listOutbox(contentRef)).length, 1);
  });

  it('settles semantic cat edits and comments only through the owner receipt', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const cat = await issueActiveSession(harness, contentRef, 'cat', 'codex-sol');
    const materialized = [];
    const patches = new CollaborativePatchService({
      semanticOperations: new SemanticOperationStore(harness.dataDir),
      sessions: harness.sessions,
      owner: harness.owner,
      materializer: {
        materialize: async ({ bytes, operation }) => {
          materialized.push(operation.kind);
          return Buffer.concat([bytes, Buffer.from(`|${operation.kind}`)]);
        },
      },
    });

    const tracked = await patches.submit({
      sessionToken: cat.sessionToken,
      expectedOwnerRevision: 1,
      operationId: 'cat-track-1',
      operation: {
        kind: 'tracked-change',
        target: { paragraphId: 'paragraph-7', textQuote: 'old text' },
        replacement: 'new text',
      },
    });
    assert.equal(tracked.status, 'applied');
    assert.equal(tracked.operationKind, 'tracked-change');
    assert.equal(tracked.receipt.actor.kind, 'cat');
    assert.equal(tracked.receipt.actor.actorId, 'codex-sol');

    const comment = await patches.submit({
      sessionToken: cat.sessionToken,
      expectedOwnerRevision: 2,
      operationId: 'cat-comment-1',
      operation: {
        kind: 'comment',
        target: { paragraphId: 'paragraph-7', textQuote: 'new text' },
        body: '请核对这个数字',
      },
    });
    assert.equal(comment.status, 'applied');
    assert.equal(comment.operationKind, 'comment');
    assert.deepEqual(materialized, ['tracked-change', 'comment']);
    assert.equal((await harness.owner.listOutbox(contentRef)).length, 3);
  });

  it('rejects whole-file cat replacement and returns typed conflict for a stale materialized edit', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const human = await issueActiveSession(harness, contentRef, 'human', 'operator');
    const cat = await issueActiveSession(harness, contentRef, 'cat', 'codex-sol');
    const patches = new CollaborativePatchService({
      semanticOperations: new SemanticOperationStore(harness.dataDir),
      sessions: harness.sessions,
      owner: harness.owner,
      materializer: {
        materialize: async ({ bytes, operation }) => Buffer.concat([bytes, Buffer.from(`|${operation.kind}`)]),
      },
    });

    assert.deepEqual(
      await patches.submit({
        sessionToken: cat.sessionToken,
        expectedOwnerRevision: 1,
        operationId: 'cat-direct-1',
        operation: { kind: 'direct-settlement', bytes: Buffer.from('cat-overwrite') },
      }),
      { status: 'rejected', reason: 'CAT_DIRECT_REPLACEMENT_FORBIDDEN' },
    );

    const humanResult = await patches.submit({
      sessionToken: human.sessionToken,
      expectedOwnerRevision: 1,
      operationId: 'human-direct-1',
      operation: { kind: 'direct-settlement', bytes: Buffer.from('human-save') },
    });
    assert.equal(humanResult.status, 'applied');

    const staleCat = await patches.submit({
      sessionToken: cat.sessionToken,
      expectedOwnerRevision: 1,
      operationId: 'cat-stale-1',
      operation: {
        kind: 'tracked-change',
        target: { paragraphId: 'paragraph-8', textQuote: 'stale' },
        replacement: 'fresh',
      },
    });
    assert.deepEqual(staleCat, { status: 'conflict', actualOwnerRevision: 2 });
    assert.equal((await harness.owner.load(contentRef)).ownerRevision, 2);
  });

  it('rechecks plugin authority after materialization and before owner settlement', async () => {
    const harness = await createHarness();
    const contentRef = await seedContent(harness);
    const cat = await issueActiveSession(harness, contentRef, 'cat', 'codex-sol');
    const patches = new CollaborativePatchService({
      semanticOperations: new SemanticOperationStore(harness.dataDir),
      sessions: harness.sessions,
      owner: harness.owner,
      materializer: {
        materialize: async ({ bytes }) => {
          harness.setAuthority({
            providerId: 'genoffice-docx',
            installationInstanceId: 'plugin-instance-1',
            providerVersion: '0.8.1039',
            packageDigest: 'sha512-package-1',
            grantRevision: 4,
            lifecycleRevision: 8,
            activationState: 'disabled',
            runtimeState: 'stopped',
            surfaceIntegrity: 'sha256-renderer-1',
            executionLeaseDigest: `sha256:${'1'.repeat(64)}`,
          });
          return Buffer.concat([bytes, Buffer.from('|late-edit')]);
        },
      },
    });

    assert.deepEqual(
      await patches.submit({
        sessionToken: cat.sessionToken,
        expectedOwnerRevision: 1,
        operationId: 'cat-authority-loss-1',
        operation: {
          kind: 'tracked-change',
          target: { paragraphId: 'paragraph-9', textQuote: 'old' },
          replacement: 'new',
        },
      }),
      { status: 'unavailable', reason: 'AUTHORITY_CHANGED' },
    );
    assert.equal((await harness.owner.load(contentRef)).ownerRevision, 1);
  });
});
