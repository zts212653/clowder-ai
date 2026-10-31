import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoteActiveBar } from '../VoteActiveBar';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiFetch.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('VoteActiveBar overflow recovery', () => {
  it('keeps an active long question in the recovery primitive', async () => {
    const question = '该不该迁移到新的存储方案？'.repeat(30);
    apiFetch.mockImplementation(async () =>
      Response.json({
        vote: {
          status: 'active',
          question,
          votes: {},
          voters: ['a', 'b'],
          deadline: Date.now() + 60_000,
          anonymous: false,
        },
      }),
    );
    await act(async () => root.render(<VoteActiveBar threadId="vote-thread" onEnd={vi.fn()} />));
    const blocks = [...host.querySelectorAll('[data-overflow-measure="block"]')];
    expect(blocks.map((node) => node.textContent)).toContain(`投票进行中: ${question}`);
  });
});
