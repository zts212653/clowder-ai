import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RichInteractiveBlock } from '@/stores/chat-types';
import { RichBlocks } from '../RichBlocks';

type StandaloneInteractiveBlock = RichInteractiveBlock & { autoGroup: false };

function standaloneBlock(id: string, title: string, optionId: string): StandaloneInteractiveBlock {
  return {
    id,
    kind: 'interactive',
    v: 1,
    interactiveType: 'select',
    title,
    options: [{ id: optionId, label: optionId.toUpperCase() }],
    autoGroup: false,
  };
}

describe('RichBlocks standalone interactive boundaries', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSend: ((event: Event) => void) | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (onSend) window.removeEventListener('cat-cafe:interactive-send', onSend);
    React.act(() => root.unmount());
    container.remove();
  });

  it('keeps adjacent provider items independently submittable', () => {
    const sent: string[] = [];
    onSend = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string }>).detail;
      sent.push(detail.text);
    };
    window.addEventListener('cat-cafe:interactive-send', onSend);

    React.act(() => {
      root.render(
        <RichBlocks
          blocks={[standaloneBlock('first', 'First question', 'a'), standaloneBlock('second', 'Second question', 'b')]}
        />,
      );
    });

    expect(container.querySelector('[data-rich-block-group-id]')).toBeNull();
    expect(container.querySelectorAll('[data-rich-block-id]')).toHaveLength(2);
    expect(container.textContent).not.toContain('全部提交');

    const first = container.querySelector('[data-rich-block-id="first"]');
    React.act(() => first?.querySelector<HTMLButtonElement>('button')?.click());
    const firstSubmit = [...(first?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) =>
      button.textContent?.includes('确认选择'),
    );
    React.act(() => firstSubmit?.click());
    expect(sent).toEqual(['我选了：A（First question）']);

    const second = container.querySelector('[data-rich-block-id="second"]');
    expect(second?.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
    React.act(() => second?.querySelector<HTMLButtonElement>('button')?.click());
    const secondSubmit = [...(second?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) =>
      button.textContent?.includes('确认选择'),
    );
    React.act(() => secondSubmit?.click());
    expect(sent).toEqual(['我选了：A（First question）', '我选了：B（Second question）']);
  });

  it('keeps temporary grouped selections pending until the group submits', () => {
    const first = { ...standaloneBlock('pending-first', 'First', 'a'), autoGroup: true };
    const second = { ...standaloneBlock('pending-second', 'Second', 'b'), autoGroup: true };
    React.act(() => root.render(<RichBlocks blocks={[first, second]} />));
    expect(container.querySelectorAll('[data-message-navigation-response="interactive"]')).toHaveLength(2);
    const choices = container.querySelectorAll<HTMLButtonElement>('[data-message-navigation-response] button');
    expect(choices).toHaveLength(2);
    React.act(() => choices[0]?.click());
    expect(container.querySelectorAll('[data-message-navigation-response="interactive"]')).toHaveLength(2);
    const secondChoice = container.querySelectorAll<HTMLButtonElement>('[data-message-navigation-response] button')[1];
    React.act(() => secondChoice?.click());
    const submit = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('全部提交'),
    );
    expect(submit).toBeTruthy();
    expect(submit!.disabled).toBe(false);
    React.act(() => submit?.click());
    expect(container.querySelector('[data-message-navigation-response]')).toBeNull();
  });

  it('does not publish actionable signals from forwarded readonly interactive blocks', () => {
    React.act(() => root.render(<RichBlocks blocks={[standaloneBlock('copy', 'Copied question', 'a')]} readOnly />));
    expect(container.querySelector('[data-message-navigation-response]')).toBeNull();
  });

  it('keeps legacy adjacent blocks auto-grouped by default', () => {
    const first = { ...standaloneBlock('legacy-first', 'First', 'a') };
    const second = { ...standaloneBlock('legacy-second', 'Second', 'b') };
    delete (first as Partial<StandaloneInteractiveBlock>).autoGroup;
    delete (second as Partial<StandaloneInteractiveBlock>).autoGroup;

    React.act(() => root.render(<RichBlocks blocks={[first, second]} />));

    expect(container.querySelector('[data-rich-block-group-id]')).not.toBeNull();
    expect(container.textContent).toContain('全部提交');
  });
});
