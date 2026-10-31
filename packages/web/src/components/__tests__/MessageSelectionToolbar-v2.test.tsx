import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSelectionToolbar } from '../MessageSelectionToolbar';
import { writeShellLanguage } from '../shell/shell-language';
import { writeShellPresentation } from '../shell/shell-presentation';

describe('F322 selection composer', () => {
  let host: HTMLDivElement;
  let root: Root;
  const forward = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    forward.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    writeShellLanguage('zh');
  });
  function render(presentation: 'classic' | 'v2', disabled = false) {
    writeShellPresentation(presentation);
    act(() =>
      root.render(
        <MessageSelectionToolbar
          threadId="thread"
          selectedMessageIds={['first', 'second']}
          onCancel={() => {}}
          onExportSuccess={() => {}}
          forwardingDisabled={disabled}
          onForward={forward}
        />,
      ),
    );
  }
  it('pins classic markup with an English preference', () => {
    writeShellLanguage('en');
    render('classic');
    expect(host.innerHTML).toMatchSnapshot();
  });
  it('groups the three unchanged exports under one label and keeps forwarding as the primary action', () => {
    render('v2');
    const exports = host.querySelector('[role="group"][aria-label="导出为"]');
    expect(exports).not.toBeNull();
    expect(Array.from(exports!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['文档', '文本', '长图']);
    expect(host.textContent).toContain('已选 2 条');
    const button = host.querySelector<HTMLButtonElement>('[data-selection-primary="forward"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(forward).toHaveBeenCalledOnce();
  });
  it('keeps the same version-admission fence in English', () => {
    writeShellLanguage('en');
    render('v2', true);
    expect(host.textContent).toContain('2 selected');
    expect(host.querySelector<HTMLButtonElement>('[data-selection-primary="forward"]')?.disabled).toBe(true);
    expect(host.querySelector('[role="group"][aria-label="Export as"]')).not.toBeNull();
  });
});
