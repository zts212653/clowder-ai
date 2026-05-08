'use client';

import type { BacklogItem, MissionHubSelfClaimScope, ThreadPhase } from '@cat-cafe/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getThreadHref } from '@/components/ThreadSidebar/thread-navigation';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { SuggestionDecisionPanel } from './SuggestionDecisionPanel';
import { SuggestionOpenForm } from './SuggestionOpenForm';

interface SuggestionDrawerProps {
  item: BacklogItem | null;
  submitting?: boolean;
  selectedPhase: ThreadPhase;
  selfClaimScopes: Record<string, MissionHubSelfClaimScope>;
  selfClaimPolicyBlocker?: 'once' | 'thread' | null;
  onChangePhase: (phase: ThreadPhase) => void;
  onSuggest: (payload: {
    itemId: string;
    catId: string;
    why: string;
    plan: string;
    requestedPhase: ThreadPhase;
  }) => Promise<void>;
  onApprove: (payload: { itemId: string; threadPhase: ThreadPhase }) => Promise<void>;
  onReject: (payload: { itemId: string; note?: string }) => Promise<void>;
  onSelfClaim: (payload: {
    itemId: string;
    catId: string;
    why: string;
    plan: string;
    requestedPhase: ThreadPhase;
  }) => Promise<void>;
  onAcquireLease: (payload: { itemId: string; catId: string; ttlMs?: number }) => Promise<void>;
  onHeartbeatLease: (payload: { itemId: string; catId: string; ttlMs?: number }) => Promise<void>;
  onReleaseLease: (payload: { itemId: string; catId?: string }) => Promise<void>;
  onReclaimLease: (payload: { itemId: string }) => Promise<void>;
}

