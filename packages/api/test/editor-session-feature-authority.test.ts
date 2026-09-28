import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EditorSessionService } from '../src/domains/collaborative-content/editor-session-service.js';
import { OfficeProviderBindingStore } from '../src/domains/collaborative-content/provider-binding-store.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

test('a fresh feature activation invalidates an old editor session even with unchanged inventory revisions', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f309-session-feature-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir });
  const bindings = new OfficeProviderBindingStore({ dataDir });
  await owner.importContent({
    contentRef: 'doc:one',
    bytes: Buffer.from('docx'),
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    operationId: 'import',
    actor: { kind: 'human', actorId: 'owner' },
  });
  await bindings.bind({
    contentRef: 'doc:one',
    providerId: 'docx',
    installationInstanceId: 'instance',
    providerVersion: '0.1.0-alpha.0',
    expectedBindingRevision: 0,
  });
  let executionLeaseDigest = `sha256:${'1'.repeat(64)}`;
  const sessions = new EditorSessionService({
    dataDir,
    owner,
    bindings,
    authority: {
      resolve: async () => ({
        providerId: 'docx',
        installationInstanceId: 'instance',
        providerVersion: '0.1.0-alpha.0',
        packageDigest: 'sha512-package',
        grantRevision: 1,
        lifecycleRevision: 3,
        activationState: 'enabled',
        runtimeState: 'healthy',
        surfaceIntegrity: 'sha256-renderer',
        executionLeaseDigest,
      }),
      run: async (_expected, work) => work(),
    },
  });
  const issued = await sessions.issue({ contentRef: 'doc:one', principal: { kind: 'human', subjectId: 'owner' } });
  await sessions.activate({ sessionToken: issued.sessionToken, surfaceIntegrity: 'sha256-renderer' });
  executionLeaseDigest = `sha256:${'2'.repeat(64)}`;
  await assert.rejects(sessions.authorize(issued.sessionToken), /authority/i);
  await assert.rejects(
    sessions.prepareResume({ sessionRef: issued.sessionRef, principal: { kind: 'human', subjectId: 'owner' } }),
    /revoked/i,
  );
});
