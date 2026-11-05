import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { EditorSessionError } from '../src/domains/collaborative-content/editor-session-types.js';
import { createCollaborativeContentComposition } from '../src/domains/collaborative-content/runtime-composition.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { staticEditorFixture, staticEditorManifest } from './plugin-static-editor.fixture.js';

const worker = `self.onmessage = ({data}) => self.postMessage({
  protocolVersion: data.protocolVersion, requestId: data.requestId,
  result: data.operation.kind === 'inspect'
    ? {kind:'inspection', paragraphs:[{target:{paragraphId:'p1',textQuote:atob(data.bytesBase64)},editable:true}],nextCursor:null}
    : {kind:'document',bytesBase64:btoa(data.operation.replacement)}
});`;

test('production composition routes installed editor inspect/edit/reopen through its declared worker', async (t) => {
  const manifest = staticEditorManifest();
  const contribution = manifest.contributions![0];
  assert.equal(contribution.type, 'content-editor-provider');
  if (contribution.type !== 'content-editor-provider') throw new Error('fixture');
  contribution.semanticMaterializer = {
    executionClass: 'dedicated-browser-worker',
    entrypoint: 'renderer/worker.js',
    integrity: `sha256-${createHash('sha256').update(worker).digest('base64')}`,
    protocolVersion: '1.0.0',
  };
  const fixture = await staticEditorFixture(manifest, undefined, worker);
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: fixture.root,
    editorParentOrigin: 'http://localhost:4179',
  });
  t.after(async () => {
    await runtime.shutdown();
    await fixture.cleanup();
  });
  const installed = await new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [fixture.entry],
    fetchArchive: async () => fixture.bytes,
  }).install(fixture.entry.catalogId, fixture.entry);
  const record = (await runtime.inventoryStore.snapshot()).instances[0]!;
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, record.lifecycleRevision);
  const enabled = await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  const content = createCollaborativeContentComposition({
    dataDir: join(fixture.root, 'content'),
    ownerUserId: 'owner',
    plugins: runtime,
    readSource: async () => Buffer.from('original document'),
  });
  const opened = await content.workspace.open({
    worktreeId: 'fixture',
    path: 'sample.docx',
    principal: { kind: 'human', subjectId: 'owner' },
  });
  const input = {
    principal: { userId: 'owner', catId: 'astra' },
    contentRef: opened.contentRef,
    cursor: 0,
    limit: 4,
    maxChars: 12000,
  };
  const inspected = await content.namedCats.inspect(input);
  assert.equal(inspected.status, 'ready');
  if (inspected.status !== 'ready') throw new Error('inspection unavailable');
  assert.equal(inspected.paragraphs[0]?.target.textQuote, 'original document');
  const change = {
    principal: input.principal,
    contentRef: opened.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'editor-worker-c1',
    operation: {
      kind: 'tracked-change' as const,
      target: inspected.paragraphs[0]!.target,
      replacement: 'edited document',
    },
  };
  const edited = await content.namedCats.edit(change);
  assert.equal(edited.status, 'applied');
  const replay = await content.namedCats.edit(change);
  assert.deepEqual(replay, edited);
  const reopened = await content.namedCats.inspect({ ...input, expectedOwnerRevision: 2 });
  assert.equal(reopened.status, 'ready');
  if (reopened.status === 'ready') assert.equal(reopened.paragraphs[0]?.target.textQuote, 'edited document');
  await runtime.lifecycle.disable(installed.pluginInstanceId, enabled.lifecycleRevision);
  await assert.rejects(
    content.namedCats.inspect(input),
    (error: unknown) => error instanceof EditorSessionError && error.code === 'PROVIDER_UNAVAILABLE',
  );
});
