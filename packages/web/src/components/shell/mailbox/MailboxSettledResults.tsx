import { useEffect, useState } from 'react';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '@/components/ApprovalHost';
import { useShellCopy } from '../shell-copy';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '../unified-attention-events';
import { SettledApprovalReceipt } from './SettledApprovalReceipt';
import { SettledRuntimeReceipt } from './SettledRuntimeReceipt';
import { settledResultsCopy } from './settled-results.shell-copy';
import { readSettledResults, type SettledResultItem, settledResultKey } from './settled-results-source';

/** Cold-loadable, owner-fenced receipts supplement in-flight sessions. They do not enter pending counts or writer stores. */
export function MailboxSettledResults({
  ownerUserId,
  generation,
  excludedKeys,
  verifyCurrent,
}: {
  ownerUserId: string;
  generation: number | null;
  excludedKeys: readonly string[];
  verifyCurrent: () => boolean;
}) {
  const t = useShellCopy(settledResultsCopy),
    [retry, setRetry] = useState(0);
  const [read, setRead] = useState<{
    owner: string;
    excluded: string;
    retry: number;
    items: SettledResultItem[] | null;
    preparing?: boolean;
  } | null>(null);
  const excluded = JSON.stringify([...excludedKeys].sort());
  useEffect(() => {
    const invalidate = () => setRetry((value) => value + 1);
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(event, invalidate);
    return () => {
      for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(event, invalidate);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void readSettledResults(ownerUserId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted)
          setRead((previous) => {
            if (items === 'preparing')
              return {
                owner: ownerUserId,
                excluded,
                retry,
                items: previous?.owner === ownerUserId ? previous.items : null,
                preparing: true,
              };
            const old = previous?.owner === ownerUserId && previous.retry === retry ? previous.items : null;
            const byKey = new Map(old?.map((item) => [settledResultKey(item), item]));
            const stable =
              items?.map((item) => {
                const prior = byKey.get(settledResultKey(item));
                return prior && JSON.stringify(prior) === JSON.stringify(item) ? prior : item;
              }) ?? null;
            return { owner: ownerUserId, excluded, retry, items: stable };
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRead({ owner: ownerUserId, excluded, retry, items: null });
      });
    return () => controller.abort();
  }, [ownerUserId, excluded, retry]);
  const current = read?.owner === ownerUserId ? read : null;
  useEffect(() => {
    if (!current?.preparing) return;
    const timer = window.setTimeout(() => setRetry((value) => value + 1), 1000);
    return () => window.clearTimeout(timer);
  }, [current?.preparing, current?.retry]);
  const currentAuthority = () =>
    current?.excluded === excluded && !current.preparing && current.retry === retry && verifyCurrent();
  const reread = () => setRetry((value) => value + 1);
  const items = current?.items?.filter((item) => !excludedKeys.includes(settledResultKey(item)));
  if (!current || (items?.length === 0 && current.items?.length !== 50)) return null;
  return (
    <section data-testid="mailbox-settled-results" className="mt-5 min-w-0" aria-label={t.title}>
      <h3 className="mb-2 text-sm font-semibold">{t.title}</h3>
      {current.preparing ? <p className="text-xs text-[var(--shell-muted)]">{t.preparing}</p> : null}
      {generation === null || current.excluded !== excluded || current.retry !== retry ? (
        <p className="text-xs text-[var(--shell-muted)]">{t.refreshing}</p>
      ) : null}
      {items ? (
        <ul className="m-0 list-none space-y-2 p-0">
          {items.map((item) => (
            <li
              key={settledResultKey(item)}
              data-testid="mailbox-settled-result"
              data-decision-key={settledResultKey(item)}
              className="min-w-0 py-2"
            >
              {item.sourceFeatureId === 'F306' ? (
                <SettledRuntimeReceipt item={item} reread={reread} />
              ) : (
                <ApprovalHostContext.Provider
                  value={{
                    ...PERMISSIVE_APPROVAL_HOST,
                    presentation: 'mailbox',
                    writesLocked: !currentAuthority(),
                    authorizeWrite: (kind) => kind === 'person-memory-undo' && currentAuthority(),
                  }}
                >
                  <SettledApprovalReceipt item={item} reread={reread} authorizeOpen={currentAuthority} />
                </ApprovalHostContext.Provider>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <>
          {!current.preparing ? <p className="text-xs">{t.unavailable}</p> : null}
          <button type="button" className="shell-focusable text-xs hover:underline" onClick={reread}>
            {t.reread}
          </button>
        </>
      )}
      {current.items?.length === 50 ? <p className="text-xs text-[var(--shell-muted)]">{t.recent}</p> : null}
    </section>
  );
}
