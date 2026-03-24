import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => () => Promise.resolve(true),
}));

import { HubAddMemberWizard } from '@/components/HubAddMemberWizard';
import { HubCatEditor } from '@/components/HubCatEditor';
import type { HubCatEditorDraft } from '@/components/hub-cat-editor.model';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function queryButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

function queryField<T extends HTMLElement>(container: HTMLElement, selector: string): T {
  const element = container.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element as T;
}

async function click(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function WizardHost() {
  const [wizardOpen, setWizardOpen] = useState(true);
  const [draft, setDraft] = useState<HubCatEditorDraft | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <>
      <HubAddMemberWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onComplete={(nextDraft) => {
          setDraft(nextDraft);
          setWizardOpen(false);
          setEditorOpen(true);
        }}
      />
      <HubCatEditor
        open={editorOpen}
        draft={draft ?? undefined}
        onClose={() => setEditorOpen(false)}
        onSaved={vi.fn()}
      />
    </>
  );
}

describe('HubAddMemberWizard', () => {
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
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/cats') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                id: 'antigravity-template',
                provider: 'antigravity',
                source: 'seed',
                defaultModel: 'template-antigravity-model',
                commandArgs: ['. --remote-debugging-port=9010'],
              },
              {
                id: 'runtime-antigravity-preview',
                provider: 'antigravity',
                source: 'runtime',
                defaultModel: 'runtime-custom-model',
                commandArgs: ['. --remote-debugging-port=9999'],
              },
            ],
          }),
        );
      }
      if (path === '/api/provider-profiles') {
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
                builtin: true,
                mode: 'subscription',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                builtin: true,
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
                builtin: false,
                mode: 'api_key',
                models: ['claude-opus-4-6'],
                hasApiKey: true,
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
                builtin: false,
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
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('walks the normal member flow from client to provider to model and lands in the editor', async () => {
    await act(async () => {
      root.render(React.createElement(WizardHost));
    });
    await flushEffects();

    expect(queryField(container, '[aria-label="Client Row 1"]').textContent).toContain('Claude');
    expect(queryField(container, '[aria-label="Client Row 1"]').textContent).toContain('Codex');
    expect(queryField(container, '[aria-label="Client Row 1"]').textContent).toContain('Gemini');
    expect(queryField(container, '[aria-label="Client Row 2"]').textContent).toContain('OpenCode');
    expect(queryField(container, '[aria-label="Client Row 2"]').textContent).toContain('Dare');
    expect(queryField(container, '[aria-label="Client Row 2"]').textContent).toContain('Antigravity');
    expect(container.textContent).toContain('Step 2: 选择 Provider / 配置 CLI');
    expect(container.textContent).toContain('Step 3: 选择模型');
    expect(container.textContent).toContain('Step 3: 选择模型');
    expect(container.textContent).not.toContain('【');
    expect(container.textContent).not.toContain('非 UI 直出');

    await click(queryButton(container, 'Codex'));
    expect(container.textContent).toContain('Codex (OAuth)');
    expect(container.textContent).toContain('Codex Sponsor');
    expect(container.textContent).toContain('Claude Sponsor');

    await click(queryButton(container, 'Codex Sponsor'));
    expect(container.textContent).toContain('gpt-5.4-mini');
    await click(queryButton(container, 'gpt-5.4-mini'));
    await click(queryButton(container, '创建后继续编辑'));
    await flushEffects();

    expect(container.textContent).toContain('成员配置');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="Client"]').value).toBe('openai');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('codex-sponsor');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="Model"]').value).toBe('gpt-5.4-mini');
  });

  it('allows opencode member with bare model (ocProviderName is set in editor)', async () => {
    const onComplete = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(HubAddMemberWizard, {
          open: true,
          onClose: vi.fn(),
          onComplete,
        }),
      );
    });
    await flushEffects();

    await click(queryButton(container, 'OpenCode'));
    await click(queryButton(container, 'Codex Sponsor'));

    // Finish button should NOT be disabled — bare model is allowed, editor will collect ocProviderName.
    const finishButton = queryButton(container, '创建后继续编辑');
    expect(finishButton.disabled).toBe(false);

    await click(finishButton);
    await flushEffects();

    expect(onComplete).toHaveBeenCalled();
  });

  it('walks the Antigravity flow with default CLI args and lands in the editor', async () => {
    await act(async () => {
      root.render(React.createElement(WizardHost));
    });
    await flushEffects();

    await click(queryButton(container, 'Antigravity'));
    expect(container.textContent).toContain('Step 2: 选择 Provider / 配置 CLI');
    expect(container.textContent?.split('添加成员').length).toBe(2);

    const cliInput = queryField<HTMLInputElement>(container, 'input[aria-label="CLI Command"]');
    expect(cliInput.value).toBe('. --remote-debugging-port=9010');
    expect(container.textContent).toContain('Step 3: 选择模型');

    await click(queryButton(container, 'template-antigravity-model'));
    await click(queryButton(container, '创建后继续编辑'));
    await flushEffects();

    expect(container.textContent).toContain('成员配置');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="Client"]').value).toBe('antigravity');
    expect(queryField<HTMLInputElement>(container, 'input[aria-label="CLI Command"]').value).toBe(
      '. --remote-debugging-port=9010',
    );
    expect(queryField<HTMLInputElement>(container, 'input[aria-label="Model"]').value).toBe(
      'template-antigravity-model',
    );
  });

  it('uses seed antigravity defaults from /api/cats instead of runtime cat values', async () => {
    await act(async () => {
      root.render(React.createElement(WizardHost));
    });
    await flushEffects();

    await click(queryButton(container, 'Antigravity'));
    const cliInput = queryField<HTMLInputElement>(container, 'input[aria-label="CLI Command"]');
    expect(cliInput.value).toBe('. --remote-debugging-port=9010');
    expect(container.textContent).toContain('template-antigravity-model');
    expect(container.textContent).not.toContain('runtime-custom-model');
  });
});
