// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelComposer } from '../ChannelComposer.js';

describe('channel composer visibility copy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState({}, '', '/');
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    vi.unstubAllGlobals();
  });

  async function render(language: 'zh' | 'en', namespace = 'svc_1:col_1:human_1') {
    window.history.replaceState({}, '', language === 'en' ? '/?lang=en' : '/');
    await act(async () =>
      root.render(
        <ChannelComposer
          namespace={namespace}
          collectiveName="猫猫研究所"
          channelId="general"
          participants={[]}
          humans={[]}
          delivery={{ kind: 'idle' }}
          onSend={vi.fn()}
        />,
      ),
    );
    return container.querySelector('textarea');
  }

  it('names both the destination and the real collective-wide audience while empty', async () => {
    expect((await render('zh'))?.placeholder).toBe('发到 # general · 猫猫研究所的成员都看得到');
  });

  it('keeps the same audience truth in English', async () => {
    expect((await render('en'))?.placeholder).toBe('Post to # general · visible to all 猫猫研究所 members');
  });

  it('restores A and B independently when the same Human moves A to B to A', async () => {
    const type = async (body: string) => {
      const input = container.querySelector<HTMLTextAreaElement>('textarea');
      if (!input) throw new Error('Expected channel composer');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, body);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    await render('zh', 'svc_1:col_a:human_1');
    await type('A 世界的草稿');
    await render('zh', 'svc_1:col_b:human_1');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    await type('B 世界的草稿');

    await render('zh', 'svc_1:col_a:human_1');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('A 世界的草稿');
    await render('zh', 'svc_1:col_b:human_1');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('B 世界的草稿');
  });
});
