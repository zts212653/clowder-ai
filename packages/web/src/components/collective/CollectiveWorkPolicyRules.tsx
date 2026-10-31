'use client';

import type { CollectiveRegisteredWorkGrant } from '@cat-cafe/shared';
import { useState } from 'react';
import { CollectiveWorkRuleForm } from './CollectiveWorkRuleForm';
import { policyControl } from './collective-work-policy-control';
import type { ParticipationView } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

export function CollectiveWorkPolicyRules({
  state,
  view,
  channelId,
  disabled,
}: {
  readonly state: CollectiveWorkPolicyState;
  readonly view: ParticipationView;
  readonly channelId: string;
  readonly disabled: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const { status } = state;
  const participants = view.cats.filter((cat) => view.channelRoutes[channelId]?.participants[cat.id]);
  const activeRules = status?.policy?.grants.filter((rule) => rule.status === 'active') ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">已允许的工作 {activeRules.length || ''}</h3>
        <button
          className={policyControl}
          type="button"
          disabled={disabled || !status}
          onClick={() => setAdding(!adding)}
        >
          添加…
        </button>
      </div>
      <WorkRulesBody
        loading={!status}
        rules={activeRules}
        view={view}
        defaultMode={status?.policy?.decisionMode}
        localGrants={status?.localAdoption?.grants ?? []}
        disabled={disabled}
        revoking={revoking}
        onBeginRevoke={setRevoking}
        onCancelRevoke={() => setRevoking(undefined)}
        onRevoke={(grantRef) => void state.withdraw(grantRef).then(() => setRevoking(undefined))}
      />
      {adding && (
        <CollectiveWorkRuleForm
          cats={participants}
          channelId={channelId}
          disabled={disabled}
          onAdd={(rule) => void state.change({ kind: 'add_rule', rule })}
        />
      )}
    </div>
  );
}

interface LocalGrantState {
  readonly grantRef: string;
  readonly grantRevision: number;
  readonly state: 'active' | 'changed' | 'blocked' | 'expired';
}

function WorkRulesBody({
  loading,
  rules,
  view,
  defaultMode,
  localGrants,
  disabled,
  revoking,
  onBeginRevoke,
  onCancelRevoke,
  onRevoke,
}: {
  readonly loading: boolean;
  readonly rules: readonly CollectiveRegisteredWorkGrant[];
  readonly view: ParticipationView;
  readonly defaultMode?: 'automatic' | 'manual';
  readonly localGrants: readonly LocalGrantState[];
  readonly disabled: boolean;
  readonly revoking?: string;
  readonly onBeginRevoke: (grantRef: string) => void;
  readonly onCancelRevoke: () => void;
  readonly onRevoke: (grantRef: string) => void;
}) {
  if (loading) return <p className="text-xs text-cafe-muted">正在读取授权规则…</p>;
  if (!rules.length)
    return <p className="text-xs leading-5 text-cafe-muted">猫会在频道里回应别人；要接持续的工作，会先来问你。</p>;
  return rules.map((rule) => (
    <WorkPolicyRule
      key={rule.grantRef}
      rule={rule}
      view={view}
      defaultMode={defaultMode}
      local={localGrants.find((item) => item.grantRef === rule.grantRef && item.grantRevision === rule.grantRevision)}
      disabled={disabled}
      confirming={revoking === rule.grantRef}
      onBeginRevoke={() => onBeginRevoke(rule.grantRef)}
      onCancelRevoke={onCancelRevoke}
      onRevoke={() => onRevoke(rule.grantRef)}
    />
  ));
}

function WorkPolicyRule({
  rule,
  view,
  defaultMode,
  local,
  disabled,
  confirming,
  onBeginRevoke,
  onCancelRevoke,
  onRevoke,
}: {
  readonly rule: CollectiveRegisteredWorkGrant;
  readonly view: ParticipationView;
  readonly defaultMode?: 'automatic' | 'manual';
  readonly local?: LocalGrantState;
  readonly disabled: boolean;
  readonly confirming: boolean;
  readonly onBeginRevoke: () => void;
  readonly onCancelRevoke: () => void;
  readonly onRevoke: () => void;
}) {
  return (
    <article className="border-t border-[var(--console-border-soft)] py-3 text-xs leading-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium">{grantSentence(rule, view, defaultMode)}</h4>
          <p className="mt-1 text-cafe-muted">
            {grantScopeSummary(rule)} · {localGrantLabel(local)}
          </p>
        </div>
        <button className={policyControl} disabled={disabled || !local} type="button" onClick={onBeginRevoke}>
          撤回
        </button>
      </div>
      {confirming && (
        <div className="mt-3 rounded-lg bg-[var(--cafe-surface-sunken)] p-3">
          <p>撤回后，猫不能再凭这条规则接新工作；正在做的工作会按实际情况说明原因。</p>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className={policyControl} onClick={onRevoke}>
              撤回
            </button>
            <button type="button" className={policyControl} onClick={onCancelRevoke}>
              取消
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function localGrantLabel(local?: LocalGrantState) {
  if (!local || local.state === 'changed') return '正在同步';
  if (local.state === 'active') return '已生效';
  if (local.state === 'expired') return '已到期';
  return '正在撤回';
}

export function kindLabel(kind: string) {
  return ({ guide: '写作与整理', answer: '提问回答', legal: '法律资料整理' } as Record<string, string>)[kind] ?? kind;
}

function grantSentence(
  rule: CollectiveRegisteredWorkGrant,
  view: ParticipationView,
  defaultMode?: 'automatic' | 'manual',
) {
  const cats = rule.catIds.map((id) => {
    const cat = view.cats.find((candidate) => candidate.id === id);
    return cat?.nickname ?? cat?.displayName ?? '原参与猫';
  });
  const catLabel = cats.join('、');
  const channels = rule.channelIds.map((id) => `# ${id}`).join('、');
  const people = rule.requestingHumanIds === 'channel_members' ? '任何人' : '指定成员';
  const kinds = rule.requestKinds.map((kind) => `「${kindLabel(kind)}」`).join('、');
  if (rule.sourceEventIds?.length) return `仅这一次：已允许${catLabel}处理 ${channels} 里的这条${kinds}请求`;
  const automatic = (rule.decisionMode ?? defaultMode) === 'automatic';
  return `${channels} 里${people}请${catLabel}做${kinds}，${catLabel}${automatic ? '可以自己决定接' : '会先来问你'}`;
}

function grantScopeSummary(rule: CollectiveRegisteredWorkGrant) {
  const expiry = rule.expiresAt ? `到期 ${new Date(rule.expiresAt).toLocaleDateString()}` : undefined;
  if (rule.sourceEventIds?.length) return ['指定原请求已允许', '仅这一次', expiry].filter(Boolean).join(' · ');
  return ['手动添加', expiry ?? '不设到期'].join(' · ');
}
