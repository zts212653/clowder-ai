import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { buildCatPatchPayload, buildCatPayload, initialState } from '../hub-cat-editor.model';
import { NativeRuntimeSection } from '../NativeRuntimeSection';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const cat = {
  id: 'codex',
  name: 'Codex',
  displayName: 'Codex',
  clientId: 'openai',
  accountRef: 'kitcoding',
  defaultModel: 'old-model',
  cli: { command: 'codex', outputFormat: 'json', effort: 'xhigh' },
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: ['@codex'],
} as CatData;
describe('native tool role editing', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          runtimes: [
            { id: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: ['gpt-example'] },
            { id: 'claude', label: 'Claude Code', clientId: 'anthropic', installed: true, models: ['opus'] },
          ],
        }),
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });
  it('keeps old roles on their existing path until explicitly migrated', () => {
    const form = initialState(cat);
    expect(form.configurationSource).toBe('managed_account');
    expect(form.defaultModel).toBe('old-model');
    expect(buildCatPatchPayload(form, cat)).not.toHaveProperty('configurationSource');
  });
  it('creates a native role without an application authentication account', () => {
    const form = {
      ...initialState(),
      name: 'Role',
      displayName: 'Role',
      catId: 'native',
      roleDescription: 'Role',
      mentionPatterns: '@native',
    };
    const payload = buildCatPayload(form);
    expect(payload.configurationSource).toBe('native_tool');
    expect(payload.defaultModel).toBe('');
    expect(payload).not.toHaveProperty('accountRef');
    expect(payload).not.toHaveProperty('cli');
  });
  it('clears old account and effort without refilling them when inheriting', () => {
    const form = {
      ...initialState(cat),
      configurationSource: 'native_tool' as const,
      defaultModel: '',
      cliEffort: '',
      accountRef: '',
    };
    const payload = buildCatPatchPayload(form, cat);
    expect(payload).toMatchObject({
      configurationSource: 'native_tool',
      accountRef: null,
      defaultModel: '',
      cli: { effort: null },
    });
  });
  it('preserves DSH startup args and profile when changing only role preferences', () => {
    const dsh = {
      ...cat,
      id: 'dsh',
      clientId: 'acp',
      defaultModel: '',
      configurationSource: 'native_tool' as const,
      accountRef: undefined,
      acp: { command: 'node', startupArgs: ['C:/tool with space/lib/bin.js', '--profile', 'acp'] },
    };
    const payload = buildCatPatchPayload({ ...initialState(dsh), cliEffort: 'low' }, dsh);
    expect(payload.acp).toMatchObject(dsh.acp);
    expect(payload.cli).toMatchObject({ effort: 'low' });
  });

  it('keeps an existing ACP descriptor visible until the native tool is explicitly selected', async () => {
    const original = {
      ...cat,
      acp: { command: 'node', startupArgs: ['C:/tool with space/bin.js', '--profile', 'acp'] },
    };
    const form = { ...initialState(original), configurationSource: 'native_tool' as const };
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <NativeRuntimeSection form={form} onChange={onChange}>
          <span>legacy</span>
        </NativeRuntimeSection>,
      );
    });
    const select = container.querySelector<HTMLSelectElement>('[aria-label="本机工具"]')!;
    expect(select.selectedOptions[0]?.textContent).toContain('ACP');
    expect(form.acpEnabled).toBe(true);
    await act(async () => {
      select.value = 'codex';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: 'openai', acpEnabled: false }));
    expect(buildCatPatchPayload({ ...form, ...onChange.mock.calls.at(-1)![0] }, original).acp).toBe(null);
  });

  it('shows installed tools and independent role overrides without account choices', async () => {
    await act(async () => {
      root.render(
        <NativeRuntimeSection
          form={{ ...initialState(cat), configurationSource: 'native_tool', defaultModel: '', cliEffort: '' }}
          onChange={vi.fn()}
        >
          <span>legacy account UI</span>
        </NativeRuntimeSection>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain('已发现');
    expect(container.textContent).toContain('认证状态尚未验证');
    expect(container.textContent).not.toContain('legacy account UI');
    expect(container.querySelector<HTMLInputElement>('[aria-label="角色模型"]')?.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('[aria-label="角色思考强度"]')?.value).toBe('');
  });
});
