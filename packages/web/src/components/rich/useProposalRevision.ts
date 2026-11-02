import type { ThreadProposal } from '@cat-cafe/shared';
import { useState } from 'react';
import { useGuardedWrite, type WriteEvidence } from '@/components/ApprovalHost';
import { apiFetch } from '@/utils/api-client';

export function useProposalRevision(
  proposal: ThreadProposal,
  choices: { suggestedGroupId: string | null; projectPath: string; pinned: boolean },
) {
  const [instruction, setInstruction] = useState(proposal.revisionRequest?.instruction ?? '');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(Boolean(proposal.revisionRequest?.queuedAt));
  const [error, setError] = useState<string | null>(null);
  const guardedWrite = useGuardedWrite();
  const send = () =>
    guardedWrite('producer-card', async (reportEvidence) => {
      if (!instruction.trim() || sending) return;
      setSending(true);
      setError(null);
      try {
        await postRevisionRequest(
          proposal.proposalId,
          { instruction: instruction.trim(), ...changedChoices(proposal, choices) },
          reportEvidence,
        );
        setSent(true);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        setSending(false);
      }
    });
  return { instruction, setInstruction, sending, sent, error, send };
}

function changedChoices(
  proposal: ThreadProposal,
  choices: { suggestedGroupId: string | null; projectPath: string; pinned: boolean },
) {
  const changes: { suggestedGroupId?: string | null; projectPath?: string; pinned?: boolean } = {};
  if (choices.suggestedGroupId !== (proposal.suggestedGroupId ?? null))
    changes.suggestedGroupId = choices.suggestedGroupId;
  if (choices.projectPath !== proposal.projectPath) changes.projectPath = choices.projectPath;
  if (choices.pinned !== (proposal.suggestedPinned ?? false)) changes.pinned = choices.pinned;
  return changes;
}

async function postRevisionRequest(
  proposalId: string,
  body: object,
  reportEvidence: (evidence: WriteEvidence) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await apiFetch(`/api/proposals/${encodeURIComponent(proposalId)}/request-revision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    reportEvidence({ outcome: 'network-error' });
    throw error;
  }
  reportEvidence({ outcome: response.ok ? 'settled' : 'http-error', status: response.status });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
}
