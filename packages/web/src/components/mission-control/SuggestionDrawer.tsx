'use client';

import type { BacklogItem, MissionHubSelfClaimScope, ThreadPhase } from '@cat-cafe/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
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
      <aside className="rounded-2xl border border-[#E6DAC8] bg-cafe-surface p-4">
        <h2 className="mb-2 text-sm font-semibold text-[#2A2017]">Suggestion Detail</h2>
        <p className="text-xs text-[#7C6A58]">点击左侧卡片查看详情并执行建议领取/批准流程。</p>
      </aside>
    );
  }

  return (
    <aside className="rounded-2xl border border-[#E6DAC8] bg-cafe-surface p-4">
      <h2 className="text-sm font-semibold text-[#2A2017]">Suggestion Detail</h2>
      <p className="mt-1 text-xs text-[#7C6A58]">状态：{statusLabel}</p>
      <h3 className="mt-3 text-sm font-semibold text-[#34281D]">{item.title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-[#6F5E4D]">{item.summary}</p>

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
          <div className="rounded-lg border border-[#D8C9B4] bg-[#FCF6EB] p-2 text-[11px] text-[#735F47]">
            <p>
              Self-claim policy：<span className="font-semibold">{currentSelfClaimScope}</span>
            </p>
            {currentSelfClaimScope === 'once' && (
              <p className="mt-1 text-[11px] text-[#846D55]">once：每只猫只允许一次非幂等自领。</p>
            )}
            {currentSelfClaimScope === 'thread' && (
              <p className="mt-1 text-[11px] text-[#846D55]">thread：同一只猫同一时间只允许一个 active lease 线程。</p>
            )}
            {selfClaimPolicyBlocker === 'once' && (
              <p className="mt-1 text-[11px] text-[#A14A2D]" data-testid="mc-self-claim-blocker-once">
                当前阻断原因：once 自领额度已用完。
              </p>
            )}
            {selfClaimPolicyBlocker === 'thread' && (
              <p className="mt-1 text-[11px] text-[#A14A2D]" data-testid="mc-self-claim-blocker-thread">
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
                className="mt-2 w-full rounded-lg border border-[#1F1A16] px-3 py-2 text-xs font-semibold text-[#1F1A16] disabled:opacity-40"
                data-testid="mc-self-claim-submit"
              >
                直接自领并派发
              </button>
            ) : (
              <p className="mt-1 text-[11px] text-[#846D55]">当前策略为 disabled：请走「建议 + 批准」流程。</p>
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
        <div className="mt-4 rounded-lg bg-[#EEF6FF] p-3 text-xs text-[#2F4D69]">
          <p>已派发到 Thread：{item.dispatchedThreadId}</p>
          <p>Phase：{item.dispatchedThreadPhase}</p>
          {item.lease && (
            <div className="mt-2 rounded border border-[#CFE3FB] bg-[#F7FBFF] px-2 py-1.5 text-[11px] text-[#36516E]">
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
                className="rounded border border-[#7AA4CC] px-2 py-1 text-[11px] font-semibold text-[#2F4D69] disabled:opacity-40"
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
                  className="rounded border border-[#7AA4CC] px-2 py-1 text-[11px] font-semibold text-[#2F4D69] disabled:opacity-40"
                  data-testid="mc-lease-heartbeat"
                >
                  续租 Heartbeat
                </button>
                <button
                  type="button"
                  disabled={submitting || !leaseOwnerCatId}
                  onClick={() => void onReleaseLease({ itemId: item.id, catId: leaseOwnerCatId })}
                  className="rounded border border-[#B7BFD0] px-2 py-1 text-[11px] font-semibold text-[#4A5568] disabled:opacity-40"
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
                className="rounded border border-[#D4B483] px-2 py-1 text-[11px] font-semibold text-[#7A5A2D] disabled:opacity-40"
                data-testid="mc-lease-reclaim"
              >
                回收过期 Lease
              </button>
            )}
          </div>
          {item.dispatchedThreadId && (
            <Link
              href={`/thread/${item.dispatchedThreadId}`}
              className="mt-2 inline-flex rounded bg-[#1F1A16] px-2 py-1 text-[11px] font-semibold text-white"
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
