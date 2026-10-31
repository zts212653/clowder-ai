import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { NewConversationComposerContext } from '../NewConversationComposerContext';

describe('F322 new-conversation composer context', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    writeShellLanguage('zh');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows an unchecked pin beside the project and changes it without blocking creation', () => {
    const onPinnedChange = vi.fn();
    act(() =>
      root.render(
        <NewConversationComposerContext
          existingProjects={[]}
          locked={false}
          pinned={false}
          onPinnedChange={onPinnedChange}
          onProjectChange={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('建好后置顶');
    const project = container.querySelector<HTMLButtonElement>('[data-testid="new-conversation-project"]');
    expect(project?.className).toContain('overflow-hidden');
    expect(project?.className).toContain('max-sm:w-1/3');
    expect(project?.className).toContain('max-sm:min-w-5');
    expect(project?.className).toContain('max-sm:flex-[1_1_33.333%]');
    expect(project?.className).toContain('max-sm:px-0.5');
    expect(
      container
        .querySelector('[data-testid="new-conversation-project-name"]')
        ?.getAttribute('data-compact-name-policy'),
    ).toBe('whole-or-hidden');
    const pin = container.querySelector<HTMLInputElement>('[data-testid="new-conversation-pin"]');
    expect(pin?.checked).toBe(false);
    expect(pin?.closest('label')?.className).toContain('max-sm:absolute');
    expect(pin?.closest('label')?.className).toContain('max-sm:right-3');
    expect(pin?.closest('label')?.className).toContain('max-sm:top-1.5');
    act(() => pin?.click());
    expect(onPinnedChange).toHaveBeenCalledWith(true);
  });

  it('uses the English label and locks the choice after creation begins', () => {
    writeShellLanguage('en');
    act(() =>
      root.render(
        <NewConversationComposerContext
          existingProjects={[]}
          locked
          pinned
          onPinnedChange={vi.fn()}
          onProjectChange={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('Pin after creating');
    const pin = container.querySelector<HTMLInputElement>('[data-testid="new-conversation-pin"]');
    expect(pin?.checked).toBe(true);
    expect(pin?.disabled).toBe(true);
  });
});
