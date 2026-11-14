import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InteractiveBlock } from '@/components/rich/InteractiveBlock';
import { InteractiveBlockGroup } from '@/components/rich/InteractiveBlockGroup';
import { useToastStore } from '@/stores/toastStore';

const apiFetch = vi.fn();
const updateRichBlock = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/utils/userId', () => ({ getUserId: () => 'owner' }));
vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: () => ({ updateRichBlock }) } }));

let container: HTMLDivElement;
let root: Root;
let reportResult: ((sent: boolean) => void) | undefined;
let sends: number;
let onSend: (event: Event) => void;

function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent?.includes(label));
  expect(button).toBeTruthy();
  act(() => button?.click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiFetch.mockReset().mockResolvedValue({ ok: true });
  updateRichBlock.mockReset();
  useToastStore.setState({ toasts: [] });
  sends = 0;
  reportResult = undefined;
  onSend = (event) => {
    sends += 1;
    reportResult = (event as CustomEvent<{ onResult?: (sent: boolean) => void }>).detail.onResult;
  };
  window.addEventListener('cat-cafe:interactive-send', onSend);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <InteractiveBlock
        messageId="response"
        block={{
          id: 'question',
          kind: 'interactive',
          v: 1,
          interactiveType: 'select',
          options: [{ id: 'one', label: 'Answer one' }],
        }}
      />,
    ),
  );
  click('Answer one');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.removeEventListener('cat-cafe:interactive-send', onSend);
  vi.useRealTimers();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('#1951 does not persist an answer until the send is accepted', async () => {
  click('确认选择');
  expect(sends).toBe(1);
  expect(apiFetch).not.toHaveBeenCalled();
  expect(reportResult).toBeTypeOf('function');
  await act(async () => reportResult?.(true));
  expect(apiFetch).toHaveBeenCalledOnce();
  expect(updateRichBlock).toHaveBeenCalledWith('response', 'question', { disabled: true, selectedIds: ['one'] });
});

it('#1951 locks a mounted question when hydration supplies its saved answer', () => {
  act(() =>
    root.render(
      <InteractiveBlock
        messageId="response"
        block={{
          id: 'question',
          kind: 'interactive',
          v: 1,
          interactiveType: 'select',
          options: [{ id: 'one', label: 'Answer one' }],
          disabled: true,
          selectedIds: ['one'],
        }}
      />,
    ),
  );
  expect(container.querySelector('[data-message-navigation-response="interactive"]')).toBeNull();
  click('Answer one');
  expect(sends).toBe(0);
});

it('#1951 locks a mounted group when all hydrated questions are answered', () => {
  const blocks = [
    {
      id: 'a',
      kind: 'interactive' as const,
      v: 1 as const,
      interactiveType: 'select' as const,
      options: [{ id: 'a1', label: 'Choice A' }],
    },
    {
      id: 'b',
      kind: 'interactive' as const,
      v: 1 as const,
      interactiveType: 'select' as const,
      options: [{ id: 'b1', label: 'Choice B' }],
    },
  ];
  act(() => root.render(<InteractiveBlockGroup messageId="response" blocks={blocks} />));
  act(() =>
    root.render(
      <InteractiveBlockGroup
        messageId="response"
        blocks={[{ ...blocks[0], disabled: true, selectedIds: ['a1'] }, blocks[1]]}
      />,
    ),
  );
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('全部提交'))).toBe(
    true,
  );
  act(() =>
    root.render(
      <InteractiveBlockGroup
        messageId="response"
        blocks={blocks.map((block) => ({ ...block, disabled: true, selectedIds: [block.options[0].id] }))}
      />,
    ),
  );
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('全部提交'))).toBe(
    false,
  );
  expect(sends).toBe(0);
});

it('#1951 lets a rejected send be retried without saving a false answered state', async () => {
  click('确认选择');
  expect(reportResult).toBeTypeOf('function');
  await act(async () => reportResult?.(false));
  expect(apiFetch).not.toHaveBeenCalled();
  expect(updateRichBlock).not.toHaveBeenCalled();
  expect(container.querySelector('[data-message-navigation-response="interactive"]')).not.toBeNull();
  click('确认选择');
  await act(async () => reportResult?.(true));
  expect(sends).toBe(2);
  expect(apiFetch).toHaveBeenCalledOnce();
});

