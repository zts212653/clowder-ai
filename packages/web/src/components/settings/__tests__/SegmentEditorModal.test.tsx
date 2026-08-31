// @vitest-environment jsdom

import type { SegmentEnablementMatrix } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SegmentEditorModal } from '../SegmentEditorModal';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

describe('SegmentEditorModal (F257 Console 判据⑤)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function typeInto(textarea: HTMLTextAreaElement, value: string) {
    // React controlled components need nativeInputValueSetter + input event
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    const nativeSetter = descriptor?.set;
    if (!nativeSetter) throw new Error('native value setter missing');
    nativeSetter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function makeEnablementMatrix(overrides: Partial<SegmentEnablementMatrix> = {}): SegmentEnablementMatrix {
    return {
      segmentId: 'S4',
      safetyTier: 'editable',
      allowLocalOverride: true,
      disableable: true,
      localOverlay: {
        hasOverlay: false,
        hasBackup: false,
        actions: {
          edit: { allowed: true, reason: null, reasonCode: null },
          restoreBackup: { allowed: false, reason: '当前段无备份文件', reasonCode: 'no-backup' },
          reset: { allowed: false, reason: '当前段无本地覆盖可重置', reasonCode: 'no-local-overlay' },
        },
      },
      runtimeOverride: {
        enabled: true,
        hasOverride: false,
        hasContentOverride: false,
        hasVersionSnapshot: false,
        availableEpochVersions: [],
        actions: {
          disable: { allowed: true, reason: null, reasonCode: null },
          enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
          rollback: { allowed: false, reason: '当前段无覆盖可回滚', reasonCode: 'no-override' },
          activateVersion: { allowed: false, reason: '当前段无保留版本可激活', reasonCode: 'no-version-snapshot' },
        },
      },
      ...overrides,
    };
  }

  const baseContentResponse = {
    segmentId: 'S4',
    allowLocalOverride: true,
    hasOverride: false,
    hasBackup: false,
    content: '<!-- S4: 协作格式 -->\nSource with {{CALLABLE_MENTIONS}} and {{EXAMPLE_TARGET}}.',
    baseContent: '<!-- S4: 协作格式 -->\nSource with {{CALLABLE_MENTIONS}} and {{EXAMPLE_TARGET}}.',
    templateRef: 's4-collaboration.md',
    vars: ['CALLABLE_MENTIONS', 'EXAMPLE_TARGET'],
    variableDefs: [
      {
        name: 'CALLABLE_MENTIONS',
        description: '当前可 @ 的队友句柄列表',
        placeholder: '@布偶猫 @缅因猫',
      },
      {
        name: 'EXAMPLE_TARGET',
        description: '一个具体队友句柄示例',
        placeholder: '@opus',
      },
    ],
    enablementMatrix: makeEnablementMatrix(),
  };

  it('renders variable definitions as key/value rows without template provenance', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    expect(document.body.textContent).not.toContain('模板来源');
    expect(document.body.textContent).not.toContain('s4-collaboration.md');
    expect(document.body.textContent).toContain('当前可 @ 的队友句柄列表');
    expect(document.body.textContent).toContain('@opus');
  });

  it('loads raw source with HTML comments into the editor', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toContain('<!-- S4: 协作格式 -->');
    expect(textarea.value).toContain('{{CALLABLE_MENTIONS}}');
  });

  it('edits raw source directly without a redundant preview panel', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('<!-- S4: 协作格式 -->');
    expect(document.querySelector('[data-testid="segment-editor-preview"]')).toBeNull();
    expect(document.body.textContent).not.toContain('渲染预览');
  });

  it('disables save until source is edited (dirty guard)', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    const saveBtn = document.querySelector('[data-testid="segment-editor-save"]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('PUTs only source content with placeholders, not expanded runtime values', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ saved: true }) });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      typeInto(textarea, '<!-- edited -->\nSource with {{CALLABLE_MENTIONS}} and {{EXAMPLE_TARGET}}.');
    });
    await flush();

    const saveBtn = document.querySelector('[data-testid="segment-editor-save"]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    act(() => saveBtn.click());
    await flush();

    const calls = apiFetch.mock.calls;
    const putCall = calls.find((c) => (c[1] as { method?: string })?.method === 'PUT');
    expect(putCall).toBeTruthy();
    if (!putCall) throw new Error('PUT call not found');
    const body = JSON.parse((putCall[1] as { body: string }).body);
    expect(body.content).toContain('{{CALLABLE_MENTIONS}}');
    expect(body.content).toContain('<!-- edited -->');
    expect(body.content).not.toContain('@布偶猫');
  });

  it('warns when user replaces a placeholder with an expanded value', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      typeInto(textarea, '<!-- edited -->\nSource with @布偶猫 and @opus.');
    });
    await flush();

    expect(document.body.textContent).toContain('占位符');
    const saveBtn = document.querySelector('[data-testid="segment-editor-save"]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('falls back to vars list when variableDefs is empty', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...baseContentResponse,
        variableDefs: [],
      }),
    });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    expect(document.body.textContent).toContain('{{CALLABLE_MENTIONS}}');
    expect(document.body.textContent).toContain('{{EXAMPLE_TARGET}}');
  });

  it('closes on Escape key from inside the textarea exactly once', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });
    const onClose = vi.fn();

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={onClose} />);
    });
    await flush();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    act(() => {
      textarea.focus();
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });
    const onClose = vi.fn();

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={onClose} />);
    });
    await flush();

    // The backdrop is the full-screen flex container; click its button overlay.
    const backdropButton = document.querySelector('[aria-label="关闭"]') as HTMLButtonElement;
    expect(backdropButton).toBeTruthy();

    act(() => backdropButton.click());
    await flush();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps readonly safety tier editable when the local overlay plane allows it', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...baseContentResponse,
        enablementMatrix: makeEnablementMatrix({
          safetyTier: 'readonly',
          allowLocalOverride: true,
          localOverlay: {
            hasOverlay: false,
            hasBackup: false,
            actions: {
              edit: { allowed: true, reason: null, reasonCode: null },
              restoreBackup: {
                allowed: false,
                reason: '当前段 safetyTier=readonly，禁止恢复备份',
                reasonCode: 'safety-tier-readonly',
              },
              reset: { allowed: false, reason: '当前段无本地覆盖可重置', reasonCode: 'no-local-overlay' },
            },
          },
        }),
      }),
    });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('safetyTier=readonly');
  });

  it('disables editor and shows reason when enablementMatrix is missing', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...baseContentResponse,
        enablementMatrix: undefined,
      }),
    });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(document.body.textContent).toContain('启用状态矩阵不可用');
  });

  it('shows restore-backup button only when localOverlay allows it', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...baseContentResponse,
        enablementMatrix: makeEnablementMatrix({
          localOverlay: {
            hasOverlay: true,
            hasBackup: true,
            actions: {
              edit: { allowed: true, reason: null, reasonCode: null },
              restoreBackup: { allowed: true, reason: null, reasonCode: null },
              reset: { allowed: true, reason: null, reasonCode: null },
            },
          },
        }),
      }),
    });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    expect(document.body.textContent).toContain('恢复上一版');
    expect(document.body.textContent).toContain('恢复默认');
  });
});
