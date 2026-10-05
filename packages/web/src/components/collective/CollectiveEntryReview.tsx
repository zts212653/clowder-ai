'use client';

import type { CollectivePairingIntentMessage } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { AvatarImageWithFallback } from '@/components/AvatarImageWithFallback';
import { apiFetch } from '@/utils/api-client';

interface EntryCat {
  readonly id: string;
  readonly displayName: string;
  readonly eligible: boolean;
  readonly avatar?: string;
  readonly roleDescription?: string;
  readonly defaultModel?: string;
}

interface EntryRoster {
  readonly fingerprint: string;
  readonly cats: readonly EntryCat[];
}

export function CollectiveEntryReview({
  intent,
  existing,
  busy,
  pairingError,
  onConfirm,
  onClose,
  onRetry,
}: {
  readonly intent: CollectivePairingIntentMessage;
  readonly existing: boolean;
  readonly busy: boolean;
  readonly pairingError?: string;
  readonly onConfirm: (input: { rosterFingerprint: string; excludedCatIds: string[] }) => void;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}) {
  const [roster, setRoster] = useState<EntryRoster>();
  const [included, setIncluded] = useState<readonly string[]>([]);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry intentionally refetches the same roster URL
  useEffect(() => {
    const abort = new AbortController();
    setError(undefined);
    setRoster(undefined);
    void apiFetch('/api/plugins/collective-connector/entry-roster', { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('暂时无法读取这台 Café 的注册伙伴，请重试。');
        const result = (await response.json()) as EntryRoster;
        if (!Array.isArray(result.cats) || !/^[a-f0-9]{64}$/.test(result.fingerprint))
          throw new Error('伙伴名单暂不可用，请重试。');
        if (abort.signal.aborted) return;
        setRoster(result);
        setIncluded(result.cats.filter((cat) => cat.eligible).map((cat) => cat.id));
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '伙伴名单暂不可用');
      });
    return () => abort.abort();
  }, [reload]);
  const selectedCount = included.length;
  const expired = Date.parse(intent.intent.expiresAt) <= Date.now();
  return (
    <aside
      aria-label="带入伙伴前确认"
      className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-[var(--console-border-soft)] bg-[var(--console-card-bg)] text-cafe-primary shadow-[var(--console-elevation-2)] sm:w-[min(440px,94%)]"
    >
      <header className="flex items-start justify-between border-b border-[var(--console-border-soft)] px-5 py-4">
        <div>
          <p className="text-xs text-cafe-muted">这台 Café · 加入当前共同家园</p>
          <h2 className="mt-1 text-lg font-semibold">先看清要带来的伙伴</h2>
        </div>
        <button type="button" aria-label="关闭带入确认" onClick={onClose} className="text-xl text-cafe-muted">
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p className="text-sm leading-6 text-cafe-secondary">
          勾选的伙伴会出现在获准频道的成员栏，其他成员可以点名请求回应。连接本身不会向频道发消息；不想带来的猫可先取消勾选。
        </p>
        {existing && (
          <output className="mt-4 block rounded-lg bg-conn-amber-bg p-3 text-sm text-conn-amber-text">
            这台 Café 已连接当前共同家园。打开「我的 Café」即可管理参与伙伴，不必再建一条连接。
          </output>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-conn-red-text">
            {error}
          </p>
        )}
        {pairingError && (
          <p role="alert" className="mt-4 text-sm text-conn-red-text">
            {pairingError}
          </p>
        )}
        {(error || pairingError) && (
          <button
            type="button"
            className="mt-2 text-sm font-semibold text-cafe-accent"
            onClick={() => {
              onRetry();
              setReload((current) => current + 1);
            }}
          >
            重新读取名单
          </button>
        )}
        {!roster && !error && <p className="mt-4 text-sm text-cafe-muted">正在读取注册伙伴…</p>}
        {roster && (
          <div className="mt-4 space-y-2">
            {roster.cats.map((cat) => (
              <label key={cat.id} className="flex gap-3 rounded-xl border border-[var(--console-border-soft)] p-3">
                <input
                  type="checkbox"
                  aria-label={`带入 ${cat.displayName}`}
                  checked={cat.eligible && included.includes(cat.id)}
                  disabled={!cat.eligible || existing || busy}
                  onChange={(event) =>
                    setIncluded((current) =>
                      event.target.checked ? [...current, cat.id] : current.filter((id) => id !== cat.id),
                    )
                  }
                />
                <AvatarImageWithFallback
                  src={cat.avatar?.startsWith('/avatars/') || cat.avatar?.startsWith('/uploads/') ? cat.avatar : null}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-full object-cover"
                />
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm">{cat.displayName}</strong>
                  {cat.defaultModel && <span className="block text-xs text-cafe-muted">{cat.defaultModel}</span>}
                  {cat.roleDescription && (
                    <span className="mt-1 block text-xs text-cafe-secondary">{cat.roleDescription}</span>
                  )}
                  {!cat.eligible && <span className="mt-1 block text-xs text-conn-amber-text">当前无法参与</span>}
                </span>
              </label>
            ))}
            {!roster.cats.length && <p className="text-sm text-cafe-muted">这台 Café 还没有登记伙伴。</p>}
          </div>
        )}
        <p className="mt-4 text-xs text-cafe-muted">名单表示参与资格；是否真正收到并回复，要在频道消息下看状态。</p>
      </div>
      <footer className="border-t border-[var(--console-border-soft)] p-4">
        {expired && (
          <p className="mb-2 text-xs text-conn-amber-text">本次连接邀请已过期，请在频道里重新点「连接此 Café」。</p>
        )}
        <button
          type="button"
          disabled={!roster || Boolean(error || pairingError) || existing || busy || expired}
          onClick={() =>
            roster &&
            onConfirm({
              rosterFingerprint: roster.fingerprint,
              excludedCatIds: roster.cats
                .filter((cat) => cat.eligible && !included.includes(cat.id))
                .map((cat) => cat.id),
            })
          }
          className="w-full rounded-xl bg-[var(--cafe-accent)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? '正在连接…' : `确认带入 ${selectedCount} 位伙伴`}
        </button>
      </footer>
    </aside>
  );
}
