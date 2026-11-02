import type { RuntimeInteractionRequest } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../RichBlocks';
import { RuntimeInteractionQuestionForm } from '../RuntimeInteractionQuestionForm';
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

  it('keeps labels attached to their own inputs when the original and hosted form are both mounted', async () => {
    const request: Extract<RuntimeInteractionRequest, { kind: 'question' }> = {
      version: 1,
      interactionId: 'interaction-ui',
      kind: 'question',
      owner,
      provider,
      createdAt: 1000,
      title: 'Pick a destination',
      questions: [{ id: 'destination', header: 'Destination', question: 'Where?' }],
    };
    await act(async () =>
      root.render(
        <>
          <RuntimeInteractionQuestionForm request={request} disabled={false} onSubmit={vi.fn()} onReject={vi.fn()} />
          <RuntimeInteractionQuestionForm request={request} disabled={false} onSubmit={vi.fn()} onReject={vi.fn()} />
        </>,
      ),
    );
    const inputs = [...container.querySelectorAll('input')];
    expect(inputs).toHaveLength(2);
    expect(new Set(inputs.map((input) => input.id)).size).toBe(2);
    for (const form of container.querySelectorAll('form')) {
      const label = form.querySelector('label');
      expect(label?.htmlFor).toBe(form.querySelector('input')?.id);
    }
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

  it('rejects the question through the canonical card without manufacturing an answer', async () => {
    const request: RuntimeInteractionRequest = {
      version: 1,
      interactionId: 'interaction-ui',
      kind: 'question',
      owner,
      provider: { ...provider, method: 'cat_cafe_request_user_input' },
      createdAt: 1000,
      title: 'Outcome choice',
      questions: [
        {
          id: 'outcome',
          header: 'Outcome',
          question: 'Which outcome should the entrusted work use?',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(request) }))
      .mockResolvedValueOnce(
        okJson({
          interaction: record(request, 'declined', {
            status: 'declined',
            reasonCode: 'user_rejected',
            settledAt: 3000,
          }),
        }),
      );

    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    const reject = [...container.querySelectorAll('button')].find((button) => button.textContent === '不回答');
    await act(async () => {
      reject?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/runtime-interactions/interaction-ui/reject',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ cardRef }) }),
    );
    expect(container.textContent).toContain('你已拒绝这次请求');
    expect(container.textContent).not.toContain('提交回答');
  });

  it('renders a multiSelect question as checkboxes and submits every selected value', async () => {
    const request: RuntimeInteractionRequest = {
      version: 1,
      interactionId: 'interaction-ui',
      kind: 'question',
      owner,
      provider: { ...provider, providerId: 'chrys', method: '_chrys/request_input' },
      createdAt: 1000,
      title: 'iCode 需要你的回答',
      questions: [
        {
          id: 'topics',
          header: 'Topics',
          question: 'Which topics?',
          multiSelect: true,
          allowUnanswered: true,
          options: [{ label: 'A' }, { label: 'B', description: 'bee' }, { label: 'C' }],
        },
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
            response: { kind: 'answers', answeredQuestionIds: ['topics'], secretQuestionIds: [] },
          }),
        }),
      );

    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(checkboxes).toHaveLength(3);
    await act(async () => {
      checkboxes[0].click();
    });
    await act(async () => {
      checkboxes[2].click();
    });
    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === '提交回答');
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/runtime-interactions/interaction-ui/respond',
      expect.objectContaining({
        body: JSON.stringify({ cardRef, response: { kind: 'answers', answers: { topics: ['A', 'C'] } } }),
      }),
    );
  });

  it('answers a multiSelect question without options through the single free-text input', async () => {
    const request: RuntimeInteractionRequest = {
      version: 1,
      interactionId: 'interaction-ui',
      kind: 'question',
      owner,
      provider: { ...provider, providerId: 'chrys', method: '_chrys/request_input' },
      createdAt: 1000,
      title: 'iCode 需要你的回答',
      questions: [
        {
          id: 'topics',
          header: 'Topics',
          question: 'Which topics?',
          multiSelect: true,
          allowUnanswered: true,
          // Legacy shape: the bridge used to set isOther even without options.
          isOther: true,
        },
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
            response: { kind: 'answers', answeredQuestionIds: ['topics'], secretQuestionIds: [] },
          }),
        }),
      );

    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    const inputs = [...container.querySelectorAll('input')];
    expect(inputs).toHaveLength(1);
    expect(container.querySelector('input[name="topics-other"]')).toBeNull();
    await act(async () => setInput(inputs[0] as HTMLInputElement, 'custom topic'));
    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === '提交回答');
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/runtime-interactions/interaction-ui/respond',
      expect.objectContaining({
        body: JSON.stringify({ cardRef, response: { kind: 'answers', answers: { topics: ['custom topic'] } } }),
      }),
    );
  });

  it('allows submitting when an allowUnanswered question is left empty', async () => {
    const request: RuntimeInteractionRequest = {
      version: 1,
      interactionId: 'interaction-ui',
      kind: 'question',
      owner,
      provider: { ...provider, providerId: 'chrys', method: '_chrys/request_input' },
      createdAt: 1000,
      title: 'iCode 需要你的回答',
      questions: [{ id: 'note', header: 'Note', question: 'Anything to add?', allowUnanswered: true }],
    };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(request) }))
      .mockResolvedValueOnce(
        okJson({
          interaction: record(request, 'answered', {
            status: 'answered',
            reasonCode: 'answered',
            settledAt: 3000,
            response: { kind: 'answers', answeredQuestionIds: ['note'], secretQuestionIds: [] },
          }),
        }),
      );

    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === '提交回答') as
      | HTMLButtonElement
      | undefined;
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/runtime-interactions/interaction-ui/respond',
      expect.objectContaining({
        body: JSON.stringify({ cardRef, response: { kind: 'answers', answers: { note: [] } } }),
      }),
    );
  });
});
