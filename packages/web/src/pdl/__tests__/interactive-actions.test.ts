import type { RichInteractiveBlock } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { submitInteractiveSelection } from '../interactive-actions';

const transport = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: transport }));
const choice = (): RichInteractiveBlock => ({
  v: 1,
  id: 'choice-1',
  kind: 'interactive',
  interactiveType: 'select',
  options: [{ id: 'a', label: '方案 A' }],
});
beforeEach(() => {
  transport.mockReset();
  transport.mockResolvedValue({ ok: true });
});
describe('ordinary interactive source writers', () => {
  it('waits for real send admission before persisting a disabled choice', async () => {
    const send = vi.fn(async () => false);
    await expect(submitInteractiveSelection('message-1', choice(), ['a'], undefined, send)).rejects.toThrow('未发送');
    expect(transport).not.toHaveBeenCalled();
    send.mockResolvedValue(true);
    await submitInteractiveSelection('message-1', choice(), ['a'], undefined, send);
    expect(transport.mock.calls[0][0]).toBe('/api/messages/message-1/block-state');
    expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({
      blockId: 'choice-1',
      selectedIds: ['a'],
      disabled: true,
    });
  });
  it('uses the existing callback allowlist and never treats arbitrary metadata as a URL to call', async () => {
    const block = choice();
    block.options[0].action = { type: 'callback', endpoint: 'https://untrusted.test/steal' };
    await expect(submitInteractiveSelection('message-1', block, ['a'], undefined, vi.fn())).rejects.toThrow('不允许');
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not persist terminal choice state after callback failure or an invalid source option', async () => {
    const block = choice();
    block.options[0].action = {
      type: 'callback',
      endpoint: '/api/guide-actions/cancel',
      payload: { threadId: 'thread-1' },
    };
    transport.mockResolvedValue({ ok: false });
    await expect(submitInteractiveSelection('message-1', block, ['a'], undefined, vi.fn())).rejects.toThrow('未成功');
    expect(transport).toHaveBeenCalledOnce();
    transport.mockClear();
    await expect(submitInteractiveSelection('message-1', block, ['forged'], undefined, vi.fn())).rejects.toThrow(
      '有效',
    );
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('grouped interactive submission', () => {
  it('admits one combined message before persisting each exact block id', async () => {
    const { submitInteractiveGroup } = await import('../interactive-actions');
    const a = choice(),
      b = { ...choice(), id: 'choice-2', title: '第二题', messageTemplate: '答案={selection}' };
    const send = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
    await submitInteractiveGroup(
      'message-1',
      [
        { block: a, selectedIds: ['a'] },
        { block: b, selectedIds: ['a'] },
      ],
      send,
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toContain('答案=方案 A');
    expect(transport.mock.calls.map(([, options]) => JSON.parse(options.body).blockId)).toEqual([
      'choice-1',
      'choice-2',
    ]);
  });
  it('validates the entire group, including required custom text, before any send or write', async () => {
    const { submitInteractiveGroup } = await import('../interactive-actions');
    const a = choice(),
      b = { ...choice(), id: 'choice-2', options: [{ id: 'other', label: '补充', customInput: true }] };
    const send = vi.fn();
    await expect(
      submitInteractiveGroup(
        'message-1',
        [
          { block: a, selectedIds: ['a'] },
          { block: b, selectedIds: ['other'] },
        ],
        send,
      ),
    ).rejects.toThrow('补充');
    expect(send).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
