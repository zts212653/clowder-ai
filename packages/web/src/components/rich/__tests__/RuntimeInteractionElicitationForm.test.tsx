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

describe('RuntimeInteractionElicitationForm', () => {
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

  it('renders the required URL elicitation message and safe link', async () => {
    const request = urlRequest('https://example.com/authorize');
    vi.mocked(apiFetch).mockResolvedValue(okJson({ interaction: record(request) }));
    await render(root);
    const link = container.querySelector('a');
    expect(link?.href).toBe('https://example.com/authorize');
    expect(link?.textContent).toContain('example.com');
    expect(container.textContent).toContain('Open the provider page, then confirm.');
    expect(container.textContent).not.toContain('Approval Hub');
  });

  it('does not render a clickable URL when persisted input has an unsafe scheme', async () => {
    const unsafe = urlRequest('javascript:alert(1)');
    vi.mocked(apiFetch).mockResolvedValue(okJson({ interaction: record(unsafe) }));
    await render(root);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('链接不可用');
    expect(container.textContent).toContain('Open the provider page, then confirm.');
  });

  it('keeps decline and cancel available while a required field is incomplete', async () => {
    const request = formRequest(['region']);
    vi.mocked(apiFetch).mockResolvedValue(okJson({ interaction: record(request) }));
    await render(root);
    expect(container.textContent).toContain('Choose a region or decline the request.');
    const buttons = Object.fromEntries(
      [...container.querySelectorAll('button')].map((button) => [button.textContent ?? '', button]),
    );
    expect(buttons.Submit.disabled).toBe(true);
    expect(buttons.Decline.disabled).toBe(false);
    expect(buttons.Cancel.disabled).toBe(false);
  });

  it('requires an explicit boolean choice and submits false as a boolean', async () => {
    const request: RuntimeInteractionRequest = {
      ...formRequest(['enabled']),
      message: 'Choose whether the server is enabled.',
      requestedSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean', title: 'Enabled' } },
        required: ['enabled'],
        additionalProperties: false,
      },
      decisions: [{ id: 'accept', label: 'Submit', outcome: 'accept' }],
    };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(request) }))
      .mockResolvedValueOnce(okJson({ interaction: record(request) }));
    await render(root);
    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit');
    const enabled = container.querySelector('select[name="enabled"]') as HTMLSelectElement;
    expect(submit?.disabled).toBe(true);
    await act(async () => setSelect(enabled, 'false'));
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/runtime-interactions/interaction-ui/respond',
      expect.objectContaining({
        body: JSON.stringify({
          cardRef,
          response: { kind: 'decision', decisionId: 'accept', content: { enabled: false } },
        }),
      }),
    );
  });

  it('omits an empty optional field instead of submitting an invalid empty value', async () => {
    const request = formRequest([]);
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(request) }))
      .mockResolvedValueOnce(okJson({ interaction: record(request) }));
    await render(root);
    const region = container.querySelector('input[name="region"]') as HTMLInputElement;
    await act(async () => {
      setInput(region, 'temporary');
      setInput(region, '');
    });
    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit');
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/runtime-interactions/interaction-ui/respond',
      expect.objectContaining({
        body: JSON.stringify({ cardRef, response: { kind: 'decision', decisionId: 'accept', content: {} } }),
      }),
    );
  });
});

async function render(root: Root): Promise<void> {
  await act(async () => {
    root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
    await Promise.resolve();
  });
}

function urlRequest(url: string): RuntimeInteractionRequest {
  return {
    version: 1,
    interactionId: 'interaction-ui',
    kind: 'elicitation',
    mode: 'url',
    owner,
    provider: { ...provider, method: 'mcpServer/elicitation/request' },
    createdAt: 1000,
    title: 'Authorize MCP server',
    message: 'Open the provider page, then confirm.',
    elicitationId: 'elicit-1',
    url,
    decisions: [
      { id: 'accept', label: 'Done', outcome: 'accept' },
      { id: 'decline', label: 'Decline', outcome: 'decline' },
      { id: 'cancel', label: 'Cancel', outcome: 'cancel' },
    ],
  };
}

function formRequest(required: string[]): Extract<RuntimeInteractionRequest, { kind: 'elicitation'; mode: 'form' }> {
  return {
    version: 1,
    interactionId: 'interaction-ui',
    kind: 'elicitation',
    mode: 'form',
    owner,
    provider: { ...provider, method: 'mcpServer/elicitation/request' },
    createdAt: 1000,
    title: 'Configure MCP server',
    message: 'Choose a region or decline the request.',
    requestedSchema: {
      type: 'object',
      properties: { region: { type: 'string', title: 'Region' } },
      required,
      additionalProperties: false,
    },
    decisions: [
      { id: 'accept', label: 'Submit', outcome: 'accept' },
      { id: 'decline', label: 'Decline', outcome: 'decline' },
      { id: 'cancel', label: 'Cancel', outcome: 'cancel' },
    ],
  };
}
