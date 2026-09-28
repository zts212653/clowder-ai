import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { EditorBridgeError } from '../dist/domains/collaborative-content/editor-bridge/service.js';
import { EditorSessionError } from '../dist/domains/collaborative-content/editor-session-service.js';
import { registerCollaborativeContentRoutes } from '../dist/routes/collaborative-content-routes.js';

describe('collaborative content editor bridge routes', () => {
  let app;
  let calls;

  beforeEach(async () => {
    calls = [];
    app = Fastify();
    registerCollaborativeContentRoutes(app, {
      ownerUserId: 'operator',
      bridge: {
        load: async (input) => {
          calls.push({ method: 'load', input });
          return {
            contentIdentity: 'content-opaque',
            fileName: 'proposal.docx',
            ownerRevision: 7,
            blobDigest: `sha256:${'a'.repeat(64)}`,
            mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            bytes: Buffer.from([80, 75, 3, 4]),
          };
        },
        settle: async (input) => {
          calls.push({ method: 'settle', input });
          return {
            status: 'applied',
            receipt: {
              receiptId: 'receipt-8',
              contentRef: 'hidden-from-renderer',
              previousOwnerRevision: 7,
              ownerRevision: 8,
              blobDigest: `sha256:${'b'.repeat(64)}`,
              actor: { kind: 'human', actorId: input.principal.subjectId },
              operationId: input.operationId,
              outboxSequence: 8,
            },
          };
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const invoke = (payload, userId = 'operator') =>
    app.inject({
      method: 'POST',
      url: '/api/collaborative-content/editor-bridge',
      headers: userId ? { 'x-cat-cafe-user': userId, 'content-type': 'application/json' } : {},
      payload,
    });

  it('derives the human actor from strict request identity and encodes DOCX bytes for transport', async () => {
    const response = await invoke({
      v: 1,
      sessionToken: `editor_${'a'.repeat(40)}`,
      operation: 'content.load',
      payload: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      ok: true,
      value: {
        contentIdentity: 'content-opaque',
        fileName: 'proposal.docx',
        ownerRevision: 7,
        blobDigest: `sha256:${'a'.repeat(64)}`,
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytesBase64: 'UEsDBA==',
      },
    });
    assert.deepEqual(calls[0], {
      method: 'load',
      input: {
        sessionToken: `editor_${'a'.repeat(40)}`,
        principal: { kind: 'human', subjectId: 'operator' },
      },
    });
  });

  it('decodes a bounded save and returns only the owner receipt projection', async () => {
    const response = await invoke({
      v: 1,
      sessionToken: `editor_${'b'.repeat(40)}`,
      operation: 'content.settle',
      payload: {
        expectedOwnerRevision: 7,
        operationId: 'save-8',
        bytesBase64: Buffer.from('docx-v8').toString('base64'),
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      ok: true,
      value: {
        receiptId: 'receipt-8',
        ownerRevision: 8,
        blobDigest: `sha256:${'b'.repeat(64)}`,
      },
    });
    assert.deepEqual(calls[0], {
      method: 'settle',
      input: {
        sessionToken: `editor_${'b'.repeat(40)}`,
        principal: { kind: 'human', subjectId: 'operator' },
        expectedOwnerRevision: 7,
        operationId: 'save-8',
        bytes: Buffer.from('docx-v8'),
      },
    });
  });

  it('accepts a valid DOCX body above Fastify default and rejects the configured decoded-byte ceiling', async () => {
    const aboveFastifyDefault = Buffer.alloc(1024 * 1024 + 1, 7);
    const accepted = await invoke({
      v: 1,
      sessionToken: `editor_${'b'.repeat(40)}`,
      operation: 'content.settle',
      payload: {
        expectedOwnerRevision: 7,
        operationId: 'save-large',
        bytesBase64: aboveFastifyDefault.toString('base64'),
      },
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(calls[0].input.bytes, aboveFastifyDefault);

    await app.close();
    calls = [];
    app = Fastify();
    registerCollaborativeContentRoutes(app, {
      ownerUserId: 'operator',
      maxContentBytes: 16,
      bridge: {
        load: async () => assert.fail('not reached'),
        settle: async (input) => {
          calls.push(input);
          return { status: 'conflict', actualOwnerRevision: 1 };
        },
      },
    });
    await app.ready();
    const overLimit = await invoke({
      v: 1,
      sessionToken: `editor_${'b'.repeat(40)}`,
      operation: 'content.settle',
      payload: {
        expectedOwnerRevision: 0,
        operationId: 'save-over-limit',
        bytesBase64: Buffer.alloc(17, 1).toString('base64'),
      },
    });
    assert.equal(overLimit.statusCode, 400);
    assert.deepEqual(calls, []);
  });

  it('rejects unauthenticated browser identity, unknown operations, and non-canonical base64 before dispatch', async () => {
    const noIdentity = await invoke(
      { v: 1, sessionToken: `editor_${'c'.repeat(40)}`, operation: 'content.load', payload: {} },
      null,
    );
    assert.equal(noIdentity.statusCode, 401);

    const unknown = await invoke({
      v: 1,
      sessionToken: `editor_${'c'.repeat(40)}`,
      operation: 'host.exec',
      payload: {},
    });
    assert.equal(unknown.statusCode, 400);

    const malformed = await invoke({
      v: 1,
      sessionToken: `editor_${'c'.repeat(40)}`,
      operation: 'content.settle',
      payload: { expectedOwnerRevision: 7, operationId: 'save-9', bytesBase64: 'not base64!' },
    });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(calls, []);
  });

  it('maps owner conflicts and authority/principal failures to typed fail-closed responses', async () => {
    await app.close();
    app = Fastify();
    registerCollaborativeContentRoutes(app, {
      ownerUserId: 'operator',
      bridge: {
        load: async () => {
          throw new EditorBridgeError('PRINCIPAL_MISMATCH', 'wrong actor');
        },
        settle: async () => ({ status: 'conflict', actualOwnerRevision: 9 }),
      },
    });
    await app.ready();

    const denied = await invoke({
      v: 1,
      sessionToken: `editor_${'d'.repeat(40)}`,
      operation: 'content.load',
      payload: {},
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(JSON.parse(denied.body).error.code, 'principal_mismatch');

    const conflict = await invoke({
      v: 1,
      sessionToken: `editor_${'d'.repeat(40)}`,
      operation: 'content.settle',
      payload: { expectedOwnerRevision: 8, operationId: 'save-10', bytesBase64: 'UEsDBA==' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(JSON.parse(conflict.body), {
      ok: false,
      error: { code: 'owner_revision_conflict', message: 'Owner revision changed', actualOwnerRevision: 9 },
    });

    await app.close();
    app = Fastify();
    registerCollaborativeContentRoutes(app, {
      ownerUserId: 'operator',
      bridge: {
        load: async () => {
          throw new EditorSessionError('AUTHORITY_CHANGED', 'revoked');
        },
        settle: async () => assert.fail('not reached'),
      },
    });
    await app.ready();
    const revoked = await invoke({
      v: 1,
      sessionToken: `editor_${'d'.repeat(40)}`,
      operation: 'content.load',
      payload: {},
    });
    assert.equal(revoked.statusCode, 409);
    assert.equal(JSON.parse(revoked.body).error.code, 'authority_changed');
  });

  it('persists only a public session ref and reveals the bearer token after an actor-bound surface resume', async () => {
    await app.close();
    app = Fastify();
    const sessionRef = `editor-session:${'e'.repeat(64)}`;
    const sessionToken = `editor_${'f'.repeat(40)}`;
    const session = {
      sessionRef,
      sessionToken,
      state: 'issued',
      contentRef: 'project:alpha/assets/proposal.docx',
      actor: { kind: 'human', actorId: 'operator' },
      ownerRevision: 3,
      bindingRevision: 2,
      providerId: 'genoffice-docx',
      installationInstanceId: 'plugin-instance-1',
      providerVersion: '0.8.1039',
      packageDigest: 'sha512-package-1',
      grantRevision: 4,
      lifecycleRevision: 5,
      surfaceIntegrity: `sha256-${Buffer.alloc(32, 1).toString('base64')}`,
    };
    const sessionCalls = [];
    registerCollaborativeContentRoutes(app, {
      ownerUserId: 'operator',
      bridge: { load: async () => assert.fail('not reached'), settle: async () => assert.fail('not reached') },
      sessions: {
        issue: async (input) => {
          sessionCalls.push({ method: 'issue', input });
          return session;
        },
        prepareResume: async (input) => {
          sessionCalls.push({ method: 'prepareResume', input });
          return session;
        },
        resume: async (input) => {
          sessionCalls.push({ method: 'resume', input });
          return { ...session, state: 'active' };
        },
        closeRef: async (input) => sessionCalls.push({ method: 'closeRef', input }),
      },
      surfaces: {
        resolve: async () => ({
          v: 1,
          kind: 'f202-content-editor-surface-admission',
          providerId: session.providerId,
          installationInstanceId: session.installationInstanceId,
          providerVersion: session.providerVersion,
          packageDigest: session.packageDigest,
          grantRevision: session.grantRevision,
          lifecycleRevision: session.lifecycleRevision,
          activationState: 'enabled',
          runtimeState: 'healthy',
          rendererOrigin: 'https://renderer.plugin.invalid',
          entrypointPath: '/packages/sha512-package-1/assets/renderer/index.html',
          surfaceIntegrity: session.surfaceIntegrity,
          bridgeVersion: '1.0.0',
          sandbox: 'dedicated-origin-iframe',
          framingPolicy: {
            kind: 'csp-frame-ancestors',
            parentOrigin: 'https://cafe.invalid',
          },
          navigationPolicy: 'navigation-api-deny',
        }),
      },
    });
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/api/collaborative-content/editor-sessions',
      headers: { 'x-cat-cafe-user': 'operator', 'content-type': 'application/json' },
      payload: { contentRef: session.contentRef },
    });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(JSON.parse(created.body), {
      sessionRef,
      contentRef: session.contentRef,
      providerId: 'genoffice-docx',
      ownerRevision: 3,
      bindingRevision: 2,
    });
    assert.equal(created.body.includes(sessionToken), false);

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/collaborative-content/editor-sessions/${encodeURIComponent(sessionRef)}/resume`,
      headers: { 'x-cat-cafe-user': 'operator', 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(resumed.statusCode, 200);
    assert.deepEqual(JSON.parse(resumed.body), {
      sessionRef,
      sessionToken,
      surface: {
        v: 1,
        kind: 'f202-content-editor-surface-admission',
        providerId: session.providerId,
        installationInstanceId: session.installationInstanceId,
        providerVersion: session.providerVersion,
        packageDigest: session.packageDigest,
        grantRevision: session.grantRevision,
        lifecycleRevision: session.lifecycleRevision,
        activationState: 'enabled',
        runtimeState: 'healthy',
        rendererOrigin: 'https://renderer.plugin.invalid',
        entrypointPath: '/packages/sha512-package-1/assets/renderer/index.html',
        surfaceIntegrity: session.surfaceIntegrity,
        bridgeVersion: '1.0.0',
        sandbox: 'dedicated-origin-iframe',
        framingPolicy: {
          kind: 'csp-frame-ancestors',
          parentOrigin: 'https://cafe.invalid',
        },
        navigationPolicy: 'navigation-api-deny',
      },
    });
    assert.deepEqual(
      sessionCalls.map((call) => call.method),
      ['issue', 'prepareResume', 'resume'],
    );
    assert.deepEqual(sessionCalls[2].input.principal, { kind: 'human', subjectId: 'operator' });
  });

  it('never activates a session when the F202 surface locator is missing or changes integrity', async () => {
    await app.close();
    app = Fastify();
    const sessionRef = `editor-session:${'f'.repeat(64)}`;
    let resumeCalls = 0;
    const candidate = {
      sessionRef,
      sessionToken: `editor_${'a'.repeat(40)}`,
      state: 'issued',
      contentRef: 'project:alpha/assets/proposal.docx',
      actor: { kind: 'human', actorId: 'operator' },
      ownerRevision: 1,
      bindingRevision: 1,
      providerId: 'genoffice-docx',
      installationInstanceId: 'plugin-instance-1',
      providerVersion: '0.8.1039',
      packageDigest: 'sha512-package-1',
      grantRevision: 1,
      lifecycleRevision: 1,
      surfaceIntegrity: `sha256-${Buffer.alloc(32, 1).toString('base64')}`,
    };
    registerCollaborativeContentRoutes(app, {
      ownerUserId: 'operator',
      bridge: { load: async () => assert.fail('not reached'), settle: async () => assert.fail('not reached') },
      sessions: {
        issue: async () => candidate,
        prepareResume: async () => candidate,
        resume: async () => {
          resumeCalls += 1;
          return candidate;
        },
        closeRef: async () => undefined,
      },
      surfaces: {
        resolve: async () => ({
          v: 1,
          kind: 'f202-content-editor-surface-admission',
          providerId: candidate.providerId,
          installationInstanceId: candidate.installationInstanceId,
          providerVersion: candidate.providerVersion,
          packageDigest: candidate.packageDigest,
          grantRevision: candidate.grantRevision,
          lifecycleRevision: candidate.lifecycleRevision,
          activationState: 'enabled',
          runtimeState: 'healthy',
          rendererOrigin: 'https://renderer.plugin.invalid',
          entrypointPath: '/packages/sha512-package-1/assets/renderer/index.html',
          surfaceIntegrity: `sha256-${Buffer.alloc(32, 2).toString('base64')}`,
          bridgeVersion: '1.0.0',
          sandbox: 'dedicated-origin-iframe',
          framingPolicy: {
            kind: 'csp-frame-ancestors',
            parentOrigin: 'https://cafe.invalid',
          },
          navigationPolicy: 'navigation-api-deny',
        }),
      },
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: `/api/collaborative-content/editor-sessions/${encodeURIComponent(sessionRef)}/resume`,
      headers: { 'x-cat-cafe-user': 'operator', 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).error.code, 'editor_surface_unavailable');
    assert.equal(resumeCalls, 0);
  });

  it('requires one typed F202 attestation to bind package, entrypoint, framing, and navigation before resume', async () => {
    const sessionRef = `editor-session:${'9'.repeat(64)}`;
    const candidate = {
      sessionRef,
      state: 'issued',
      contentRef: 'project:alpha/assets/proposal.docx',
      actor: { kind: 'human', actorId: 'operator' },
      ownerRevision: 1,
      bindingRevision: 1,
      providerId: 'genoffice-docx',
      installationInstanceId: 'plugin-instance-1',
      providerVersion: '0.8.1039',
      packageDigest: 'sha512-package-1',
      grantRevision: 3,
      lifecycleRevision: 4,
      surfaceIntegrity: `sha256-${Buffer.alloc(32, 3).toString('base64')}`,
    };
    const validAdmission = {
      v: 1,
      kind: 'f202-content-editor-surface-admission',
      providerId: candidate.providerId,
      installationInstanceId: candidate.installationInstanceId,
      providerVersion: candidate.providerVersion,
      packageDigest: candidate.packageDigest,
      grantRevision: candidate.grantRevision,
      lifecycleRevision: candidate.lifecycleRevision,
      activationState: 'enabled',
      runtimeState: 'healthy',
      rendererOrigin: 'https://renderer.plugin.invalid',
      entrypointPath: '/packages/sha512-package-1/assets/renderer/index.html',
      surfaceIntegrity: candidate.surfaceIntegrity,
      bridgeVersion: '1.0.0',
      sandbox: 'dedicated-origin-iframe',
      framingPolicy: { kind: 'csp-frame-ancestors', parentOrigin: 'https://cafe.invalid' },
      navigationPolicy: 'navigation-api-deny',
    };
    for (const admission of [
      null,
      { ...validAdmission, packageDigest: 'sha512-other-package' },
      { ...validAdmission, runtimeState: 'stopped' },
      { ...validAdmission, entrypointPath: '/packages/sha512-package-1/assets/../escape.html' },
      { ...validAdmission, framingPolicy: { ...validAdmission.framingPolicy, parentOrigin: 'not-an-origin' } },
      { ...validAdmission, navigationPolicy: 'revoke-after-load' },
    ]) {
      await app.close();
      app = Fastify();
      let resumeCalls = 0;
      registerCollaborativeContentRoutes(app, {
        ownerUserId: 'operator',
        bridge: { load: async () => assert.fail('not reached'), settle: async () => assert.fail('not reached') },
        sessions: {
          issue: async () => candidate,
          prepareResume: async () => candidate,
          resume: async () => {
            resumeCalls += 1;
            return { ...candidate, sessionToken: `editor_${'z'.repeat(40)}` };
          },
          closeRef: async () => undefined,
        },
        surfaces: { resolve: async () => admission },
      });
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: `/api/collaborative-content/editor-sessions/${encodeURIComponent(sessionRef)}/resume`,
        headers: { 'x-cat-cafe-user': 'operator', 'content-type': 'application/json' },
        payload: {},
      });
      assert.equal(response.statusCode, 409);
      assert.equal(JSON.parse(response.body).error.code, 'editor_surface_unavailable');
      assert.equal(resumeCalls, 0);
    }
  });
});
