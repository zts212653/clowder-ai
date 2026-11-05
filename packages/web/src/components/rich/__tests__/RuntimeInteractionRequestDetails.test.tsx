import type { RuntimeInteractionRecord, RuntimeInteractionRequest } from '@cat-cafe/shared';
import { runtimeInteractionRequestSchema } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeInteractionRequestDetails } from '../RuntimeInteractionRequestDetails';
import { approvalRequest } from './runtime-interaction-test-fixtures';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const terminal: RuntimeInteractionRecord['terminal'] = {
  status: 'declined',
  reasonCode: 'user_rejected',
  settledAt: 2000,
  response: { kind: 'decision', decisionId: 'decline' },
};
function precedes(first: Element, second: Element) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
}

it.each([
  'url',
  'form',
] as const)('keeps the original elicitation %s reading order before historical choices', (mode) => {
  const original = approvalRequest();
  if (original.kind !== 'approval') throw new Error('Expected the original approval fixture');
  const request: Extract<RuntimeInteractionRequest, { kind: 'elicitation' }> = {
    ...original,
    kind: 'elicitation',
    message: 'Choose the verification target.',
    ...(mode === 'url'
      ? { mode, elicitationId: 'historical-url', url: 'https://example.invalid/authorize' }
      : {
          mode,
          requestedSchema: {
            type: 'object',
            properties: { target: { type: 'string', title: 'Verification target' } },
            required: ['target'],
            additionalProperties: false,
          },
        }),
  };
  runtimeInteractionRequestSchema.parse(request);
  act(() => root.render(<RuntimeInteractionRequestDetails request={request} terminal={terminal} />));
  const message = [...container.querySelectorAll('p')].find((node) => node.textContent === request.message)!;
  const target =
    mode === 'url'
      ? [...container.querySelectorAll('p')].find((node) => node.textContent === 'https://example.invalid/authorize')!
      : container.querySelector('dl')!;
  const choices = container.querySelector('[data-testid="readonly-choice-list"]')!;
  precedes(container.querySelector('h3')!, message);
  precedes(message, target);
  precedes(target, choices);
  expect(choices.querySelector('[data-selected="true"]')?.textContent).toContain('Decline');
  expect(container.querySelectorAll('form,input,textarea,select,button,a')).toHaveLength(0);
});

it('retains approval description followed by the original historical choices', () => {
  const request = approvalRequest();
  act(() => root.render(<RuntimeInteractionRequestDetails request={request} terminal={terminal} />));
  precedes(container.querySelector('p')!, container.querySelector('[data-testid="readonly-choice-list"]')!);
  expect(container.querySelectorAll('form,input,button')).toHaveLength(0);
});

it('retains question prompt followed by historical options', () => {
  const original = approvalRequest();
  if (original.kind !== 'approval') throw new Error('Expected the original approval fixture');
  const request: RuntimeInteractionRequest = {
    version: original.version,
    interactionId: original.interactionId,
    owner: original.owner,
    provider: original.provider,
    createdAt: original.createdAt,
    title: original.title,
    kind: 'question',
    questions: [{ id: 'target', header: 'Target', question: 'Where should it run?', options: [{ label: 'Alpha' }] }],
  };
  runtimeInteractionRequestSchema.parse(request);
  act(() => root.render(<RuntimeInteractionRequestDetails request={request} />));
  const section = container.querySelector('section')!;
  precedes(section.querySelector('p')!, section.querySelector('[data-testid="readonly-choice-list"]')!);
  expect(container.querySelectorAll('form,input,button')).toHaveLength(0);
});
