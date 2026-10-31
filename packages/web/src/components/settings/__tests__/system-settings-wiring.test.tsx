import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { SettingsContent } from '../SettingsContent';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ config: {} }))),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], refresh: vi.fn(), isLoading: false, hasFetched: true }),
}));
vi.mock('@/hooks/useDossierProfiles', () => ({
  useDossierProfiles: () => ({ data: null }),
  catDossierCoversStrengths: () => false,
}));
vi.mock('../HubSystemSettingsTab', () => ({ HubSystemSettingsTab: () => <section aria-label="System settings" /> }));
vi.mock('../../HubEnvFilesTab', () => ({
  HubEnvFilesTab: ({ excludeCategories }: { excludeCategories: string[] }) => (
    <section aria-label="Environment and files" data-excluded={excludeCategories.join(',')} />
  ),
}));
vi.mock('../ExecutionRecordDefaultSettings', () => ({
  ExecutionRecordDefaultSettings: () => <section aria-label="Execution record default" />,
}));
vi.mock('../MessageDispositionDefaultSettings', () => ({
  MessageDispositionDefaultSettings: () => <section aria-label="Send mode default" />,
}));
vi.mock('../../DesktopUpdateSettingsPanel', () => ({ DesktopUpdateSettingsPanel: () => null }));

describe('System settings production composition', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    vi.unstubAllGlobals();
  });

  it.each([
    'classic',
    'v2',
  ] as const)('keeps system/environment surfaces and only mounts the v2 defaults in %s', async (shell) => {
    writeShellPresentation(shell);
    await act(async () => root.render(<SettingsContent section="system" />));
    expect(host.querySelector('[aria-label="System settings"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Environment and files"]')?.getAttribute('data-excluded')).toBe('connector');
    expect(host.querySelector('[aria-label="Execution record default"]') !== null).toBe(shell === 'v2');
    expect(host.querySelector('[aria-label="Send mode default"]') !== null).toBe(shell === 'v2');
  });
});
