import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { ChatInputMenus } from '../ChatInputMenus';
import { buildCatOptions } from '../chat-input-options';

const member: CatData = {
  id: 'dsh',
  displayName: '小鲸鱼',
  nickname: '鲸鲸',
  mentionPatterns: ['@deepseek', '@dsh'],
  clientId: 'dsh',
  carrier: 'acp',
  defaultModel: '',
  avatar: '/avatars/family/dsh.png',
  color: { primary: '#3B7EA1', secondary: '#DCEBF2' },
  roleDescription: '共创伙伴',
  personality: '',
};

describe('mention menu nickname and actual alias', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it.each([
    ['@deepseek', '@dsh'],
    ['@dsh', '@deepseek'],
  ])('shows the exact existing insertion for alias order %s, %s', (first, second) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onInsertMention = vi.fn();
    const options = buildCatOptions([{ ...member, mentionPatterns: [first, second] }]);
    act(() =>
      root.render(
        <ChatInputMenus
          catOptions={options}
          showMentions
          selectedIdx={0}
          onSelectIdx={vi.fn()}
          onInsertMention={onInsertMention}
          menuRef={createRef<HTMLDivElement>()}
        />,
      ),
    );
    const button = container.querySelector('button')!;
    expect(button.textContent).toContain('鲸鲸');
    expect(button.textContent).toContain(first);
    expect(button.textContent).not.toContain(second);
    act(() => button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onInsertMention).toHaveBeenCalledWith(expect.objectContaining({ id: member.id, insert: `${first} ` }));
    const all = Array.from(container.querySelectorAll('button')).find((row) => row.textContent?.includes('@all'))!;
    expect(all.textContent?.match(/@all/g)).toHaveLength(1);
    act(() => root.unmount());
    container.remove();
  });
});
