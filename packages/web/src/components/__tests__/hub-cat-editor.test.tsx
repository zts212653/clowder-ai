import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

const mockConfirm = vi.fn(() => Promise.resolve(true));
vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => mockConfirm,
}));

import { HubCatEditor } from '@/components/HubCatEditor';
import type { ProfileItem } from '@/components/hub-accounts.types';
import {
  buildCatPatchPayload,
  buildCatPayload,
  builtinAccountIdForClient,
  DEFAULT_ANTIGRAVITY_COMMAND_ARGS,
  filterProfiles,
  getAcpWarning,
  getCliEffortOptionsForClient,
  type HubCatEditorFormState,
  isAcpOnlyClient,
  showTransportSelector,
  splitCommandArgs,
  validateModelFormatForClient,
} from '@/components/hub-cat-editor.model';
import { AdvancedRuntimeSection } from '@/components/hub-cat-editor-advanced';

const mockApiFetch = vi.mocked(apiFetch);

const emptyVoiceFields = {
  voiceVoice: '',
  voiceLangCode: '',
  voiceSpeed: '',
  voiceRefAudio: '',
  voiceRefText: '',
  voiceInstruct: '',
  voiceTemperature: '',
};

const emptyAcpFields = {
  acpEnabled: false,
  acpTransport: 'stdio' as const,
  acpCommand: '',
  acpStartupArgs: '',
  acpMaxLiveProcesses: '',
  acpIdleTtlMinutes: '',
  mcpSupport: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function profileItem(
  input: Omit<ProfileItem, 'kind' | 'builtin'> & Partial<Pick<ProfileItem, 'kind' | 'builtin'>>,
): ProfileItem {
  const builtin = input.builtin ?? input.authType === 'oauth';
  return { ...input, builtin, kind: input.kind ?? (builtin ? 'builtin' : 'api_key') };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function changeField(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  eventType: 'input' | 'change' = 'input',
) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event(eventType, { bubbles: true }));
  });
}

function queryField<T extends HTMLElement>(_container: HTMLElement, selector: string): T {
  // HubCatEditor uses createPortal(... , document.body), so query the body
  const element = document.body.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element as T;
}

