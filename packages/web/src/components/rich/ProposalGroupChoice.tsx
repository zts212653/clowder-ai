import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { apiFetch } from '@/utils/api-client';
import { ProposalChoice } from './ProposalChoice';
import { proposalCardCopy } from './proposal-card.shell-copy';

export function ProposalGroupChoice({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const t = useShellCopy(proposalCardCopy);
  const [groups, setGroups] = useState<ThreadAttentionGroup[]>([]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch('/api/config/thread-attention', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Group read failed');
        const data = (await response.json()) as { groups?: ThreadAttentionGroup[] };
        if (!controller.signal.aborted) {
          setGroups(data.groups ?? []);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [retry]);
  return (
    <ProposalChoice
      label={t.group}
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={[
        ...groups.map((group) => ({ value: group.id, label: group.name || `${group.threadIds.length} ${t.group}` })),
        { value: '', label: t.noGroup },
      ]}
      notice={
        failed ? (
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            {t.groupsUnavailable}
          </button>
        ) : null
      }
    />
  );
}
