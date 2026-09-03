'use client';

import type { CustodyOfferV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface CustodyOfferReadResponse {
  sourceMessageRevision: string;
  offer: CustodyOfferV1 | null;
}

async function readCustodyOffer(sourceMessageId: string): Promise<CustodyOfferReadResponse> {
  const response = await apiFetch(`/api/messages/${encodeURIComponent(sourceMessageId)}/custody-offer`);
  if (!response.ok) throw new Error('托付状态同步失败');
  return (await response.json()) as CustodyOfferReadResponse;
}

async function submitDecision(
  sourceMessageId: string,
  offer: CustodyOfferV1,
  decision: 'accept' | 'decline',
): Promise<CustodyOfferV1 | null> {
  const endpoint = decision === 'accept' ? 'accept' : 'refuse';
  const response = await apiFetch(`/api/messages/${encodeURIComponent(sourceMessageId)}/custody-offer/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceMessageRevision: offer.sourceMessageRevision,
      offerId: offer.offerId,
      ...(decision === 'decline' ? { disposition: 'declined' } : {}),
    }),
  });
  if (response.status === 409) return null;
  const body = (await response.json()) as { offer?: CustodyOfferV1; error?: string };
  if (!response.ok || !body.offer) throw new Error(body.error ?? '托付处理失败');
  return body.offer;
}

export function CustodyOfferCard({
  sourceMessageId,
  expectedOffer,
}: {
  sourceMessageId: string;
  expectedOffer: CustodyOfferV1;
}) {
  const [offer, setOffer] = useState<CustodyOfferV1 | null>(null);
  const [sourceRevision, setSourceRevision] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchGeneration = useRef(0);

  const hydrate = useCallback(async () => {
    const generation = ++fetchGeneration.current;
    setLoading(true);
    try {
      const body = await readCustodyOffer(sourceMessageId);
      if (fetchGeneration.current !== generation) return;
      setOffer(body.offer);
      setSourceRevision(body.sourceMessageRevision);
      setError(null);
    } catch (caught) {
      if (fetchGeneration.current === generation) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (fetchGeneration.current === generation) setLoading(false);
    }
  }, [sourceMessageId]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ messageId?: string }>).detail;
      if (detail?.messageId === sourceMessageId) void hydrate();
    };
    window.addEventListener('cat-cafe:custody-offer-updated', listener);
    return () => window.removeEventListener('cat-cafe:custody-offer-updated', listener);
  }, [hydrate, sourceMessageId]);

  const canonical =
    offer !== null &&
    sourceRevision === expectedOffer.sourceMessageRevision &&
    offer.sourceMessageRevision === expectedOffer.sourceMessageRevision &&
    offer.offerId === expectedOffer.offerId;

  const decide = async (decision: 'accept' | 'decline'): Promise<void> => {
    if (!canonical || !offer || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await submitDecision(sourceMessageId, offer, decision);
      if (!updated) {
        await hydrate();
        return;
      }
      fetchGeneration.current += 1;
      setOffer(updated);
      setSourceRevision(updated.sourceMessageRevision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className="mt-3 max-w-full min-w-0 overflow-hidden rounded-2xl border border-cafe bg-cafe-surface p-3 shadow-sm"
      data-testid="custody-offer-card"
    >
      {loading && !offer ? <p className="text-sm text-cafe-muted">正在同步托付状态…</p> : null}
      {error ? (
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 flex-1 break-words text-sm text-[var(--semantic-critical)]">{error}</p>
          <button
            type="button"
            onClick={() => void hydrate()}
            className="shrink-0 rounded-lg border border-cafe px-2.5 py-1.5 text-xs font-semibold text-cafe-secondary"
          >
            重试
          </button>
        </div>
      ) : null}
      {offer && !canonical ? (
        <p className="text-sm text-cafe-muted">这份状态不是当前源消息的可操作版本，请回到原消息处理。</p>
      ) : null}
      {offer && canonical ? (
        <OfferState offer={offer} disabled={submitting} onDecide={(decision) => void decide(decision)} />
      ) : null}
    </section>
  );
}

function OfferState({
  offer,
  disabled,
  onDecide,
}: {
  offer: CustodyOfferV1;
  disabled: boolean;
  onDecide: (decision: 'accept' | 'decline') => void;
}) {
  if (offer.disposition === 'pending') {
    return (
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold text-cafe-primary">要不要我帮你接住这件事？</p>
        <p className="mt-1 break-words text-xs text-cafe-muted">接住后会建立一份可继续、可追溯的任务。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onDecide('accept')}
            className="rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] transition-colors hover:bg-cafe-interactive disabled:opacity-50"
          >
            接住
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onDecide('decline')}
            className="rounded-lg border border-cafe px-3 py-1.5 text-xs font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated disabled:opacity-50"
          >
            不用
          </button>
        </div>
      </div>
    );
  }
  if (offer.disposition !== 'accepted') {
    return <p className="text-sm text-cafe-muted">这次不纳入跟踪。</p>;
  }
  if (offer.admission.state === 'pending') {
    return <p className="text-sm text-cafe-muted">正在把这件事接稳…</p>;
  }
  const result = offer.admission.result;
  if (result.result === 'needs_clarification') {
    return (
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold text-cafe-primary">
          还差一个关键信息，我会在原对话里继续确认。
        </p>
        <p className="mt-1 break-words text-xs text-cafe-muted">目前还没有建立任务，也不会出现在全局视图里。</p>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <p className="text-sm font-semibold text-cafe-primary">我们接住了</p>
      <p className="mt-1 break-all text-xs text-cafe-muted">
        {result.result === 'resumed' ? '已接回原任务' : '已建立任务'} · {result.ownerRef}
      </p>
    </div>
  );
}
