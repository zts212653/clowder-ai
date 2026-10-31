import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineShellCopy, resolveShellCopy, useShellCopy } from '../shell-copy';
import { writeShellLanguage } from '../shell-language';

const sample = defineShellCopy(
  {
    zh: {
      title: '正在发生',
      scope: (count: number) => `全局 · ${count}`,
      group: { code: '代码' },
    },
    en: {
      title: 'Happening now',
      scope: (count: number) => `Global · ${count}`,
      group: { code: 'Code' },
    },
  },
  { samples: { scope: [[0], [1], [7]] } },
);

function Draft() {
  const t = useShellCopy(sample);
  const [draft, setDraft] = useState('');
  return (
    <div>
      <h2>{t.title}</h2>
      <p data-testid="scope">{t.scope(3)}</p>
      <input aria-label="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </div>
  );
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('defineShellCopy / useShellCopy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('resolves each language to its own tree, nested groups and templates included', () => {
    expect(resolveShellCopy(sample, 'zh').title).toBe('正在发生');
    expect(resolveShellCopy(sample, 'en').title).toBe('Happening now');
    expect(resolveShellCopy(sample, 'zh').scope(2)).toBe('全局 · 2');
    expect(resolveShellCopy(sample, 'en').scope(2)).toBe('Global · 2');
    expect(resolveShellCopy(sample, 'en').group.code).toBe('Code');
  });

  it('keeps what the user typed and the focus when the language flips: the words change, the component does not remount', () => {
    act(() => root.render(<Draft />));
    const input = container.querySelector('input') as HTMLInputElement;
    act(() => typeInto(input, 'half a sentence'));
    act(() => input.focus());
    expect(container.querySelector('h2')?.textContent).toBe('正在发生');

    act(() => writeShellLanguage('en'));

    expect(container.querySelector('h2')?.textContent).toBe('Happening now');
    expect(container.querySelector('[data-testid="scope"]')?.textContent).toBe('Global · 3');
    const after = container.querySelector('input') as HTMLInputElement;
    expect(after).toBe(input);
    expect(after.value).toBe('half a sentence');
    expect(document.activeElement).toBe(input);
  });

  it('hands out frozen trees, so a page cannot rewrite the shared words', () => {
    expect(Object.isFrozen(sample.zh)).toBe(true);
    expect(Object.isFrozen(sample.en)).toBe(true);
    expect(Object.isFrozen(sample.zh.group)).toBe(true);
  });
});

describe('the examples in the module header, copied as they are written there (tsc compiles them)', () => {
  it('the members example and the declared-grammar example both define and resolve', () => {
    const membersCopy = defineShellCopy(
      {
        zh: { title: '成员', running: (n: number) => `运行中 ${n}` },
        en: { title: 'Members', running: (n: number) => `${n} running` },
      },
      { samples: { running: [[0], [1], [12]] } },
    );
    expect(resolveShellCopy(membersCopy, 'en').running(3)).toBe('3 running');

    const onlineCopy = defineShellCopy(
      {
        zh: { online: (gender: 'female' | 'male'): string => (gender === 'female' ? '她已上线' : '他已上线') },
        en: { online: () => 'They are online' },
      },
      { samples: { online: [['female'], ['male']] }, grammar: { online: ['0'] } },
    );
    expect(resolveShellCopy(onlineCopy, 'zh').online('female')).toBe('她已上线');
    expect(resolveShellCopy(onlineCopy, 'en').online('female')).toBe('They are online');
  });
});
