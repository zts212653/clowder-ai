import type { RuntimeInteractionRequest } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../RichBlocks';
import {
  block,
  cardRef,
  messageId,
  okJson,
  owner,
  provider,
  record,
  setInput,
  setSelect,
} from './runtime-interaction-test-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis as Record<string, unknown>, { React });

describe('RuntimeInteractionQuestionForm', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true));
  afterAll(() => delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT);
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('submits every answer once and never echoes answer values after terminal state', async () => {
    const request: RuntimeInteractionRequest = {
      version: 1,
      interactionId: 'interaction-ui',
      kind: 'question',
      owner,
      provider: { ...provider, method: 'item/tool/requestUserInput' },
      createdAt: 1000,
      title: 'Deployment details',
      questions: [
        { id: 'environment', header: 'Environment', question: 'Where should this run?' },
        { id: 'token', header: 'Token', question: 'One-time token?', isSecret: true },
      ],
    };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(request) }))
      .mockResolvedValueOnce(
        okJson({
          interaction: record(request, 'answered', {
            status: 'answered',
            reasonCode: 'answered',
            settledAt: 3000,
            response: {
              kind: 'answers',
              answeredQuestionIds: ['environment', 'token'],
              secretQuestionIds: ['token'],
            },
          }),
        }),
      );

    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    const environment = container.querySelector('input[name="environment"]') as HTMLInputElement;
    const token = container.querySelector('input[name="token"]') as HTMLInputElement;
    expect(token.type).toBe('password');
    await act(async () => {
      setInput(environment, 'Alpha');
      setInput(token, 'super-secret-value');
    });
    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === '提交回答');
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/runtime-interactions/interaction-ui/respond',
      expect.objectContaining({
        body: JSON.stringify({
          cardRef,
          response: { kind: 'answers', answers: { environment: ['Alpha'], token: ['super-secret-value'] } },
        }),
      }),
    );
    expect(container.textContent).toContain('回答已提交');
    expect(container.querySelector('input[name="environment"]')).toBeNull();
    expect(container.querySelector('input[name="token"]')).toBeNull();
  });

  it('gives controls accessible names and keeps Other mutually exclusive with a listed option', async () => {
    const request: RuntimeInteractionRequest = {
      version: 1,
      interactionId: 'interaction-ui',
      kind: 'question',
      owner,
      provider: { ...provider, method: 'item/tool/requestUserInput' },
      createdAt: 1000,
      title: 'Deployment target',
      questions: [
        {
          id: 'environment',
          header: 'Environment',
          question: 'Where should this run?',
          options: [{ label: 'Alpha' }],
          isOther: true,
        },
      ],
    };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(request) }))
      .mockResolvedValueOnce(okJson({ interaction: record(request) }));

    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    const select = container.querySelector('select[name="environment"]') as HTMLSelectElement;
    const other = container.querySelector('input[name="environment-other"]') as HTMLInputElement;
    expect(select.labels?.[0]?.textContent).toContain('Where should this run?');
    expect(other.labels?.[0]?.textContent).toContain('其他');
    await act(async () => setSelect(select, 'Alpha'));
    await act(async () => setInput(other, 'Custom'));
    expect(select.value).toBe('');
    await act(async () => setSelect(select, 'Alpha'));
    expect(other.value).toBe('');

    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === '提交回答');
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/runtime-interactions/interaction-ui/respond',
      expect.objectContaining({
        body: JSON.stringify({ cardRef, response: { kind: 'answers', answers: { environment: ['Alpha'] } } }),
      }),
    );
  });
});
