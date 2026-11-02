import type { RichCardBlock } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { okRead, storeItem, visibleApproval } from '@/components/shell/mailbox/__tests__/mailbox-fixtures';
import { INITIAL_RECONCILE } from '@/components/shell/mailbox/approval-reconcile';
import { createApprovalSessions } from '@/components/shell/mailbox/approval-sessions';
import { RetainedResult } from '@/components/shell/mailbox/RetainedResults';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { apiFetch } from '@/utils/api-client';
import { HandoffResultRow } from '../HandoffResultRow';
import { ProfileUpdateResult } from '../ProfileUpdateCardContent';

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
  for (const entrance of ['Chat', 'Inbox'] as const)
    it.each([
      ['F225', 'approved', /接力已发起/, /handoff started/i],
      ['F225', 'rejected', /当前会话继续/, /current session continues/i],
      ['F231', 'approved', /写入.*档案|档案.*写入/, /profile written|written to your profile/i],
    ] as const)(`${language} ${entrance}: %s %s preserves the confirmed result on collapse and disclosure`, async (feature, status, zh, en) => {
      writeShellLanguage(language);
      const proposalId = 'effect-result';
      const block: RichCardBlock = {
        id: 'effect-original',
        kind: 'card',
        v: 1,
        title: 'Original proposal',
        bodyMarkdown: 'Original accepted source',
        fields: [{ label: '下一步', value: 'Continue the accepted verification.' }],
      };
      vi.mocked(apiFetch).mockResolvedValue(
        Response.json(
          feature === 'F225'
            ? { proposal: { proposalId, status, sealedSessionId: 'original-session' } }
            : { proposalId, status },
        ),
      );
      if (entrance === 'Chat') {
        await act(async () =>
          root.render(
            feature === 'F225' ? (
              <HandoffResultRow status={status} block={block} title={block.title} error={null} />
            ) : (
              <ProfileUpdateResult status={status} block={block} error={null} />
            ),
          ),
        );
      } else {
        const sessions = createApprovalSessions({
          readsStarted: () => 1,
          refetch: vi.fn(),
          refreshStore: async () => {},
          storeItems: () => [],
          attempts: () => ({}),
          latestRead: () => ({ result: okRead([]), generation: 1 }),
          now: Date.now,
        });
        const session = sessions.open({
          ownerUserId: 'owner-1',
          decisionRef: 'approval:effect-result',
          originalBlock: block,
          approval: visibleApproval(
            storeItem({ sourceFeatureId: feature, proposalId, detail: { sourceSessionId: 'original-session' } }),
          ),
        });
        session.model = {
          ...INITIAL_RECONCILE,
          state: {
            kind: 'decided',
            terminal: { resolution: status === 'approved' ? 'accepted' : 'rejected', decidedBy: 'owner-1' },
          },
        };
        await act(async () => root.render(<RetainedResult session={session} sessions={sessions} />));
      }
      const expected = language === 'zh' ? zh : en;
      expect(container.querySelector('[data-testid=decision-result-label]')?.textContent).toMatch(expected);
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded=false]')?.click());
      expect(container.querySelector('[data-testid=decision-result-details]')?.textContent).not.toMatch(expected);
      expect(container.textContent).toContain('Continue the accepted verification.');
      expect(container.querySelectorAll('form, input, textarea, select')).toHaveLength(0);
      expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    });