export function SuggestionDrawer({
  item,
  submitting,
  selectedPhase,
  selfClaimScopes,
  selfClaimPolicyBlocker,
  onChangePhase,
  onSuggest,
  onApprove,
  onReject,
  onSelfClaim,
  onAcquireLease,
  onHeartbeatLease,
  onReleaseLease,
  onReclaimLease,
}: SuggestionDrawerProps) {
  const { cats } = useCatData();
  const catOptions = useMemo(
    () =>
      cats.map((cat) => ({
        id: cat.id,
        label: !cat.variantLabel && cat.nickname ? `${formatCatName(cat)}（${cat.nickname}）` : formatCatName(cat),
      })),
    [cats],
  );

  const [catId, setCatId] = useState('');
  const [why, setWhy] = useState('');
  const [plan, setPlan] = useState('');
  const [rejectNote, setRejectNote] = useState('');
  const [leaseClock, setLeaseClock] = useState(() => Date.now());
  const leaseState = item?.lease?.state;
  const leaseExpiresAt = item?.lease?.expiresAt;
  const itemStatus = item?.status;
  const itemId = item?.id;

  useEffect(() => {
    if (catOptions.length === 0) {
      if (catId) setCatId('');
      return;
    }
    if (!catId || !catOptions.some((option) => option.id === catId)) {
      setCatId(catOptions[0].id);
    }
  }, [catOptions, catId]);

  useEffect(() => {
    if (!itemId || itemStatus !== 'dispatched' || leaseState !== 'active' || !leaseExpiresAt) {
      return;
    }

    const delayMs = Math.max(0, leaseExpiresAt - Date.now()) + 50;
    const timer = window.setTimeout(() => {
      setLeaseClock(Date.now());
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [itemId, itemStatus, leaseState, leaseExpiresAt]);

  const statusLabel = useMemo(() => {
    if (!item) return '未选择任务';
    if (item.status === 'open') return '待建议领取';
    if (item.status === 'suggested') return '等待铲屎官决策';
    if (item.status === 'dispatched') return '已派发';
    return '已批准';
  }, [item]);

  const currentSelfClaimScope: MissionHubSelfClaimScope = selfClaimScopes[catId] ?? 'disabled';
  const canSelfClaim = currentSelfClaimScope !== 'disabled';
  const leaseOwnerCatId = item?.lease?.ownerCatId ?? item?.suggestion?.catId ?? catId;
  const leaseExpiresAtMs = item?.lease?.expiresAt ?? 0;
  const leaseIsActive = item?.lease?.state === 'active' && leaseExpiresAtMs > leaseClock;
  const leaseExpired = item?.lease?.state === 'active' && leaseExpiresAtMs <= leaseClock;

  if (!item) {
    return (
      <aside className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-cafe">Suggestion Detail</h2>
        <p className="text-xs text-cafe-secondary">点击左侧卡片查看详情并执行建议领取/批准流程。</p>
      </aside>
    );
  }

  return (
    <aside className="p-4">
      <h2 className="text-sm font-semibold text-cafe">Suggestion Detail</h2>
      <p className="mt-1 text-xs text-cafe-secondary">状态：{statusLabel}</p>
      <div className="mt-3 rounded-lg bg-[var(--console-field-bg)] p-3">
        <h3 className="text-sm font-semibold text-cafe">{item.title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-cafe-secondary">{item.summary}</p>
      </div>

      {item.status === 'open' && (
        <div className="mt-4 space-y-2">
          <SuggestionOpenForm
            itemId={item.id}
            catOptions={catOptions}
            catId={catId}
            why={why}
            plan={plan}
            selectedPhase={selectedPhase}
            submitting={submitting}
            onCatIdChange={setCatId}
            onWhyChange={setWhy}
            onPlanChange={setPlan}
            onSubmit={async (payload) => {
              await onSuggest(payload);
              setWhy('');
              setPlan('');
            }}
          />
          <div className="rounded-lg bg-[var(--console-field-bg)] p-2 text-[11px] text-cafe-secondary">
            <p>
              Self-claim policy：<span className="font-semibold">{currentSelfClaimScope}</span>
            </p>
            {currentSelfClaimScope === 'once' && (
              <p className="mt-1 text-[11px] text-cafe-secondary">once：每只猫只允许一次非幂等自领。</p>
            )}
            {currentSelfClaimScope === 'thread' && (
              <p className="mt-1 text-[11px] text-cafe-secondary">
                thread：同一只猫同一时间只允许一个 active lease 线程。
              </p>
            )}
            {selfClaimPolicyBlocker === 'once' && (
              <p className="mt-1 text-[11px] text-conn-red-text" data-testid="mc-self-claim-blocker-once">
                当前阻断原因：once 自领额度已用完。
              </p>
            )}
            {selfClaimPolicyBlocker === 'thread' && (
              <p className="mt-1 text-[11px] text-conn-red-text" data-testid="mc-self-claim-blocker-thread">
                当前阻断原因：该猫已有 active lease 线程。
              </p>
            )}
            {canSelfClaim ? (
              <button
                type="button"
                disabled={submitting || !catId || !why.trim() || !plan.trim()}
                onClick={() =>
                  void onSelfClaim({
                    itemId: item.id,
                    catId,
                    why: why.trim(),
                    plan: plan.trim(),
                    requestedPhase: selectedPhase,
                  })
                }
                className="console-button-secondary mt-2 w-full disabled:opacity-40"
                data-testid="mc-self-claim-submit"
              >
                直接自领并派发
              </button>
            ) : (
              <p className="mt-1 text-[11px] text-cafe-secondary">当前策略为 disabled：请走「建议 + 批准」流程。</p>
            )}
          </div>
        </div>
      )}

      {(item.status === 'suggested' || item.status === 'approved') && (
        <SuggestionDecisionPanel
          item={item}
          selectedPhase={selectedPhase}
          rejectNote={rejectNote}
          submitting={submitting}
          onChangePhase={onChangePhase}
          onChangeRejectNote={setRejectNote}
          onApprove={onApprove}
          onReject={onReject}
        />
      )}

      {item.status === 'dispatched' && (
        <div className="mt-4 rounded-lg bg-conn-sky-bg p-3 text-xs text-conn-sky-text">
          <p>已派发到 Thread：{item.dispatchedThreadId}</p>
          <p>Phase：{item.dispatchedThreadPhase}</p>
          {item.lease && (
            <div className="mt-2 rounded border border-conn-sky-ring bg-conn-sky-bg px-2 py-1.5 text-[11px] text-conn-sky-text">
              <p>Lease：{item.lease.state}</p>
              <p>Owner：{item.lease.ownerCatId}</p>
              <p>ExpiresAt：{new Date(item.lease.expiresAt).toLocaleString()}</p>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {!leaseIsActive && !leaseExpired && (
              <button
                type="button"
                disabled={submitting || !leaseOwnerCatId}
                onClick={() => void onAcquireLease({ itemId: item.id, catId: leaseOwnerCatId, ttlMs: 60_000 })}
                className="rounded border border-conn-sky-ring px-2 py-1 text-[11px] font-semibold text-conn-sky-text disabled:opacity-40"
                data-testid="mc-lease-acquire"
              >
                获取 Lease
              </button>
            )}
            {leaseIsActive && (
              <>
                <button
                  type="button"
                  disabled={submitting || !leaseOwnerCatId}
                  onClick={() => void onHeartbeatLease({ itemId: item.id, catId: leaseOwnerCatId, ttlMs: 60_000 })}
                  className="rounded border border-conn-sky-ring px-2 py-1 text-[11px] font-semibold text-conn-sky-text disabled:opacity-40"
                  data-testid="mc-lease-heartbeat"
                >
                  续租 Heartbeat
                </button>
                <button
                  type="button"
                  disabled={submitting || !leaseOwnerCatId}
                  onClick={() => void onReleaseLease({ itemId: item.id, catId: leaseOwnerCatId })}
                  className="rounded border border-conn-sky-ring px-2 py-1 text-[11px] font-semibold text-cafe-secondary disabled:opacity-40"
                  data-testid="mc-lease-release"
                >
                  释放 Lease
                </button>
              </>
            )}
            {leaseExpired && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void onReclaimLease({ itemId: item.id })}
                className="rounded border border-[var(--console-border-soft)] px-2 py-1 text-[11px] font-semibold text-conn-amber-text disabled:opacity-40"
                data-testid="mc-lease-reclaim"
              >
                回收过期 Lease
              </button>
            )}
          </div>
          {item.dispatchedThreadId && (
            <Link
              href={getThreadHref(item.dispatchedThreadId)}
              className="mt-2 inline-flex rounded bg-cafe px-2 py-1 text-[11px] font-semibold text-[var(--cafe-surface)]"
              data-testid="mc-open-thread-link"
            >
              打开执行 Thread
            </Link>
          )}
        </div>
      )}
    </aside>
  );
}
