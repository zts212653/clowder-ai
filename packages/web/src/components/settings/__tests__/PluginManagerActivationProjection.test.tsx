import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginInstanceRecord,
  PluginInventorySnapshot,
} from '../../../../../api/src/domains/plugin/host-inventory/types';
import { projectPluginManagerCatalogCandidate } from '../../../../../api/src/domains/plugin/plugin-manager-projection';
import { PluginManagerContent } from '../plugin-manager/PluginManagerContent';
import { designFixture } from '../plugin-manager/plugin-manager-live-api';

const candidate = {
  catalogId: 'activation-proof',
  pluginId: 'official.activation-proof',
  packageName: '@clowder-ai/activation-proof',
  version: '0.1.0',
  packageDigest: 'sha512-proof',
  displayName: 'Activation proof',
  ownerAuthRequired: false,
  capabilities: [],
};

function project(
  activationState: PluginInstanceRecord['activationState'],
  runtimeState: PluginInstanceRecord['runtimeState'],
  diagnostic = true,
) {
  const snapshot: PluginInventorySnapshot = {
    schemaVersion: 1,
    packages: [
      {
        pluginId: candidate.pluginId,
        packageDigest: candidate.packageDigest,
        version: candidate.version,
        contractVersion: '0.1.0',
        packageState: 'installed',
        signalSchemas: {},
        verifiedAt: 1,
        updatedAt: 1,
        manifest: {
          pluginId: candidate.pluginId,
          version: candidate.version,
          contractVersion: '0.1.0',
          name: candidate.displayName,
          features: [],
          runtime: { transport: 'stdio', entrypoint: 'dist/main.js' },
        },
      },
    ],
    grants: [],
    instances: [
      {
        pluginId: candidate.pluginId,
        pluginInstanceId: 'pi_activation',
        packageDigest: candidate.packageDigest,
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState,
        runtimeState,
        lifecycleRevision: 3,
        installedAt: 1,
        updatedAt: 2,
        ...(diagnostic
          ? { lastRuntimeError: { code: 'UNEXPECTED_RUNTIME_FAILURE', occurredAt: 2, exitCode: null, signal: null } }
          : {}),
      },
    ],
  };
  return projectPluginManagerCatalogCandidate(candidate, snapshot);
}

describe('Host activation projection through Plugin Manager UI', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows the real stopped startup failure without changing intent or permissions', () => {
    const item = project('error', 'stopped');
    expect(item.intent).toBe('disabled');
    expect(item.live).toBe('stopped');
    expect(item.actions.setEnabled).toBe(true);
    act(() =>
      root.render(
        <PluginManagerContent presentation="v2" fixtures={[designFixture(item, undefined, { state: 'absent' })]} />,
      ),
    );
    expect(container.querySelector('[data-plugin-section="attention"]')?.textContent).toContain(
      'UNEXPECTED_RUNTIME_FAILURE',
    );
  });

  it('shows current activation failure even without a recorded diagnostic', () => {
    const item = project('error', 'stopped', false);
    act(() =>
      root.render(
        <PluginManagerContent presentation="v2" fixtures={[designFixture(item, undefined, { state: 'absent' })]} />,
      ),
    );
    expect(container.querySelector('[data-plugin-section="attention"]')?.textContent).toContain('插件运行操作失败');
  });

  it.each([
    ['disabled', 'stopped'],
    ['enabled', 'healthy'],
  ] as const)('does not turn a historical diagnostic into a current failure (%s/%s)', (activation, runtime) => {
    const item = project(activation, runtime);
    expect(item.diagnostic?.code).toBe('UNEXPECTED_RUNTIME_FAILURE');
    act(() =>
      root.render(
        <PluginManagerContent presentation="v2" fixtures={[designFixture(item, undefined, { state: 'absent' })]} />,
      ),
    );
    expect(container.querySelector('[data-plugin-section="attention"]')).toBeNull();
    expect(container.querySelector('[data-plugin-section="installed"]')).not.toBeNull();
  });

  it('retains v1 grouping for the same production failure', () => {
    const item = project('error', 'stopped');
    act(() => root.render(<PluginManagerContent fixtures={[designFixture(item, undefined, { state: 'absent' })]} />));
    expect(container.querySelector('[data-plugin-section="attention"]')).toBeNull();
    expect(container.querySelector('[data-plugin-section="installed"]')).not.toBeNull();
  });
});
