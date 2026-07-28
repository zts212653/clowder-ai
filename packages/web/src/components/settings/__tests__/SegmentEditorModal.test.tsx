// @vitest-environment jsdom

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
  };

  it('renders templateRef and variable definitions separately from source', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    expect(document.body.textContent).toContain('s4-collaboration.md');
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

  it('shows stripped preview but keeps raw source untouched', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseContentResponse });

    act(() => {
      root.render(<SegmentEditorModal segmentId="S4" segmentName="协作格式" allowLocalOverride onClose={() => {}} />);
    });
    await flush();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('<!-- S4: 协作格式 -->');
    const preview = document.querySelector('[data-testid="segment-editor-preview"]') as HTMLPreElement;
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('Source with {{CALLABLE_MENTIONS}}');
    expect(preview.textContent).not.toContain('<!-- S4: 协作格式 -->');
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
});
