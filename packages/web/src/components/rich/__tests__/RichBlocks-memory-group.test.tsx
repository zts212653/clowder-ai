import type { RichCardBlock } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RichBlocks } from '../RichBlocks';

Object.assign(globalThis as Record<string, unknown>, { React });

const block: RichCardBlock = {
  kind: 'card',
  v: 1,
  id: 'remember-one',
  title: '这次记下的内容',
  meta: {
    kind: 'memory_group',
    memoryGroup: {
      v: 1,
      groupId: 'remember-one',
      rows: [
        { itemId: 'p', target: 'profile', statusCode: 200, proposalId: 'original-profile', status: 'pending' },
        { itemId: 't', target: 'taste', statusCode: 422, error: '原来源不符合要求' },
        { itemId: 'a', target: 'person_abstain', statusCode: 200, status: 'abstained' },
        { itemId: 'm', target: 'matter', statusCode: 200, resultRef: 'original-matter', status: 'updated' },
      ],
    },
  },
};
function render(value = block, readOnly = false) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <RichBlocks
      blocks={[value]}
      publication={{ threadId: 'thread', messageId: 'group-message', messageRevision: '1000' }}
      readOnly={readOnly}
    />,
  );
  return host;
}

it('shows the ordered original results in one group without creating an approval for direct or refused rows', () => {
  const host = render();
  expect(host.querySelectorAll('[data-memory-group-id="remember-one"]')).toHaveLength(1);
  expect(
    [...host.querySelectorAll('[data-memory-group-row]')].map((node) => node.getAttribute('data-memory-group-row')),
  ).toEqual(['p', 't', 'a', 'm']);
  expect(host.textContent).toContain('原来源不符合要求');
  expect(host.textContent).toContain('这次不记');
  expect(host.textContent).toContain('已记下');
  for (const id of ['t', 'a', 'm']) expect(host.querySelector(`[data-memory-group-row="${id}"] button`)).toBeNull();
});

it('finds the same group and original proposal reference after loading the persisted message again', () => {
  const reloaded: RichCardBlock = structuredClone(block);
  const host = render(reloaded);
  expect(host.querySelector('[data-memory-group-id]')?.getAttribute('data-memory-group-id')).toBe('remember-one');
  expect(host.querySelectorAll('[data-memory-group-row]')).toHaveLength(4);
  expect(host.querySelector('[data-memory-group-row="p"]')?.textContent).toContain('正在读取原提案');
});

it('forwarded group cards stay inert original evidence', () => {
  const host = render(block, true);
  expect(host.querySelector('[data-memory-group-id]')).toBeNull();
  expect(host.querySelector('button')).toBeNull();
});