describe('HubCatEditor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    mockConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderAdvancedRuntimeSection(clientId: HubCatEditorFormState['clientId']) {
    const form: HubCatEditorFormState = {
      catId: `runtime-${clientId}`,
      name: `runtime-${clientId}`,
      displayName: `Runtime ${clientId}`,
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/default.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: `@runtime-${clientId}`,
      roleDescription: 'runtime config',
      personality: '',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId,
      accountRef: '',
      defaultModel: 'test-model',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyAcpFields,
      ...emptyVoiceFields,
    };

    await act(async () => {
      root.render(
        React.createElement(AdvancedRuntimeSection, {
          cat: null,
          form,
          strategyForm: null,
          loadingStrategy: false,
          strategyError: null,
          codexSettings: null,
          loadingCodexSettings: false,
          codexSettingsError: null,
          codexSettingsEditable: false,
          showCodexSettings: false,
          onChange: vi.fn(),
          onStrategyChange: vi.fn(),
          onCodexChange: vi.fn(),
        }),
      );
    });
  }

  it('shows extra CLI args editor for CLI clients and hides it for API-only clients', async () => {
    for (const clientId of ['anthropic', 'openai', 'google', 'kimi', 'opencode'] as const) {
      await renderAdvancedRuntimeSection(clientId);
      expect(document.body.textContent, clientId).toContain('额外 CLI 参数');
    }

    for (const clientId of ['antigravity', 'catagent'] as const) {
      await renderAdvancedRuntimeSection(clientId);
      expect(document.body.textContent, clientId).not.toContain('额外 CLI 参数');
    }
  });

  it('buildCatPayload keeps name in PATCH payload when editing an existing cat', () => {
    const form: HubCatEditorFormState = {
      catId: 'runtime-codex',
      name: '运行时缅因猫',
      displayName: '运行时缅因猫',
      variantLabel: 'GPT-5.5',
      nickname: '',
      avatar: '/avatars/codex.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-codex',
      roleDescription: '审查',
      personality: '严谨',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'openai',
      accountRef: '',
      defaultModel: 'gpt-5.4',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyAcpFields,
      ...emptyVoiceFields,
    };
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#16a34a', secondary: '#bbf7d0' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: '审查',
    } as CatData;

    const payload = buildCatPayload(form, existingCat) as Record<string, unknown>;
    expect(payload.name).toBe('运行时缅因猫');
    expect(payload.variantLabel).toBe('GPT-5.5');
  });

  it('buildCatPayload recomputes mcpSupport when client changes on existing cat', () => {
    const baseForm: HubCatEditorFormState = {
      catId: 'runtime-codex',
      name: '运行时缅因猫',
      displayName: '运行时缅因猫',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/codex.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-codex',
      roleDescription: '审查',
      personality: '严谨',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'openai',
      accountRef: '',
      defaultModel: 'gpt-5.4',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyAcpFields,
      ...emptyVoiceFields,
    };
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'antigravity',
      defaultModel: 'gemini-bridge',
      color: { primary: '#16a34a', secondary: '#bbf7d0' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: '审查',
    } as CatData;

    const payload = buildCatPayload(baseForm, existingCat) as Record<string, unknown>;
    expect(payload.mcpSupport).toBe(true);

    const acpPayload = buildCatPayload(
      {
        ...baseForm,
        clientId: 'acp',
        accountRef: 'claude',
        defaultModel: 'acp-model',
        acpEnabled: true,
        acpCommand: 'custom-acp-agent',
        acpStartupArgs: '--acp',
      },
      { ...existingCat, clientId: 'openai' },
    ) as Record<string, unknown>;
    expect(acpPayload.mcpSupport).toBe(true);
  });

  it('buildCatPayload seeds default Antigravity command args when the field is still blank', () => {
    const form: HubCatEditorFormState = {
      catId: 'runtime-bridge',
      name: '桥接猫',
      displayName: '桥接猫',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/bridge.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-bridge',
      roleDescription: 'bridge',
      personality: 'steady',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'antigravity',
      accountRef: '',
      defaultModel: 'gemini-bridge',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyAcpFields,
      ...emptyVoiceFields,
    };

    const payload = buildCatPayload(form, null) as Record<string, unknown>;
    expect(payload.commandArgs).toEqual(splitCommandArgs(DEFAULT_ANTIGRAVITY_COMMAND_ARGS));
  });

  it('exposes provider-aware effort options for Claude and Codex only', () => {
    expect(getCliEffortOptionsForClient('anthropic')).toEqual(['low', 'medium', 'high', 'max']);
    expect(getCliEffortOptionsForClient('openai')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(getCliEffortOptionsForClient('opencode')).toBeNull();
  });

  it('buildCatPayload keeps structured cli.effort separate from raw cliConfigArgs', () => {
    const form = {
      catId: 'runtime-codex',
      name: '运行时缅因猫',
      displayName: '运行时缅因猫',
      nickname: '',
      avatar: '/avatars/codex.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-codex',
      roleDescription: '审查',
      personality: '严谨',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      commandArgs: '',
      cliConfigArgs: ['--config model_provider="custom"'],
      cliEffort: 'xhigh',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyAcpFields,
      ...emptyVoiceFields,
    } as HubCatEditorFormState & { cliEffort: string };

    const payload = buildCatPayload(form, null) as Record<string, unknown>;
    expect(payload.cli).toEqual({ effort: 'xhigh' });
    expect(payload.cliConfigArgs).toEqual(['--config model_provider="custom"']);
  });

  it('splitCommandArgs preserves quoted segments', () => {
    expect(splitCommandArgs('chat --mode "agent bridge" --path "/tmp/work tree"')).toEqual([
      'chat',
      '--mode',
      'agent bridge',
      '--path',
      '/tmp/work tree',
    ]);
  });

  it('validateModelFormatForClient rejects opencode model without providerId/modelId format', () => {
    expect(validateModelFormatForClient('opencode', 'gpt-5.4')).toMatch(/providerId\/modelId/i);
    expect(validateModelFormatForClient('opencode', 'openai/gpt-5.4')).toBeNull();
    expect(validateModelFormatForClient('openai', 'gpt-5.4')).toBeNull();
  });

  it('buildCatPayload includes ACP transport config when enabled for OpenCode', () => {
    const form: HubCatEditorFormState = {
      catId: 'opencode-acp',
      name: 'OpenCode ACP',
      displayName: 'OpenCode ACP',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/opencode.png',
      colorPrimary: '#c8a951',
      colorSecondary: '#f5edda',
      mentionPatterns: '@opencode-acp',
      roleDescription: 'OpenCode over ACP',
      personality: '',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'opencode',
      accountRef: 'claude-key',
      defaultModel: 'claude-opus-4-6',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: 'anthropic',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyVoiceFields,
      acpEnabled: true,
      acpTransport: 'stdio',
      acpCommand: 'opencode',
      acpStartupArgs: '--acp --mode agent',
      acpMaxLiveProcesses: '4',
      acpIdleTtlMinutes: '30',
    };

    const payload = buildCatPayload(form, null) as Record<string, unknown>;
    expect(payload.acp).toEqual({
      command: 'opencode',
      startupArgs: ['--acp', '--mode', 'agent'],
      pool: { maxLiveProcesses: 4, idleTtlMs: 1_800_000 },
    });
  });

  it('buildCatPayload preserves existing hidden ACP fields when ACP stays enabled', () => {
    const form: HubCatEditorFormState = {
      catId: 'opencode-acp',
      name: 'OpenCode ACP',
      displayName: 'OpenCode ACP',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/opencode.png',
      colorPrimary: '#c8a951',
      colorSecondary: '#f5edda',
      mentionPatterns: '@opencode-acp',
      roleDescription: 'OpenCode over ACP',
      personality: '',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'opencode',
      accountRef: 'claude-key',
      defaultModel: 'claude-opus-4-6',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: 'anthropic',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyVoiceFields,
      acpEnabled: true,
      acpTransport: 'stdio',
      acpCommand: 'opencode',
      acpStartupArgs: 'acp',
      acpMaxLiveProcesses: '',
      acpIdleTtlMinutes: '',
    };
    const cat = {
      id: 'opencode-acp',
      name: 'opencode-acp',
      displayName: 'OpenCode ACP',
      clientId: 'opencode',
      acp: {
        command: 'opencode',
        startupArgs: ['acp'],
        mcpWhitelist: ['search_evidence'],
        supportsMultiplexing: true,
      },
    } as CatData;

    const payload = buildCatPayload(form, cat) as Record<string, unknown>;

    expect(payload.acp).toEqual({
      command: 'opencode',
      startupArgs: ['acp'],
      mcpWhitelist: ['search_evidence'],
      supportsMultiplexing: true,
    });
  });

  it('showTransportSelector for dual-transport clients (opencode, google, kimi)', () => {
    expect(showTransportSelector('opencode')).toBe(true);
    expect(showTransportSelector('google')).toBe(true);
    expect(showTransportSelector('kimi')).toBe(true);
    expect(showTransportSelector('acp')).toBe(false);
    expect(showTransportSelector('anthropic')).toBe(false);
    expect(showTransportSelector('openai')).toBe(false);
    expect(showTransportSelector('antigravity')).toBe(false);
  });

  it('isAcpOnlyClient identifies generic ACP client', () => {
    expect(isAcpOnlyClient('acp')).toBe(true);
    expect(isAcpOnlyClient('opencode')).toBe(false);
    expect(isAcpOnlyClient('anthropic')).toBe(false);
  });

  it('getAcpWarning returns kimi login warning when kimi + ACP', () => {
    const warning = getAcpWarning('kimi', true);
    expect(warning).toBeTruthy();
    expect(warning).toContain('kimi login');
  });

  it('getAcpWarning returns null for kimi when ACP disabled', () => {
    expect(getAcpWarning('kimi', false)).toBeNull();
  });

  it('getAcpWarning returns null for non-kimi clients', () => {
    expect(getAcpWarning('opencode', true)).toBeNull();
    expect(getAcpWarning('google', true)).toBeNull();
    expect(getAcpWarning('anthropic', true)).toBeNull();
  });

  it('buildCatPayload forces ACP transport for generic acp client', () => {
    const form: HubCatEditorFormState = {
      catId: 'acp-deepseek',
      name: 'DeepSeek ACP',
      displayName: 'DeepSeek ACP',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/default.png',
      colorPrimary: '#0f172a',
      colorSecondary: '#e2e8f0',
      mentionPatterns: '@acp-deepseek',
      roleDescription: 'ACP agent',
      personality: '',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'acp',
      accountRef: 'deepseek-key',
      defaultModel: 'deepseek-chat',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyVoiceFields,
      acpEnabled: true,
      acpTransport: 'stdio',
      acpCommand: 'deepseek-cli',
      acpStartupArgs: '--acp',
      acpMaxLiveProcesses: '',
      acpIdleTtlMinutes: '',
    };

    const payload = buildCatPayload(form, null) as Record<string, unknown>;
    expect(payload.clientId).toBe('acp');
    expect(payload.acp).toEqual({
      command: 'deepseek-cli',
      startupArgs: ['--acp'],
    });
  });

  it('buildCatPatchPayload clears stale provider for generic ACP — provider is opencode-only, not carried by acp', () => {
    // F161 root-cause fix: clientId='acp' (generic ACP) is NOT a provider carrier.
    // `provider` selects the env-map template (BUILTIN_ENV_MAPS[provider]) and is an
    // OpenCode-only concept — there is no UI field for generic ACP, and env customization
    // flows through account envVars templates instead. A stale provider (e.g. left over from
    // a clientId='opencode' member or pre-cleanup data) must be cleared (provider:null) on
    // save; otherwise prepareAcpProcessEnv forwards it to the env-map and injects the new
    // account's key under the wrong provider's env name. For OpenCode provider management,
    // use clientId='opencode' (cli or acp transport).
    const form: HubCatEditorFormState = {
      catId: 'acp-opencode',
      name: 'OpenCode ACP',
      displayName: 'OpenCode ACP',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/default.png',
      colorPrimary: '#0f172a',
      colorSecondary: '#e2e8f0',
      mentionPatterns: '@acp-opencode',
      roleDescription: 'OpenCode over generic ACP',
      personality: '',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'acp',
      accountRef: 'anthropic-key',
      defaultModel: 'claude-opus-4-6',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyVoiceFields,
      acpEnabled: true,
      acpTransport: 'stdio',
      acpCommand: 'opencode',
      acpStartupArgs: 'acp',
      acpMaxLiveProcesses: '',
      acpIdleTtlMinutes: '',
    };
    const existingCat = {
      id: 'acp-opencode',
      name: 'OpenCode ACP',
      displayName: 'OpenCode ACP',
      clientId: 'acp',
      accountRef: 'anthropic-key',
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      acp: { command: 'opencode', startupArgs: ['acp'] },
      color: { primary: '#0f172a', secondary: '#e2e8f0' },
      mentionPatterns: ['@acp-opencode'],
      avatar: '/avatars/default.png',
      roleDescription: 'OpenCode over generic ACP',
    } as CatData;

    const payload = buildCatPatchPayload(form, existingCat) as Record<string, unknown>;
    expect(payload.provider).toBeNull();
  });

  it('buildCatPatchPayload provider handling is independent of command basename — generic ACP never carries provider, kimi or opencode alike', () => {
    // F161 root-cause fix: provider handling for generic ACP must NOT depend on the command
    // basename. A clientId='acp' member is never a provider carrier whether the command is
    // "kimi", "opencode", or anything else — a stale provider is always cleared on save.
    // (Pre-cleanup, the opencode command basename alone preserved it; the cleanup commit
    // wrongly widened the carrier to ALL acp — the correct scope is opencode-only.)
    const form: HubCatEditorFormState = {
      catId: 'acp-kimi',
      name: 'Kimi ACP',
      displayName: 'Kimi ACP',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/default.png',
      colorPrimary: '#0f172a',
      colorSecondary: '#e2e8f0',
      mentionPatterns: '@acp-kimi',
      roleDescription: 'Kimi over generic ACP',
      personality: '',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'acp',
      accountRef: 'moonshot-key',
      defaultModel: 'kimi-k2',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyVoiceFields,
      acpEnabled: true,
      acpTransport: 'stdio',
      acpCommand: 'kimi',
      acpStartupArgs: 'acp',
      acpMaxLiveProcesses: '',
      acpIdleTtlMinutes: '',
    };
    const existingCat = {
      id: 'acp-kimi',
      name: 'Kimi ACP',
      displayName: 'Kimi ACP',
      clientId: 'acp',
      accountRef: 'moonshot-key',
      provider: 'moonshot',
      defaultModel: 'kimi-k2',
      acp: { command: 'kimi', startupArgs: ['acp'] },
      color: { primary: '#0f172a', secondary: '#e2e8f0' },
      mentionPatterns: ['@acp-kimi'],
      avatar: '/avatars/default.png',
      roleDescription: 'Kimi over generic ACP',
    } as CatData;

    const payload = buildCatPatchPayload(form, existingCat) as Record<string, unknown>;
    expect(payload.provider).toBeNull();
  });

  it('buildCatPatchPayload does not emit a redundant provider:null when a generic ACP member has no stale provider', () => {
    // F161 root-cause fix guard: a clean generic ACP member (no existing provider) must NOT
    // gain a noisy provider:null on every save. Clearing only applies when there is a stale
    // value to remove.
    const form: HubCatEditorFormState = {
      catId: 'acp-clean',
      name: 'Clean ACP',
      displayName: 'Clean ACP',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/default.png',
      colorPrimary: '#0f172a',
      colorSecondary: '#e2e8f0',
      mentionPatterns: '@acp-clean',
      roleDescription: 'Clean generic ACP',
      personality: '',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'acp',
      accountRef: 'some-key',
      defaultModel: 'some-model',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      ...emptyVoiceFields,
      acpEnabled: true,
      acpTransport: 'stdio',
      acpCommand: 'some-acp-agent',
      acpStartupArgs: 'acp',
      acpMaxLiveProcesses: '',
      acpIdleTtlMinutes: '',
    };
    const existingCat = {
      id: 'acp-clean',
      name: 'Clean ACP',
      displayName: 'Clean ACP',
      clientId: 'acp',
      accountRef: 'some-key',
      defaultModel: 'some-model',
      acp: { command: 'some-acp-agent', startupArgs: ['acp'] },
      color: { primary: '#0f172a', secondary: '#e2e8f0' },
      mentionPatterns: ['@acp-clean'],
      avatar: '/avatars/default.png',
      roleDescription: 'Clean generic ACP',
    } as CatData;

    const payload = buildCatPatchPayload(form, existingCat) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('provider');
  });

  it('renders normal member provider/model fields and saves to /api/cats', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            providers: [
              {
                id: 'claude-oauth',
                provider: 'claude-oauth',
                displayName: 'Claude (OAuth)',
                name: 'Claude (OAuth)',
                authType: 'oauth',
                protocol: 'anthropic',
                mode: 'subscription',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain('认证信息');
    expect(document.body.textContent).not.toContain('CLI Command');

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Avatar"]'), '/avatars/spark.png');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4-mini');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    expect(postCall?.[1]?.method).toBe('POST');
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.clientId).toBe('openai');
    expect(payload.catId).toMatch(/^cat-[a-z0-9]+$/);
    expect(payload.accountRef).toBe('codex-sponsor');
    expect(payload.defaultModel).toBe('gpt-5.4-mini');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('AC-C2: defaults API-key member aliases to the selected model name', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'openai', accountRef: 'codex-sponsor', defaultModel: 'gpt-5.4-mini' },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.accountRef).toBe('codex-sponsor');
    expect(payload.defaultModel).toBe('gpt-5.4-mini');
    expect(payload.mentionPatterns).toContain('@gpt-5.4-mini');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('uploads ref audio and saves the returned /uploads path in voiceConfig', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/uploads/ref-audio') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeInstanceOf(FormData);
        return Promise.resolve(jsonResponse({ url: '/uploads/ref-audio-test.wav' }));
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'openai', accountRef: 'codex-sponsor', defaultModel: 'gpt-5.4-mini' },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark');

    const voiceToggle = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Voice Config'),
    );
    await act(async () => {
      voiceToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Voice Lang Code"]'), 'zh', 'change');
    const audioInput = queryField<HTMLInputElement>(container, 'input[type="file"][accept*="audio"]');
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'voice.wav', { type: 'audio/wav' });
    Object.defineProperty(audioInput, 'files', {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      audioInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushEffects();

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.voiceConfig).toMatchObject({
      voice: 'zm_yunjian',
      langCode: 'zh',
      refAudio: '/uploads/ref-audio-test.wav',
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('dispatches guide:confirm only after a successful member save', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const onGuideConfirm = vi.fn();
    window.addEventListener('guide:confirm', onGuideConfirm as EventListener);
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      return Promise.resolve(jsonResponse({ config: {} }));
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'openai', accountRef: 'codex-sponsor', defaultModel: 'gpt-5.4-mini' },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onGuideConfirm).toHaveBeenCalledTimes(1);
    expect((onGuideConfirm.mock.calls[0]?.[0] as CustomEvent<{ target: string }>).detail).toEqual({
      target: 'member-editor.profile',
    });

    window.removeEventListener('guide:confirm', onGuideConfirm as EventListener);
  });

  it('does not dispatch guide:confirm when member save fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const onGuideConfirm = vi.fn();
    window.addEventListener('guide:confirm', onGuideConfirm as EventListener);
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ error: '保存失败' }, 500));
      }
      return Promise.resolve(jsonResponse({ config: {} }));
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'openai', accountRef: 'codex-sponsor', defaultModel: 'gpt-5.4-mini' },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onSaved).not.toHaveBeenCalled();
    expect(onGuideConfirm).not.toHaveBeenCalled();

    window.removeEventListener('guide:confirm', onGuideConfirm as EventListener);
  });

  it('blocks creating opencode+api_key member without ocProviderName', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'opencode',
            providers: [
              {
                id: 'opencode',
                provider: 'opencode',
                displayName: 'OpenCode (OAuth)',
                name: 'OpenCode (OAuth)',
                authType: 'oauth',
                protocol: 'anthropic',
                mode: 'subscription',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'oc-apikey',
                provider: 'oc-apikey',
                displayName: 'OC API Key',
                name: 'OC API Key',
                authType: 'api_key',
                mode: 'api_key',
                models: ['glm-5'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-opencode' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: {
            clientId: 'opencode',
            accountRef: 'oc-apikey',
            defaultModel: 'glm-5',
          },
          onClose: vi.fn(),
          onSaved: onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '运行时金渐层');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '审查');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-jinjianceng');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    // Save should be blocked — opencode+api_key without provider is rejected.
    const postCall = mockApiFetch.mock.calls.find(([path, init]) => path === '/api/cats' && init?.method === 'POST');
    expect(postCall).toBeUndefined();
    expect(document.body.textContent).toContain('Provider 名称');
  });

  it('lets OpenCode members opt into ACP transport from the auth section', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-key',
            providers: [
              {
                id: 'claude-key',
                provider: 'claude',
                displayName: 'Claude Key',
                name: 'Claude Key',
                authType: 'api_key',
                mode: 'api_key',
                models: ['claude-opus-4-6'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ cat: { id: 'opencode-acp' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'opencode', accountRef: 'claude-key', defaultModel: 'claude-opus-4-6' },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
    await flushEffects();

    expect(document.body.textContent).toContain('Transport');
    await changeField(queryField(container, 'select[aria-label="Transport"]'), 'acp', 'change');
    expect(document.body.textContent).toContain('ACP Command');

    await changeField(queryField(container, 'input[aria-label="Name"]'), 'OpenCode ACP');
    await changeField(queryField(container, 'input[aria-label="Description"]'), 'OpenCode over ACP');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@opencode-acp');
    await changeField(queryField(container, 'input[aria-label="OC Provider Name"]'), 'anthropic');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path, init]) => path === '/api/cats' && init?.method === 'POST');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.acp).toEqual({ command: 'opencode', startupArgs: ['acp'] });
    expect(onSaved).toHaveBeenCalled();
  });

  it('drops stale ACP transport when switching an ACP-enabled member to a CLI-only client', async () => {
    const existingCat = {
      id: 'opencode-acp',
      name: 'opencode-acp',
      displayName: 'OpenCode ACP',
      clientId: 'opencode',
      accountRef: 'claude-key',
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@opencode-acp'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'OpenCode over ACP',
      acp: { command: 'opencode', startupArgs: ['acp'] },
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-key',
            providers: [
              {
                id: 'claude-key',
                provider: 'claude',
                displayName: 'Claude Key',
                name: 'Claude Key',
                authType: 'api_key',
                protocol: 'anthropic',
                mode: 'api_key',
                clientId: 'anthropic',
                models: ['claude-opus-4-6'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/opencode-acp' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'opencode-acp' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: existingCat,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="Transport"]').value).toBe('acp');
    await changeField(queryField<HTMLSelectElement>(container, 'select[aria-label="Client"]'), 'anthropic', 'change');
    expect(document.body.querySelector('select[aria-label="Transport"]')).toBeNull();

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/opencode-acp' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.clientId).toBe('anthropic');
    expect(payload.acp).toBeNull();
  });

  it('resets default ACP command and args when switching between dual-transport clients', async () => {
    const existingCat = {
      id: 'opencode-acp',
      name: 'opencode-acp',
      displayName: 'OpenCode ACP',
      clientId: 'opencode',
      accountRef: 'claude-key',
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@opencode-acp'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'OpenCode over ACP',
      acp: { command: 'opencode', startupArgs: ['acp'] },
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-key',
            providers: [
              {
                id: 'claude-key',
                provider: 'claude',
                displayName: 'Claude Key',
                name: 'Claude Key',
                authType: 'api_key',
                protocol: 'anthropic',
                mode: 'api_key',
                clientId: 'anthropic',
                models: ['claude-opus-4-6'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'gemini-oauth',
                provider: 'gemini',
                displayName: 'Gemini OAuth',
                name: 'Gemini OAuth',
                authType: 'oauth',
                protocol: 'google',
                mode: 'subscription',
                clientId: 'google',
                models: ['gemini-2.5-pro'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/opencode-acp' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'opencode-acp' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: existingCat,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="Transport"]').value).toBe('acp');
    await changeField(queryField<HTMLSelectElement>(container, 'select[aria-label="Client"]'), 'google', 'change');
    await flushEffects();
    await changeField(
      queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]'),
      'gemini-oauth',
      'change',
    );
    await changeField(queryField<HTMLInputElement>(container, 'input[aria-label="Model"]'), 'gemini-2.5-pro');

    expect(queryField<HTMLInputElement>(container, 'input[aria-label="ACP Command"]').value).toBe('gemini');
    expect(queryField<HTMLInputElement>(container, 'input[aria-label="ACP Startup Args"]').value).toBe(
      '--acp --approval-mode yolo',
    );

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/opencode-acp' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.clientId).toBe('google');
    expect(payload.acp).toEqual({
      command: 'gemini',
      startupArgs: ['--acp', '--approval-mode', 'yolo'],
    });
  });

  it('resets defaultModel when switching Provider to prevent stale model carry-over', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [
          {
            id: 'claude',
            provider: 'claude',
            displayName: 'Claude (OAuth)',
            name: 'Claude (OAuth)',
            authType: 'oauth',
            clientId: 'anthropic',
            models: ['claude-opus-4-6', 'claude-sonnet-4-5'],
            hasApiKey: false,
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'codex-sponsor',
            provider: 'codex-sponsor',
            displayName: 'Codex Sponsor',
            name: 'Codex Sponsor',
            authType: 'api_key',
            models: ['gpt-5.4-mini'],
            hasApiKey: true,
            baseUrl: 'https://proxy.example',
            createdAt: '',
            updatedAt: '',
          },
        ],
      }),
    );

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: {
            id: 'opus',
            displayName: 'Opus',
            breedDisplayName: 'Ragdoll',
            nickname: '',
            clientId: 'anthropic',
            accountRef: 'claude',
            defaultModel: 'claude-opus-4-6',
            color: { primary: '#000', secondary: '#fff' },
            mentionPatterns: ['@opus'],
            avatar: '',
            roleDescription: '',
            personality: '',
          },
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    // Initially model should be claude-opus-4-6
    const modelInput = queryField<HTMLInputElement>(container, 'input[aria-label="Model"]');
    expect(modelInput.value).toBe('claude-opus-4-6');

    // Switch Provider to codex-sponsor (API Key)
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await flushEffects();

    // defaultModel should have been reset (not still 'claude-opus-4-6')
    const modelInputAfter = queryField<HTMLInputElement>(container, 'input[aria-label="Model"]');
    expect(modelInputAfter.value).not.toBe('claude-opus-4-6');
  });

  it('resets provider when switching account to prevent stale provider carry-over', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [
          {
            id: 'maas-key',
            provider: 'maas-key',
            displayName: 'MaaS Key',
            name: 'MaaS Key',
            authType: 'api_key',
            models: ['glm-5'],
            hasApiKey: true,
            baseUrl: 'https://maas.example',
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'deepseek-key',
            provider: 'deepseek-key',
            displayName: 'DeepSeek Key',
            name: 'DeepSeek Key',
            authType: 'api_key',
            models: ['deepseek-r2'],
            hasApiKey: true,
            baseUrl: 'https://deepseek.example',
            createdAt: '',
            updatedAt: '',
          },
        ],
      }),
    );

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: {
            id: 'oc-maas',
            displayName: 'OC MaaS',
            breedDisplayName: 'OpenCode',
            nickname: '',
            clientId: 'opencode',
            accountRef: 'maas-key',
            defaultModel: 'maas/glm-5',
            provider: 'maas',
            color: { primary: '#000', secondary: '#fff' },
            mentionPatterns: ['@oc-maas'],
            avatar: '',
            roleDescription: '',
            personality: '',
          } as CatData,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    // Initially provider (model provider name) should be 'maas'
    const providerInput = queryField<HTMLInputElement>(container, 'input[aria-label="OC Provider Name"]');
    expect(providerInput.value).toBe('maas');

    // Switch account to deepseek-key
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'deepseek-key', 'change');
    await flushEffects();

    // provider should have been cleared (not still 'maas')
    const providerInputAfter = queryField<HTMLInputElement>(container, 'input[aria-label="OC Provider Name"]');
    expect(providerInputAfter.value).toBe('');
  });

  it('switches to Antigravity branch and shows CLI command field', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Client"]'), 'antigravity', 'change');
    expect(document.body.textContent).toContain('CLI Command');
    expect(document.body.querySelector('select[aria-label="认证信息"]')).toBeNull();
  });

  it('shows the selected client builtin account together with all API key accounts', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'claude-sponsor',
                provider: 'claude-sponsor',
                displayName: 'Claude Sponsor',
                name: 'Claude Sponsor',
                authType: 'api_key',
                protocol: 'anthropic',
                mode: 'api_key',
                models: ['claude-opus-4-6'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    const providerSelect = queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]');
    const optionLabels = Array.from(providerSelect.options).map((option) => option.textContent ?? '');
    expect(optionLabels).toContain('Codex (OAuth)（OAuth）');
    expect(optionLabels).toContain('Claude Sponsor（API Key）');
  });

  it('keeps builtin accounts client-specific while exposing all API key accounts', () => {
    const profiles: ProfileItem[] = [
      profileItem({
        id: 'claude-oauth',
        provider: 'claude-oauth',
        displayName: 'Claude (OAuth)',
        name: 'Claude (OAuth)',
        authType: 'oauth',
        mode: 'subscription',
        models: ['claude-opus-4-6'],
        hasApiKey: false,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      }),
      profileItem({
        id: 'claude-sponsor',
        provider: 'claude-sponsor',
        displayName: 'Claude Sponsor',
        name: 'Claude Sponsor',
        authType: 'api_key',
        mode: 'api_key',
        models: ['claude-opus-4-6'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      }),
      profileItem({
        id: 'codex-oauth',
        provider: 'codex-oauth',
        displayName: 'Codex (OAuth)',
        name: 'Codex (OAuth)',
        authType: 'oauth',
        mode: 'subscription',
        models: ['gpt-5.4'],
        hasApiKey: false,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      }),
      profileItem({
        id: 'codex-sponsor',
        provider: 'codex-sponsor',
        displayName: 'Codex Sponsor',
        name: 'Codex Sponsor',
        authType: 'api_key',
        mode: 'api_key',
        models: ['gpt-5.4'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      }),
    ];

    expect(filterProfiles('openai', profiles).map((profile) => profile.id)).toEqual([
      'codex-oauth',
      'claude-sponsor',
      'codex-sponsor',
    ]);
    expect(filterProfiles('anthropic', profiles).map((profile) => profile.id)).toEqual([
      'claude-oauth',
      'claude-sponsor',
      'codex-sponsor',
    ]);
    expect(filterProfiles('opencode', profiles).map((profile) => profile.id)).toEqual([
      'claude-sponsor',
      'codex-sponsor',
    ]);

    // F159: catagent shares anthropic credential family
    expect(filterProfiles('catagent', profiles).map((profile) => profile.id)).toEqual(
      filterProfiles('anthropic', profiles).map((profile) => profile.id),
    );
    expect(builtinAccountIdForClient('catagent')).toEqual('claude');
  });

  it('allows google to use builtin auth plus third-party gateway accounts only', () => {
    const profiles: ProfileItem[] = [
      {
        id: 'gemini',
        provider: 'gemini',
        displayName: 'Gemini (OAuth)',
        name: 'Gemini (OAuth)',
        authType: 'oauth',
        kind: 'builtin',
        builtin: true,
        mode: 'subscription',
        clientId: 'google',
        models: ['gemini-2.5-pro'],
        hasApiKey: false,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
      {
        id: 'gemini-proxy',
        provider: 'gemini-proxy',
        displayName: 'Gemini Proxy',
        name: 'Gemini Proxy',
        authType: 'api_key',
        kind: 'api_key',
        builtin: false,
        mode: 'api_key',
        baseUrl: 'https://gateway.example/google',
        models: ['openrouter/google/gemini-3-flash-preview'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
      {
        id: 'google-official',
        provider: 'google-official',
        displayName: 'Google Official API',
        name: 'Google Official API',
        authType: 'api_key',
        kind: 'api_key',
        builtin: false,
        mode: 'api_key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        models: ['gemini-2.5-pro'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
      {
        id: 'broken-proxy',
        provider: 'broken-proxy',
        displayName: 'Broken Proxy',
        name: 'Broken Proxy',
        authType: 'api_key',
        kind: 'api_key',
        builtin: false,
        mode: 'api_key',
        baseUrl: 'not-a-valid-url',
        models: ['gemini-2.5-pro'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
    ];

    expect(filterProfiles('google', profiles).map((profile) => profile.id)).toEqual(['gemini', 'gemini-proxy']);
  });

  it('shows google api_key accounts with baseUrl, hides those without (#470)', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: null,
            providers: [
              {
                id: 'gemini',
                provider: 'gemini',
                displayName: 'Gemini (OAuth)',
                name: 'Gemini (OAuth)',
                authType: 'oauth',
                kind: 'builtin',
                builtin: true,
                clientId: 'google',
                mode: 'subscription',
                models: ['gemini-2.5-pro'],
                hasApiKey: false,
                createdAt: '',
                updatedAt: '',
              },
              {
                id: 'gemini-proxy',
                provider: 'gemini-proxy',
                displayName: 'Gemini Proxy',
                name: 'Gemini Proxy',
                authType: 'api_key',
                kind: 'api_key',
                builtin: false,
                clientId: 'google',
                mode: 'api_key',
                baseUrl: 'https://gateway.example/google',
                models: ['openrouter/google/gemini-3-flash-preview'],
                hasApiKey: true,
                createdAt: '',
                updatedAt: '',
              },
              {
                id: 'google-official',
                provider: 'google-official',
                displayName: 'Google Official API',
                name: 'Google Official API',
                authType: 'api_key',
                kind: 'api_key',
                builtin: false,
                clientId: 'google',
                mode: 'api_key',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                models: ['gemini-2.5-pro'],
                hasApiKey: true,
                createdAt: '',
                updatedAt: '',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'google', accountRef: 'gemini', defaultModel: 'gemini-2.5-pro' },
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    const providerSelect = queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]');
    const optionLabels = Array.from(providerSelect.options).map((option) => option.textContent ?? '');
    expect(optionLabels).toContain('Gemini (OAuth)（内置）');
    // #470: api_key profiles WITH baseUrl (third-party proxy) now show;
    // official Google endpoint (no baseUrl) stays hidden — filterAccounts rejects it.
    expect(optionLabels).toContain('Gemini Proxy（API Key）');
    expect(optionLabels).not.toContain('Google Official API（API Key）');
  });

  it('preserves existing model when it is not listed in provider defaults', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      accountRef: 'codex-oauth',
      defaultModel: 'gpt-5.3-codex-spark',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    const modelInput = queryField<HTMLInputElement>(container, 'input[aria-label="Model"]');
    expect(modelInput.value).toBe('gpt-5.3-codex-spark');
    const modelList = document.getElementById(modelInput.getAttribute('list') ?? '');
    const modelSuggestions = Array.from(modelList?.querySelectorAll('option') ?? []).map((option) => option.value);
    expect(modelSuggestions).toEqual(['gpt-5.3-codex-spark', 'gpt-5.4']);
    expect(document.body.textContent).toContain('当前模型不在此认证信息的模型列表中');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.defaultModel).toBeUndefined();
    expect(payload.clientId).toBeUndefined();
    expect(payload.accountRef).toBeUndefined();
  });

  it('describes and saves edited custom models that are not listed in provider defaults', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      accountRef: 'codex-oauth',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4-custom');

    expect(document.body.textContent).toContain('修改后会保存你输入的自定义值');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.defaultModel).toBe('gpt-5.4-custom');
  });

  it('does not rewrite unchanged Gemini model when saving alias-only edits', async () => {
    const existingCat = {
      id: 'gemini25',
      name: '遇罗猫',
      displayName: '遇罗猫',
      variantLabel: 'Gemini 3.5 Flash',
      clientId: 'google',
      accountRef: 'gemini',
      defaultModel: 'Gemini 3.5 Flash (High)',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@gemini25'],
      avatar: '/avatars/gemini.png',
      roleDescription: '审美与创意探索',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'gemini',
            providers: [
              {
                id: 'gemini',
                provider: 'gemini',
                displayName: 'Gemini (OAuth)',
                name: 'Gemini (OAuth)',
                authType: 'oauth',
                protocol: 'google',
                mode: 'subscription',
                models: ['gemini-2.5-pro', 'gemini-3.1-pro-preview'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/gemini25' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'gemini25' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@gemini35, @gemini-35');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/gemini25' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.mentionPatterns).toEqual(['@gemini35', '@gemini-35']);
    expect(payload.defaultModel).toBeUndefined();
    expect(payload.clientId).toBeUndefined();
    expect(payload.accountRef).toBeUndefined();
  });

  it('keeps unbound cats unbound when opening the editor', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.accountRef).toBeUndefined();
  });

  it('keeps unbound opencode members unbound until a provider is chosen', async () => {
    const existingCat = {
      id: 'runtime-opencode',
      name: 'runtime-opencode',
      displayName: '运行时 OpenCode',
      clientId: 'opencode',
      defaultModel: 'claude-opus-4-6',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-opencode'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            providers: [
              {
                id: 'claude-oauth',
                provider: 'claude-oauth',
                displayName: 'Claude (OAuth)',
                name: 'Claude (OAuth)',
                authType: 'oauth',
                protocol: 'anthropic',
                mode: 'subscription',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'claude-sponsor',
                provider: 'claude-sponsor',
                displayName: 'Claude Sponsor',
                name: 'Claude Sponsor',
                authType: 'api_key',
                protocol: 'anthropic',
                mode: 'api_key',
                models: ['claude-opus-4-6'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/runtime-opencode' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-opencode' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-opencode' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.accountRef).toBeUndefined();
  });

  it('allows saving existing opencode members while provider profiles are still loading', async () => {
    const existingCat = {
      id: 'runtime-opencode',
      name: 'runtime-opencode',
      displayName: '运行时 OpenCode',
      clientId: 'opencode',
      defaultModel: 'claude-opus-4-6',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-opencode'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'review',
    } as CatData;

    let resolveProfiles!: (value: Response) => void;
    const profilesPromise = new Promise<Response>((resolve) => {
      resolveProfiles = resolve;
    });

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return profilesPromise;
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/runtime-opencode' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-opencode' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    expect(saveButton).toBeTruthy();
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(
      mockApiFetch.mock.calls.find(([path, init]) => path === '/api/cats/runtime-opencode' && init?.method === 'PATCH'),
    ).toBeTruthy();

    resolveProfiles(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: 'claude-oauth',
        providers: [
          {
            id: 'claude-oauth',
            provider: 'claude-oauth',
            displayName: 'Claude (OAuth)',
            name: 'Claude (OAuth)',
            authType: 'oauth',
            protocol: 'anthropic',
            mode: 'subscription',
            models: ['claude-opus-4-6'],
            hasApiKey: false,
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
          {
            id: 'claude-sponsor',
            provider: 'claude-sponsor',
            displayName: 'Claude Sponsor',
            name: 'Claude Sponsor',
            authType: 'api_key',
            protocol: 'anthropic',
            mode: 'api_key',
            models: ['claude-opus-4-6'],
            hasApiKey: true,
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
        ],
      }),
    );
    await flushEffects();
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('');
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends accountRef=null when clearing an existing provider binding', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="认证信息"]'), '', 'change');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.accountRef).toBeNull();
  });

  it('sends accountRef=null when switching a bound member to antigravity', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Client"]'), 'antigravity', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gemini-bridge');
    await changeField(queryField(container, 'input[aria-label="CLI Command"]'), 'chat --mode agent');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.clientId).toBe('antigravity');
    expect(payload.accountRef).toBeNull();
    // #712: mcpSupport is omitted from PATCH when the value hasn't changed (both default to true)
    expect(payload.mcpSupport).toBeUndefined();
  });

  it('sends contextBudget=null when clearing existing runtime budget', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      accountRef: 'codex-oauth',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      contextBudget: {
        maxPromptTokens: 32000,
        maxContextTokens: 24000,
        maxMessages: 40,
        maxContentLengthPerMsg: 8000,
      },
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '');
    await changeField(queryField(container, 'input[aria-label="Max Context Tokens"]'), '');
    await changeField(queryField(container, 'input[aria-label="Max Messages"]'), '');
    await changeField(queryField(container, 'input[aria-label="Max Content Length Per Msg"]'), '');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.contextBudget).toBeNull();
  });

  it('requires all runtime budget fields when any budget value is provided', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain('4 项要么全部留空，要么全部填写');

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Avatar"]'), '/avatars/spark.png');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4-mini');
    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '48000');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain('上下文预算要么全部留空，要么 4 项都填写');
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/cats', expect.objectContaining({ method: 'POST' }));
  });

  it('does not show delete action inside editor (delete lives on member list)', async () => {
    const existingCat: CatData = {
      id: 'runtime-antigravity',
      name: '运行时桥接猫',
      displayName: '运行时桥接猫',
      clientId: 'antigravity',
      defaultModel: 'gemini-bridge',
      commandArgs: ['chat', '--mode', 'agent'],
      color: { primary: '#0f766e', secondary: '#99f6e4' },
      mentionPatterns: ['@runtime-antigravity'],
      avatar: '/avatars/antigravity.png',
      roleDescription: '桥接通道',
      personality: '稳定',
    };
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(document.body.querySelector('button[aria-label="删除成员"]')).toBeNull();
    expect(document.body.textContent).not.toContain('删除成员');
  });

  it('prompts before closing when there are unsaved edits', async () => {
    const onClose = vi.fn();
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [],
      }),
    );

    mockConfirm.mockResolvedValue(false);
    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose, onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '临时名字');

    const closeButton = document.body.querySelector('button[aria-label="关闭"]') as HTMLElement;
    await act(async () => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockConfirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    mockConfirm.mockResolvedValue(true);
    await act(async () => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onClose).toHaveBeenCalledTimes(1);
    mockConfirm.mockResolvedValue(true);
  });

  it('does not show delete action inside editor for any member type', async () => {
    const existingCat: CatData = {
      id: 'codex',
      name: '缅因猫',
      displayName: '缅因猫',
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      personality: 'rigorous',
    };

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(document.body.querySelector('button[aria-label="删除成员"]')).toBeNull();
  });

  it('loads runtime controls for an existing member and saves strategy separately', async () => {
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '砚砚',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex', '@缅因猫'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      personality: 'rigorous',
      teamStrengths: '代码审查、找 bug',
      caution: null,
      strengths: ['security', 'testing'],
      sessionChain: true,
      contextBudget: {
        maxPromptTokens: 32000,
        maxContextTokens: 24000,
        maxMessages: 40,
        maxContentLengthPerMsg: 8000,
      },
    } as CatData & {
      contextBudget: {
        maxPromptTokens: number;
        maxContextTokens: number;
        maxMessages: number;
        maxContentLengthPerMsg: number;
      };
    };

    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'runtime_override',
                hasOverride: true,
                override: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              coCreator: {
                name: 'Co-worker',
                aliases: ['共创伙伴'],
                mentionPatterns: ['@co-worker', '@owner'],
              },
              cats: {},
              perCatBudgets: {},
              a2a: { enabled: true, maxDepth: 2 },
              memory: { enabled: true, maxKeysPerThread: 50 },
              hindsight: {
                enabled: true,
                baseUrl: 'http://localhost:18888',
                sharedBank: 'cat-cafe-shared',
              },
              governance: { degradationEnabled: true, doneTimeoutMs: 300000, heartbeatIntervalMs: 30000 },
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                model: 'gpt-5.4',
                authMode: 'oauth',
                passModelArg: true,
              },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(
          jsonResponse({
            catId: 'codex',
            effective: {
              strategy: 'handoff',
              thresholds: { warn: 0.55, action: 0.8 },
            },
            source: 'runtime_override',
          }),
        );
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain('昵称');
    expect(document.body.textContent).toContain('显示后缀');
    expect(document.body.textContent).toContain('擅长领域');
    expect(document.body.textContent).toContain('注意事项');
    expect(document.body.textContent).toContain('Strengths');
    expect(document.body.textContent).toContain('▸ Voice Config');
    expect(document.body.textContent).toContain('展开后可配置 TTS clone 参考音频和文本。');
    expect(document.body.textContent).toContain('别名与 @ 路由');
    expect(document.body.textContent).toContain('认证与模型');
    expect(document.body.textContent).toContain('Session Chain');
    expect(document.body.textContent).toContain('── Codex 专属 (仅 Client=Codex 时显示) ──');
    expect(document.body.textContent).toContain('Codex Sandbox (Codex)');
    expect(document.body.textContent).toContain('Codex Approval (Codex)');
    expect(document.body.textContent).toContain('Codex Auth Mode (Codex)');
    expect(document.body.textContent).not.toContain('这 3 项是全局运行参数（非成员级）');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').disabled).toBe(false);
    expect(document.body.textContent).toContain('运行时持久化');
    expect(document.body.textContent).toContain('保存');
    expect(document.body.textContent).not.toContain('删除成员');
    expect(document.body.textContent).not.toContain('账号与运行方式');
    expect(document.body.textContent).not.toContain('Primary');
    expect(document.body.textContent).not.toContain('Secondary');
    expect(document.body.textContent).not.toContain('Display Name');

    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '48000');
    await changeField(queryField(container, 'input[aria-label="Variant Label"]'), 'GPT-5.5');
    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '砚砚升级版');
    await changeField(queryField(container, 'input[aria-label="Team Strengths"]'), '代码审查、找 bug、深度思考');
    await changeField(queryField(container, 'input[aria-label="Strengths"]'), 'security, testing, debugging');
    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Session Warn Threshold"]'), '0.55', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Approval"]'), 'never', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Auth Mode"]'), 'api_key', 'change');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();
    const catPayload = JSON.parse(String(catPatch?.[1]?.body));
    expect(catPayload.contextBudget.maxPromptTokens).toBe(48000);
    expect(catPayload.variantLabel).toBe('GPT-5.5');
    expect(catPayload.nickname).toBe('砚砚升级版');
    expect(catPayload.teamStrengths).toBe('代码审查、找 bug、深度思考');
    expect(catPayload.strengths).toEqual(['security', 'testing', 'debugging']);
    expect(catPayload.sessionChain).toBe(true);

    const strategyPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatch).toBeTruthy();
    const strategyPayload = JSON.parse(String(strategyPatch?.[1]?.body));
    expect(strategyPayload.strategy).toBe('handoff');
    expect(strategyPayload.thresholds.warn).toBe(0.55);

    const codexConfigPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(codexConfigPatches).toHaveLength(3);
    expect(String(codexConfigPatches[0]?.[1]?.body)).toContain('cli.codexSandboxMode');
    expect(String(codexConfigPatches[0]?.[1]?.body)).toContain('danger-full-access');
    expect(String(codexConfigPatches[1]?.[1]?.body)).toContain('cli.codexApprovalPolicy');
    expect(String(codexConfigPatches[1]?.[1]?.body)).toContain('never');
    expect(String(codexConfigPatches[2]?.[1]?.body)).toContain('codex.execution.authMode');
    expect(String(codexConfigPatches[2]?.[1]?.body)).toContain('api_key');
  });

  it('does not write session-strategy override when strategy fields are unchanged', async () => {
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex', '@缅因猫'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      sessionChain: true,
      contextBudget: {
        maxPromptTokens: 32000,
        maxContextTokens: 24000,
        maxMessages: 40,
        maxContentLengthPerMsg: 8000,
      },
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'breed',
                hasOverride: false,
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: { codexSandboxMode: 'workspace-write', codexApprovalPolicy: 'on-request' },
              codexExecution: { authMode: 'oauth' },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '砚砚');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();
    const strategyPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatch).toBeFalsy();
  });

  it('hides session strategy controls and skips invalid strategy validation when Session Chain is disabled', async () => {
    const existingCat = {
      id: 'opencode',
      name: 'opencode',
      displayName: '金渐层',
      clientId: 'opencode',
      accountRef: 'opencode',
      defaultModel: 'anthropic/claude-opus-4-6',
      color: { primary: '#C8A951', secondary: '#F5EDDA' },
      mentionPatterns: ['@opencode'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'coding',
      sessionChain: false,
    } as CatData;
    const onSaved = vi.fn(() => Promise.resolve());

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'opencode',
            providers: [],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'opencode',
                displayName: '金渐层',
                provider: 'opencode',
                effective: {
                  strategy: 'handoff',
                  thresholds: { warn: 0.85, action: 0.75 },
                },
                source: 'provider',
                hasOverride: false,
                hybridCapable: false,
                sessionChainEnabled: false,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/cats/opencode' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'opencode' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain('Session Chain 未开启');
    expect(document.body.textContent).toContain('策略不会生效');
    expect(document.body.querySelector('select[aria-label="Session Strategy"]')).toBeNull();
    expect(document.body.querySelector('input[aria-label="Session Warn Threshold"]')).toBeNull();
    expect(document.body.querySelector('input[aria-label="Session Action Threshold"]')).toBeNull();

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/opencode' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();
    const strategyPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/session-strategy/opencode' && init?.method === 'PATCH',
    );
    expect(strategyPatch).toBeFalsy();
    expect(document.body.textContent).not.toContain('Warn Threshold 必须小于 Action Threshold');
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows Codex-only runtime controls for any Client=Codex and lets alias chips be removed', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'danger-full-access',
                codexApprovalPolicy: 'never',
              },
              codexExecution: {
                authMode: 'api_key',
              },
            },
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-reviewer' } }, 201));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '运行时审查猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), 'review');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-reviewer, @第二别名');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();

    expect(document.body.textContent).toContain('Codex Sandbox (Codex)');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').value).toBe(
      'danger-full-access',
    );
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').value).toBe('never');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').value).toBe('api_key');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').disabled).toBe(false);

    const removeAliasButton = queryField<HTMLButtonElement>(container, 'button[aria-label="移除 @第二别名"]');
    await act(async () => {
      removeAliasButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'workspace-write', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Approval"]'), 'on-request', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Auth Mode"]'), 'oauth', 'change');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.mentionPatterns).toEqual(['@runtime-reviewer']);
    const codexConfigPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(codexConfigPatches).toHaveLength(3);
    expect(String(codexConfigPatches[0]?.[1]?.body)).toContain('cli.codexSandboxMode');
    expect(String(codexConfigPatches[1]?.[1]?.body)).toContain('cli.codexApprovalPolicy');
    expect(String(codexConfigPatches[2]?.[1]?.body)).toContain('codex.execution.authMode');
  });

  it('surfaces an error when a Codex runtime PATCH fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: 'Codex PATCH failed' }, 500));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain('Codex PATCH failed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('disables Codex-only fields and skips Codex PATCHes when baseline loading fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(new Response('{}', { status: 503 }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain('Codex 运行参数加载失败 (503)');
    expect(document.body.textContent).toContain('Codex 配置基线未加载成功');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').disabled).toBe(true);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').disabled).toBe(true);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').disabled).toBe(true);

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '新昵称');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();

    const codexConfigPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(codexConfigPatches).toHaveLength(0);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('rolls back the cat PATCH when a Codex runtime PATCH fails after the member save succeeds', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: 'Codex PATCH failed' }, 500));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '新昵称');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatches).toHaveLength(2);

    const firstPayload = JSON.parse(String(catPatches[0]?.[1]?.body));
    expect(firstPayload.nickname).toBe('新昵称');

    const rollbackPayload = JSON.parse(String(catPatches[1]?.[1]?.body));
    expect(rollbackPayload.nickname).toBe('旧昵称');
    expect(rollbackPayload.defaultModel).toBe('gpt-5.4');
    expect(rollbackPayload.accountRef).toBe('codex-sponsor');
    expect(document.body.textContent).toContain('Codex PATCH failed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('rolls back prior strategy and config mutations when a later Codex config PATCH fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    let configPatchCount = 0;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'runtime_override',
                hasOverride: true,
                override: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        configPatchCount += 1;
        if (configPatchCount === 2) {
          return Promise.resolve(jsonResponse({ error: 'Second Codex PATCH failed' }, 500));
        }
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '新昵称');
    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Session Warn Threshold"]'), '0.55');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Approval"]'), 'never', 'change');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const strategyPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatches).toHaveLength(2);
    expect(JSON.parse(String(strategyPatches[0]?.[1]?.body)).strategy).toBe('handoff');
    const strategyRollbackPayload = JSON.parse(String(strategyPatches[1]?.[1]?.body));
    expect(strategyRollbackPayload.strategy).toBe('compress');
    expect(strategyRollbackPayload.thresholds.warn).toBe(0.6);

    const configPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(configPatches.length).toBeGreaterThanOrEqual(3);
    expect(
      configPatches.some(
        ([, init]) =>
          String(init?.body).includes('cli.codexSandboxMode') && String(init?.body).includes('workspace-write'),
      ),
    ).toBe(true);

    const catPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatches).toHaveLength(2);
    const rollbackPayload = JSON.parse(String(catPatches[1]?.[1]?.body));
    expect(rollbackPayload.nickname).toBe('旧昵称');
    expect(document.body.textContent).toContain('Second Codex PATCH failed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('rolls back already-applied strategy mutations when later save requests throw', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'runtime_override',
                hasOverride: true,
                override: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.reject(new Error('network dropped during cat save'));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Session Warn Threshold"]'), '0.55');

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const strategyPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatches).toHaveLength(2);
    expect(JSON.parse(String(strategyPatches[0]?.[1]?.body)).strategy).toBe('handoff');
    expect(JSON.parse(String(strategyPatches[1]?.[1]?.body)).strategy).toBe('compress');
    expect(document.body.textContent).toContain('network dropped during cat save');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows dossier notice badge only when hasDossier is true (OQ-9 per-field regression)', async () => {
    const catWithDossier: CatData = {
      id: 'opus',
      name: 'opus',
      displayName: '布偶猫',
      clientId: 'claude-code',
      defaultModel: 'claude-opus-4-6',
      commandArgs: [],
      color: { primary: '#7c3aed', secondary: '#ddd6fe' },
      mentionPatterns: ['@opus'],
      avatar: '/avatars/opus.png',
      roleDescription: '主架构师',
      personality: '温柔但有主见',
    };
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    // Render WITH hasDossier=true — badge should appear
    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: catWithDossier,
          hasDossier: true,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();
    expect(document.body.textContent).toContain('擅长领域由画像驱动');

    // Re-render WITHOUT hasDossier — badge must NOT appear
    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: catWithDossier,
          hasDossier: false,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();
    expect(document.body.textContent).not.toContain('擅长领域由画像驱动');
  });
});
