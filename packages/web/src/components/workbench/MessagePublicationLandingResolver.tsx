'use client';
import {
  type MessageMediaPublicationSource,
  type MessagePublicationLanding,
  messagePublicationLandingSchema,
} from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { checked, json } from '@/components/content-review/modification-http';
import { apiFetch } from '@/utils/api-client';
import { choiceIntro, namedChoices, useChoiceReviews } from './message-publication-choices';
import { PublicationLandingResolver } from './PublicationLandingResolver';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export function MessagePublicationLandingResolver({
  source,
  surface,
  onBack,
  onResolved,
  forceChoice = false,
}: {
  source: MessageMediaPublicationSource;
  surface: WorkspaceSurfaceDescriptor;
  onBack: () => void;
  onResolved: (surface: WorkspaceSurfaceDescriptor) => void;
  forceChoice?: boolean;
}) {
  const sourceKey = JSON.stringify(source);
  const [landing, setLanding] = useState<{ sourceKey: string; value: MessagePublicationLanding } | null>(null);
  const [selection, setSelection] = useState<{ contentRef: string; ownerRevision: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missingSelection, setMissingSelection] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const current = landing?.sourceKey === sourceKey ? landing.value : null;
  const choiceReviews = useChoiceReviews(current);
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    setError(null);
    const read = async () => {
      const result = messagePublicationLandingSchema.parse(
        await checked<unknown>(
          await apiFetch('/api/content-publications/resolve', {
            ...json({
              source: JSON.parse(sourceKey),
              operationId: crypto.randomUUID(),
              ...(selection ? { selection } : {}),
            }),
            signal: abort.signal,
          }),
        ),
      );
      if (abort.signal.aborted) return;
      const storageKey = `cat-cafe:message-publication:${result.ownerUserId}:${sourceKey}`;
      if (!forceChoice && !selection && !(result.status === 'choice-required' && result.unavailableContexts)) {
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(storageKey);
        } catch {
          /* The explicit choice remains usable without browser storage. */
        }
        if (saved) {
          const assets = result.status === 'resolved' ? [result.asset] : result.choices.map((choice) => choice.asset);
          const prior = assets.find(
            (asset) => JSON.stringify({ contentRef: asset.contentRef, ownerRevision: asset.ownerRevision }) === saved,
          );
          if (prior) {
            setLanding({ sourceKey, value: result });
            setSelection({ contentRef: prior.contentRef, ownerRevision: prior.ownerRevision });
            return;
          }
          setError('上次选择的作品当前不可用，请明确选择要继续的作品。');
          setMissingSelection(storageKey);
        }
      }
      if (result.status === 'resolved' && selection) {
        try {
          localStorage.setItem(storageKey, JSON.stringify(selection));
        } catch {
          /* Persistence may be disabled; fresh owner resolution still succeeded. */
        }
        setMissingSelection(null);
      }
      setLanding({ sourceKey, value: result });
    };
    void read()
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '暂时无法核对原作品。');
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [sourceKey, selection, retry, forceChoice]);
  if (current?.status === 'resolved' && !error && (!forceChoice || selection))
    return (
      <PublicationLandingResolver
        sourceSurface={surface}
        target={current.asset}
        confirmSingleContext={!selection}
        onResolved={(resolved) =>
          onResolved({
            ...resolved,
            messagePublicationSource: source,
            navigationOrigin: surface.navigationOrigin ?? {
              kind: 'chat-file-link',
              threadId: source.threadId,
              messageId: source.messageId,
            },
          })
        }
        onBack={onBack}
      >
        <p role="status">正在回到原作品…</p>
      </PublicationLandingResolver>
    );
  return (
    <section className="p-4">
      <button type="button" className="mb-3 text-xs text-cafe-muted" onClick={onBack}>
        {forceChoice ? '返回作品' : '返回来源'}
      </button>
      <h2 className="text-sm font-semibold">{surface.title}</h2>
      {error ? (
        <div role="alert" className="my-2 text-sm text-cafe-error">
          {error}
          <button type="button" disabled={busy} onClick={() => setRetry((n) => n + 1)}>
            重新读取
          </button>
          {missingSelection ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                try {
                  localStorage.removeItem(missingSelection);
                } catch {
                  /* Unavailable browser storage has no authority. */
                }
                setMissingSelection(null);
                setSelection(null);
                setRetry((n) => n + 1);
              }}
            >
              查看当前可用作品
            </button>
          ) : null}
        </div>
      ) : null}
      {current?.status === 'resolved' && forceChoice && !selection ? (
        <div className="space-y-3 py-3 text-sm">
          <p>当前只有这一份可访问的作品。</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setSelection({ contentRef: current.asset.contentRef, ownerRevision: current.asset.ownerRevision })
            }
          >
            打开第 {current.asset.ownerRevision} 版
          </button>
        </div>
      ) : current?.status === 'choice-required' ? (
        <>
          {current.unavailableContexts ? (
            <p role="status" className="my-2 text-sm text-cafe-muted">
              还有历史作品当前无法访问。请选择当前可用的作品，或返回原对话核对权限。
            </p>
          ) : null}
          <p className="my-3 text-sm">{choiceIntro(current.choices)}</p>
          <ul className="space-y-2">
            {namedChoices(current.choices, choiceReviews).map(({ choice, heading, detail }) => (
              <li key={`${choice.asset.contentRef}:${choice.asset.ownerRevision}`}>
                <button
                  type="button"
                  disabled={busy}
                  className="w-full rounded-lg border border-cafe-subtle p-3 text-left text-sm"
                  onClick={() =>
                    setSelection({ contentRef: choice.asset.contentRef, ownerRevision: choice.asset.ownerRevision })
                  }
                >
                  <span className="block font-medium">{heading}</span>
                  <span className="text-xs text-cafe-muted">{detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p role="status" className="my-3 text-sm text-cafe-muted">
          正在核对已保存的作品…
        </p>
      )}
    </section>
  );
}
