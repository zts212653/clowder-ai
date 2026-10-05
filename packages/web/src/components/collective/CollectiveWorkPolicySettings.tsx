'use client';
import { useState } from 'react';
import { CollectiveWorkRuleForm } from './CollectiveWorkRuleForm';
import type { ParticipationView } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

export const policyControl =
  'h-8 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 text-sm text-cafe-primary disabled:opacity-50';
export function CollectiveWorkPolicySettings({
  state,
  view,
  channelId,
  enabled,
}: {
  state: CollectiveWorkPolicyState;
  view: ParticipationView;
  channelId: string;
  enabled: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const { status, listening, busy } = state;
  const participants = view.cats.filter((cat) => view.channelRoutes[channelId]?.participants[cat.id]);
  const currentListening = listening?.channelListening[channelId];
  const duty = currentListening?.dutyCatId ?? participants[0]?.id;
  const currentMode = status?.policy?.decisionMode ?? 'automatic';
  const disabled = !enabled || busy;
  const active = Boolean(
    status?.policy &&
      status.localAdoption?.revision === status.policy.revision &&
      status.localAdoption.grants.every((grant) => grant.state !== 'changed') &&
      !status.localAdoption.pendingRevocations.length,
  );
  return (
    <section
      aria-label="参与设置"
      className="space-y-4 border-b border-[var(--console-border-soft)] pb-4"
      data-testid="collective-work-policy-settings"
    >
      <fieldset className="space-y-2" disabled={disabled || !listening}>
        <legend className="mb-2 text-sm font-medium">消息听取</legend>
        <label className="flex gap-2 text-sm">
          <input
            type="radio"
            className="accent-[var(--cafe-text)]"
            name="collective-listening"
            checked={currentListening?.mode !== 'all'}
            onChange={() => void state.listen(channelId, 'mentions')}
          />
          只听 @ 我家猫的消息
        </label>
        <label className="flex gap-2 text-sm">
          <input
            type="radio"
            className="accent-[var(--cafe-text)]"
            name="collective-listening"
            checked={currentListening?.mode === 'all'}
            disabled={!participants.length}
            onChange={() => void state.listen(channelId, 'all', duty)}
          />
          值班猫把所有消息看一眼
        </label>
        {currentListening?.mode === 'all' && (
          <label className="grid gap-1 text-xs text-cafe-secondary">
            值班猫
            <select
              className={policyControl}
              value={duty}
              onChange={(event) => void state.listen(channelId, 'all', event.target.value)}
            >
              {participants.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="text-xs leading-5 text-cafe-muted">仅调整 # {channelId}。看见不等于接活，也不会叫醒每只猫。</p>
      </fieldset>
      <fieldset className="space-y-2 border-t border-[var(--console-border-soft)] pt-4" disabled={disabled || !status}>
        <legend className="pt-4 text-sm font-medium">工作接受</legend>
        <label className="flex gap-2 text-sm">
          <input
            type="radio"
            className="accent-[var(--cafe-text)]"
            name="collective-work-decision"
            checked={currentMode === 'automatic'}
            onChange={() => void state.change({ kind: 'set_mode', decisionMode: 'automatic' })}
          />
          猫自己决定
        </label>
        <p className="text-xs leading-5 text-cafe-muted">在下面的授权规则之内直接接；超出了才问我。</p>
        <label className="flex gap-2 text-sm">
          <input
            type="radio"
            className="accent-[var(--cafe-text)]"
            name="collective-work-decision"
            checked={currentMode === 'manual'}
            onChange={() => void state.change({ kind: 'set_mode', decisionMode: 'manual' })}
          />
          每件都要我批准
        </label>
        {currentMode === 'manual' && (
          <p className="text-xs text-cafe-muted">已明确允许的同类规则仍可自动接；其他事项继续请你决定。</p>
        )}
      </fieldset>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">授权规则</h3>
          <button
            className={policyControl}
            type="button"
            disabled={disabled || !status}
            onClick={() => setAdding(!adding)}
          >
            添加规则…
          </button>
        </div>
        {!status ? (
          <p className="text-xs text-cafe-muted">正在读取授权规则…</p>
        ) : !status.policy?.grants.some((rule) => rule.status === 'active') ? (
          <p className="text-xs leading-5 text-cafe-muted">尚无授权规则。猫可以回应；持续工作需要你允许。</p>
        ) : (
          status.policy.grants
            .filter((rule) => rule.status === 'active')
            .map((rule) => {
              const local = status.localAdoption?.grants.find(
                (item) => item.grantRef === rule.grantRef && item.grantRevision === rule.grantRevision,
              );
              const label =
                !local || local.state === 'changed'
                  ? 'Service 已登记，等待本机采用'
                  : local.state === 'active'
                    ? '已生效'
                    : local.state === 'expired'
                      ? '已到期'
                      : '已撤回，等待同步';
              return (
                <article
                  key={rule.grantRef}
                  className="rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 text-xs leading-5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-medium">
                      {rule.catIds
                        .map((id) => view.cats.find((cat) => cat.id === id)?.displayName ?? '原参与猫')
                        .join('、')}{' '}
                      · {rule.channelIds.map((id) => `# ${id}`).join('、')} ·{' '}
                      {rule.requestKinds.map(kindLabel).join('、')}
                    </h4>
                    <button
                      className={policyControl}
                      disabled={disabled || !local}
                      type="button"
                      onClick={() => void state.withdraw(rule.grantRef)}
                    >
                      撤回
                    </button>
                  </div>
                  <p className="mt-2">可读：当前事项有权查看的共同体资料</p>
                  <p>可做：在家里准备结果，并回到原处</p>
                  <p>
                    {rule.sourceEventIds
                      ? '仅允许指定的原请求'
                      : (rule.decisionMode ?? status.policy?.decisionMode) === 'automatic'
                        ? '允许此类工作自动接下'
                        : '此类工作每件请你决定'}{' '}
                    · {rule.requestingHumanIds === 'channel_members' ? '频道成员可提出' : '仅指定成员可提出'}
                  </p>
                  <p>
                    {rule.expiresAt ? `到期：${new Date(rule.expiresAt).toLocaleString()}` : '持续到你撤回'} · {label}
                  </p>
                </article>
              );
            })
        )}
        {adding && (
          <CollectiveWorkRuleForm
            cats={participants}
            channelId={channelId}
            disabled={disabled}
            onAdd={(rule) => void state.change({ kind: 'add_rule', rule })}
          />
        )}
        <p className="text-xs leading-5 text-cafe-muted">
          撤回后，猫不能再凭这条规则接活或继续执行；受影响的工作会说明原因。已经完成的动作不会回退。
        </p>
      </div>
      <div aria-live="polite" className="text-xs leading-5 text-cafe-secondary">
        {busy ? (
          <p>{state.phase}</p>
        ) : status?.policy ? (
          <p>{active ? '已生效' : 'Service 已登记，等待本机采用'}</p>
        ) : null}
        {!busy && status?.policy && !active && (
          <button type="button" className={policyControl} disabled={!enabled} onClick={() => void state.adopt()}>
            采用当前登记
          </button>
        )}
        {state.error && (
          <p role="alert">
            {state.error}{' '}
            <button type="button" className="underline" onClick={() => void state.read()}>
              重新读取
            </button>
          </p>
        )}
      </div>
    </section>
  );
}
export function kindLabel(kind: string) {
  return ({ guide: '写作与整理', answer: '提问回答', legal: '法律资料整理' } as Record<string, string>)[kind] ?? kind;
}
