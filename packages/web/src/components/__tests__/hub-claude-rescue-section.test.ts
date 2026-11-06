// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '@/stores/toastStore';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/utils/api-client';
import { HubClaudeRescueSection } from '../HubClaudeRescueSection';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('HubClaudeRescueSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useToastStore.setState({ toasts: [] });
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders scanned broken sessions as checklist items', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        sessions: [
          {
            sessionId: 'broken-2',
            transcriptPath: '/tmp/broken-2.jsonl',
            removableThinkingTurns: 8,
            detectedBy: 'api_error_entry',
          },
          {
            sessionId: 'broken-1',
            transcriptPath: '/tmp/broken-1.jsonl',
            removableThinkingTurns: 12,
            detectedBy: 'api_error_entry',
          },
        ],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubClaudeRescueSection));
    });
    await flushEffects();

    expect(container.textContent).toContain('布偶猫救援中心');
    expect(container.textContent).toContain('检测到 2 只布偶猫 session 需要救援');
    expect(container.textContent).toContain('broken-1');
    expect(container.textContent).toContain('broken-2');
    expect(container.textContent).toContain('纯 thinking turn：12 条');
    expect(container.textContent).toContain('纯 thinking turn：8 条');
    expect(container.textContent).toContain('/tmp/broken-1.jsonl');
    expect(container.textContent).toContain('/tmp/broken-2.jsonl');
    expect(container.textContent).toContain('一键救活 2 只布偶猫');

    const checkedBoxes = Array.from(container.querySelectorAll('input[type="checkbox"]')).filter(
      (node) => (node as HTMLInputElement).checked,
    );
    expect(checkedBoxes).toHaveLength(2);
  });

  it('shows empty state when scan finds no broken sessions', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ sessions: [] }));

    await act(async () => {
      root.render(React.createElement(HubClaudeRescueSection));
    });
    await flushEffects();

    expect(container.textContent).toContain('暂未发现坏掉的布偶猫 session');
    expect(container.textContent).toContain('重新扫描');
  });

  it('rescues selected sessions, refreshes scan, and shows success toast', async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        jsonResponse({
          sessions: [
            {
              sessionId: 'broken-1',
              transcriptPath: '/tmp/broken-1.jsonl',
              removableThinkingTurns: 12,
              detectedBy: 'api_error_entry',
            },
            {
              sessionId: 'broken-2',
              transcriptPath: '/tmp/broken-2.jsonl',
              removableThinkingTurns: 8,
              detectedBy: 'api_error_entry',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'ok',
          rescuedCount: 2,
          skippedCount: 0,
          results: [
            {
              sessionId: 'broken-1',
              status: 'repaired',
              removedTurns: 12,
              backupPath: '/tmp/backups/broken-1.jsonl',
            },
            {
              sessionId: 'broken-2',
              status: 'repaired',
              removedTurns: 8,
              backupPath: '/tmp/backups/broken-2.jsonl',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sessions: [] }));

    await act(async () => {
      root.render(React.createElement(HubClaudeRescueSection));
    });
    await flushEffects();

    const rescueButton = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('一键救活 2 只布偶猫'),
    ) as HTMLButtonElement | undefined;
    expect(rescueButton).toBeDefined();

    await act(async () => {
      rescueButton?.click();
    });
    await flushEffects();
    await flushEffects();

    expect(mockApiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/claude-rescue/rescue',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    );
    const rescueInit = mockApiFetch.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(rescueInit?.body))).toEqual({
      sessionIds: ['broken-1', 'broken-2'],
    });

    expect(container.textContent).toContain('刚刚救活 2 只布偶猫');
    expect(container.textContent).toContain('暂未发现坏掉的布偶猫 session');

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((toast) => toast.type === 'success' && toast.title === '布偶猫已救活')).toBe(true);
  });
});
