import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  derivePluginManagerActions,
  pluginManagerContributionsFromManifest,
  projectPluginManagerCatalogCandidate,
} from '../dist/domains/plugin/plugin-manager-projection.js';

function digest(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

const candidate = {
  catalogId: 'video-analysis',
  pluginId: 'official.video-analysis',
  packageName: '@clowder-ai/video-analysis',
  version: '0.1.0-alpha.1',
  packageDigest: digest('video-analysis'),
  displayName: 'Video Analysis',
  description: 'Analyze an explicitly selected video.',
  publisher: 'Clowder AI',
  ownerAuthRequired: false,
  capabilities: [
    {
      id: 'events.publish',
      kind: 'events',
      name: 'Publish declared events',
    },
  ],
};

function installedSnapshot(overrides = {}) {
  const packageRecord = {
    packageDigest: candidate.packageDigest,
    pluginId: candidate.pluginId,
    version: candidate.version,
    contractVersion: '0.1.0',
    manifest: {
      pluginId: candidate.pluginId,
      version: candidate.version,
      contractVersion: '0.1.0',
      name: candidate.displayName,
      description: candidate.description,
      features: [
        {
          id: 'events',
          name: 'Events',
          resources: [],
          capabilities: ['events.publish'],
        },
      ],
      runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
    },
    signalSchemas: {},
    packageState: 'installed',
    verifiedAt: 1_000,
    updatedAt: 1_000,
  };
  const instance = {
    pluginInstanceId: 'pi_video',
    pluginId: candidate.pluginId,
    packageDigest: candidate.packageDigest,
    lifecycleState: 'installed',
    configReadiness: 'ready',
    activationState: 'enabled',
    runtimeState: 'healthy',
    lifecycleRevision: 4,
    installedAt: 1_000,
    updatedAt: 1_100,
    ...overrides,
  };
  return {
    schemaVersion: 1,
    packages: [packageRecord],
    instances: [instance],
    grants: [
      {
        pluginInstanceId: instance.pluginInstanceId,
        requestedCapabilities: ['events.publish'],
        effectiveGrants: ['events.publish'],
        grantRevision: 1,
        updatedAt: 1_000,
      },
    ],
  };
}

const emptySnapshot = { schemaVersion: 1, packages: [], instances: [], grants: [] };

describe('F202 terminal Plugin Manager projection', () => {
  it('projects declared contributions without relabeling permission grants as tools', () => {
    const manifest = {
      ...installedSnapshot().packages[0].manifest,
      contributions: [
        {
          type: 'mcp',
          id: 'video-analysis-toolset',
          runtime: { transport: 'stdio', entrypoint: 'dist/mcp-entrypoint.js' },
        },
        {
          type: 'tool',
          id: 'summarize-video',
          name: 'summarize_video',
          description: 'Summarize an explicitly selected video.',
          inputSchema: { type: 'object' },
          action: { method: 'video.summarize' },
        },
        {
          type: 'schedule',
          id: 'daily-video-summary',
          schedule: { kind: 'interval', everyMs: 86_400_000 },
          action: { method: 'video.summarize' },
          policy: { overlap: 'skip', timeoutMs: 60_000 },
        },
        { type: 'skill', id: 'video-analysis-guide', path: 'skills/video-analysis/SKILL.md' },
        {
          type: 'content-editor-provider',
          id: 'docx-editor',
          mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
          surface: {
            entrypoint: 'dist/editor.js',
            integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            sandbox: 'dedicated-origin-iframe',
            navigationPolicy: 'navigation-api-deny',
          },
          bridgeVersion: '1.0.0',
          operations: ['load', 'settle', 'comment', 'tracked-change'],
        },
      ],
    };

    assert.deepEqual(pluginManagerContributionsFromManifest(manifest), [
      { id: 'video-analysis-toolset', kind: 'mcp', name: 'video-analysis-toolset' },
      {
        id: 'summarize-video',
        kind: 'direct-tool',
        name: 'summarize_video',
        description: 'Summarize an explicitly selected video.',
      },
      { id: 'daily-video-summary', kind: 'schedule', name: 'daily-video-summary' },
      { id: 'video-analysis-guide', kind: 'skill', name: 'video-analysis-guide' },
      { id: 'docx-editor', kind: 'content-editor-provider', name: 'docx-editor' },
    ]);
  });

  it('expresses an uninstalled catalog candidate only through the install action', () => {
    const projected = projectPluginManagerCatalogCandidate(candidate, emptySnapshot);

    assert.equal(projected.artifact, 'absent');
    assert.equal(projected.pluginInstanceId, null);
    assert.equal(projected.packageDigest, candidate.packageDigest);
    assert.deepEqual(projected.actions, {
      install: true,
      setEnabled: false,
      uninstall: false,
      blockingReasons: [],
    });
    assert.equal(projected.auth, 'not-required');
    assert.equal(projected.intent, 'disabled');
    assert.equal(projected.live, 'stopped');
  });

  it('joins an installed instance without an update or repair affordance', () => {
    const projected = projectPluginManagerCatalogCandidate(candidate, installedSnapshot(), {
      authState: 'not-required',
      activeCapabilityIds: ['events.publish'],
    });

    assert.equal(projected.pluginInstanceId, 'pi_video');
    assert.equal(projected.artifact, 'installed');
    assert.equal(projected.config, 'ready');
    assert.equal(projected.intent, 'enabled');
    assert.equal(projected.live, 'running');
    assert.equal(projected.capabilitySummary[0].active, true);
    assert.deepEqual(projected.actions, {
      install: false,
      setEnabled: true,
      uninstall: true,
      blockingReasons: [],
    });
    assert.equal(Object.hasOwn(projected.actions, 'update'), false);
    assert.equal(Object.hasOwn(projected.actions, 'repair'), false);
  });

  it('allows disable and uninstall after a crash without inventing repair', () => {
    const projected = projectPluginManagerCatalogCandidate(candidate, installedSnapshot({ runtimeState: 'crashed' }), {
      activeCapabilityIds: [],
    });

    assert.equal(projected.intent, 'enabled');
    assert.equal(projected.live, 'crashed');
    assert.equal(projected.actions.setEnabled, true);
    assert.equal(projected.actions.uninstall, true);
    assert.equal(Object.hasOwn(projected.actions, 'repair'), false);
  });

  it('blocks enable until config and typed owner auth are ready', () => {
    assert.deepEqual(
      derivePluginManagerActions({
        artifact: 'installed',
        config: 'incomplete',
        auth: 'disconnected',
        intent: 'disabled',
        activationTransition: false,
      }),
      {
        install: false,
        setEnabled: false,
        uninstall: true,
        blockingReasons: ['config-incomplete', 'auth-disconnected'],
      },
    );
  });

  it('keeps a quarantined catalog artifact visible but exposes no executable lifecycle action', () => {
    const snapshot = installedSnapshot();
    snapshot.packages[0].packageState = 'quarantined';
    snapshot.instances = [];
    snapshot.grants = [];

    const projected = projectPluginManagerCatalogCandidate(candidate, snapshot);

    assert.equal(projected.artifact, 'quarantined');
    assert.equal(projected.pluginInstanceId, null);
    assert.deepEqual(projected.actions, {
      install: false,
      setEnabled: false,
      uninstall: false,
      blockingReasons: ['package-quarantined'],
    });
  });

  it('does not infer owner authentication from a healthy process', () => {
    const authCandidate = { ...candidate, ownerAuthRequired: true };
    const projected = projectPluginManagerCatalogCandidate(authCandidate, installedSnapshot());

    assert.equal(projected.live, 'running');
    assert.equal(projected.auth, 'disconnected');
    assert.equal(projected.actions.setEnabled, true, 'an already-enabled plugin must remain disable-able');
  });
});
