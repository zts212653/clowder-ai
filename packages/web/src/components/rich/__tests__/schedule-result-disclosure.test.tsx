import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { describeReconcile, type Terminal } from '@/components/shell/mailbox/approval-reconcile';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { apiFetch } from '@/utils/api-client';
import { ReconciledApprovalResult } from '../ReconciledApprovalResult';
import { scheduleEffect } from '../read-schedule-approval';
import { ScheduleMutationProposalCard } from '../ScheduleMutationProposalCard';
import { coordinate, ok, scheduleBlock, scheduleProposal } from './schedule-approval.fixture';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root, container: HTMLDivElement;
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
  writeShellLanguage('zh');
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

for (const language of ['zh', 'en'] as const)
  for (const status of ['approved', 'rejected'] as const)
    it.each([
      'Chat',
      'Inbox',
    ] as const)(`keeps one readable ${status} schedule result through %s disclosure in ${language}`, async (host) => {
      writeShellLanguage(language);
      const proposal = scheduleProposal(status);
      vi.mocked(apiFetch).mockImplementation(async (path) =>
        String(path) === '/api/session' ? ok({ userId: 'owner-1' }) : ok({ proposal }),
      );
      const terminal: Terminal = {
        resolution: status === 'approved' ? 'accepted' : 'rejected',
        decidedAt: 2000,
        decidedBy: 'owner-1',
      };
      const label = describeReconcile(
        { kind: 'decided', terminal },
        { language, ownerUserId: proposal.ownerUserId, originalEffect: scheduleEffect(proposal) },
      ).line;
      if (!label) throw new Error('Canonical terminal label required');
      const card = <ScheduleMutationProposalCard block={scheduleBlock} coordinate={coordinate} />;
      await act(async () =>
        root.render(
          host === 'Inbox' ? (
            <ReconciledApprovalResult terminal={terminal} line={label}>
              {card}
            </ReconciledApprovalResult>
          ) : (
            card
          ),
        ),
      );
      const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
      expect(disclosure).not.toBeNull();
      expect(container.textContent?.split(label).length).toBe(2);
      await act(async () => disclosure?.click());
      expect(container.textContent).toContain('Read the evidence');
      expect(container.querySelectorAll('[data-testid="decision-result-label"]')).toHaveLength(1);
      expect(container.textContent?.split(label).length).toBe(2);
      expect(container.querySelector('[data-testid="schedule-approve"]')).toBeNull();
      expect(container.querySelector('[data-testid="schedule-reject"]')).toBeNull();
      expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
      expect(
        vi.mocked(apiFetch).mock.calls.some(([path]) => String(path) === '/api/schedule-proposals/schedule-1'),
      ).toBe(true);
    });
