import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { apiFetch } from '@/utils/api-client';
import { CardBlock } from '../CardBlock';
import { HandoffProposalCard } from '../HandoffProposalCard';
import { RuntimeInteractionCard } from '../RuntimeInteractionCard';
import { ScheduleMutationProposalCard } from '../ScheduleMutationProposalCard';
import {
  approvalRequest,
  messageId,
  owner,
  provider,
  record,
  block as runtimeBlock,
} from './runtime-interaction-test-fixtures';
import { coordinate, ok, scheduleBlock, scheduleProposal } from './schedule-approval.fixture';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('v2');
  writeShellLanguage('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
  writeShellLanguage('zh');
  writeShellPresentation('classic');
  vi.unstubAllGlobals();
});

describe('one decided-row presentation in original approval surfaces', () => {
  it.each([
    'approved',
    'rejected',
    'expired',
  ] as const)('collapses a canonical %s handoff and recovers its original details', async (status) => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ proposal: { status } }));
    await act(async () =>
      root.render(
        <HandoffProposalCard
          block={{
            kind: 'card',
            v: 1,
            id: 'handoff-p1',
            title: 'Session handoff',
            fields: [{ label: '下一步', value: 'Verify the original source' }],
            actions: [{ action: 'handoff:approve', label: 'Approve', payload: { proposalId: 'p1' } }],
          }}
        />,
      ),
    );
    const row = container.querySelector('[data-testid="decision-result-row"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-status]')?.getAttribute('data-status')).toBe(status);
    // DESIGN Colors/Semantic: the redundant status indicator is an 8px circle.
    const dot = row?.querySelector('[data-testid="decision-result-dot"]');
    expect(dot?.classList.contains('h-2')).toBe(true);
    expect(dot?.classList.contains('w-2')).toBe(true);
    expect(container.textContent).not.toContain('Verify the original source');
    const disclosure = row?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(disclosure).not.toBeNull();
    await act(async () => disclosure?.click());
    expect(container.textContent).toContain('Verify the original source');
    expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('collapses a registered schedule while retaining the exact original task on disclosure', async () => {
    const proposal = scheduleProposal('approved');
    vi.mocked(apiFetch).mockImplementation(async (path) =>
      String(path) === '/api/session' ? ok({ userId: 'owner-1' }) : ok({ proposal }),
    );
    await act(async () => root.render(<ScheduleMutationProposalCard block={scheduleBlock} coordinate={coordinate} />));
    const row = container.querySelector('[data-testid="decision-result-row"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('registered');
    expect(container.textContent).not.toContain('Read the evidence');
    await act(async () => row?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    expect(container.textContent).toContain('Read the evidence');
    expect(container.textContent).not.toContain('This scheduling effect has not happened yet.');
    expect(container.querySelector('[data-testid="schedule-approve"]')).toBeNull();
  });

  it('reads the actual selected provider option and keeps the original request behind disclosure', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      ok({
        interaction: record(approvalRequest(), 'answered', {
          status: 'answered',
          reasonCode: 'answered',
          settledAt: 2000,
          response: { kind: 'decision', decisionId: 'accept-session' },
        }),
      }),
    );
    await act(async () => root.render(<RuntimeInteractionCard block={runtimeBlock} messageId={messageId} />));
    expect(container.querySelector('[data-testid="decision-result-label"]')?.textContent).toContain(
      'Allow this session',
    );
    expect(container.querySelector('h3')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    expect(container.querySelector('h3')?.textContent).toBe('Run tests?');
    expect(container.querySelector('form')).toBeNull();
  });

  it('preserves the original profile diff after its terminal read and exposes it only on disclosure', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ proposalId: 'profile-1', status: 'approved' }));
    await act(async () =>
      root.render(
        <CardBlock
          messageId="profile-card"
          block={{
            id: 'profile-update-profile-1',
            kind: 'card',
            v: 1,
            title: '提议更新共享事实档案（corpus）',
            bodyMarkdown:
              'Reason\n\n**当前内容：**\n```\nOriginal profile\n```\n\n**提议改为：**\n```\nRevised profile\n```',
            meta: { approval: { producerId: 'F231', canonicalProposalId: 'profile-1' } },
          }}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="decision-result-row"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Original profile');
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    expect(container.textContent).toContain('Original profile');
    expect(container.textContent).toContain('Revised profile');
    expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('recovers only public predefined choices, ignoring secret and malformed receipt indexes', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      ok({
        interaction: record(
          {
            version: 1,
            interactionId: 'interaction-ui',
            kind: 'question',
            owner,
            provider,
            createdAt: 1000,
            title: 'Choose an environment',
            questions: [
              {
                id: 'environment',
                header: 'Environment',
                question: 'Where?',
                options: [{ label: 'Alpha' }, { label: 'Production' }],
              },
              {
                id: 'private',
                header: 'Private',
                question: 'Which private option?',
                isSecret: true,
                options: [{ label: 'Private selection' }],
              },
            ],
          },
          'answered',
          {
            status: 'answered',
            reasonCode: 'answered',
            settledAt: 2000,
            response: {
              kind: 'answers',
              answeredQuestionIds: ['environment', 'private'],
              secretQuestionIds: ['private'],
              selectedOptionIndexes: { environment: [-1, 0, 1.5, 99], private: [0] },
            },
          },
        ),
      }),
    );
    await act(async () => root.render(<RuntimeInteractionCard block={runtimeBlock} messageId={messageId} />));
    const label = container.querySelector('[data-testid="decision-result-label"]')?.textContent;
    expect(label).toContain('Chose “Alpha”');
    expect(label).not.toContain('Private selection');
    expect(label).not.toContain('Production');
    expect(container.querySelector('form')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    expect(container.textContent).toContain('Where?');
    expect(container.textContent).not.toContain('Private selection');
    expect(container.querySelector('input, select, textarea, form')).toBeNull();
  });
  it('recovers the original form purpose and field labels without restoring answers or controls', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      ok({
        interaction: record(
          {
            version: 1,
            interactionId: 'interaction-ui',
            kind: 'elicitation',
            mode: 'form',
            owner,
            provider,
            createdAt: 1000,
            title: 'Verification request',
            message: 'Choose the verification target.',
            requestedSchema: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean', title: 'Enabled', description: 'Whether this target participates.' },
              },
              required: ['enabled'],
              additionalProperties: false,
            },
            decisions: [{ id: 'accept', label: 'Allow once', outcome: 'accept' }],
          },
          'answered',
          {
            status: 'answered',
            reasonCode: 'answered',
            settledAt: 2000,
            response: { kind: 'decision', decisionId: 'accept', submittedFieldIds: ['enabled'] },
          },
        ),
      }),
    );
    await act(async () => root.render(<RuntimeInteractionCard block={runtimeBlock} messageId={messageId} />));
    expect(container.textContent).not.toContain('Choose the verification target.');
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    expect(container.textContent).toContain('Choose the verification target.');
    expect(container.textContent).toContain('Enabled');
    expect(container.textContent).toContain('Whether this target participates.');
    expect(container.querySelector('input, select, textarea, form')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
});
