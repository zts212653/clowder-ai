'use client';

import type { RoutingSignalEventV1, RoutingSubjectRefV1 } from '@cat-cafe/shared';
import { useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { closeRoutingSignal, markRoutingSignal } from './routing-context-client';
import { buildSignalMarkCommand, newRoutingCommandId, openRoutingSignalsForSubject } from './routing-context-commands';
import { availabilityStateLabel } from './team-member-projection';

const HOUR_MS = 3_600_000;

/** Reason codes this surface writes or has ever rendered; anything else stays as stored. */
const REASON_CODE_LABELS: Record<string, string> = {
  'owner-constraint': 'co-creator设置的临时限制',
  'owner-maintenance': '维护中',
  'quota-window': '额度周期限制',
  quota_exhausted: '额度已用尽',
  authentication_rejected: '鉴权被拒绝',
  provider_unreachable: '服务暂时不可达',
  provider_timeout: '服务响应超时',
};

function reasonCodeLabel(reasonCode: string): string {
  return REASON_CODE_LABELS[reasonCode] ?? reasonCode;
}

export function RoutingSignalControls({
  subjectRef,
  affectedCatIds,
  signalEvents,
  onChanged,
}: {
  subjectRef: RoutingSubjectRefV1;
  affectedCatIds: readonly string[];
  signalEvents: readonly RoutingSignalEventV1[];
  onChanged: () => Promise<boolean>;
}) {
  const [state, setState] = useState<'scarce' | 'degraded' | 'unavailable'>('scarce');
  const [reasonCode, setReasonCode] = useState('owner-constraint');
  const [note, setNote] = useState('');
  const [durationHours, setDurationHours] = useState(4);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markCommandId = useRef<string | null>(null);
  const closeCommandIds = useRef(new Map<string, string>());
  const openAssertions = useMemo(
    () => openRoutingSignalsForSubject(signalEvents, subjectRef),
    [signalEvents, subjectRef],
  );
  const { cats } = useCatData({ fetch: false });
  const affectedNames = affectedCatIds
    .map((catId) => cats.find((cat) => cat.id === catId)?.displayName)
    .filter((name): name is string => Boolean(name));
  const outsideCatalog = affectedCatIds.length - affectedNames.length;
  const affectedLine =
    affectedCatIds.length === 0
      ? '当前目录无匹配成员'
      : [affectedNames.join('、'), outsideCatalog > 0 ? `${outsideCatalog} 位目录外成员` : '']
          .filter(Boolean)
          .join('；');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const commandId = markCommandId.current ?? newRoutingCommandId('signal');
      markCommandId.current = commandId;
      await markRoutingSignal(
        buildSignalMarkCommand({
          commandId,
          subjectRef,
          state,
          reasonCode,
          note,
          observedAt: Date.now(),
          durationMs: durationHours * HOUR_MS,
        }),
      );
      await onChanged();
      markCommandId.current = null;
      setNote('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '路由信号写入失败');
    } finally {
      setSaving(false);
    }
  }

  async function close(eventId: string, action: 'recover' | 'retract') {
    setSaving(true);
    setError(null);
    try {
      const intentKey = `${eventId}:${action}`;
      const commandId = closeCommandIds.current.get(intentKey) ?? newRoutingCommandId(`signal-${action}`);
      closeCommandIds.current.set(intentKey, commandId);
      await closeRoutingSignal(eventId, action, {
        v: 1,
        commandId,
        reasonCode: action === 'recover' ? 'owner-confirmed-recovery' : 'owner-retracted-assertion',
      });
      await onChanged();
      closeCommandIds.current.delete(intentKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '路由信号更新失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4"
      data-testid="routing-signal-controls"
    >
      <div>
        <h4 className="text-xs font-semibold text-cafe-black">Owner 路由信号</h4>
        <p className="mt-1 text-micro leading-4 text-cafe-muted">
          只影响未来发送前判断；不会取消已开始的 invocation，也不会自动改派原目标。
        </p>
        <p className="mt-1 text-micro leading-4 text-cafe-secondary">
          影响 {affectedCatIds.length} 位成员：{affectedLine}
        </p>
      </div>
      {openAssertions.length > 0 && (
        <div className="mt-3 space-y-2">
          {openAssertions.map((assertion) => (
            <div key={assertion.eventId} className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-2.5">
              <p className="text-xs font-semibold text-conn-amber-text">
                {Math.min(
                  assertion.validUntil ?? Number.POSITIVE_INFINITY,
                  assertion.resetAt ?? Number.POSITIVE_INFINITY,
                ) <= Date.now()
                  ? '已过期（等待确认）'
                  : assertion.eventType === 'asserted'
                    ? availabilityStateLabel(assertion.state)
                    : ''}{' '}
                · {reasonCodeLabel(assertion.reasonCode)}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void close(assertion.eventId, 'recover')}
                  className="text-micro font-semibold text-cafe-accent hover:underline"
                >
                  确认恢复
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void close(assertion.eventId, 'retract')}
                  className="text-micro font-semibold text-cafe-secondary hover:underline"
                >
                  撤回断言
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-micro font-semibold text-cafe-secondary">
            状态
            <select
              value={state}
              onChange={(event) => {
                markCommandId.current = null;
                setState(event.target.value as typeof state);
              }}
              className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
            >
              <option value="scarce">需节制</option>
              <option value="degraded">能力降级</option>
              <option value="unavailable">暂不可用</option>
            </select>
          </label>
          <label className="text-micro font-semibold text-cafe-secondary">
            有效时长
            <select
              value={durationHours}
              onChange={(event) => {
                markCommandId.current = null;
                setDurationHours(Number(event.target.value));
              }}
              className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
            >
              <option value={1}>1 小时</option>
              <option value={4}>4 小时</option>
              <option value={24}>24 小时</option>
              <option value={168}>7 天</option>
            </select>
          </label>
        </div>
        <label className="text-micro font-semibold text-cafe-secondary">
          原因
          <input
            name="signal-reason"
            required
            value={reasonCode}
            onChange={(event) => {
              markCommandId.current = null;
              setReasonCode(event.target.value);
            }}
            className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
          />
        </label>
        <label className="text-micro font-semibold text-cafe-secondary">
          说明（可选）
          <input
            value={note}
            onChange={(event) => {
              markCommandId.current = null;
              setNote(event.target.value);
            }}
            className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
          />
        </label>
        {error && <p className="text-xs text-conn-red-text">{error}</p>}
        <button
          type="submit"
          disabled={saving || !reasonCode.trim()}
          className="h-9 justify-self-start rounded-lg bg-cafe-accent px-3 text-xs font-semibold text-[var(--cafe-surface)] disabled:opacity-50"
        >
          {saving ? '正在写入…' : '登记信号'}
        </button>
      </form>
    </section>
  );
}
