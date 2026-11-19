import assert from 'node:assert/strict';
import test from 'node:test';

import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { WorkspacePreviewService } from '../src/domains/collaborative-content/workspace-preview-service.js';
import {
  staticContentProviderContributions,
  staticEditorContributions,
} from '../src/domains/plugin/content-editor-runtime/admission.js';

const surface = {
  entrypoint: 'renderer/index.html',
  integrity: `sha256-${'A'.repeat(43)}=`,
  sandbox: 'dedicated-origin-iframe',
  navigationPolicy: 'navigation-api-deny',
} as const;

const editor = {
  type: 'content-editor-provider',
  id: 'docx',
  mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  surface,
  bridgeVersion: '1.0.0',
  operations: ['load', 'settle', 'comment', 'tracked-change'],
} as const;

const preview = {
  type: 'content-preview-provider',
  id: 'preview',
  formats: [{ extension: 'pdf', mediaType: 'application/pdf' }],
  surface: { ...surface, entrypoint: 'preview/index.html' },
  bridgeVersion: '1.0.0',
} as const;

const manifest = {
  pluginId: 'dev.clowder.genoffice-docx',
  name: 'GenOffice',
  version: '0.1.0-alpha.4',
  contractVersion: '0.1.0',
  runtime: { transport: 'builtin' },
  contributions: [editor, preview],
  features: [
    { id: 'edit-docx', name: 'Edit', resources: [], contributions: [{ type: editor.type, id: editor.id }] },
    { id: 'preview', name: 'Preview', resources: [], contributions: [{ type: preview.type, id: preview.id }] },
  ],
} satisfies PluginManifest;

test('one static package can declare a viewer without losing its DOCX editor', () => {
  assert.deepEqual(staticContentProviderContributions(manifest), [editor, preview]);
  assert.deepEqual(staticEditorContributions(manifest), [editor]);
});

test('a viewer package cannot carry an unrelated executable contribution', () => {
  const mixed = {
    ...manifest,
    contributions: [...manifest.contributions, { type: 'skill' as const, id: 'other', path: 'skill' }],
  };
  assert.deepEqual(staticContentProviderContributions(mixed), []);
  assert.deepEqual(staticEditorContributions(mixed), []);
});

test('dispatches a plugin-declared extension to a single read-only snapshot', async () => {
  const generic = { ...preview, formats: [{ extension: 'deck', mediaType: 'application/x-example-deck' }] };
  const snapshot = {
    schemaVersion: 1,
    instances: [
      {
        lifecycleState: 'installed',
        activationState: 'enabled',
        runtimeState: 'healthy',
        configReadiness: 'ready',
        pluginId: manifest.pluginId,
        pluginInstanceId: 'active',
        packageDigest: 'digest',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      },
    ],
    packages: [
      {
        packageDigest: 'digest',
        pluginId: manifest.pluginId,
        version: manifest.version,
        contractVersion: manifest.contractVersion,
        manifest: { ...manifest, contributions: [editor, generic] },
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      },
    ],
  } satisfies Awaited<ReturnType<ConstructorParameters<typeof WorkspacePreviewService>[0]['inventory']['snapshot']>>;
  const reads: string[] = [];
  const service = new WorkspacePreviewService({
    inventory: { snapshot: async () => snapshot },
    runtime: {
      resolvePreview: async (id, provider) => {
        assert.equal(id, 'active');
        assert.equal(provider, 'preview');
        return {
          contribution: generic,
          installationInstanceId: id,
          packageDigest: 'digest',
          providerVersion: manifest.version,
          lifecycleRevision: 1,
          executionLease: 'preview-lease',
          featureId: 'preview',
          integrityEpoch: 1,
          activationRevision: 1,
          rendererOrigin: 'http://editor-00000000000000000000000000000000.localhost:56123',
          entrypointPath: '/packages/seed/assets/preview/index.html',
          parentOrigin: 'http://localhost:3010',
        };
      },
    },
    readSource: async (worktreeId, path) => {
      reads.push(worktreeId + ':' + path);
      return Buffer.from('snapshot');
    },
  });
  assert.equal(await service.open({ worktreeId: 'project', path: 'ordinary.pdf' }), null);
  assert.deepEqual(reads, []);
  assert.deepEqual(await service.open({ worktreeId: 'project', path: 'presentations/sample.DECK' }), {
    rendererOrigin: 'http://editor-00000000000000000000000000000000.localhost:56123',
    entrypointPath: '/packages/seed/assets/preview/index.html',
    fileName: 'sample.DECK',
    mediaType: 'application/x-example-deck',
    bytesBase64: Buffer.from('snapshot').toString('base64'),
  });
  assert.deepEqual(reads, ['project:presentations/sample.DECK']);
});