it.each([
  404,
  500,
  'network',
] as const)('#1951 reports save failure %s without sending the accepted answer again', async (failure) => {
  vi.useFakeTimers();
  if (failure === 'network') apiFetch.mockRejectedValue(new TypeError('Connection interrupted'));
  else apiFetch.mockResolvedValue({ ok: false, status: failure });
  click('确认选择');
  await act(async () => {
    reportResult?.(true);
    await vi.runAllTimersAsync();
  });
  expect(sends).toBe(1);
  expect(useToastStore.getState().toasts.some((toast) => toast.type === 'error')).toBe(true);
  expect(container.querySelector('[data-message-navigation-response="interactive"]')).toBeNull();
});

it('#1951 a grouped answer waits for admission, retries a rejected send, and saves the group once', async () => {
  act(() =>
    root.render(
      <InteractiveBlockGroup
        messageId="response"
        blocks={[
          { id: 'a', kind: 'interactive', v: 1, interactiveType: 'select', options: [{ id: 'a1', label: 'Choice A' }] },
          { id: 'b', kind: 'interactive', v: 1, interactiveType: 'select', options: [{ id: 'b1', label: 'Choice B' }] },
        ]}
      />,
    ),
  );
  click('Choice A');
  click('Choice B');
  click('全部提交');
  expect(sends).toBe(1);
  expect(apiFetch).not.toHaveBeenCalled();
  await act(async () => reportResult?.(false));
  expect(apiFetch).not.toHaveBeenCalled();
  click('全部提交');
  await act(async () => reportResult?.(true));
  expect(sends).toBe(2);
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(updateRichBlock).toHaveBeenCalledWith('response', 'a', { disabled: true, selectedIds: ['a1'] });
  expect(updateRichBlock).toHaveBeenCalledWith('response', 'b', { disabled: true, selectedIds: ['b1'] });
});

it('#1951 saves grouped blocks sequentially so full-message writes retain both answers', async () => {
  const firstWrite = Promise.withResolvers<void>();
  let saved = new Set<string>();
  apiFetch.mockImplementation(async (_url: string, options: RequestInit) => {
    // The block-state route reads and writes an entire message snapshot, as Redis does.
    const next = new Set(saved);
    const patch = JSON.parse(String(options.body)) as { blockId: string };
    next.add(patch.blockId);
    if (patch.blockId === 'a') await firstWrite.promise;
    saved = next;
    return { ok: true };
  });
  act(() =>
    root.render(
      <InteractiveBlockGroup
        messageId="response"
        blocks={[
          { id: 'a', kind: 'interactive', v: 1, interactiveType: 'select', options: [{ id: 'a1', label: 'Choice A' }] },
          { id: 'b', kind: 'interactive', v: 1, interactiveType: 'select', options: [{ id: 'b1', label: 'Choice B' }] },
        ]}
      />,
    ),
  );
  click('Choice A');
  click('Choice B');
  click('全部提交');
  await act(async () => reportResult?.(true));
  await act(async () => firstWrite.resolve());
  expect([...saved].sort()).toEqual(['a', 'b']);
  expect(sends).toBe(1);
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('#1951 a partially saved Codex group stays submitted after reload and late hydration', async () => {
  vi.useFakeTimers();
  const blocks = ['a', 'b'].map((id) => ({
    id,
    kind: 'interactive' as const,
    v: 1 as const,
    interactiveType: 'select' as const,
    groupId: 'codex-async-question-test',
    options: [{ id: `${id}1`, label: `Choice ${id.toUpperCase()}` }],
  }));
  apiFetch.mockImplementation(async (_url: string, options: RequestInit) => {
    const patch = JSON.parse(String(options.body)) as { blockId: string };
    return patch.blockId === 'a' ? { ok: true } : { ok: false, status: 500 };
  });
  act(() => root.render(<InteractiveBlockGroup key="before-reload" messageId="response" blocks={blocks} />));
  click('Choice A');
  click('Choice B');
  click('全部提交');
  await act(async () => {
    reportResult?.(true);
    await vi.runAllTimersAsync();
  });
  expect(sends).toBe(1);
  expect(apiFetch).toHaveBeenCalledTimes(4);
  const partial = [{ ...blocks[0], disabled: true, selectedIds: ['a1'] }, blocks[1]];
  act(() => root.render(<InteractiveBlockGroup key="after-reload" messageId="response" blocks={partial} />));
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('全部提交'))).toBe(
    false,
  );
  click('Choice B');
  expect(sends).toBe(1);
  act(() => root.render(<InteractiveBlockGroup key="late-history" messageId="response" blocks={blocks} />));
  act(() => root.render(<InteractiveBlockGroup key="late-history" messageId="response" blocks={partial} />));
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('全部提交'))).toBe(
    false,
  );
  expect(sends).toBe(1);
});
