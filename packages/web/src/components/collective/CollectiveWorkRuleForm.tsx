'use client';
import type { CollectiveWorkGrantScope } from '@cat-cafe/shared';
import { useState } from 'react';
import { policyControl } from './collective-work-policy-control';
import type { ParticipationView } from './use-collective-participation';

export function CollectiveWorkRuleForm({
  cats,
  channelId,
  disabled,
  onAdd,
}: {
  cats: ParticipationView['cats'];
  channelId: string;
  disabled: boolean;
  onAdd: (rule: Omit<CollectiveWorkGrantScope, 'grantRef' | 'sourceEventIds'>) => void;
}) {
  const [catId, setCatId] = useState(cats[0]?.id ?? '');
  const [kind, setKind] = useState('');
  const [expiry, setExpiry] = useState('');
  return (
    <fieldset className="space-y-3 border-t border-[var(--console-border-soft)] pt-3" disabled={disabled}>
      <legend className="text-sm font-medium">新规则 · # {channelId}</legend>
      <label className="grid gap-1 text-xs">
        由哪只猫处理
        <select className={policyControl} value={catId} onChange={(event) => setCatId(event.target.value)}>
          {cats.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        工作类型
        <input
          className={policyControl}
          maxLength={240}
          value={kind}
          placeholder="如 写作与整理"
          onChange={(event) => setKind(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        到期时间（可选）
        <input
          className={policyControl}
          type="datetime-local"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
        />
      </label>
      <p className="text-xs leading-5 text-cafe-muted">
        允许这个频道里的成员提出这类工作；猫可以自己决定接不接。到期留空时，一直有效到你撤回。
      </p>
      <button
        type="button"
        className={policyControl}
        disabled={!catId || !kind.trim()}
        onClick={() =>
          onAdd({
            catIds: [catId],
            channelIds: [channelId],
            requestingHumanIds: 'channel_members',
            requestKinds: [
              ({ 写作与整理: 'guide', 提问回答: 'answer', 法律资料整理: 'legal' } as Record<string, string>)[
                kind.trim()
              ] ?? kind.trim(),
            ],
            expiresAt: expiry ? new Date(expiry).toISOString() : null,
          })
        }
      >
        允许此类工作
      </button>
    </fieldset>
  );
}
