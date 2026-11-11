import { useEffect, useRef, useState } from 'react';
import { useShellCopy } from '../shell-copy';
import { personProposalForgetCopy } from './person-proposal-forget.shell-copy';
import {
  executePendingProposalForget,
  proposalForgetBusy,
  usePendingProposalForgets,
} from './proposal-forget-recovery';

export function PersonProposalForgetRecovery({
  owner,
  onForgotten,
}: {
  owner: string | null;
  onForgotten: (ids: string[], count: number) => void;
}) {
  const t = useShellCopy(personProposalForgetCopy);
  const pending = usePendingProposalForgets(owner);
  const [note, setNote] = useState('');
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  // A response belonging to another owner's old display must not become current feedback.
  useEffect(() => setNote(''), [owner]);
  return (
    <div data-testid="person-proposal-forget-recovery" className="space-y-3">
      {note ? (
        <p role="status" className="text-compact">
          {note}
        </p>
      ) : null}
      {pending.map((command) => (
        <div
          key={command.requestId}
          className="space-y-2 rounded-lg p-3 text-compact"
          style={{ background: 'var(--shell-frame)' }}
        >
          <p role="status">{proposalForgetBusy(command) ? t.busy : t.unknown}</p>
          <details className="text-xs text-[var(--shell-muted)]">
            <summary className="shell-focusable">{t.title}</summary>
            <code className="break-all">{command.proposalId}</code>
          </details>
          <button
            type="button"
            className="shell-focusable underline underline-offset-4 disabled:opacity-50"
            disabled={proposalForgetBusy(command)}
            onClick={async () => {
              if (!owner) return;
              const result = await executePendingProposalForget(owner, command);
              if (currentOwner.current !== owner) return;
              if (result.outcome === 'purged' || result.outcome === 'already_absent')
                onForgotten(command.proposalIds, result.count);
              else
                setNote(
                  result.outcome === 'stale_revision'
                    ? t.stale
                    : result.outcome === 'person_bound'
                      ? t.bound
                      : result.outcome === 'conflict'
                        ? t.conflict
                        : '',
                );
            }}
          >
            {t.retry}
          </button>
        </div>
      ))}
    </div>
  );
}
